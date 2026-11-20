// Chapter 11: DOM-free models of two kinds of message broker.
//  - LogBroker: a partitioned, append-only log with consumer groups and offsets (Kafka style).
//  - QueueBroker: a traditional queue that deletes on acknowledgement (AMQP / JMS style).

/** Deterministic string hash, used to pick a partition for a key. */
export function hashKey(key, n) {
  let h = 7;
  for (const ch of String(key)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return h % n;
}

/**
 * A log-based broker with one topic, N partitions, and one consumer group.
 * Each partition is an append-only list of messages with increasing offsets.
 * Retention keeps only the newest `retention` messages of each partition.
 */
export class LogBroker {
  constructor({ partitions = 3, retention = 30, commitEvery = 5, rate = 1, slowRate = 0.2 } = {}) {
    this.n = partitions;
    this.parts = Array.from({ length: partitions }, () => ({ start: 0, msgs: [] }));
    this.retention = retention;
    this.commitEvery = commitEvery;
    this.rate = rate;
    this.slowRate = slowRate;
    this.committed = Array(partitions).fill(0); // group offsets, stored by the broker
    this.consumers = [];                          // alive members of the group
    this.owner = Array(partitions).fill(null);    // partition -> consumer name
    this.times = new Map();                       // "p:offset" -> times processed
    this.stats = { produced: 0, processed: 0, again: 0, expired: 0 };
    this.notes = [];                              // what happened in the last operation
    this.clock = 0;
  }

  end(p) { const P = this.parts[p]; return P.start + P.msgs.length; }
  partitionOf(key) { return hashKey(key, this.n); }
  get(p, offset) { const P = this.parts[p]; return P.msgs[offset - P.start] || null; }
  consumer(name) { return this.consumers.find((c) => c.name === name) || null; }

  produce(key, value) {
    const p = this.partitionOf(key);
    const P = this.parts[p];
    const offset = this.end(p);
    P.msgs.push({ p, offset, key, value, at: this.clock });
    if (P.msgs.length > this.retention) { P.msgs.shift(); P.start++; }
    this.stats.produced++;
    return { p, offset };
  }

  /** Messages a partition still has to deliver to the group. */
  lag(p) {
    const c = this.owner[p] && this.consumer(this.owner[p]);
    const pos = c ? c.pos[p] : this.committed[p];
    return Math.max(0, this.end(p) - Math.max(pos, this.parts[p].start));
  }

  addConsumer(name) {
    if (this.consumer(name)) return;
    this.consumers.push({ name, slow: false, credit: 0, pos: {}, since: 0, rr: 0 });
    this.consumers.sort((a, b) => a.name.localeCompare(b.name));
    this.rebalance();
  }

  /** A clean leave: the consumer commits what it has processed first. */
  removeConsumer(name) {
    const c = this.consumer(name);
    if (!c) return;
    this.commit(c);
    this.consumers = this.consumers.filter((x) => x !== c);
    this.rebalance();
  }

  /** A crash: uncommitted progress is lost. Returns what will be processed again. */
  crash(name) {
    const c = this.consumer(name);
    if (!c) return [];
    const redo = [];
    for (const [p, pos] of Object.entries(c.pos)) {
      const from = Math.max(this.committed[p], this.parts[p].start);
      if (pos > from) redo.push({ p: +p, from, to: pos - 1 });
    }
    this.consumers = this.consumers.filter((x) => x !== c);
    this.rebalance();
    return redo;
  }

  /**
   * Range assignment: partition p goes to member p mod (group size).
   * Surviving members commit their progress before partitions move.
   */
  rebalance() {
    const before = [...this.owner];
    for (const c of this.consumers) this.commit(c);
    for (const c of this.consumers) c.pos = {};
    for (let p = 0; p < this.n; p++) {
      const c = this.consumers.length ? this.consumers[p % this.consumers.length] : null;
      this.owner[p] = c ? c.name : null;
      if (c) c.pos[p] = this.committed[p];
    }
    this.notes = [];
    for (let p = 0; p < this.n; p++) if (before[p] !== this.owner[p]) this.notes.push({ p, from: before[p], to: this.owner[p] });
    return this.notes;
  }

  commit(c) {
    for (const [p, pos] of Object.entries(c.pos)) this.committed[p] = Math.max(this.committed[p], pos);
    c.since = 0;
  }

  /** One unit of time: every consumer processes up to its rate, round-robin over its partitions. */
  tick() {
    this.clock++;
    const done = [];
    for (const c of this.consumers) {
      c.credit += c.slow ? this.slowRate : this.rate;
      const mine = Object.keys(c.pos).map(Number);
      while (c.credit >= 1 && mine.length) {
        let picked = -1;
        for (let i = 0; i < mine.length; i++) {
          const p = mine[(c.rr + i) % mine.length];
          if (c.pos[p] < this.end(p)) { picked = p; c.rr = (c.rr + i + 1) % mine.length; break; }
        }
        if (picked < 0) { c.credit = Math.min(c.credit, 1); break; }
        const p = picked;
        if (c.pos[p] < this.parts[p].start) { // retention deleted messages this consumer never read
          this.stats.expired += this.parts[p].start - c.pos[p];
          c.pos[p] = this.parts[p].start;
        }
        const offset = c.pos[p];
        const id = `${p}:${offset}`;
        const n = (this.times.get(id) || 0) + 1;
        this.times.set(id, n);
        this.stats.processed++;
        if (n > 1) this.stats.again++;
        c.pos[p] = offset + 1;
        c.credit -= 1;
        c.since++;
        done.push({ consumer: c.name, p, offset, again: n > 1 });
        if (c.since >= this.commitEvery) this.commit(c);
      }
    }
    return done;
  }

  /** Move the group's offsets back (or forward) and let consumers read from there. */
  seek(offset) {
    for (let p = 0; p < this.n; p++) {
      const o = Math.min(Math.max(offset, this.parts[p].start), this.end(p));
      this.committed[p] = o;
      const c = this.owner[p] && this.consumer(this.owner[p]);
      if (c) c.pos[p] = o;
    }
    for (const c of this.consumers) c.since = 0;
  }
}

/**
 * A traditional broker: one queue, messages are deleted once acknowledged.
 * mode "balance": each message goes to one consumer.
 * mode "fanout": each consumer has its own queue and receives every message.
 */
export class QueueBroker {
  constructor({ mode = "balance", messages = [], consumers = [] } = {}) {
    this.mode = mode;
    this.clock = 0;
    this.consumers = consumers.map((c) => ({ name: c.name, work: c.work, alive: true, busy: null, left: 0, done: [] }));
    const all = messages.map((id, i) => ({ id, seq: i, deliveries: 0 }));
    this.queues = mode === "fanout"
      ? Object.fromEntries(this.consumers.map((c) => [c.name, all.map((m) => ({ ...m }))]))
      : { shared: all };
    this.log = [];      // completed: { id, seq, by, redelivered }
    this.acked = 0;
    this.notes = [];
    this.rr = 0;
    this.limbo = [];          // unacknowledged messages of a dead consumer, until the broker notices
    this.timeout = 3;         // ticks before the broker gives up on a silent consumer
  }

  queueFor(c) { return this.mode === "fanout" ? this.queues[c.name] : this.queues.shared; }
  get pending() { return Object.values(this.queues).reduce((s, q) => s + q.length, 0); }
  get inFlight() { return this.consumers.filter((c) => c.busy).length; }
  get finished() { return this.pending === 0 && this.inFlight === 0 && this.limbo.length === 0; }

  tick() {
    this.clock++;
    this.notes = [];
    // 1. busy consumers make progress; finished work is acknowledged and deleted
    for (const c of this.consumers) {
      if (!c.alive || !c.busy) continue;
      c.left--;
      if (c.left <= 0) {
        const m = c.busy;
        c.busy = null;
        this.acked++;
        const entry = { id: m.id, seq: m.seq, by: c.name, redelivered: m.deliveries > 1 };
        c.done.push(entry);
        this.log.push(entry);
        this.notes.push({ type: "ack", id: m.id, by: c.name });
      }
    }
    // 2. after the timeout, unacknowledged messages of a dead consumer go back to the front of the queue
    for (const l of this.limbo.filter((x) => x.until <= this.clock)) {
      this.queueFor(l.c).unshift(l.m);
      this.notes.push({ type: "requeue", id: l.m.id });
    }
    this.limbo = this.limbo.filter((x) => x.until > this.clock);
    // 3. the broker pushes the next message to each idle consumer (round-robin)
    const n = this.consumers.length;
    for (let i = 0; i < n; i++) {
      const c = this.consumers[(this.rr + i) % n];
      if (!c.alive || c.busy) continue;
      const q = this.queueFor(c);
      if (!q.length) continue;
      const m = q.shift();
      m.deliveries++;
      c.busy = m;
      c.left = c.work;
      this.notes.push({ type: "deliver", id: m.id, to: c.name, redelivery: m.deliveries > 1 });
    }
    this.rr = (this.rr + 1) % Math.max(1, n);
  }

  /**
   * The consumer dies. Its unacknowledged message is redelivered once the broker
   * notices, after a timeout (missed heartbeats, or a visibility timeout).
   */
  crash(name) {
    const c = this.consumers.find((x) => x.name === name);
    if (!c || !c.alive) return null;
    c.alive = false;
    const m = c.busy;
    c.busy = null;
    if (m) this.limbo.push({ m, c, until: this.clock + this.timeout });
    return m;
  }

  restart(name) {
    const c = this.consumers.find((x) => x.name === name);
    if (c) c.alive = true;
  }

  /**
   * Completed entries that finished after a message that was sent later.
   * In fan-out mode each consumer's own sequence is checked separately.
   */
  outOfOrder() {
    const bad = new Set();
    const lists = this.mode === "fanout" ? this.consumers.map((c) => c.done) : [this.log];
    for (const list of lists) {
      let maxSeq = -1;
      for (const e of list) { if (e.seq < maxSeq) bad.add(e); maxSeq = Math.max(maxSeq, e.seq); }
    }
    return bad;
  }
}
