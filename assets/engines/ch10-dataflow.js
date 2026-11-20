// Chapter 10: timing model for a three-stage job run as chained MapReduce jobs vs a dataflow engine,
// and a Pregel-style bulk synchronous parallel simulator. DOM-free.

/* ------------------------------------------------------------------ */
/* Timeline model                                                       */
/* ------------------------------------------------------------------ */
// Rates are for the whole cluster, in GB per second. Simple, but the ratios are what matter.
export const RATES = { read: 4, write: 1.5, compute: 2.5, spill: 6 };
export const STARTUP = { job: 25, engine: 25 };
export const OUT_RATIO = [0.8, 0.3, 0.05]; // output size of each stage relative to the job input
export const STAGES = ["Stage 1: clean and key events", "Stage 2: aggregate per user", "Stage 3: rank and format"];

/**
 * Returns segments for both plans. Segment: { stage, kind, t0, t1 }.
 * kinds: wait, startup, read, compute, write, spill, recompute.
 */
export function timelines({ sizeGB = 200, replication = 3, failure = false } = {}) {
  const ins = [sizeGB, sizeGB * OUT_RATIO[0], sizeGB * OUT_RATIO[1]];
  const outs = OUT_RATIO.map((r) => sizeGB * r);
  const comp = ins.map((x) => x / RATES.compute);

  // Chained MapReduce: every stage is a job that reads from and writes to the distributed filesystem.
  const mr = [];
  let t = 0, mrBytes = 0;
  for (let i = 0; i < 3; i++) {
    if (t > 0) mr.push({ stage: i, kind: "wait", t0: 0, t1: t });
    const seg = (kind, d) => { mr.push({ stage: i, kind, t0: t, t1: t + d }); t += d; };
    seg("startup", STARTUP.job);
    seg("read", ins[i] / RATES.read);
    seg("compute", comp[i]);
    if (failure && i === 2) seg("recompute", ins[i] / RATES.read / 3 + comp[i] / 3 + STARTUP.job / 5);
    seg("write", (outs[i] * replication) / RATES.write);
    mrBytes += outs[i] * replication;
  }

  // Dataflow engine: one startup, intermediate state kept in memory or spilled to local disk without replication.
  // Stage 1 -> 2 needs a shuffle (a barrier). Stage 2 -> 3 is pipelined: stage 3 consumes records as they arrive.
  const df = [];
  let u = 0;
  const dseg = (stage, kind, t0, d) => { df.push({ stage, kind, t0, t1: t0 + d }); return t0 + d; };
  u = dseg(0, "startup", 0, STARTUP.engine);
  u = dseg(0, "read", u, ins[0] / RATES.read);
  u = dseg(0, "compute", u, comp[0]);
  u = dseg(0, "spill", u, outs[0] / RATES.spill);
  df.push({ stage: 1, kind: "wait", t0: 0, t1: u });
  const s2start = u;
  u = dseg(1, "compute", u, comp[1]);
  const s2end = u;
  // Stage 3 runs alongside stage 2, finishing shortly after it, then writes the final output.
  const lag = Math.min(comp[2], comp[1]) * 0.15 + 1;
  df.push({ stage: 2, kind: "wait", t0: 0, t1: s2start + lag });
  let v = dseg(2, "compute", s2start + lag, Math.max(s2end - s2start - lag, 0) + comp[2] * 0.3);
  if (failure) {
    // Lost partition of stage 2 output: recompute that partition from its lineage (stage 1 input -> stage 2 -> stage 3).
    const d = (ins[0] / RATES.read + comp[0] + comp[1] + comp[2]) / 3;
    v = dseg(2, "recompute", v, d);
  }
  v = dseg(2, "write", v, (outs[2] * replication) / RATES.write);
  const dfBytes = outs[2] * replication;

  return {
    mr: { segments: mr, total: t, dfsBytes: mrBytes },
    df: { segments: df, total: v, dfsBytes: dfBytes },
  };
}

/* ------------------------------------------------------------------ */
/* Pregel: vertices exchange messages in supersteps                     */
/* ------------------------------------------------------------------ */
export const GRAPH = {
  nodes: [
    { id: "A", x: 60, y: 70, w: 0 }, { id: "B", x: 170, y: 40, w: 0 }, { id: "C", x: 160, y: 150, w: 1 },
    { id: "D", x: 280, y: 90, w: 1 }, { id: "E", x: 290, y: 200, w: 2 }, { id: "F", x: 400, y: 50, w: 2 },
    { id: "G", x: 410, y: 160, w: 0 }, { id: "H", x: 520, y: 100, w: 1 },
    { id: "J", x: 520, y: 230, w: 2 }, { id: "K", x: 610, y: 180, w: 0 }, { id: "L", x: 610, y: 270, w: 1 },
  ],
  edges: [["A", "B"], ["A", "C"], ["B", "D"], ["C", "D"], ["C", "E"], ["D", "F"], ["D", "G"], ["E", "G"], ["F", "H"], ["G", "H"], ["J", "K"], ["J", "L"], ["K", "L"]],
};

export function neighbors(graph) {
  const adj = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const [a, b] of graph.edges) { adj.get(a).push(b); adj.get(b).push(a); }
  return adj;
}

/**
 * mode "hops": shortest hop count from source. mode "components": smallest label in each connected component.
 * step() runs one superstep: each vertex with mail (or every vertex in superstep 0) runs compute(),
 * may change its value, and sends messages that are delivered at the start of the next superstep.
 */
export function createPregel(graph, mode = "hops", source = "A") {
  const adj = neighbors(graph);
  const worker = new Map(graph.nodes.map((n) => [n.id, n.w]));
  const s = {
    superstep: 0,
    value: new Map(graph.nodes.map((n) => [n.id, mode === "hops" ? Infinity : n.id])),
    inbox: new Map(),
    halted: false,
    totalMessages: 0,
    totalCross: 0,
  };

  function step() {
    if (s.halted) return null;
    const changed = [], sent = [];
    const send = (from, val) => { for (const to of adj.get(from)) sent.push({ from, to, val, cross: worker.get(from) !== worker.get(to) }); };
    if (s.superstep === 0) {
      if (mode === "hops") { s.value.set(source, 0); changed.push(source); send(source, 1); }
      else for (const n of graph.nodes) { changed.push(n.id); send(n.id, n.id); }
    } else {
      for (const [id, msgs] of s.inbox) {
        const best = msgs.reduce((a, b) => (b < a ? b : a));
        if (best < s.value.get(id)) {
          s.value.set(id, best);
          changed.push(id);
          send(id, mode === "hops" ? best + 1 : best);
        }
      }
    }
    const received = s.inbox;
    s.inbox = new Map();
    for (const m of sent) { if (!s.inbox.has(m.to)) s.inbox.set(m.to, []); s.inbox.get(m.to).push(m.val); }
    const cross = sent.filter((m) => m.cross).length;
    s.totalMessages += sent.length; s.totalCross += cross;
    const result = { superstep: s.superstep, received, changed, sent, cross };
    s.superstep++;
    if (sent.length === 0) s.halted = true;
    return result;
  }
  return { state: s, step, source, mode };
}
