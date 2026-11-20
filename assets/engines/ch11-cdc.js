// Chapter 11, lesson 2: dual writes versus change data capture, and an event-sourced parcel tracker.

/**
 * Two clients update the same listing's nightly price.
 * mode "dual": each client writes the database, waits for the ack, then writes the search index itself.
 * mode "cdc":  clients write only the database; a connector ships the database's log to the index in order.
 * delay: network delay (ms) for the first write that heads to the index (client A's in dual mode,
 *        the first log entry in CDC mode).
 * Returns messages (arrows) and applies (value changes on a lane), all in simulated milliseconds.
 */
export function priceRace({ mode = "dual", delay = 140, initial = 110, a = 120, b = 95 } = {}) {
  const msgs = [];
  const applies = [{ lane: "db", t: 0, value: initial }, { lane: "idx", t: 0, value: initial }];
  const send = (from, to, t0, t1, label, cls) => { msgs.push({ from, to, t0, t1, label, cls }); return t1; };

  // Both clients write the database first.
  const aDb = send("A", "db", 0, 30, `price=${a}`, "a");
  applies.push({ lane: "db", t: aDb, value: a, by: "A", lsn: 1 });
  const aAck = send("db", "A", aDb, aDb + 25, "ok", "ack");
  const bDb = send("B", "db", 45, 75, `price=${b}`, "b");
  applies.push({ lane: "db", t: bDb, value: b, by: "B", lsn: 2 });
  const bAck = send("db", "B", bDb, bDb + 25, "ok", "ack");

  if (mode === "dual") {
    const aIdx = send("A", "idx", aAck, aAck + delay, `price=${a}`, "a");
    const bIdx = send("B", "idx", bAck, bAck + 30, `price=${b}`, "b");
    applies.push({ lane: "idx", t: aIdx, value: a, by: "A" }, { lane: "idx", t: bIdx, value: b, by: "B" });
  } else {
    // The connector reads the log in order: entry 2 cannot be applied before entry 1.
    const c1 = send("db", "idx", aDb, aDb + delay, `#1 ${a}`, "cdc");
    const d2 = Math.max(bDb, c1);
    const c2 = send("db", "idx", d2, d2 + 30, `#2 ${b}`, "cdc");
    applies.push({ lane: "idx", t: c1, value: a, by: "log #1" }, { lane: "idx", t: c2, value: b, by: "log #2" });
  }
  applies.sort((x, y) => x.t - y.t);
  const end = Math.max(...msgs.map((m) => m.t1)) + 25;
  const valueAt = (lane, t) => {
    let v = null;
    for (const ap of applies) if (ap.lane === lane && ap.t <= t) v = ap.value;
    return v;
  };
  const order = (lane) => applies.filter((x) => x.lane === lane && x.by).map((x) => x.by);
  return { msgs, applies, end, valueAt, order, final: { db: valueAt("db", end), idx: valueAt("idx", end) } };
}

/* ------------------------------------------------------------------
   Event-sourced parcel tracker
   ------------------------------------------------------------------ */

export const ROUTE = ["Utrecht hub", "Arnhem depot", "Zwolle depot", "Assen depot"];

/** Validate a command against current state. Returns an event, or { error }. */
export function decide(state, cmd) {
  const s = state.get(cmd.id);
  if (cmd.type === "Registered") return s ? { error: `${cmd.id} already exists.` } : { ...cmd };
  if (!s) return { error: `${cmd.id} does not exist.` };
  if (s.erased) return { error: `${cmd.id} was erased.` };
  const st = s.status;
  switch (cmd.type) {
    case "Scanned":
      if (st === "delivered") return { error: `${cmd.id} is already delivered.` };
      if (st === "out for delivery") return { error: `${cmd.id} is on a van; it must be delivered or fail first.` };
      if (s.scans >= ROUTE.length) return { error: `${cmd.id} has reached its last depot.` };
      return { type: "Scanned", id: cmd.id, hub: ROUTE[s.scans] };
    case "OutForDelivery":
      if (st !== "in transit" && st !== "attempt failed") return { error: `${cmd.id} must be at a depot first (it is ${st}).` };
      return { type: "OutForDelivery", id: cmd.id };
    case "AttemptFailed":
      if (st !== "out for delivery") return { error: `${cmd.id} is not out for delivery.` };
      return { type: "AttemptFailed", id: cmd.id };
    case "Delivered":
      if (st !== "out for delivery") return { error: `${cmd.id} is not out for delivery.` };
      return { type: "Delivered", id: cmd.id };
    default:
      return { error: "Unknown command." };
  }
}

/** Apply one event to the state map (mutates and returns it). */
export function apply(state, ev) {
  const s = state.get(ev.id);
  switch (ev.type) {
    case "Registered": state.set(ev.id, { status: "registered", location: "sender", dest: ev.dest, attempts: 0, scans: 0 }); break;
    case "Scanned": state.set(ev.id, { ...s, status: "in transit", location: ev.hub, scans: s.scans + 1 }); break;
    case "OutForDelivery": state.set(ev.id, { ...s, status: "out for delivery", location: "van" }); break;
    case "AttemptFailed": state.set(ev.id, { ...s, status: "attempt failed", location: "back at depot", attempts: s.attempts + 1 }); break;
    case "Delivered": state.set(ev.id, { ...s, status: "delivered", location: s.dest }); break;
    case "Erased": state.delete(ev.id); break;
  }
  return state;
}

/** Current state is a left fold over the log. */
export const fold = (events, upto = events.length) => events.slice(0, upto).reduce(apply, new Map());

export function describe(ev) {
  switch (ev.type) {
    case "Registered": return `Registered, to ${ev.dest}`;
    case "Scanned": return `Scanned at ${ev.hub}`;
    case "OutForDelivery": return "Out for delivery";
    case "AttemptFailed": return "Delivery attempt failed";
    case "Delivered": return "Delivered";
    case "Erased": return "Erased on request";
    default: return ev.type;
  }
}

/**
 * The change stream a CDC connector would emit for the "parcels" table:
 * the full new row after each event (or a tombstone when the row is deleted).
 */
export function changelog(events) {
  const state = new Map();
  return events.map((ev, i) => {
    apply(state, ev);
    const row = state.get(ev.id);
    return { seq: i + 1, key: ev.id, value: row ? `${row.status}, ${row.location}` : null };
  });
}

/** Log compaction: keep only the newest record per key; drop keys whose newest record is a tombstone. */
export function compact(records, { dropTombstones = true } = {}) {
  const last = new Map();
  for (const r of records) last.set(r.key, r);
  return records.filter((r) => last.get(r.key) === r && !(dropTombstones && r.value === null));
}
