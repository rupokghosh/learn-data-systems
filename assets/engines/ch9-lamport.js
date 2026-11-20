// Chapter 9: Lamport timestamps and the happens-before relation. DOM-free.
//
// events:   { id, proc, t, kind: "local" | "send" | "recv", msg? }
// messages: { id, send: eventId, recv: eventId }   (recv.t must be > send.t)
// `t` is only the horizontal position on the diagram. Nodes never see it.

/**
 * Computes, for every event, its Lamport timestamp and a vector clock.
 * The vector clock is used only to answer "is a causally before b?" exactly;
 * the Lamport counter is what a real node would attach to its messages.
 */
export function analyse(nProcs, events, messages) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const sendOf = new Map(messages.map((m) => [m.recv, m.send]));
  const sorted = [...events].sort((a, b) => a.t - b.t || a.proc - b.proc);
  const counter = new Array(nProcs).fill(0);
  const vclock = Array.from({ length: nProcs }, () => new Array(nProcs).fill(0));
  const info = new Map();
  for (const e of sorted) {
    const p = e.proc;
    if (e.kind === "recv") {
      const s = info.get(sendOf.get(e.id));
      if (!s) throw new Error("receive processed before its send");
      counter[p] = Math.max(counter[p], s.lamport) + 1;
      vclock[p] = vclock[p].map((v, i) => Math.max(v, s.vc[i]));
    } else {
      counter[p] += 1;
    }
    vclock[p] = [...vclock[p]];
    vclock[p][p] += 1;
    info.set(e.id, { lamport: counter[p], vc: [...vclock[p]], proc: p, ev: byId.get(e.id) });
  }
  return info;
}

/** "before" if a happened before b, "after" if b happened before a, else "concurrent". */
export function relation(info, a, b) {
  if (a === b) return "same";
  const va = info.get(a).vc, vb = info.get(b).vc;
  const le = va.every((v, i) => v <= vb[i]);
  const ge = va.every((v, i) => v >= vb[i]);
  if (le && !ge) return "before";
  if (ge && !le) return "after";
  return "concurrent";
}

/** The Lamport total order: by counter, ties broken by process number. */
export function totalOrder(info) {
  return [...info.entries()]
    .sort(([, a], [, b]) => a.lamport - b.lamport || a.proc - b.proc)
    .map(([id]) => id);
}

/** Checks the clock condition: a happened before b implies L(a) < L(b). */
export function clockConditionHolds(info) {
  const ids = [...info.keys()];
  for (const a of ids) for (const b of ids) {
    if (relation(info, a, b) === "before" && !(info.get(a).lamport < info.get(b).lamport)) return false;
  }
  return true;
}
