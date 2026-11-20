// Chapter 5, lesson 2: three scripted stories about replication lag, each with
// a fix that can be switched on. Built on the shared Sim. DOM-free.
import { Sim } from "./ch5-sim.js";

/** A key-value replica group: one leader that applies puts and streams them to followers. */
function kvGroup(sim, leader, followers, initial = {}) {
  const mk = (id, role) => sim.addNode(id, { role, kv: new Map(Object.entries(initial)), pos: 0, waiting: [], followers: role === "leader" ? followers : [] });
  mk(leader, "leader");
  for (const f of followers) mk(f, "follower");
}

function installKV(sim, hooks) {
  sim.on("put", (node, m) => {
    const { key, value } = m.payload;
    node.pos += 1;
    node.kv.set(key, value);
    sim.mark(node.id, m.payload.short, "write");
    sim.send(node.id, m.from, "ok", { pos: node.pos, key }, { label: "ok", cls: "ok" });
    for (const f of node.followers) sim.send(node.id, f, "repl", { pos: node.pos, key, value, short: m.payload.short }, { label: null, cls: "repl" });
  });
  sim.on("repl", (node, m) => {
    const { pos, key, value, short } = m.payload;
    if (pos !== node.pos + 1) return;
    node.pos = pos;
    node.kv.set(key, value);
    sim.mark(node.id, short, "repl");
    // Reads that were waiting for this position can be answered now.
    node.waiting = node.waiting.filter((r) => {
      if (node.pos < r.payload.minPos) return true;
      answer(node, r);
      return false;
    });
  });
  function answer(node, m) {
    const values = m.payload.keys.map((k) => node.kv.get(k));
    const { label, cls } = hooks.replyLabel(node, m, values);
    sim.send(node.id, m.from, "reply", { values, keys: m.payload.keys, tag: m.payload.tag, pos: node.pos }, { label, cls });
  }
  sim.on("get", (node, m) => {
    if (m.payload.minPos && node.pos < m.payload.minPos) {
      node.waiting.push(m);
      sim.mark(node.id, "holds read", "hint");
      return;
    }
    answer(node, m);
  });
  sim.on("ok", (node, m) => hooks.ok?.(node, m));
  sim.on("reply", (node, m) => hooks.reply(node, m));
}

const between = (sim, a, b) => () => a + sim.rand() * (b - a);

export const SCENARIOS = {
  own: {
    title: "Read your own writes",
    fixes: [["none", "No fix"], ["leader", "Read own profile from the leader"], ["position", "Wait for my write position"]],
    seed: 3,
  },
  monotonic: {
    title: "Monotonic reads",
    fixes: [["none", "No fix"], ["sticky", "Sticky routing to one replica"]],
    seed: 3,
  },
  prefix: {
    title: "Consistent prefix reads",
    fixes: [["none", "No fix"], ["same", "Related writes in one partition"]],
    seed: 1,
  },
};

/**
 * Build one scenario. Returns a sim with:
 *   sim.lanes: [{ id, label }]
 *   sim.saw: [{ t, text, cls }]   what the person saw, in order
 *   sim.anomaly: true when the scenario's anomaly happened
 */
