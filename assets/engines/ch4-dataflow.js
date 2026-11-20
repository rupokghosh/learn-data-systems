// Chapter 4: one "place an order" flow in three modes of dataflow. DOM-free.
// Time runs from 0 to 100. The fault (when on) cuts the link to the receiving side
// from t = 21 to t = 62, just after the first request has reached it.

export const FAULT = { from: 21, to: 62 };

const msg = (t0, t1, from, to, label, opts = {}) => ({ kind: "msg", t0, t1, from, to, label, ...opts });
const note = (t, lane, text, cls = "") => ({ kind: "note", t, lane, text, cls, creates: /^creates /.test(text) });

/**
 * Build the timeline for one mode.
 * mode: "db" | "rpc" | "broker"; fault: link to the receiver drops; idem: requests carry an idempotency key.
 * Returns { lanes, events, faultLink (the two lanes whose link drops), orders, charges, verdict: { cls, text } }.
 */
export function scenario(mode, { fault = false, idem = false } = {}) {
  const ev = [];
  if (mode === "db") {
    const lanes = ["Checkout", "Database", "Fulfillment"];
    ev.push(msg(3, 12, 0, 1, "INSERT order 5521", { creates: true }));
    ev.push(msg(13, 20, 1, 0, "committed"));
    ev.push(note(22, 0, "shows: order placed"));
    if (!fault) {
      ev.push(msg(30, 38, 2, 1, "new orders?"));
      ev.push(msg(39, 47, 1, 2, "order 5521"));
      ev.push(note(50, 2, "packs order 5521", "good"));
    } else {
      ev.push(msg(30, 38, 2, 1, "new orders?", { lost: 0.55 }));
      ev.push(note(40, 2, "timeout; will poll again", "warn"));
      ev.push(note(44, 1, "row is durable, waiting"));
      ev.push(msg(66, 74, 2, 1, "new orders?"));
      ev.push(msg(75, 83, 1, 2, "order 5521"));
      ev.push(note(86, 2, "packs order 5521 (late)", "good"));
    }
    return {
      lanes, events: ev, faultLink: [1, 2], orders: 1, charges: 1,
      verdict: fault
        ? { cls: "good", text: "Nothing lost. The writer was done once the row committed; the reader caught up after the network came back." }
        : { cls: "good", text: "The writer and the reader never talk to each other. The row in the database is the message." },
    };
  }
  if (mode === "rpc") {
    const lanes = ["Checkout", "Orders API"];
    const key = idem ? " key=k-31c" : "";
    ev.push(msg(3, 15, 0, 1, `POST /orders${key}`));
    ev.push(note(17, 1, "creates 5521, charges card"));
    if (!fault) {
      ev.push(msg(25, 37, 1, 0, "201 order 5521"));
      ev.push(note(40, 0, "shows: order placed", "good"));
      return { lanes, events: ev, faultLink: [0, 1], orders: 1, charges: 1,
        verdict: { cls: "good", text: "A request, a response, and both sides agree. Remote calls look like this most of the time, which is what makes the other times dangerous." } };
    }
    ev.push(msg(25, 37, 1, 0, "201 order 5521", { lost: 0.5 }));
    ev.push(note(46, 0, "timeout: did it happen?", "warn"));
    ev.push(msg(64, 76, 0, 1, `retry POST /orders${key}`));
    if (idem) {
      ev.push(note(77, 1, "key seen: returns saved reply", "good"));
      ev.push(msg(84, 95, 1, 0, "201 order 5521"));
      ev.push(note(97, 0, "shows: order placed", "good"));
      return { lanes, events: ev, faultLink: [0, 1], orders: 1, charges: 1,
        verdict: { cls: "good", text: "The retry carried the same idempotency key. The server recognised it, did not run the order again, and returned the reply it had saved. One order, one charge." } };
    }
    ev.push(note(77, 1, "creates 5522, charges card", "bad"));
    ev.push(msg(84, 95, 1, 0, "201 order 5522"));
    ev.push(note(97, 0, "shows: order placed", ""));
    return { lanes, events: ev, faultLink: [0, 1], orders: 2, charges: 2,
      verdict: { cls: "bad", text: "Two orders and two charges. The first request succeeded; only its reply was lost. The caller could not tell the difference between that and a request that never arrived, so it retried." } };
  }
  // broker
  const lanes = ["Checkout", "Broker", "Orders worker"];
  ev.push(msg(3, 11, 0, 1, "publish OrderPlaced"));
  ev.push(msg(12, 18, 1, 0, "stored"));
  ev.push(note(20, 0, "order received"));
  if (!fault) {
    ev.push(msg(22, 32, 1, 2, "deliver"));
    ev.push(note(33, 2, "creates order 5521", "good"));
    ev.push(msg(40, 48, 2, 1, "ack"));
    ev.push(note(50, 1, "message removed"));
  } else {
    ev.push(msg(22, 32, 1, 2, "deliver", { lost: 0.5 }));
    ev.push(note(36, 1, "no ack; message stays queued", "warn"));
    ev.push(msg(63, 73, 1, 2, "redeliver"));
    ev.push(note(74, 2, "creates order 5521", "good"));
    ev.push(msg(81, 89, 2, 1, "ack"));
    ev.push(note(91, 1, "message removed"));
  }
  return { lanes, events: ev, faultLink: [1, 2], orders: 1, charges: 1,
    verdict: fault
      ? { cls: "good", text: "The sender moved on as soon as the broker stored the message. The broker held it through the outage and delivered it when the worker was reachable again." }
      : { cls: "good", text: "The sender only talks to the broker. It does not know or care which worker processes the order, or when." } };
}

/** State of one message at time t: hidden, travelling (fraction 0..1), arrived, or lost at its fraction. */
export function messageAt(m, t) {
  if (t < m.t0) return { visible: false, frac: 0 };
  const raw = Math.min(1, (t - m.t0) / (m.t1 - m.t0));
  if (m.lost !== undefined) return { visible: true, frac: Math.min(raw, m.lost), dead: raw >= m.lost };
  return { visible: true, frac: raw, done: raw >= 1 };
}
