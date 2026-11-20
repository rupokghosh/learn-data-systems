// Chapter 5: a small deterministic discrete-event simulator for replication demos.
// DOM-free. Nodes hold whatever state a protocol needs; messages travel with a
// configurable delay; a seeded random source makes every run reproducible.
// Faults: crash and recover a node, cut and heal a link.
import { rng } from "../charts.js";

export class Sim {
  /**
   * @param {object} o
   * @param {number} o.seed   seed for the random source
   * @param {number} o.delay  default one-way delay in simulated milliseconds
   * @param {number} o.jitter default random spread, as a fraction of the delay (0.2 = plus or minus 20%)
   * @param {boolean} o.fifo  messages on one directed link never overtake each other
   * @param {boolean} o.dropOnCrash  a crash also loses the node's outgoing messages still in flight
   *   (think of them as sitting in its send buffer)
   */
  constructor({ seed = 1, delay = 100, jitter = 0, fifo = true, dropOnCrash = false } = {}) {
    this.dropOnCrash = dropOnCrash;
    this.seed = seed;
    this.rand = rng(seed);
    this.t = 0;
    this.q = [];
    this.seq = 0;
    this.nodes = new Map();
    this.order = [];
    this.msgs = [];
    this.marks = [];
    this.handlers = {};
    this.delay = delay;
    this.jitter = jitter;
    this.fifo = fifo;
    this.linkDelay = new Map(); // "a>b" -> number | (sim) => number
    this.linkFree = new Map();  // "a>b" -> time the last message on this link arrives
    this.cuts = new Set();      // "a|b" (sorted) for partitioned links
    this.onCrash = null;
    this.onRecover = null;
  }

  addNode(id, state = {}) {
    const n = { id, up: true, downs: [], ...state };
    this.nodes.set(id, n);
    if (!this.order.includes(id)) this.order.push(id);
    return n;
  }
  node(id) { return this.nodes.get(id); }
  on(kind, fn) { this.handlers[kind] = fn; return this; }

  /** Set the base one-way delay for a directed link (or both directions). A function receives the sim. */
  setDelay(a, b, d, both = true) {
    const put = (k) => (d == null ? this.linkDelay.delete(k) : this.linkDelay.set(k, d));
    put(a + ">" + b);
    if (both) put(b + ">" + a);
  }
  delayFor(a, b) {
    const v = this.linkDelay.get(a + ">" + b);
    let base = typeof v === "function" ? v(this) : v ?? this.delay;
    if (this.jitter) base *= 1 + (this.rand() * 2 - 1) * this.jitter;
    return Math.max(1, base);
  }

  // ---- event queue ----
  schedule(time, fn) {
    const ev = { time: Math.max(time, this.t), seq: this.seq++, fn, cancelled: false };
    let i = this.q.length;
    while (i > 0 && (this.q[i - 1].time > ev.time || (this.q[i - 1].time === ev.time && this.q[i - 1].seq > ev.seq))) i--;
    this.q.splice(i, 0, ev);
    return ev;
  }
  after(dt, fn) { return this.schedule(this.t + dt, fn); }
  cancel(ev) { if (ev) ev.cancelled = true; }
  nextTime() {
    while (this.q.length && this.q[0].cancelled) this.q.shift();
    return this.q.length ? this.q[0].time : Infinity;
  }
  idle() { return this.nextTime() === Infinity; }
  step() {
    if (this.idle()) return false;
    const ev = this.q.shift();
    this.t = Math.max(this.t, ev.time);
    ev.fn(this);
    return true;
  }
  runUntil(t) {
    while (this.nextTime() <= t) this.step();
    this.t = Math.max(this.t, t);
  }
  runAll(max = 20000) {
    let i = 0;
    while (!this.idle() && i++ < max) this.step();
  }

  // ---- messages ----
  /**
   * Send a message. Returns the message record, or null when the sender is down.
   * opts.delay overrides the link delay; opts.label and opts.cls are for drawing.
   */
  send(from, to, kind, payload = {}, opts = {}) {
    const src = this.node(from);
    if (!src || !src.up) return null;
    const d = opts.delay ?? this.delayFor(from, to);
    let arrive = this.t + d;
    const key = from + ">" + to;
    if (this.fifo) {
      arrive = Math.max(arrive, (this.linkFree.get(key) ?? -Infinity) + 1);
      this.linkFree.set(key, arrive);
    }
    const m = {
      id: this.msgs.length + 1, from, to, kind, payload,
      label: opts.label === undefined ? kind : opts.label, cls: opts.cls ?? kind,
      sent: this.t, arrive, status: "flight", cutAtSend: this.isCut(from, to),
    };
    this.msgs.push(m);
    this.schedule(arrive, () => this.deliver(m));
    return m;
  }
  deliver(m) {
    if (m.status !== "flight") return;
    const dst = this.node(m.to);
    if (!dst || !dst.up) { m.status = "lost"; m.why = "down"; return; }
    if (m.cutAtSend || this.isCut(m.from, m.to)) { m.status = "lost"; m.why = "partition"; return; }
    m.status = "done";
    const h = this.handlers[m.kind];
    if (h) h(dst, m, this);
  }
  inFlight() { return this.msgs.filter((m) => m.status === "flight"); }

  // ---- faults ----
  crash(id) {
    const n = this.node(id);
    if (!n || !n.up) return;
    n.up = false;
    n.downs.push([this.t, Infinity]);
    if (this.dropOnCrash) for (const m of this.msgs) if (m.from === id && m.status === "flight") { m.status = "lost"; m.why = "crash"; m.lostAt = this.t; }
    this.onCrash?.(n, this);
  }
  recover(id) {
    const n = this.node(id);
    if (!n || n.up) return;
    n.up = true;
    const last = n.downs[n.downs.length - 1];
    if (last) last[1] = this.t;
    this.onRecover?.(n, this);
  }
  linkKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }
  partition(a, b) { this.cuts.add(this.linkKey(a, b)); }
  heal(a, b) { this.cuts.delete(this.linkKey(a, b)); }
  isCut(a, b) { return this.cuts.has(this.linkKey(a, b)); }

  /** A labelled point on a node's timeline (a write applied, a read answered, a decision). */
  mark(node, label, cls = "", extra = {}) {
    const m = { node, t: this.t, label, cls, ...extra };
    this.marks.push(m);
    return m;
  }
}

// ---- small pure helpers used by several lessons ----

/** Compare two version vectors (objects of counters). Returns "before", "after", "equal", or "concurrent". */
export function compareVV(a, b) {
  let less = false, more = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k] || 0, y = b[k] || 0;
    if (x < y) less = true;
    if (x > y) more = true;
  }
  if (less && more) return "concurrent";
  if (less) return "before";
  if (more) return "after";
  return "equal";
}

/** Pointwise maximum of two version vectors. */
export function mergeVV(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] || 0, v);
  return out;
}
