// Chapter 7: a tiny multi-version key-value store that runs interleaved
// transactions under different isolation levels. DOM-free.
//
// Programs are arrays of ops:
//   { op: "read",  key, as, forUpdate? }
//   { op: "scan",  prefix, where?(value, key), as, forUpdate?, label? }
//   { op: "write", key, value (constant or fn(locals)), if?(locals), skip? }
//   { op: "insert", key, value, if?(locals) }      fails on an existing key (unique index)
//   { op: "inc",   key, by }                        atomic read-modify-write
//   { op: "commit" } | { op: "abort", why? }
// Every op may carry a `label` shown before it runs.

import { rng } from "../charts.js";

export const SETUP_TXID = 90;

export const LEVELS = {
  none: { label: "No isolation", read: "latest", writeLocks: false },
  ru: { label: "Read uncommitted", read: "latest", writeLocks: true },
  rc: { label: "Read committed", read: "committed", writeLocks: true },
  si: { label: "Snapshot isolation", read: "snapshot", writeLocks: true, detectLost: true, mvcc: true },
  "si-mysql": { label: "Snapshot isolation, no lost-update check", read: "snapshot", writeLocks: true, detectLost: false, mvcc: true },
  "2pl": { label: "Two-phase locking", read: "committed", writeLocks: true, readLocks: true, predLocks: true },
  ssi: { label: "Serializable snapshot isolation", read: "snapshot", writeLocks: true, detectLost: true, ssi: true, mvcc: true },
};

export const short = (k) => String(k).slice(String(k).lastIndexOf(":") + 1);

export function fmtv(v) {
  if (v === null || v === undefined) return "none";
  if (Array.isArray(v)) return v.length ? `${v.length} (${v.map(short).join(", ")})` : "0";
  return String(v);
}

export function defaultLabel(op) {
  switch (op.op) {
    case "read": return `${op.forUpdate ? "read for update" : "read"} ${op.key}`;
    case "scan": return `${op.forUpdate ? "scan for update" : "scan"} ${op.prefix}*`;
    case "write": return `write ${op.key}`;
    case "insert": return `insert ${op.key}`;
    case "inc": return `${op.key} ${op.by < 0 ? "−" : "+"}= ${Math.abs(op.by)} (atomic)`;
    case "commit": return "commit";
    case "abort": return "abort";
  }
  return op.op;
}

export class TxnDB {
  constructor({ initial = {}, level = "rc", firstTxid = SETUP_TXID + 1 } = {}) {
    this.level = level;
    this.L = LEVELS[level];
    this.seq = 0;
    this.vid = 0;
    this.nextTxid = firstTxid;
    this.versions = new Map();
    this.txns = [];
    this.byTxid = new Map();
    this.locks = new Map();          // key -> { S: Set<i>, X: i | null }
    this.preds = [];                 // 2PL predicate (index-range) locks: { tx, prefix }
    this.readers = new Map();        // SSI: key -> Set<i>
    this.predReaders = [];           // SSI: { tx, prefix }
    this.waiting = [];               // indices of waiting transactions, FIFO
    this.wal = [];
    this.events = [];
    this.lastDeadlock = null;
    for (const [k, v] of Object.entries(initial)) this.versions.set(k, [{ id: ++this.vid, value: v, by: SETUP_TXID, xmax: null, aborted: false }]);
  }

  addTxn(name, ops, role = "") {
    const i = this.txns.length;
    this.txns.push({ i, name, role, ops, pc: 0, status: "idle", txid: null, startSeq: null, commitSeq: null,
      locals: {}, reads: [], results: [], held: new Set(), writes: new Set(), waitFor: null, waitRes: null,
      out: new Map(), inn: new Map(), reason: null, kind: null });
    return i;
  }

  // ---------- status helpers ----------
  tx(txid) { return this.byTxid.get(txid) || null; }
  committedSeq(txid) {
    if (txid === SETUP_TXID) return -1;
    const t = this.tx(txid);
    return t && t.status === "committed" ? t.commitSeq : null;
  }
  runnable(i) { const t = this.txns[i]; return (t.status === "idle" || t.status === "active") && t.pc < t.ops.length; }
  finished() { return this.txns.every((t) => t.status === "committed" || t.status === "aborted"); }
  begun(t) { return t.status !== "idle"; }
  live(t) { return t.status === "active" || t.status === "waiting"; }

