// Chapter 11, lesson 4: stream joins, and a consumer that must survive crashes.

/* ------------------------------------------------------------------
   Stream-table join: coffee purchases enriched with the member's tier
   ------------------------------------------------------------------ */

export const DISCOUNT = { bronze: 0, silver: 5, gold: 10 };

export const MEMBERS0 = [
  { id: "m1", name: "Ana", tier: "silver" },
  { id: "m2", name: "Bo", tier: "bronze" },
  { id: "m3", name: "Cy", tier: "gold" },
];

// Event times in seconds. "buy" is the purchase stream; "chg" is the CDC stream of the members table.
export const INPUT = [
  { t: 1, kind: "buy", member: "m1", amount: 4.5 },
  { t: 2, kind: "buy", member: "m2", amount: 3.2 },
  { t: 3, kind: "chg", member: "m2", set: { tier: "silver" } },
  { t: 4, kind: "buy", member: "m2", amount: 6.0 },
  { t: 5, kind: "buy", member: "m3", amount: 2.8 },
  { t: 6, kind: "chg", member: "m1", set: { tier: "gold" } },
  { t: 7, kind: "buy", member: "m1", amount: 5.1 },
  { t: 8, kind: "chg", member: "m4", set: { name: "Dee", tier: "bronze" } },
  { t: 9, kind: "buy", member: "m4", amount: 3.9 },
  { t: 10, kind: "buy", member: "m2", amount: 4.4 },
];

/** The member row that was valid at time t (the correct answer for any purchase at t). */
export function asOf(member, t) {
  let row = MEMBERS0.find((m) => m.id === member);
  row = row ? { ...row } : null;
  for (const e of INPUT) if (e.kind === "chg" && e.member === member && e.t <= t) row = { ...(row || { id: member }), ...e.set };
  return row;
}

/**
 * Simulate the join processor.
 * cdcDelay: seconds the change stream lags behind its event time (purchases lag 0.3 s).
 * mode "latest": join each purchase with the processor's local table as it is right now.
 * mode "versioned": keep table history and join with the version valid at the purchase's
 *                   event time, waiting until the change stream has caught up to that time.
 * Returns steps in processing order: { at, input, table (snapshot), outputs emitted at this step }.
 */
