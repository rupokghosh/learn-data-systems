// Chapter 5, lesson 4: Dynamo-style leaderless replication with quorums,
// read repair, anti-entropy, and sloppy quorums with hinted handoff.
// Built on the shared Sim. DOM-free.
import { Sim } from "./ch5-sim.js";

export const SPARES = ["S1", "S2"];

export function quorumCluster({ n = 3, w = 2, r = 2, sloppy = false, seed = 11, base = 200 } = {}) {
  // Requests are independent, so a later message may overtake an earlier one on the same link.
  const sim = new Sim({ seed, delay: base, fifo: false });
  sim.cfg = { n, w, r, sloppy, base };
  sim.home = Array.from({ length: n }, (_, i) => "R" + (i + 1));
  sim.latest = 0;     // newest version whose write was reported successful
  sim.attempted = 0;  // newest version anyone tried to write
  sim.ops = [];
  sim.addNode("C");
  for (const id of [...sim.home, ...SPARES]) sim.addNode(id, { ver: 0, hints: [] });
  // Every message gets its own random delay, so replies come back in a different order each time.
  // About one message in three hits a slow path (a busy node, a retransmit): latency has a long tail.
  const lat = (s) => base * (0.35 + 0.6 * s.rand()) + (s.rand() < 0.3 ? base * (0.8 + 1.6 * s.rand()) : 0);
  for (const id of [...sim.home, ...SPARES]) {
    for (const [a, b] of [["C", id], [id, "C"]]) sim.setDelay(a, b, lat, false);
  }
  const timeoutMs = () => 2 * 3.4 * base + 60;

  sim.lastWrite = () => [...sim.ops].reverse().find((o) => o.type === "write");
  sim.lastRead = () => [...sim.ops].reverse().find((o) => o.type === "read");

  sim.write = () => {
    const ver = ++sim.attempted;
    const op = { type: "write", ver, need: sim.cfg.w, acks: [], targets: [], decided: false, ok: false, t: sim.t };
    sim.ops.push(op);
    let targets = sim.home.map((to) => ({ to }));
    if (sim.cfg.sloppy) {
      // The coordinator knows which home replicas are down and asks stand-ins to hold their copies.
      const down = sim.home.filter((id) => !sim.node(id).up);
      const spares = SPARES.filter((id) => sim.node(id).up);
      targets = sim.home.filter((id) => sim.node(id).up).map((to) => ({ to }));
      down.forEach((d, i) => { if (spares[i]) targets.push({ to: spares[i], hintFor: d }); });
    }
    op.targets = targets;
    for (const t of targets) sim.send("C", t.to, "put", { ver, op: sim.ops.length - 1, hintFor: t.hintFor }, { label: "v" + ver, cls: t.hintFor ? "hint" : "write" });
    sim.after(timeoutMs(), () => {
      if (op.decided) return;
      op.decided = true;
      sim.mark("C", `write v${ver} failed`, "bad");
    });
    return op;
  };

  sim.on("put", (node, m) => {
    const { ver, hintFor, repair } = m.payload;
    if (hintFor) node.hints.push({ for: hintFor, ver });
    else if (ver > node.ver) node.ver = ver;
    if (!repair) sim.send(node.id, "C", "ack", { op: m.payload.op }, { label: null, cls: "ok" });
  });
  sim.on("ack", (node, m) => {
    const op = sim.ops[m.payload.op];
    op.acks.push(m.from);
    if (!op.decided && op.acks.length >= op.need) {
      op.decided = true; op.ok = true;
      sim.latest = Math.max(sim.latest, op.ver);
      sim.mark("C", `v${op.ver} ok`, "ok");
    }
  });

  sim.read = () => {
    const op = { type: "read", need: sim.cfg.r, replies: [], counted: [], decided: false, result: null, stale: false, latestAtStart: sim.latest, repaired: [], t: sim.t };
    sim.ops.push(op);
    const idx = sim.ops.length - 1;
    sim.home.forEach((to, i) => sim.send("C", to, "get", { op: idx }, { label: i === 0 ? "read" : null, cls: "read" }));
    sim.after(timeoutMs(), () => {
      if (op.decided) return;
      op.decided = true;
      sim.mark("C", "read failed", "bad");
    });
    return op;
  };
  sim.on("get", (node, m) => sim.send(node.id, "C", "reply", { op: m.payload.op, ver: node.ver }, { label: "v" + node.ver, cls: "reply" }));
  sim.on("reply", (node, m) => {
    const op = sim.ops[m.payload.op];
    op.replies.push({ from: m.from, ver: m.payload.ver });
    if (!op.decided && op.replies.length >= op.need) {
      op.decided = true;
      op.counted = op.replies.map((x) => x.from);
      op.result = Math.max(...op.replies.map((x) => x.ver));
      op.stale = op.result < op.latestAtStart;
      sim.mark("C", `read v${op.result}`, op.stale ? "stale" : "reply");
      for (const x of op.replies) repair(op, x);
    } else if (op.decided && op.result != null) repair(op, op.replies[op.replies.length - 1]);
  });
  // Read repair: any replica that answered with an older version gets the newer one.
  function repair(op, x) {
    if (x.ver >= op.result || op.result === 0) return;
    op.repaired.push(x.from);
    sim.send("C", x.from, "put", { ver: op.result, repair: true }, { label: "repair", cls: "repair" });
  }

  // Hinted handoff: when a home replica comes back, stand-ins hand over what they held for it.
  sim.onRecover = (node) => {
    if (!sim.home.includes(node.id)) return;
    for (const s of SPARES) {
      const sp = sim.node(s);
      const mine = sp.hints.filter((h) => h.for === node.id);
      if (!mine.length || !sp.up) continue;
      sp.hints = sp.hints.filter((h) => h.for !== node.id);
      const ver = Math.max(...mine.map((h) => h.ver));
      sim.send(s, node.id, "put", { ver, repair: true }, { label: "handoff", cls: "hint", delay: base * 1.6 });
    }
  };

  /** Anti-entropy: a background process copies the newest version to every running replica that lacks it. */
  sim.antiEntropy = () => {
    const up = sim.home.filter((id) => sim.node(id).up);
    if (!up.length) return 0;
    const src = up.reduce((a, b) => (sim.node(b).ver > sim.node(a).ver ? b : a));
    const ver = sim.node(src).ver;
    let k = 0;
    for (const id of up) if (sim.node(id).ver < ver) { k++; sim.send(src, id, "put", { ver, repair: true }, { label: "sync", cls: "repair", delay: base * 0.8 }); }
    return k;
  };
  return sim;
}