  /** The version a transaction would read. mode: latest | committed | snapshot */
  visible(t, key, mode) {
    const vs = this.versions.get(key);
    if (!vs) return null;
    for (let j = vs.length - 1; j >= 0; j--) {
      const v = vs[j];
      if (v.aborted) continue;
      if (t && t.txid !== null && v.by === t.txid) return v;
      if (mode === "latest") return v;
      const cs = this.committedSeq(v.by);
      if (cs === null) continue;
      if (mode === "committed") return v;
      if (cs < t.startSeq) return v;
    }
    return null;
  }
  value(t, key, mode) { const v = this.visible(t, key, mode); return v ? v.value : null; }

  /** Committed state: key -> value (absent keys omitted). */
  state() {
    const s = {};
    for (const k of [...this.versions.keys()].sort()) { const v = this.value(null, k, "committed"); if (v !== null) s[k] = v; }
    return s;
  }

  keysWithPrefix(prefix) { return [...this.versions.keys()].filter((k) => k.startsWith(prefix)).sort(); }

  /** A version of key written by a transaction that committed after t began. */
  concurrentWriter(t, key) {
    const vs = this.versions.get(key) || [];
    for (let j = vs.length - 1; j >= 0; j--) {
      const v = vs[j];
      if (v.aborted || v.by === t.txid) continue;
      const cs = this.committedSeq(v.by);
      if (cs === null) continue;
      if (cs > t.startSeq) return this.tx(v.by);
      return null;
    }
    return null;
  }

  // ---------- locks ----------
  lockOf(key) { let l = this.locks.get(key); if (!l) { l = { S: new Set(), X: null }; this.locks.set(key, l); } return l; }
  blockersX(t, key) {
    const out = new Set();
    const l = this.locks.get(key);
    if (l) { if (l.X !== null && l.X !== t.i) out.add(l.X); for (const s of l.S) if (s !== t.i) out.add(s); }
    if (this.L.predLocks) for (const p of this.preds) if (p.tx !== t.i && key.startsWith(p.prefix)) out.add(p.tx);
    return [...out];
  }
  blockersS(t, key) { const l = this.locks.get(key); return l && l.X !== null && l.X !== t.i ? [l.X] : []; }
  blockersPred(t, prefix) {
    const out = new Set();
    for (const [k, l] of this.locks) if (k.startsWith(prefix) && l.X !== null && l.X !== t.i) out.add(l.X);
    return [...out];
  }
  grantX(t, key) { this.lockOf(key).X = t.i; t.held.add(key); }
  grantS(t, key) { this.lockOf(key).S.add(t.i); t.held.add(key); }
  grantPred(t, prefix) { if (!this.preds.some((p) => p.tx === t.i && p.prefix === prefix)) this.preds.push({ tx: t.i, prefix }); }
  release(t) {
    for (const k of t.held) {
      const l = this.locks.get(k);
      if (!l) continue;
      l.S.delete(t.i);
      if (l.X === t.i) l.X = null;
      if (!l.S.size && l.X === null) this.locks.delete(k);
    }
    t.held.clear();
    this.preds = this.preds.filter((p) => p.tx !== t.i);
  }

  /** Rows for a lock-table view. */
  lockTable() {
    const rows = [];
    for (const [k, l] of [...this.locks].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (l.X !== null) rows.push({ res: k, mode: "exclusive", holders: [l.X] });
      const s = [...l.S].filter((i) => i !== l.X);
      if (s.length) rows.push({ res: k, mode: "shared", holders: s });
    }
    const byPrefix = new Map();
    for (const p of this.preds) { if (!byPrefix.has(p.prefix)) byPrefix.set(p.prefix, []); byPrefix.get(p.prefix).push(p.tx); }
    for (const [prefix, h] of byPrefix) rows.push({ res: prefix + "*", mode: "shared range", holders: h });
    for (const r of rows) r.waiters = this.waiting.filter((w) => {
      const t = this.txns[w];
      if (!t.waitFor.some((h) => r.holders.includes(h))) return false;
      if (r.res.endsWith("*")) return t.waitRes.startsWith(r.res.slice(0, -1));
      if (t.waitRes.endsWith("*")) return r.res.startsWith(t.waitRes.slice(0, -1));
      return t.waitRes === r.res;
    });
    return rows;
  }
  waitEdges() {
    const e = [];
    for (const w of this.waiting) for (const h of this.txns[w].waitFor || []) e.push({ from: w, to: h, res: this.txns[w].waitRes });
    return e;
  }
  rwEdges() {
    const e = [];
    for (const t of this.txns) if (t.status !== "aborted") for (const [w, key] of t.out) if (this.txns[w].status !== "aborted") e.push({ from: t.i, to: w, key });
    return e;
  }