export function enrichment({ cdcDelay = 0, mode = "latest" } = {}) {
  const arrivals = INPUT.map((e, i) => ({ ...e, i, at: e.t + (e.kind === "chg" ? cdcDelay : 0.3) }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  const table = new Map(MEMBERS0.map((m) => [m.id, { ...m }]));
  const waiting = []; // versioned mode: purchases waiting for the change stream to catch up
  const steps = [];

  const enrich = (buy, row, at) => {
    const correct = asOf(buy.member, buy.t);
    const tier = row ? row.tier : null;
    return {
      t: buy.t, member: buy.member, amount: buy.amount, name: row ? row.name : null, tier,
      discount: tier ? DISCOUNT[tier] : null,
      correctTier: correct ? correct.tier : null,
      ok: (correct ? correct.tier : null) === tier,
      waited: Math.max(0, at - buy.at),
    };
  };
  // Versioned mode: the change stream is known to be complete up to (now - cdcDelay),
  // because it sends heartbeats. A purchase at t is joined once that point passes t,
  // using the table version that was valid at t.
  const release = (now) => {
    const out = [];
    for (let k = 0; k < waiting.length;) {
      const w = waiting[k];
      if (now - cdcDelay >= w.t - 1e-9) { out.push(enrich(w, asOf(w.member, w.t), now)); waiting.splice(k, 1); } else k++;
    }
    return out;
  };

  for (const a of arrivals) {
    const outputs = [];
    if (a.kind === "chg") table.set(a.member, { ...(table.get(a.member) || { id: a.member }), ...a.set });
    else if (mode === "latest") outputs.push(enrich(a, table.get(a.member), a.at));
    else waiting.push(a);
    if (mode === "versioned") outputs.push(...release(a.at));
    steps.push({ at: a.at, input: a, table: [...table.values()].map((r) => ({ ...r })), outputs, waiting: waiting.length });
  }
  while (waiting.length) { // the change stream's heartbeat eventually passes the last purchases
    const at = Math.min(...waiting.map((w) => w.t)) + cdcDelay;
    steps.push({ at, input: null, table: [...table.values()].map((r) => ({ ...r })), outputs: release(at), waiting: 0 });
    steps[steps.length - 1].waiting = waiting.length;
  }
  return steps;
}

/* ------------------------------------------------------------------
   Stream-stream window join: notifications sent, and app opens
   ------------------------------------------------------------------ */

/** Minutes. Each open carries the id of the notification that was tapped (or none). */
export const SENT = [
  { id: "n1", t: 2 }, { id: "n2", t: 6 }, { id: "n3", t: 9 }, { id: "n4", t: 15 }, { id: "n5", t: 19 },
  { id: "n6", t: 24 }, { id: "n7", t: 30 }, { id: "n8", t: 33 }, { id: "n9", t: 41 }, { id: "n10", t: 47 },
];
export const OPENS = [
  { ref: "n1", t: 4 }, { ref: "n2", t: 29 }, { ref: "n3", t: 10 }, { ref: "n5", t: 21 }, { ref: "n6", t: 37 },
  { ref: "n7", t: 31 }, { ref: "n9", t: 44 }, { ref: "n4", t: 58 }, { ref: "n10", t: 49 },
];

/**
 * Join each open to its notification if it happened within `win` minutes after the send.
 * Notifications whose window closes without an open are emitted as "ignored".
 * Also reports the peak number of sends the processor must hold in state at once.
 */
export function windowJoin(win) {
  const pairs = [], orphans = [], ignored = [];
  for (const o of OPENS) {
    const s = SENT.find((x) => x.id === o.ref);
    if (s && o.t >= s.t && o.t - s.t <= win) pairs.push({ sent: s, open: o, gap: o.t - s.t });
    else orphans.push(o);
  }
  for (const s of SENT) if (!pairs.some((p) => p.sent === s)) ignored.push(s);
  let peak = 0;
  for (const s of SENT) {
    const held = SENT.filter((x) => x.t <= s.t && x.t + win > s.t).length;
    peak = Math.max(peak, held);
  }
  return { pairs, orphans, ignored, peak };
}

/* ------------------------------------------------------------------
   A consumer that writes output and commits offsets, and can crash
   ------------------------------------------------------------------ */

/**
 * strategy:
 *   "before"     commit the batch's end offset, then write each output   (at most once)
 *   "after"      write each output, then commit the batch's end offset   (at least once)
 *   "idempotent" like "after", but each write is an upsert keyed by the message offset
 *   "atomic"     write outputs and the offset inside one transaction      (exactly-once effect)
 */
export class OffsetConsumer {
  constructor({ messages = 10, batch = 3, strategy = "after" } = {}) {
    this.n = messages;
    this.batch = batch;
    this.strategy = strategy;
    this.committed = 0;   // durable, survives a crash
    this.pos = 0;         // in memory
    this.ops = [];        // planned ops for the current batch
    this.history = [];    // executed ops, for display
    this.sink = [];       // { offset, attempt, state: "visible" | "pending" | "aborted" }
    this.overwrites = 0;
    this.attempt = 1;
    this.down = false;
    this.plan();
  }

  get done() { return this.committed >= this.n && !this.ops.length && !this.down; }

  plan() {
    if (this.down || this.pos >= this.n) { this.ops = []; return; }
    const from = this.pos, to = Math.min(this.n, from + this.batch);
    const writes = [];
    for (let i = from; i < to; i++) writes.push({ type: "write", offset: i });
    const commit = { type: "commit", offset: to };
    if (this.strategy === "before") this.ops = [commit, ...writes];
    else if (this.strategy === "atomic") this.ops = [{ type: "begin" }, ...writes, { type: "txcommit", offset: to }];
    else this.ops = [...writes, commit];
  }

  /** Execute one op. Returns the op (with a description) or null when finished. */
  step() {
    if (this.down) {
      this.down = false;
      this.pos = this.committed;
      this.attempt++;
      const op = { type: "restart", offset: this.committed };
      this.history.push(op);
      this.plan();
      return op;
    }
    if (!this.ops.length) this.plan();
    const op = this.ops.shift();
    if (!op) return null;
    if (op.type === "write") {
      if (this.strategy === "idempotent") {
        const existing = this.sink.find((r) => r.offset === op.offset && r.state === "visible");
        if (existing) { existing.attempt = this.attempt; this.overwrites++; op.overwrote = true; }
        else this.sink.push({ offset: op.offset, attempt: this.attempt, state: "visible" });
      } else {
        this.sink.push({ offset: op.offset, attempt: this.attempt, state: this.strategy === "atomic" ? "pending" : "visible" });
      }
      this.pos = op.offset + 1;
    } else if (op.type === "commit") {
      this.committed = op.offset;
    } else if (op.type === "txcommit") {
      for (const r of this.sink) if (r.state === "pending") r.state = "visible";
      this.committed = op.offset;
    }
    this.history.push(op);
    if (!this.ops.length) this.plan();
    return op;
  }

  /** Crash: in-memory position and planned ops are lost; an open transaction is rolled back. */
  crash() {
    if (this.down || this.done) return null;
    const lostOps = this.ops.slice();
    this.ops = [];
    for (const r of this.sink) if (r.state === "pending") r.state = "aborted";
    this.down = true;
    const op = { type: "crash", committed: this.committed, pos: this.pos, lostOps };
    this.history.push(op);
    return op;
  }

  /** Per input offset: how many visible outputs exist. 0 = lost, 2+ = duplicated. */
  tally() {
    const counts = Array(this.n).fill(0);
    for (const r of this.sink) if (r.state === "visible") counts[r.offset]++;
    return {
      counts,
      lost: this.done ? counts.filter((c) => c === 0).length : null,
      dup: counts.reduce((s, c) => s + Math.max(0, c - 1), 0),
      visible: counts.reduce((s, c) => s + c, 0),
    };
  }
}
