// Chapter 5, lesson 3: multi-leader replication. Two models on the shared Sim:
//  1. one record edited in three data centres, with a choice of conflict resolution;
//  2. a write spreading through a circular, star, or all-to-all topology.
// DOM-free.
import { Sim } from "./ch5-sim.js";

// ---------------------------------------------------------------- model 1
export const DCS = [
  { id: "fra", name: "Frankfurt", who: "Amara", skew: 0, vals: ["Lisbon", "Porto", "Bergen"] },
  { id: "sin", name: "Singapore", who: "Kenji", skew: -400, vals: ["Kyoto", "Hanoi", "Perth"] },
  { id: "sao", name: "São Paulo", who: "Luis", skew: 0, vals: ["Lima", "Cusco", "Quito"] },
];
export const STRATEGIES = [
  ["home", "Avoid: one home leader"],
  ["lww", "Last write wins"],
  ["merge", "Merge the values"],
  ["custom", "Keep both, ask a person"],
];
const INITIAL = { id: "w0", dc: "fra", who: "", val: "Oslo", ts: 0, real: 0, deps: [] };

export function teamRecord({ seed = 5, delay = 600, strategy = "lww" } = {}) {
  const sim = new Sim({ seed, delay, jitter: 0.15 });
  sim.t = 10000; // clocks read 10 s at the start, so skewed timestamps stay positive
  sim.cfg = { delay, strategy };
  sim.dcs = DCS;
  let n = 0;
  const edits = Object.fromEntries(DCS.map((d) => [d.id, 0]));
  for (const d of DCS) sim.addNode(d.id, { writes: new Map([["w0", INITIAL]]), skew: d.skew });
  for (const a of DCS) for (const b of DCS) if (a !== b) sim.setDelay(a.id, b.id, () => sim.cfg.delay, false);

  const all = (node) => [...node.writes.values()];
  function heads(node) {
    const ws = all(node);
    const covered = new Set(ws.flatMap((w) => w.deps));
    return ws.filter((w) => !covered.has(w.id));
  }
  const lwwWinner = (ws) => ws.reduce((a, b) => (b.ts > a.ts || (b.ts === a.ts && b.dc > a.dc) ? b : a));

  /** What a reader in this data centre sees. */
  sim.view = (id) => {
    const node = sim.node(id);
    const hs = heads(node);
    const s = sim.cfg.strategy;
    if (s === "lww") {
      const win = lwwWinner(all(node));
      return { val: win.val, winner: win, heads: hs, conflict: hs.length > 1 };
    }
    if (hs.length === 1) return { val: hs[0].val, winner: hs[0], heads: hs, conflict: false };
    if (s === "merge") return { val: [...new Set(hs.map((w) => w.val))].sort().join(" / "), winner: null, heads: hs, conflict: true, merged: true };
    if (s === "custom") return { val: null, winner: null, heads: hs, conflict: true };
    const win = lwwWinner(hs);
    return { val: win.val, winner: win, heads: hs, conflict: true };
  };

  /** Edits that no data centre will ever show again: not the winner, and not something the winner saw. */
  sim.lost = () => {
    if (sim.cfg.strategy !== "lww") return [];
    const ws = new Map();
    for (const d of DCS) for (const w of all(sim.node(d.id))) ws.set(w.id, w);
    const win = lwwWinner([...ws.values()]);
    return [...ws.values()].filter((w) => w.id !== "w0" && w.id !== win.id && !win.deps.includes(w.id));
  };
  sim.converged = () => {
    if (sim.msgs.some((m) => m.status === "flight")) return false;
    const vals = DCS.map((d) => JSON.stringify(sim.view(d.id).val));
    return vals.every((v) => v === vals[0]);
  };

  function create(at, who, val, origin) {
    const node = sim.node(at);
    const w = { id: "w" + ++n, dc: at, who, val, ts: Math.round(sim.t + node.skew), real: Math.round(sim.t), deps: [...node.writes.keys()], origin };
    node.writes.set(w.id, w);
    sim.mark(at, val, "write");
    for (const d of DCS) if (d.id !== at) sim.send(at, d.id, "repl", { w }, { label: null, cls: "repl" });
    return w;
  }

  sim.on("repl", (node, m) => {
    const { w } = m.payload;
    if (node.writes.has(w.id)) return;
    const before = heads(node).length;
    node.writes.set(w.id, w);
    if (heads(node).length > 1 && before === 1) sim.mark(node.id, "conflict", "hint");
  });
  // Conflict avoidance: every edit to this record is routed to its home leader in Frankfurt.
  sim.on("edit", (node, m) => create(node.id, m.payload.who, m.payload.val, m.from));

  sim.edit = (dc) => {
    const d = DCS.find((x) => x.id === dc);
    const val = d.vals[edits[dc]++ % d.vals.length];
    if (sim.cfg.strategy === "home" && dc !== "fra") {
      sim.send(dc, "fra", "edit", { who: d.who, val }, { label: val, cls: "write" });
      sim.mark(dc, d.who, "write");
    } else create(dc, d.who, val, dc);
    return val;
  };
  sim.nextVal = (dc) => { const d = DCS.find((x) => x.id === dc); return d.vals[edits[dc] % d.vals.length]; };
  /** A person resolves a conflict in one data centre by picking one of the values. */
  sim.resolve = (dc, val) => create(dc, "resolved", val, dc);
  return sim;
}