export function lagScenario(kind, { fix = "none", seed } = {}) {
  const sim = new Sim({ seed: seed ?? SCENARIOS[kind].seed, delay: 70, jitter: 0.2 });
  sim.saw = [];
  sim.anomaly = false;
  sim.fix = fix;
  const say = (text, cls = "") => sim.saw.push({ t: sim.t, text, cls });
  const pickFollower = () => (sim.rand() < 0.5 ? "A" : "B");

  if (kind === "own") {
    const OLD = "Harbour St 4", NEW = "Mill Lane 9";
    sim.lanes = [{ id: "ines", label: "Ines" }, { id: "L", label: "Leader" }, { id: "A", label: "Follower A" }, { id: "B", label: "Follower B" }];
    kvGroup(sim, "L", ["A", "B"], { address: OLD });
    sim.addNode("ines");
    sim.setDelay("L", "A", between(sim, 380, 520), false);
    sim.setDelay("L", "B", between(sim, 700, 1100), false);
    let myPos = 0;
    installKV(sim, {
      replyLabel: (node, m, [v]) => ({ label: v, cls: v === NEW ? "reply" : "stale" }),
      ok: (node, m) => {
        myPos = m.payload.pos;
        say(`"Address saved." The app reloads her profile.`);
        sim.after(30, () => {
          const to = fix === "leader" ? "L" : pickFollower();
          const payload = { keys: ["address"], minPos: fix === "position" ? myPos : 0 };
          sim.send("ines", to, "get", payload, { label: "read", cls: "read" });
        });
      },
      reply: (node, m) => {
        const v = m.payload.values[0];
        const from = m.from === "L" ? "the leader" : "follower " + m.from;
        if (v === NEW) say(`Profile from ${from} shows ${v}. Her change is there.`, "good");
        else { sim.anomaly = true; sim.mark(node.id, "old address", "bad"); say(`Profile from ${from} shows ${v}. Her change seems to have vanished.`, "bad"); }
      },
    });
    sim.after(40, () => {
      say(`Ines changes her delivery address from ${OLD} to ${NEW}.`);
      sim.send("ines", "L", "put", { key: "address", value: NEW, short: "Mill Ln" }, { label: "set address", cls: "write" });
    });
  }

  if (kind === "monotonic") {
    sim.lanes = [{ id: "desk", label: "Score desk" }, { id: "L", label: "Leader" }, { id: "A", label: "Follower A" }, { id: "B", label: "Follower B" }, { id: "tomas", label: "Tomas" }];
    kvGroup(sim, "L", ["A", "B"], { score: "1–1" });
    sim.addNode("desk");
    sim.addNode("tomas", { best: 0 });
    sim.setDelay("L", "A", between(sim, 150, 260), false);
    sim.setDelay("L", "B", between(sim, 1150, 1450), false);
    const rank = (s) => (s === "2–1" ? 2 : 1);
    installKV(sim, {
      replyLabel: (node, m, [v]) => ({ label: v, cls: "reply" }),
      reply: (node, m) => {
        const v = m.payload.values[0];
        const went = rank(v) < node.best;
        if (went) { sim.anomaly = true; sim.mark(node.id, "went back", "bad"); say(`Refresh ${m.payload.tag} (follower ${m.from}): ${v}. The goal he just saw is gone.`, "bad"); }
        else say(`Refresh ${m.payload.tag} (follower ${m.from}): ${v}.`, rank(v) === 2 ? "good" : "");
        node.best = Math.max(node.best, rank(v));
      },
    });
    sim.after(40, () => {
      say("The score desk records a goal: 2–1.");
      sim.send("desk", "L", "put", { key: "score", value: "2–1", short: "2–1" }, { label: "goal", cls: "write" });
    });
    // Sticky routing: hash the user ID to pick one replica, every time.
    const sticky = "B";
    [500, 950, 1750].forEach((t, i) => sim.schedule(t, () => {
      const to = fix === "sticky" ? sticky : pickFollower();
      sim.send("tomas", to, "get", { keys: ["score"], tag: i + 1 }, { label: "refresh", cls: "read" });
    }));
  }

  if (kind === "prefix") {
    sim.lanes = [{ id: "shop", label: "Shop app" }, { id: "P1", label: "P1 leader" }, { id: "P1f", label: "P1 follower" }, { id: "P2", label: "P2 leader" }, { id: "P2f", label: "P2 follower" }, { id: "dash", label: "Dashboard" }];
    kvGroup(sim, "P1", ["P1f"]);
    kvGroup(sim, "P2", ["P2f"]);
    sim.addNode("shop");
    sim.addNode("dash", { got: {} });
    sim.setDelay("P1", "P1f", between(sim, 950, 1250), false);
    sim.setDelay("P2", "P2f", between(sim, 110, 200), false);
    const orderPart = fix === "same" ? "P1" : "P2";
    installKV(sim, {
      replyLabel: (node, m, values) => ({ label: values.filter(Boolean).length ? values.filter(Boolean).map((v) => v.short).join(", ") : "nothing", cls: "reply" }),
      ok: (node, m) => {
        if (m.payload.key !== "product:K-17") return;
        say(`Catalogue confirms K-17. A customer buys one: order 5203 goes to partition ${orderPart === "P1" ? "1, next to the product" : "2"}.`);
        sim.send("shop", orderPart, "put", { key: "order:5203", value: { short: "order 5203", sku: "K-17" }, short: "order" }, { label: "order 5203", cls: "write" });
      },
      reply: (node, m) => {
        const r = node.got[m.payload.tag] || (node.got[m.payload.tag] = { n: 0, vals: {} });
        m.payload.keys.forEach((k, i) => { if (m.payload.values[i]) r.vals[k] = m.payload.values[i]; });
        r.n += 1;
        if (r.n < 2) return;
        const hasP = !!r.vals["product:K-17"], hasO = !!r.vals["order:5203"];
        if (hasO && !hasP) { sim.anomaly = true; sim.mark(node.id, "orphan order", "bad"); say(`Dashboard read ${m.payload.tag}: order 5203 for product K-17, but no product K-17 exists.`, "bad"); }
        else if (hasO && hasP) say(`Dashboard read ${m.payload.tag}: product K-17 and its order 5203.`, "good");
        else if (hasP) say(`Dashboard read ${m.payload.tag}: product K-17, no orders yet. Behind, but consistent.`);
        else say(`Dashboard read ${m.payload.tag}: nothing yet. Behind, but consistent.`);
      },
    });
    sim.after(40, () => {
      say("A merchant adds product K-17, a linen apron, to the catalogue (partition 1).");
      sim.send("shop", "P1", "put", { key: "product:K-17", value: { short: "K-17" }, short: "K-17" }, { label: "add K-17", cls: "write" });
    });
    const keys = ["product:K-17", "order:5203"];
    [700, 1650].forEach((t, i) => sim.schedule(t, () => {
      sim.send("dash", "P1f", "get", { keys, tag: i + 1 }, { label: i ? null : "read", cls: "read" });
      sim.send("dash", "P2f", "get", { keys, tag: i + 1 }, { label: null, cls: "read" });
    }));
  }
  return sim;
}
