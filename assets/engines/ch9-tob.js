// Chapter 9: total order broadcast through a sequencer. DOM-free.
// A sequencer (in practice, the leader of a consensus group) stamps each
// message with the next sequence number and sends it to every replica.
// Network delays differ, so copies arrive in different orders. In ordered
// mode a replica holds a message back until every lower number has been
// delivered. In unordered mode it delivers on arrival.
// Each replica applies delivered messages to a tiny state machine: the first
// claim on a seat wins, later claims on the same seat are rejected.
import { rng } from "../charts.js";

export class Broadcast {
  constructor({ replicas = ["R1", "R2", "R3"], seed = 7, ordered = true } = {}) {
    this.rand = rng(seed);
    this.ordered = ordered;
    this.now = 0;
    this.seq = 0;
    this.inflight = []; // { msg, replica, sentAt, arriveAt }
    this.replicas = replicas.map((name) => ({ name, held: [], delivered: [], seats: {}, next: 1 }));
  }

  /** Sends a claim; returns the stamped message. */
  broadcast(sender, seat) {
    const msg = { seq: ++this.seq, sender, seat };
    this.replicas.forEach((_, r) => {
      const delay = 0.8 + this.rand() * 4.2;
      this.inflight.push({ msg, replica: r, sentAt: this.now, arriveAt: this.now + delay });
    });
    return msg;
  }

  nextArrival() {
    return this.inflight.reduce((m, f) => Math.min(m, f.arriveAt), Infinity);
  }

  /** Advances the clock to `t`, processing arrivals in time order. Returns events. */
  advanceTo(t) {
    const events = [];
    for (;;) {
      const next = this.inflight.filter((f) => f.arriveAt <= t).sort((a, b) => a.arriveAt - b.arriveAt)[0];
      if (!next) break;
      this.inflight.splice(this.inflight.indexOf(next), 1);
      this.now = next.arriveAt;
      events.push(...this.arrive(next.replica, next.msg));
    }
    this.now = Math.max(this.now, t);
    return events;
  }

  arrive(r, msg) {
    const rep = this.replicas[r];
    const events = [{ type: "arrive", replica: r, msg }];
    if (!this.ordered) {
      events.push(this.deliver(rep, r, msg));
      return events;
    }
    rep.held.push(msg);
    rep.held.sort((a, b) => a.seq - b.seq);
    while (rep.held.length && rep.held[0].seq === rep.next) {
      const m = rep.held.shift();
      rep.next++;
      events.push(this.deliver(rep, r, m));
    }
    return events;
  }

  deliver(rep, r, msg) {
    const holder = rep.seats[msg.seat];
    const granted = !holder;
    if (granted) rep.seats[msg.seat] = msg.sender;
    rep.delivered.push({ ...msg, granted });
    return { type: "deliver", replica: r, msg, granted };
  }

  /** True when every replica has delivered the same sequence of messages. */
  logsAgree() {
    const sig = (rep) => rep.delivered.map((m) => m.seq).join(",");
    const first = sig(this.replicas[0]);
    return this.replicas.every((rep) => sig(rep) === first);
  }

  /** Seats whose holder differs between replicas, considering only seats every replica has assigned. */
  disagreements() {
    const seats = new Set(this.replicas.flatMap((rep) => Object.keys(rep.seats)));
    return [...seats].filter((s) => {
      const hs = this.replicas.map((rep) => rep.seats[s]);
      return hs.every(Boolean) && new Set(hs).size > 1;
    });
  }
}
