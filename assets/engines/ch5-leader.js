// Chapter 5, lesson 1: single-leader replication with sync/async followers,
// catch-up after a crash, manual failover, and an optional fence for an old
// leader that comes back. Built on the shared Sim. DOM-free.
import { Sim } from "./ch5-sim.js";

export const DB_NODES = ["n1", "n2", "n3", "n4"];
export const CLIENTS = ["app", "cron"];
// Rough "distance" of each machine: n4 sits in a far-away region.
const ZONE = { app: 0.5, cron: 0.5, n1: 0.5, n2: 1.6, n3: 2.2, n4: 3 };

/**
 * opts.base: base one-way delay (simulated ms)
 * opts.sync: Set of node ids that replicate synchronously while they are followers
 * opts.fence: when a deposed leader restarts, make it step down (true) or let it keep leading (false)
 */
export function leaderCluster({ seed = 7, base = 120, sync = new Set(), fence = true } = {}) {
  const sim = new Sim({ seed, delay: base, jitter: 0.15, dropOnCrash: true });
  sim.cfg = { base, sync, fence, detect: 0 };
  sim.writes = new Map();     // w -> { w, client, status: "sent" | "acked" | "refused", leader }
  sim.discarded = [];         // { node, w } entries an old leader threw away when it stepped down
  sim.failovers = [];
  sim.leader = "n1";
  sim.epoch = 1;
  let nextW = 1;

  for (const id of DB_NODES) {
    sim.addNode(id, {
      role: id === "n1" ? "leader" : "follower", leader: "n1", epoch: 1, log: [],
      followers: id === "n1" ? DB_NODES.filter((x) => x !== id) : [], match: {}, pending: [],
    });
  }
  for (const id of CLIENTS) sim.addNode(id, { target: "n1" });
  for (const a of [...DB_NODES, ...CLIENTS]) for (const b of [...DB_NODES, ...CLIENTS]) {
    if (a !== b) sim.setDelay(a, b, () => sim.cfg.base * Math.max(ZONE[a], ZONE[b]), false);
  }

  const isSync = (id) => sim.cfg.sync.has(id);

  function checkPending(node) {
    const need = node.followers.filter(isSync);
    node.pending = node.pending.filter((p) => {
      if (!need.every((f) => (node.match[f] || 0) > p.idx)) return true;
      sim.send(node.id, p.client, "ok", { w: p.w }, { label: "ok w" + p.w, cls: "ok" });
      return false;
    });
  }
  sim.checkPending = () => { const n = sim.node(sim.leader); if (n.up) checkPending(n); for (const id of DB_NODES) { const x = sim.node(id); if (x.up && x.role === "leader" && x.id !== sim.leader) checkPending(x); } };

  sim.on("write", (node, m) => {
    const { w } = m.payload;
    if (node.role !== "leader") {
      sim.send(node.id, m.from, "refused", { w }, { label: "not leader", cls: "bad" });
      return;
    }
    const idx = node.log.length;
    node.log.push({ w, epoch: node.epoch });
    Object.assign(sim.writes.get(w), { leader: node.id, at: sim.t });
    sim.mark(node.id, "w" + w, "write");
    for (const f of node.followers) sim.send(node.id, f, "repl", { idx, w, epoch: node.epoch }, { label: null, cls: "repl" });
    node.pending.push({ w, idx, client: m.from });
    checkPending(node);
  });

  sim.on("repl", (node, m) => {
    if (node.role !== "follower" || node.leader !== m.from) return; // not my leader: ignore
    const { idx, w, epoch } = m.payload;
    if (idx === node.log.length) node.log.push({ w, epoch });
    else if (idx > node.log.length) { sim.send(node.id, m.from, "catchup", { len: node.log.length }, { label: null, cls: "ctl" }); return; }
    sim.send(node.id, m.from, "ack", { len: node.log.length }, { label: null, cls: "ok" });
  });

  sim.on("ack", (node, m) => {
    if (node.role !== "leader") return;
    node.match[m.from] = Math.max(node.match[m.from] || 0, m.payload.len);
    checkPending(node);
  });

  sim.on("catchup", (node, m) => {
    if (node.role !== "leader") return;
    if (!node.followers.includes(m.from)) node.followers.push(m.from);
    const from = m.payload.len;
    node.log.slice(from).forEach((e, i) =>
      sim.send(node.id, m.from, "repl", { idx: from + i, w: e.w, epoch: e.epoch }, { label: i === 0 ? "catch up" : null, cls: "repl" }));
  });

  sim.on("ok", (node, m) => {
    const rec = sim.writes.get(m.payload.w);
    if (rec.status === "sent") rec.status = "acked";
    sim.mark(node.id, "ok", "ok");
  });
  sim.on("refused", (node, m) => {
    sim.writes.get(m.payload.w).status = "refused";
    sim.mark(node.id, "refused", "bad");
  });

  // A node learns about a newer leader: step down or re-point, drop entries the
  // new leader does not have, then ask for whatever it is missing.
  sim.on("newleader", (node, m) => {
    const { leader, epoch, log } = m.payload;
    if (CLIENTS.includes(node.id)) { node.target = leader; sim.mark(node.id, "→ " + leader, "ctl"); return; }
    if (epoch <= node.epoch) return;
    const wasLeader = node.role === "leader";
    node.epoch = epoch; node.role = "follower"; node.leader = leader; node.followers = []; node.pending = [];
    let p = 0;
    while (p < node.log.length && p < log.length && node.log[p].w === log[p]) p++;
    const dropped = node.log.splice(p);
    for (const e of dropped) sim.discarded.push({ node: node.id, w: e.w });
    if (wasLeader) sim.mark(node.id, dropped.length ? `steps down, drops ${dropped.length}` : "steps down", "bad");
    sim.send(node.id, leader, "catchup", { len: node.log.length }, { label: null, cls: "ctl" });
  });

  sim.onRecover = (n) => {
    if (!DB_NODES.includes(n.id)) return;
    const cur = sim.node(sim.leader);
    if (n.id === sim.leader) return; // the leader restarted before anyone replaced it
    if (n.epoch < sim.epoch) {
      if (n.role === "leader" && !sim.cfg.fence) { sim.mark(n.id, "still thinks it leads", "bad"); return; }
      if (cur.up) {
        if (!cur.followers.includes(n.id)) cur.followers.push(n.id);
        sim.send(cur.id, n.id, "newleader", { leader: cur.id, epoch: sim.epoch, log: cur.log.map((e) => e.w) }, { label: n.role === "leader" ? "fence" : "new leader", cls: "ctl" });
      }
      return;
    }
    if (n.role === "follower") sim.send(n.id, n.leader, "catchup", { len: n.log.length }, { label: null, cls: "ctl" });
  };

  // ---- public actions ----
  sim.write = (client) => {
    const w = nextW++;
    sim.writes.set(w, { w, client, status: "sent", leader: null });
    sim.send(client, sim.node(client).target, "write", { w }, { label: "w" + w, cls: "write" });
    return w;
  };
  sim.canFailover = () => !sim.node(sim.leader).up && !sim.failoverRunning && DB_NODES.some((id) => id !== sim.leader && sim.node(id).up);
  sim.failover = (timeout) => {
    if (!sim.canFailover()) return false;
    const old = sim.leader;
    sim.failoverRunning = true;
    sim.after(timeout, () => {
      sim.failoverRunning = false;
      const cands = DB_NODES.filter((id) => id !== old && sim.node(id).up && sim.node(id).role === "follower");
      if (!cands.length || sim.node(old).up) return;
      for (const id of cands) sim.mark(id, "timeout", "bad");
      // The most up-to-date follower wins, to lose as little as possible.
      cands.sort((a, b) => sim.node(b).log.length - sim.node(a).log.length || (a < b ? -1 : 1));
      const nl = sim.node(cands[0]);
      sim.epoch += 1;
      nl.role = "leader"; nl.leader = nl.id; nl.epoch = sim.epoch; nl.match = {}; nl.pending = [];
      nl.followers = DB_NODES.filter((x) => x !== nl.id && x !== old);
      sim.leader = nl.id;
      sim.failovers.push({ t: sim.t, from: old, to: nl.id });
      sim.mark(nl.id, "new leader", "ok");
      const log = nl.log.map((e) => e.w);
      for (const id of nl.followers) sim.send(nl.id, id, "newleader", { leader: nl.id, epoch: sim.epoch, log }, { label: null, cls: "ctl" });
      // Only the app is told. The cron job looked up the leader once, at startup.
      sim.send(nl.id, "app", "newleader", { leader: nl.id, epoch: sim.epoch, log }, { label: "reconfigure", cls: "ctl" });
    });
    return true;
  };

  /** Make every up node from an older epoch follow the current leader (the fence). */
  sim.fenceNow = () => {
    const cur = sim.node(sim.leader);
    if (!cur.up) return;
    for (const id of DB_NODES) {
      const n = sim.node(id);
      if (id === cur.id || !n.up || n.epoch >= sim.epoch) continue;
      if (!cur.followers.includes(id)) cur.followers.push(id);
      sim.send(cur.id, id, "newleader", { leader: cur.id, epoch: sim.epoch, log: cur.log.map((e) => e.w) }, { label: "fence", cls: "ctl" });
    }
  };

  /** Acknowledged writes that the current leader does not have. */
  sim.lostWrites = () => {
    const have = new Set(sim.node(sim.leader).log.map((e) => e.w));
    return [...sim.writes.values()].filter((r) => r.status === "acked" && !have.has(r.w)).map((r) => r.w);
  };
  /** Nodes that currently accept writes as leader and are up. */
  sim.activeLeaders = () => DB_NODES.filter((id) => sim.node(id).up && sim.node(id).role === "leader");
  return sim;
}