  // ---------- SSI bookkeeping ----------
  concurrent(a, b) {
    if (!this.begun(a) || !this.begun(b)) return false;
    if (a.status === "committed" && a.commitSeq < b.startSeq) return false;
    if (b.status === "committed" && b.commitSeq < a.startSeq) return false;
    return true;
  }
  addEdge(r, w, key) {
    if (r === w || r.status === "aborted" || w.status === "aborted") return;
    if (!r.out.has(w.i)) r.out.set(w.i, key);
    if (!w.inn.has(r.i)) w.inn.set(r.i, key);
  }
  noteRead(t, key) {
    let set = this.readers.get(key);
    if (!set) { set = new Set(); this.readers.set(key, set); }
    set.add(t.i);
    // Writers whose versions t cannot see: their write happened "after" t's read.
    const vs = this.versions.get(key) || [];
    for (let j = vs.length - 1; j >= 0; j--) {
      const v = vs[j];
      if (v.aborted || v.by === t.txid || v.by === SETUP_TXID) { if (v.by === SETUP_TXID) break; continue; }
      const w = this.tx(v.by);
      if (w.status === "committed" && w.commitSeq < t.startSeq) break;
      this.addEdge(t, w, key);
    }
  }
  noteScan(t, prefix) {
    this.predReaders.push({ tx: t.i, prefix });
    for (const k of this.keysWithPrefix(prefix)) {
      const vs = this.versions.get(k);
      for (let j = vs.length - 1; j >= 0; j--) {
        const v = vs[j];
        if (v.by === SETUP_TXID) break;
        if (v.aborted || v.by === t.txid) continue;
        const w = this.tx(v.by);
        if (w.status === "committed" && w.commitSeq < t.startSeq) break;
        this.addEdge(t, w, k);
      }
    }
  }
  noteWrite(t, key) {
    const set = this.readers.get(key);
    if (set) for (const r of [...set]) {
      const R = this.txns[r];
      if (R.status === "aborted" || (R.status === "committed" && R.commitSeq < t.startSeq)) { set.delete(r); continue; }
      if (this.concurrent(R, t)) this.addEdge(R, t, key);
    }
    for (const p of this.predReaders) {
      const R = this.txns[p.tx];
      if (key.startsWith(p.prefix) && R.status !== "aborted" && this.concurrent(R, t)) this.addEdge(R, t, key);
    }
  }
  /** Returns an abort reason if committing t would complete a dangerous structure. */
  ssiCheck(t) {
    const committed = (i) => this.txns[i].status === "committed";
    const outC = [...t.out].filter(([w]) => committed(w));
    const inn = [...t.inn].filter(([r]) => this.txns[r].status !== "aborted");
    if (inn.length && outC.length) {
      const [r, k1] = inn[0], [w, k2] = outC[0];
      return { kind: "ssi", pivot: t.i, from: r, to: w, keys: [k1, k2],
        text: `${this.txns[r].name} → ${t.name} → ${this.txns[w].name}: ${this.txns[r].name} read ${k1} before ${t.name} wrote it, and ${t.name} read ${k2} before ${this.txns[w].name} wrote it. ${this.txns[w].name} has committed, so ${t.name} aborts.` };
    }
    for (const [p, k1] of outC) {
      for (const [x, k2] of this.txns[p].out) {
        if (x !== t.i && committed(x)) {
          return { kind: "ssi", pivot: p, from: t.i, to: x, keys: [k1, k2],
            text: `${t.name} → ${this.txns[p].name} → ${this.txns[x].name}: both of the others have committed with read-write conflicts that only make sense if ${t.name} ran first, but ${t.name} read stale data, so it aborts.` };
        }
      }
    }
    return null;
  }

