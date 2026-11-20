// Chapter 8: a tiny deterministic discrete-event simulator for messages, clocks,
// crashes, and process pauses. DOM-free, so it can be tested with node.
// Times are in seconds of "true" time (the time an outside observer would measure).
import { rng, normal } from "../charts.js";

/* ------------------------------------------------------------------ */
/* Core simulator                                                      */
/* ------------------------------------------------------------------ */

export class Sim {
  constructor(seed = 1) {
    this.now = 0;
    this.queue = [];
    this.seq = 0;
    this.nodes = {};
    this.msgs = [];
    this.events = [];
    this.spans = [];
    this.rand = rng(seed);
  }

  addNode(id, { label = id, clock = null, onMessage = null } = {}) {
    this.nodes[id] = { id, label, clock, onMessage, state: "up", inbox: [] };
    return this.nodes[id];
  }

  at(t, fn) { this.queue.push({ t, seq: this.seq++, fn }); }
  after(dt, fn) { this.at(this.now + dt, fn); }

  /** What the node's own clock says right now (true time if it has no clock model). */
  clockOf(id, t = this.now) {
    const c = this.nodes[id].clock;
    return c ? c.read(t) : t;
  }

  /** Record something a node did or noticed. opts are passed through to the renderer. */
  log(node, label, opts = {}) {
    const e = { node, t: this.now, clock: this.clockOf(node), label, ...opts };
    this.events.push(e);
    return e;
  }

  /**
   * Send a message. delay: one-way network delay. lost: the network drops it part way.
   * A message that arrives at a crashed node is dropped; one that arrives at a paused
   * node waits in its inbox until the pause ends.
   */
  send(from, to, label, { delay = 0.1, lost = false, data = null, ...opts } = {}) {
    const m = { id: this.msgs.length, from, to, label, data, send: this.now, delay,
      status: "in flight", recv: null, handled: null, ...opts };
    this.msgs.push(m);
    if (lost) {
      m.status = "lost";
      m.lostAt = this.now + delay * 0.45;
    } else {
      this.at(this.now + delay, () => this._deliver(m));
    }
    return m;
  }

  _deliver(m) {
    const n = this.nodes[m.to];
    m.recv = this.now;
    if (n.state === "crashed") { m.status = "dropped"; return; }
    if (n.state === "paused") { m.status = "queued"; n.inbox.push(m); return; }
    this._handle(n, m);
  }

  _handle(n, m) {
    m.status = "handled";
    m.handled = this.now;
    n.onMessage?.(this, m);
  }

  crash(id, label = "crashes") {
    this.nodes[id].state = "crashed";
    this.spans.push({ node: id, kind: "crash", t0: this.now, t1: Infinity, label });
  }

  /** Freeze a node for dur seconds. It does nothing and handles no messages meanwhile. */
  pause(id, dur, label = "paused", then = null) {
    const n = this.nodes[id];
    n.state = "paused";
    this.spans.push({ node: id, kind: "pause", t0: this.now, t1: this.now + dur, label });
    this.after(dur, () => {
      n.state = "up";
      for (const m of n.inbox.splice(0)) this._handle(n, m);
      then?.(this);
    });
  }

  run(until = Infinity) {
    while (this.queue.length) {
      this.queue.sort((a, b) => a.t - b.t || a.seq - b.seq);
      if (this.queue[0].t > until) break;
      const ev = this.queue.shift();
      this.now = ev.t;
      ev.fn(this);
    }
    return this;
  }