// ---------------------------------------------------------------- model 2
export const TOPO_NODES = ["A", "B", "C", "D"];
export const TOPOLOGIES = { circular: "Circular", star: "Star", all: "All-to-all" };
const RING = { A: "B", B: "C", C: "D", D: "A" };
const HUB = "A";

export function topology({ kind = "circular", seed = 2, delay = 260 } = {}) {
  const sim = new Sim({ seed, delay, jitter: 0.25 });
  sim.kind = kind;
  let n = 0;
  for (const id of TOPO_NODES) sim.addNode(id, { seen: [], rows: new Map(), errors: [] });

  function forward(node, op, path) {
    const p = [...path, node.id];
    let to = [];
    if (sim.kind === "circular") to = [RING[node.id]];
    else if (sim.kind === "star") to = node.id === HUB ? TOPO_NODES.filter((x) => x !== HUB) : p.length === 1 ? [HUB] : [];
    else if (p.length === 1) to = TOPO_NODES.filter((x) => x !== node.id);
    for (const t of to) if (!p.includes(t)) sim.send(node.id, t, "op", { op, path: p }, { label: p.length === 1 ? op.label : null, cls: op.type === "update" ? "repair" : "write" });
  }
  function apply(node, op) {
    node.seen.push(op.id);
    if (op.type === "insert") node.rows.set(op.key, op.val);
    else if (!node.rows.has(op.key)) {
      node.errors.push(op.id);
      sim.mark(node.id, "update for a missing row", "bad");
      return false;
    } else node.rows.set(op.key, op.val);
    sim.onApply?.(node, op);
    return true;
  }
  sim.on("op", (node, m) => {
    const { op, path } = m.payload;
    if (node.seen.includes(op.id)) return; // already have it: this is how loops stop
    if (apply(node, op)) sim.mark(node.id, op.short, op.type === "update" ? "repair" : "write");
    forward(node, op, path);
  });

  sim.write = (at, op = {}) => {
    const node = sim.node(at);
    if (!node.up) return null;
    const id = "x" + ++n;
    const o = { id, type: "insert", key: id, val: "new", label: id, short: id, ...op };
    if (apply(node, o)) sim.mark(at, o.short, o.type === "update" ? "repair" : "write");
    forward(node, o, []);
    return o;
  };

  /**
   * The all-to-all causality problem: A inserts order 88, B sees it and marks it
   * paid, and B's update reaches C before A's insert, because the A to C link is slow.
   */
  sim.overtake = () => {
    sim.setDelay("A", "C", () => delay * 4.5, false);
    sim.onApply = (node, op) => {
      if (node.id === "B" && op.key === "order-88" && op.type === "insert") {
        sim.after(60, () => {
          sim.write("B", { type: "update", key: "order-88", val: "paid", label: "88 paid", short: "paid" });
        });
      }
    };
    const ins = sim.write("A", { type: "insert", key: "order-88", val: "placed", label: "insert 88", short: "insert" });
    sim.setDelay("A", "C", null, false);
    return ins;
  };
  return sim;
}