  // ---------- writes and lifecycle ----------
  writeVersion(t, key, value) {
    let vs = this.versions.get(key);
    if (!vs) { vs = []; this.versions.set(key, vs); }
    let head = null;
    for (let j = vs.length - 1; j >= 0; j--) if (!vs[j].aborted) { head = vs[j]; break; }
    const before = head ? head.value : null;
    if (head && head.by === t.txid) head.value = value;
    else {
      if (head) head.xmax = t.txid;
      vs.push({ id: ++this.vid, value, by: t.txid, xmax: null, aborted: false });
    }
    t.writes.add(key);
    this.wal.push({ type: "update", txid: t.txid, key, before, after: value });
  }
  begin(t) {
    t.txid = this.nextTxid++;
    t.startSeq = ++this.seq;
    t.status = "active";
    this.byTxid.set(t.txid, t);
    this.wal.push({ type: "begin", txid: t.txid });
  }
  finish(t, ok, reason = null, kind = null) {
    if (ok) { t.status = "committed"; t.commitSeq = ++this.seq; this.wal.push({ type: "commit", txid: t.txid }); }
    else {
      t.status = "aborted"; t.reason = reason; t.kind = kind;
      for (const k of t.writes) for (const v of this.versions.get(k)) {
        if (v.by === t.txid) v.aborted = true;
        if (v.xmax === t.txid) v.xmax = null;
      }
      if (t.txid !== null) this.wal.push({ type: "abort", txid: t.txid });
    }
    this.waiting = this.waiting.filter((w) => w !== t.i);
    t.waitFor = null; t.waitRes = null;
    this.release(t);
  }