  trace(extra = {}) {
    return {
      nodes: Object.values(this.nodes).map(({ id, label }) => ({ id, label })),
      msgs: this.msgs, events: this.events, spans: this.spans, ...extra,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Clocks                                                              */
/* ------------------------------------------------------------------ */

/**
 * A time-of-day clock. offset: error at t = 0 (seconds). drift: seconds gained per
 * second of true time (0.01 means 10 ms fast every second). syncs: [{ t, residual }]
 * means NTP stepped the clock at true time t to t + residual.
 * mono(t) is the matching monotonic clock: it drifts too, but syncs never step it.
 */
export function makeClock({ offset = 0, drift = 0, syncs = [] } = {}) {
  const ss = [...syncs].sort((a, b) => a.t - b.t);
  const read = (t, inclusive = true) => {
    let base = 0, val = offset;
    for (const s of ss) {
      if (s.t > t || (!inclusive && s.t === t)) break;
      base = s.t;
      val = s.t + s.residual;
    }
    return val + (t - base) * (1 + drift);
  };
  const mono = (t) => t * (1 + drift);
  const jumps = ss.map((s) => ({ t: s.t, from: read(s.t, false), to: read(s.t, true) }));
  return { read, mono, jumps, offset, drift };
}

/* ------------------------------------------------------------------ */
/* Lesson 1: the six fates of a request                                */
/* ------------------------------------------------------------------ */

export const FATES = [
  { id: "req-lost", label: "Request lost" },
  { id: "req-delayed", label: "Request delayed" },
  { id: "server-crash", label: "Server crashed" },
  { id: "server-pause", label: "Server paused" },
  { id: "resp-lost", label: "Response lost" },
  { id: "resp-delayed", label: "Response delayed" },
];

export function requestFate(fate, { timeout = 1.0 } = {}) {
  const sim = new Sim(7);
  const D = 0.25, SEND = 0.1, END = 2.6;
  let gotResponse = false, executed = false, reached = false;

  sim.addNode("client", {
    label: "Client",
    onMessage: (s, m) => {
      gotResponse = true;
      const late = s.now > SEND + timeout;
      s.log("client", late ? "late response" : "response", { kind: late ? "late" : "ok", pos: "above" });
    },
  });
  sim.addNode("server", {
    label: "Server",
    onMessage: (s, m) => {
      reached = true;
      executed = true;
      s.log("server", "executes", { kind: "work", pos: "below" });
      s.after(0.12, () => s.send("server", "client", "response", {
        delay: fate === "resp-delayed" ? 1.55 : D,
        lost: fate === "resp-lost",
        cls: fate === "resp-lost" || fate === "resp-delayed" ? "bad" : "",
      }));
    },
  });

  sim.at(SEND, (s) => {
    s.log("client", "sends", { kind: "send", pos: "above" });
    s.send("client", "server", "request", {
      delay: fate === "req-delayed" ? 1.7 : D,
      lost: fate === "req-lost",
      cls: fate === "req-lost" || fate === "req-delayed" ? "bad" : "",
    });
    s.after(timeout, () => {
      if (!gotResponse) s.log("client", "gives up", { kind: "timeout", pos: "above" });
    });
  });
  if (fate === "server-crash") sim.at(0.22, (s) => s.crash("server"));
  if (fate === "server-pause") sim.at(0.2, (s) => s.pause("server", 1.35, "paused (GC)"));

  sim.run(END);
  const req = sim.msgs[0];
  if (req.status === "dropped") reached = true;
  return sim.trace({
    t0: 0, t1: END, fate, timeoutAt: SEND + timeout,
    reached, executed, gotResponse,
    lateResponse: gotResponse && sim.events.some((e) => e.kind === "late"),
  });
}

/* ------------------------------------------------------------------ */
/* Lesson 1: timeouts against a realistic round-trip distribution      */
/* ------------------------------------------------------------------ */

/**
 * One ping round trip in seconds. Most are about a millisecond and a half; some wait in
 * switch or OS queues (more with congestion); a few hit a TCP retransmission timeout;
 * a very few land on a remote process that is paused.
 */
export function sampleRtt(rand, congestion = 0.3) {
  let v = Math.exp(Math.log(0.0015) + 0.45 * normal(rand));
  if (rand() < 0.01 + 0.14 * congestion) v += Math.exp(Math.log(0.02 + 0.1 * congestion) + 0.9 * normal(rand));
  if (rand() < 0.002 + 0.01 * congestion) v += 0.2 * 2 ** Math.floor(rand() * 3);
  if (rand() < 0.0015) v += 0.3 + rand() * 2.2;
  return v;
}

const rttCache = new Map();
export function rttSamples(congestion, n = 6000, seed = 5) {
  const key = `${congestion}:${n}:${seed}`;
  if (!rttCache.has(key)) {
    const r = rng(seed);
    rttCache.set(key, Float64Array.from({ length: n }, () => sampleRtt(r, congestion)));
  }
  return rttCache.get(key);
}

export function quantile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/**
 * A detector pings a node once per interval and declares it dead when a ping gets no
 * reply within the timeout. Healthy run: every ping slower than the timeout is a false
 * alarm. Crash runs: a crash at a random moment is noticed when the first ping that the
 * dead node can no longer answer times out.
 */
export function timeoutExperiment({ timeout, congestion = 0.3, interval = 1, crashes = 500, seed = 5 }) {
  const samples = rttSamples(congestion, 6000, seed);
  let falseAlarms = 0;
  for (const v of samples) if (v > timeout) falseAlarms++;
  const sorted = Float64Array.from(samples).sort();

  const r = rng(seed + 101);
  let total = 0, worst = 0;
  for (let k = 0; k < crashes; k++) {
    const c = 5 * interval + r() * interval; // crash moment
    let detectedAt = Infinity;
    for (let i = 0; i < 20; i++) {
      const s = i * interval;
      const rtt = sampleRtt(r, congestion);
      // The node answers half way through the round trip; after the crash it cannot.
      if (s + rtt / 2 >= c) { detectedAt = s + timeout; break; }
    }
    const d = Math.max(0, detectedAt - c);
    total += d;
    worst = Math.max(worst, d);
  }
  return {
    samples, sorted,
    pings: samples.length,
    falseAlarms,
    falseRate: falseAlarms / samples.length,
    falsePerHour: (falseAlarms / samples.length) * (3600 / interval),
    detectMean: total / crashes,
    detectWorst: worst,
    p50: quantile(sorted, 0.5), p99: quantile(sorted, 0.99), p999: quantile(sorted, 0.999), max: sorted[sorted.length - 1],
  };
}

/* ------------------------------------------------------------------ */
/* Lesson 2: last write wins with drifting clocks                      */
/* ------------------------------------------------------------------ */

export const LWW_SYNC_AT = 4;

export function lwwClocks({ skew = 0.3, drift = 0.01, ntp = false }) {
  const s = (res) => (ntp ? [{ t: LWW_SYNC_AT, residual: res }] : []);
  return {
    A: makeClock({ offset: 0.02, drift: 0, syncs: s(0.002) }),
    B: makeClock({ offset: skew / 2, drift, syncs: s(-0.006) }),
    C: makeClock({ offset: -skew / 2, drift: -drift, syncs: s(0.004) }),
  };
}

/**
 * Priya sets the hallway thermostat on node B; a little later Tomas sets it on node C.
 * Each write carries a timestamp from the local time-of-day clock, replicates to the
 * other nodes, and every node keeps the value with the highest timestamp.
 */
export function lwwScenario({ skew = 0.3, drift = 0.01, gap = 0.2, ntp = false, t1 = 6 } = {}) {
  const clocks = lwwClocks({ skew, drift, ntp });
  const sim = new Sim(3);
  const store = {};
  const names = { A: "Node A", B: "Node B", C: "Node C" };
  const order = { A: 0, B: 1, C: 2 };
  const apply = (s, node, w, from) => {
    const cur = store[node];
    const wins = w.ts > cur.ts || (w.ts === cur.ts && w.node > cur.node);
    if (wins) store[node] = w;
    if (!from) return; // a local write is shown by its own marker
    // Put the label on the side away from the incoming arrow.
    s.log(node, wins ? `gets ${w.value}°, keeps it` : `gets ${w.value}°, ignores it`,
      { kind: wins ? "ok" : "drop", pos: order[from] < order[node] ? "below" : "above" });
  };
  for (const id of ["A", "B", "C"]) {
    store[id] = { value: 21, ts: 0, who: "earlier", node: "-" };
    sim.addNode(id, { label: names[id], clock: clocks[id], onMessage: (s, m) => apply(s, id, m.data, m.from) });
  }
  const writes = [];
  const write = (node, who, value, delays, pos) => (s) => {
    const w = { who, node, value, t: s.now, ts: s.clockOf(node) };
    writes.push(w);
    s.log(node, `${who} sets ${value}°`, { kind: "write", pos, align: "left", stamp: w.ts });
    apply(s, node, w, null);
    for (const [to, d] of delays) s.send(node, to, "", { delay: d, data: w, cls: who === "Tomas" ? "alt" : "" });
  };
  sim.at(t1, write("B", "Priya", 19, [["A", 0.22], ["C", 0.3]], "above"));
  sim.at(t1 + gap, write("C", "Tomas", 23, [["A", 0.26], ["B", 0.34]], "below"));
  sim.run();

  const [p, t] = writes;
  const realLater = t; // Tomas always writes after Priya in true time (gap >= 0)
  const winner = p.ts > t.ts ? p : t;
  const final = Object.fromEntries(Object.entries(store).map(([k, v]) => [k, v.value]));
  const converged = new Set(Object.values(final)).size === 1;
  return sim.trace({
    t0: t1 - 0.25, t1: t1 + gap + 0.75, clocks, writes, winner, realLater,
    anomaly: winner !== realLater, final, converged,
  });
}

/* ------------------------------------------------------------------ */
/* Lesson 2: a leader with a lease pauses mid-request                  */
/* ------------------------------------------------------------------ */

export function leaseScenario({ pause = 4, lease = 10 } = {}) {
  const sim = new Sim(11);
  const L = { holder: null, expires: 0 };
  const leaseEnd = 0.2 + lease; // node-1's lease, as the lease service sees it
  let storage = "plan 0";
  const storageLog = [];
  const CHECK = 7.4, PAUSE_AT = 7.5, N2_RETRY = 10.3;

  sim.addNode("n1", { label: "node-1", onMessage: (s, m) => {
    if (m.label === "granted") s.log("n1", `leader until ${lease.toFixed(1)} s`, { kind: "ok", pos: "above" });
    if (m.label === "refused") s.log("n1", "learns it lost the lease", { kind: "drop", pos: "above" });
    if (m.label === "renewed") s.log("n1", "lease renewed", { kind: "ok", pos: "above" });
  } });
  sim.addNode("ls", { label: "lease service", onMessage: (s, m) => {
    const expired = s.now >= L.expires;
    if (m.label === "acquire") {
      if (!L.holder || expired) {
        const takeover = L.holder && L.holder !== m.from;
        L.holder = m.from; L.expires = s.now + lease;
        s.send("ls", m.from, "granted", { delay: 0.2 });
        if (takeover) s.log("ls", "grants node-2", { kind: "check", pos: "below" });
      } else {
        s.send("ls", m.from, "busy", { delay: 0.2, cls: "muted" });
      }
    }
    if (m.label === "renew") {
      if (L.holder === m.from && !expired) { L.expires = s.now + lease; s.send("ls", m.from, "renewed", { delay: 0.2 }); }
      else s.send("ls", m.from, "refused", { delay: 0.2, cls: "bad" });
    }
  } });
  sim.addNode("n2", { label: "node-2", onMessage: (s, m) => {
    if (m.label === "granted") {
      s.log("n2", "now the leader", { kind: "ok", pos: "above" });
      s.after(0.5, (s2) => s2.send("n2", "st", "plan B", { delay: 0.2, data: "plan B", cls: "alt" }));
    }
  } });
  sim.addNode("st", { label: "storage", onMessage: (s, m) => {
    const stale = m.from === "n1" && s.now >= leaseEnd;
    storage = m.data;
    storageLog.push({ t: s.now, from: m.from, value: storage, stale });
    s.log("st", `holds ${storage}`, { kind: stale ? "drop" : "ok", pos: "below" });
  } });

  const n1Write = (s) => s.send("n1", "st", "plan A", { delay: 0.2, data: "plan A", cls: s.now >= leaseEnd ? "bad" : "" });
  const n1Renew = (s) => s.send("n1", "ls", "renew", { delay: 0.2 });
  sim.at(0, (s) => s.send("n1", "ls", "acquire", { delay: 0.2 }));
  sim.at(8.6, (s) => s.send("n2", "ls", "acquire", { delay: 0.2 }));
  sim.at(N2_RETRY, (s) => s.send("n2", "ls", "acquire", { delay: 0.2 }));
  sim.at(CHECK, (s) => s.log("n1", `checks: ${(lease - CHECK).toFixed(1)} s left`, { kind: "check", pos: "above" }));
  sim.at(PAUSE_AT, (s) => {
    if (pause <= 0) { n1Write(s); s.after(0.4, n1Renew); return; }
    s.pause("n1", pause, "paused", (s2) => { n1Write(s2); s2.after(0.4, n1Renew); });
  });
  sim.run(60);

  const w1 = storageLog.find((w) => w.from === "n1");
  const w2 = storageLog.find((w) => w.from === "n2");
  let outcome;
  if (!w1.stale) outcome = "safe";
  else if (!w2 || w1.t < w2.t) outcome = "overlap";
  else outcome = "clobbered";
  const end = Math.max(14, ...sim.msgs.map((m) => m.recv ?? 0)) + 0.8;
  return sim.trace({ t0: 6.5, t1: end, leaseEnd, outcome, storage, storageLog, pauseAt: PAUSE_AT, resumeAt: PAUSE_AT + pause, tookOver: !!w2 });
}

/* ------------------------------------------------------------------ */
/* Lesson 3: a lock with a lease, a storage service, fencing tokens    */
/* ------------------------------------------------------------------ */

export function fencingScenario({ pause = 7.5, fencing = false, lease = 6 } = {}) {
  const sim = new Sim(13);
  const lock = { holder: null, expires: 0, token: 32 };
  const st = { maxToken: 0, value: "nothing yet", history: [] };
  const PAUSE_AT = 1.4;
  const D = 0.3; // one-way network delay
  const leaseEnd = 0.2 + D + lease; // client 1's lease, as the lock service sees it

  sim.addNode("c1", { label: "client 1", onMessage: (s, m) => {
    if (m.label.startsWith("ok")) s.log("c1", `holds lock (token ${m.data.token})`, { kind: "ok", pos: "above" });
    if (m.label.startsWith("rejected")) s.log("c1", "write refused", { kind: "drop", pos: "above" });
  } });
  sim.addNode("ls", { label: "lock service", onMessage: (s, m) => {
    if (m.label === "acquire") {
      const free = !lock.holder || s.now >= lock.expires;
      if (free) {
        lock.holder = m.from; lock.expires = s.now + lease; lock.token += 1;
        s.send("ls", m.from, fencing ? `ok, token ${lock.token}` : "ok", { delay: D, data: { token: lock.token } });
        if (m.from === "c2") s.log("ls", fencing ? `grants token ${lock.token}` : "grants client 2", { kind: "check", pos: "below" });
      } else {
        s.send("ls", m.from, "busy", { delay: D, cls: "muted" });
      }
    }
  } });
  sim.addNode("c2", { label: "client 2", onMessage: (s, m) => {
    if (m.label.startsWith("ok")) {
      s.log("c2", `holds lock (token ${m.data.token})`, { kind: "ok", pos: "above" });
      s.after(0.3, (s2) => s2.send("c2", "st", fencing ? `write, token ${m.data.token}` : "write", { delay: D, data: { token: m.data.token, who: "client 2" }, cls: "alt" }));
    }
  } });
  sim.addNode("st", { label: "storage", onMessage: (s, m) => {
    const { token, who } = m.data;
    const ok = !fencing || token >= st.maxToken;
    if (ok) {
      st.maxToken = Math.max(st.maxToken, token);
      st.value = `edit by ${who}`;
      st.history.push({ t: s.now, who, token, accepted: true });
      s.log("st", fencing ? `stores, token ${token}` : `stores edit from ${who}`, { kind: who === "client 1" && s.now >= leaseEnd ? "drop" : "ok", pos: "below" });
    } else {
      st.history.push({ t: s.now, who, token, accepted: false });
      s.log("st", `rejects token ${token} (has seen ${st.maxToken})`, { kind: "check", pos: "below" });
      s.send("st", m.from, "rejected", { delay: D, cls: "bad" });
    }
  } });

  sim.at(0.2, (s) => s.send("c1", "ls", "acquire", { delay: D }));
  sim.at(PAUSE_AT, (s) => {
    const go = (s2) => s2.send("c1", "st", fencing ? "write, token 33" : "write", { delay: D, data: { token: 33, who: "client 1" }, cls: s2.now + D >= leaseEnd ? "bad" : "" });
    if (pause <= 0) go(s);
    else s.pause("c1", pause, "paused", go);
  });
  sim.at(3, (s) => s.send("c2", "ls", "acquire", { delay: D }));
  sim.at(leaseEnd + 0.3, (s) => s.send("c2", "ls", "acquire", { delay: D }));
  sim.run(60);

  const c1 = st.history.find((h) => h.who === "client 1");
  const c2 = st.history.find((h) => h.who === "client 2");
  let outcome;
  if (c1.t < leaseEnd) outcome = "safe";
  else if (!c1.accepted) outcome = "fenced";
  else if (c1.t > c2.t) outcome = "corrupted";
  else outcome = "late-but-ordered";
  const end = Math.max(9.5, ...sim.msgs.map((m) => m.recv ?? 0)) + 0.6;
  return sim.trace({ t0: 0, t1: end, leaseEnd, outcome, final: st.value, history: st.history, resumeAt: PAUSE_AT + pause });
}

/* ------------------------------------------------------------------ */
/* Lesson 3: safety versus liveness                                    */
/* ------------------------------------------------------------------ */

// Each trace runs on a 0..120 time axis. "end" is where the trace stops being recorded:
// Infinity means it continues past the right edge.
export const PROPERTY_TRACES = [
  {
    id: "mutex", kind: "safety", text: "No two clients hold the lock at the same time",
    bars: [{ from: 10, to: 52, label: "client 1 holds", lane: 0 }, { from: 40, to: 88, label: "client 2 holds", lane: 1 }],
    violatedAt: 40, why: "both hold the lock",
  },
  {
    id: "tokens", kind: "safety", text: "Fencing tokens only ever increase",
    points: [{ t: 12, label: "33" }, { t: 38, label: "34" }, { t: 66, label: "34" }, { t: 96, label: "35" }],
    violatedAt: 66, why: "token 34 issued twice",
  },
  {
    id: "answer", kind: "liveness", text: "Every lock request is eventually answered",
    points: [{ t: 18, label: "request" }],
    satisfiedAt: 112, pendingFrom: 18, why: "answered at 112",
  },
  {
    id: "detect", kind: "liveness", text: "A crashed node is eventually suspected",
    points: [{ t: 30, label: "crash" }],
    satisfiedAt: Infinity, pendingFrom: 30, why: "never suspected",
  },
];

/** Status of a property after observing the trace up to time t. */
export function propertyStatus(p, t) {
  if (p.kind === "safety") {
    return t >= p.violatedAt ? { state: "violated", at: p.violatedAt } : { state: "holds" };
  }
  if (t < p.pendingFrom) return { state: "holds" };
  if (t >= p.satisfiedAt) return { state: "satisfied", at: p.satisfiedAt };
  return { state: "pending", since: p.pendingFrom };
}