  // ---------- executing one op ----------
  attempt(t, op) {
    const L = this.L, loc = t.locals;
    const done = (text, extra = {}) => ({ kind: "done", text, ...extra });
    const wait = (on, res, mode) => ({ kind: "wait", on, res, mode });
    const lost = (w, key) => ({ kind: "abort", why: "lost", text: `could not serialize: ${w.name} changed ${key} after ${t.name}'s snapshot was taken` });
    const label = op.label || defaultLabel(op);
    switch (op.op) {
      case "read": {
        if (op.forUpdate && L.writeLocks) { const b = this.blockersX(t, op.key); if (b.length) return wait(b, op.key, "X"); this.grantX(t, op.key); }
        else if (L.readLocks) { const b = this.blockersS(t, op.key); if (b.length) return wait(b, op.key, "S"); this.grantS(t, op.key); }
        let mode = L.read;
        if (op.forUpdate) {
          if (L.detectLost) { const w = this.concurrentWriter(t, op.key); if (w) return lost(w, op.key); }
          if (mode === "snapshot") mode = "committed";
        }
        const val = this.value(t, op.key, mode);
        if (L.ssi) this.noteRead(t, op.key);
        if (op.as) loc[op.as] = val;
        t.reads.push(val);
        return done(`${label} → ${fmtv(val)}`);
      }
      case "scan": {
        if (L.predLocks) { const b = this.blockersPred(t, op.prefix); if (b.length) return wait(b, op.prefix + "*", "S"); this.grantPred(t, op.prefix); }
        const keys = this.keysWithPrefix(op.prefix);
        const match = (k, mode) => { const v = this.value(t, k, mode); return v !== null && (!op.where || op.where(v, k)); };
        let mode = L.read;
        if (op.forUpdate && L.writeLocks) {
          const m = keys.filter((k) => match(k, L.read === "latest" ? "latest" : "committed") || (L.detectLost && match(k, "snapshot")));
          for (const k of m) { const b = this.blockersX(t, k); if (b.length) return wait(b, k, "X"); this.grantX(t, k); }
          if (L.detectLost) for (const k of m) { const w = this.concurrentWriter(t, k); if (w) return lost(w, k); }
          if (mode === "snapshot") mode = "committed";
        }
        const res = keys.filter((k) => match(k, mode));
        if (L.ssi) this.noteScan(t, op.prefix);
        if (op.as) loc[op.as] = res;
        t.reads.push(res);
        return done(`${label} → ${fmtv(res)}`);
      }
      case "write":
      case "insert": {
        if (op.if && !op.if(loc)) return done(op.skip || `${label}: skipped`, { skip: true });
        if (L.writeLocks) { const b = this.blockersX(t, op.key); if (b.length) return wait(b, op.key, "X"); this.grantX(t, op.key); }
        if (L.detectLost) { const w = this.concurrentWriter(t, op.key); if (w) return op.op === "insert" ? { kind: "abort", why: "unique", text: `duplicate key: ${op.key} was inserted by ${w.name}` } : lost(w, op.key); }
        if (op.op === "insert") {
          const cur = this.value(t, op.key, L.read === "latest" ? "latest" : "committed");
          if (cur !== null) return { kind: "abort", why: "unique", text: `duplicate key: ${op.key} already exists` };
        }
        const val = typeof op.value === "function" ? op.value(loc) : op.value;
        this.writeVersion(t, op.key, val);
        if (L.ssi) this.noteWrite(t, op.key);
        return done(`${label} = ${fmtv(val)}`);
      }
      case "inc": {
        if (L.writeLocks) { const b = this.blockersX(t, op.key); if (b.length) return wait(b, op.key, "X"); this.grantX(t, op.key); }
        if (L.detectLost) { const w = this.concurrentWriter(t, op.key); if (w) return lost(w, op.key); }
        const cur = this.value(t, op.key, L.read === "latest" ? "latest" : "committed") ?? 0;
        const val = cur + op.by;
        if (L.ssi) this.noteRead(t, op.key);
        this.writeVersion(t, op.key, val);
        if (L.ssi) this.noteWrite(t, op.key);
        return done(`${label} → ${val}`);
      }
      case "commit": {
        if (L.ssi) { const c = this.ssiCheck(t); if (c) return { kind: "abort", why: "ssi", text: c.text, ssi: c }; }
        this.finish(t, true);
        return done("commit");
      }
      case "abort":
        this.finish(t, false, op.why || "the application rolled back", "app");
        return done(op.why ? `abort: ${op.why}` : "abort");
    }
    throw new Error("unknown op " + op.op);
  }

  /** Describes the lock that holder h holds and that blocks a request on res. */
  lockDesc(h, res) {
    const name = this.txns[h].name;
    if (res.endsWith("*")) {
      const k = [...this.locks].find(([k, l]) => k.startsWith(res.slice(0, -1)) && l.X === h);
      return `${name} holds an exclusive lock on ${k ? k[0] : res}, inside the range it wants to read`;
    }
    const l = this.locks.get(res);
    if (l && l.X === h) return `${name} holds an exclusive lock on ${res}`;
    if (l && l.S.has(h)) return `${name} holds a shared lock on ${res}`;
    const p = this.preds.find((p) => p.tx === h && res.startsWith(p.prefix));
    if (p) return `${name} holds a range lock on ${p.prefix}*, which covers ${res}`;
    return `${name} holds a lock on ${res}`;
  }

  findCycle(start) {
    const stack = [[start, [start]]];
    const seen = new Set();
    while (stack.length) {
      const [n, path] = stack.pop();
      const t = this.txns[n];
      if (t.status !== "waiting") continue;
      for (const h of t.waitFor) {
        if (h === start) return path;
        if (!seen.has(h)) { seen.add(h); stack.push([h, [...path, h]]); }
      }
    }
    return null;
  }

  exec(t, evs, resumed) {
    const pc = t.pc;
    const op = t.ops[pc];
    const r = this.attempt(t, op);
    if (r.kind === "done") {
      t.results[pc] = { state: r.skip ? "skip" : "done", text: r.text };
      t.pc++;
      if (t.status === "waiting") { t.status = "active"; this.waiting = this.waiting.filter((w) => w !== t.i); t.waitFor = null; t.waitRes = null; }
      evs.push({ tx: t.i, kind: resumed ? "resume" : op.op === "commit" ? "commit" : op.op === "abort" ? "abort" : "op", text: `${t.name}: ${r.text}${resumed ? " (lock granted)" : ""}` });
      return;
    }
    if (r.kind === "abort") {
      t.results[pc] = { state: "abort", text: r.text };
      this.finish(t, false, r.text, r.why);
      evs.push({ tx: t.i, kind: "abort", why: r.why, ssi: r.ssi, text: `${t.name} aborts: ${r.text}` });
      return;
    }
    // wait
    const same = t.status === "waiting" && t.waitRes === r.res && String(t.waitFor) === String(r.on);
    t.status = "waiting";
    t.waitFor = r.on;
    t.waitRes = r.res;
    if (!this.waiting.includes(t.i)) this.waiting.push(t.i);
    const names = r.on.map((h) => this.txns[h].name).join(" and ");
    t.results[pc] = { state: "wait", text: `${op.label || defaultLabel(op)}: waits for ${names}` };
    const cycle = this.findCycle(t.i);
    if (cycle) {
      this.lastDeadlock = cycle.slice();
      const links = cycle.map((c, j) => `${this.txns[c].name} waits for ${this.txns[cycle[(j + 1) % cycle.length]].name}`);
      const text = `deadlock: ${links.slice(0, -1).join(", ")}${links.length > 2 ? "," : ""} and ${links[links.length - 1]}. ${t.name} is rolled back`;
      t.results[pc] = { state: "abort", text };
      this.finish(t, false, text, "deadlock");
      evs.push({ tx: t.i, kind: "deadlock", cycle, text: text[0].toUpperCase() + text.slice(1) });
      return;
    }
    if (!same) evs.push({ tx: t.i, kind: "wait", text: `${t.name} waits: ${this.lockDesc(r.on[0], r.res)}` });
  }

  wake(evs) {
    let progress = true;
    while (progress) {
      progress = false;
      for (const w of [...this.waiting]) {
        const t = this.txns[w];
        if (t.status !== "waiting") continue;
        this.exec(t, evs, true);
        if (t.status !== "waiting") { progress = true; break; }
      }
    }
  }

  /** Run the next op of transaction i. Returns the events it caused, or null if i cannot run now. */
  step(i) {
    const t = this.txns[i];
    if (!this.runnable(i)) return null;
    if (t.status === "idle") this.begin(t);
    const evs = [];
    this.exec(t, evs, false);
    this.wake(evs);
    this.events.push(...evs);
    return evs;
  }

  /** Crash: every unfinished transaction is rolled back using the log's before-images. */
  crash() {
    const undone = [];
    this.wal.push({ type: "crash" });
    for (const t of this.txns) {
      if (!this.live(t)) continue;
      const ups = this.wal.filter((e) => e.type === "update" && e.txid === t.txid).reverse();
      for (const u of ups) { undone.push(u); this.wal.push({ type: "undo", txid: t.txid, key: u.key, before: u.after, after: u.before }); }
      this.finish(t, false, "crash", "crash");
    }
    return undone;
  }
}

/** Steps through a preset interleaving, skipping transactions that are blocked or finished. */
export class Driver {
  constructor(db, order) { this.db = db; this.queue = order.slice(); }
  next() {
    const db = this.db;
    this.queue = this.queue.filter((i) => db.runnable(i) || db.txns[i].status === "waiting");
    let k = this.queue.findIndex((i) => db.runnable(i));
    if (k < 0) {
      const any = db.txns.findIndex((t, i) => db.runnable(i));
      if (any < 0) return null;
      return { tx: any, evs: db.step(any) };
    }
    const i = this.queue.splice(k, 1)[0];
    return { tx: i, evs: db.step(i) };
  }
  take(i) { const k = this.queue.indexOf(i); if (k >= 0) this.queue.splice(k, 1); }
}

function permutations(a) {
  if (a.length <= 1) return [a.slice()];
  const out = [];
  a.forEach((x, k) => { for (const p of permutations([...a.slice(0, k), ...a.slice(k + 1)])) out.push([x, ...p]); });
  return out;
}

/** Is the outcome of db one that some serial order of its committed transactions produces? */
export function serialCheck(initial, db) {
  const committed = db.txns.filter((t) => t.status === "committed").map((t) => t.i);
  const target = JSON.stringify(db.state());
  for (const order of permutations(committed)) {
    const s = new TxnDB({ initial, level: "rc" });
    const map = {};
    for (const i of order) map[i] = s.addTxn(db.txns[i].name, db.txns[i].ops);
    for (const i of order) while (s.runnable(map[i])) s.step(map[i]);
    const readsMatch = order.every((i) => JSON.stringify(s.txns[map[i]].reads) === JSON.stringify(db.txns[i].reads));
    if (readsMatch && JSON.stringify(s.state()) === target) return { ok: true, order: order.map((i) => db.txns[i].name) };
  }
  return { ok: false, order: null };
}

/**
 * Throughput simulation. `clients` clients each run transactions over `rows`
 * rows, one op per tick per client. A share of them are read-only reports that
 * read `reads` rows; the rest update one row (read it for update, read one
 * other row, write). Blocked clients idle; aborted transactions retry after a
 * short random backoff.
 */
export function simulate({ level = "2pl", rows = 16, clients = 8, ticks = 1500, reads = 4, readOnly = 0.5, seed = 7 } = {}) {
  const rand = rng(seed);
  const initial = {};
  for (let k = 0; k < rows; k++) initial["r" + k] = 0;
  const db = new TxnDB({ initial, level });
  const pick = (n) => {
    const keys = [];
    n = Math.min(n, rows);
    while (keys.length < n) { const k = "r" + Math.floor(rand() * rows); if (!keys.includes(k)) keys.push(k); }
    return keys;
  };
  const mk = () => {
    // Read-only reports always read `reads` rows (repeats allowed) so their length does not depend on `rows`.
    if (rand() < readOnly) return [...Array.from({ length: reads }, () => ({ op: "read", key: "r" + Math.floor(rand() * rows) })), { op: "commit" }];
    const [a, b] = pick(2);
    const ops = [{ op: "read", key: a, as: "a", forUpdate: true }];
    if (b) ops.push({ op: "read", key: b, as: "b" });
    ops.push({ op: "write", key: a, value: (L) => (L.a || 0) + (L.b || 0) + 1 }, { op: "commit" });
    return ops;
  };
  const cl = Array.from({ length: clients }, () => ({ tx: -1, first: 0, backoff: 0, retry: false, ops: null }));
  let commits = 0, aborts = 0, deadlocks = 0, blocked = 0, latSum = 0, worked = 0, wasted = 0;
  const lats = [];
  for (let tick = 0; tick < ticks; tick++) {
    const order = cl.map((_, c) => c);
    for (let j = order.length - 1; j > 0; j--) { const r = Math.floor(rand() * (j + 1)); [order[j], order[r]] = [order[r], order[j]]; }
    for (const c of order) {
      const C = cl[c];
      if (C.backoff > 0) { C.backoff--; continue; }
      if (C.tx < 0) {
        if (!C.retry) { C.first = tick; C.ops = mk(); }
        C.tx = db.addTxn("c" + c, C.ops);
      }
      const t = db.txns[C.tx];
      if (t.status === "waiting") { blocked++; continue; }
      if (db.runnable(C.tx)) { db.step(C.tx); worked++; }
    }
    for (const C of cl) {
      if (C.tx < 0) continue;
      const t = db.txns[C.tx];
      if (t.status === "committed") {
        commits++; const lat = tick - C.first + 1; latSum += lat; lats.push(lat);
        C.tx = -1; C.retry = false;
      } else if (t.status === "aborted") {
        aborts++; if (t.kind === "deadlock") deadlocks++;
        wasted += t.pc + 1;
        C.tx = -1; C.retry = true; C.backoff = 1 + Math.floor(rand() * 3);
      }
    }
  }
  lats.sort((a, b) => a - b);
  return {
    throughput: (commits / ticks) * 100,
    latency: commits ? latSum / commits : 0,
    p95: lats.length ? lats[Math.floor(lats.length * 0.95)] : 0,
    abortRate: aborts / Math.max(1, commits + aborts),
    blockedShare: blocked / (clients * ticks),
    wastedShare: wasted / Math.max(1, worked),
    commits, aborts, deadlocks,
  };
}
