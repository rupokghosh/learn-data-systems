// Chapter 5, lesson 5: detecting concurrent writes. Two models on the shared Sim:
//  1. one server with a version number per key, keeping sibling values for concurrent writes;
//  2. three replicas with version vectors, syncing with each other.
// DOM-free.
import { Sim, compareVV, mergeVV } from "./ch5-sim.js";

// ---------------------------------------------------------------- model 1
export const POOLS = { noor: ["tent", "stove", "map", "kettle"], felix: ["lantern", "rope", "snacks", "tarp"] };

/** Union of every sibling's items, minus anything a sibling recorded as removed (when tombstones are on). */
export function mergeSiblings(siblings, useTombs) {
  const items = [], tombs = new Set();
  for (const s of siblings) {
    for (const x of s.items) if (!items.includes(x)) items.push(x);
    if (useTombs) for (const x of s.tombs) tombs.add(x);
  }
  return { items: items.filter((x) => !tombs.has(x)), tombs: [...tombs] };
}

export function siblingStore({ seed = 3, delay = 160, tombstones = false } = {}) {
  const sim = new Sim({ seed, delay, jitter: 0.1 });
  sim.cfg = { tombstones };
  sim.addNode("server", { counter: 0, siblings: [] });
  for (const id of ["noor", "felix"]) sim.addNode(id, { known: 0, items: [], tombs: [], next: 0, lastSiblings: [] });
  const vlab = (sibs) => sibs.length > 1 ? `${sibs.length} values` : "1 value";

  function reply(node, to, kind) {
    const sibs = node.siblings.map((s) => ({ ...s, items: [...s.items], tombs: [...s.tombs] }));
    sim.send(node.id, to, kind, { ver: node.counter, siblings: sibs }, { label: `v${node.counter} · ${vlab(sibs)}`, cls: sibs.length > 1 ? "hint" : "ok" });
  }
  sim.on("put", (node, m) => {
    const { items, tombs, ver } = m.payload;
    node.counter += 1;
    // Overwrite everything the client had seen (version <= ver); keep what it had not seen.
    const before = node.siblings.length;
    node.siblings = node.siblings.filter((s) => s.ver > ver);
    node.siblings.push({ ver: node.counter, items, tombs, by: m.from });
    sim.mark("server", `v${node.counter}`, node.siblings.length > 1 ? "hint" : "write");
    sim.lastPut = { by: m.from, based: ver, ver: node.counter, kept: node.siblings.length - 1, dropped: before - (node.siblings.length - 1) };
    reply(node, m.from, "ok");
  });
  sim.on("get", (node, m) => reply(node, m.from, "value"));
  const absorb = (node, m) => {
    const { ver, siblings } = m.payload;
    node.known = ver;
    node.lastSiblings = siblings;
    const merged = mergeSiblings(siblings, sim.cfg.tombstones);
    node.items = merged.items;
    node.tombs = merged.tombs;
  };
  sim.on("ok", absorb);
  sim.on("value", absorb);

  const put = (id, label) => {
    const c = sim.node(id);
    sim.send(id, "server", "put", { items: [...c.items], tombs: sim.cfg.tombstones ? [...c.tombs] : [], ver: c.known }, { label: `${label}, v${c.known}`, cls: "write" });
  };
  sim.add = (id) => {
    const c = sim.node(id);
    const pool = POOLS[id];
    const i = c.next++;
    const item = pool[i % pool.length] + (i >= pool.length ? " " + (Math.floor(i / pool.length) + 1) : "");
    c.items.push(item);
    put(id, "+" + item);
    return item;
  };
  sim.remove = (id, item) => {
    const c = sim.node(id);
    c.items = c.items.filter((x) => x !== item);
    if (sim.cfg.tombstones && !c.tombs.includes(item)) c.tombs.push(item);
    put(id, "−" + item);
  };
  sim.read = (id) => sim.send(id, "server", "get", {}, { label: "read", cls: "read" });
  return sim;
}

/** The scripted example: [client, action, item?, explanation]. */
export const SIBLING_SCRIPT = [
  ["noor", "add", null, "Noor adds tent. She has read nothing yet, so she writes with version 0. The server stores it as v1."],
  ["felix", "add", null, "Felix adds lantern, also based on version 0: he has not seen Noor's write. The server cannot order the two, so it keeps both as siblings, v1 and v2, and returns both to Felix, who merges them."],
  ["noor", "add", null, "Noor adds stove to what she has, based on v1. The server overwrites v1, which she had seen, and keeps v2, which she had not. Siblings: v2 and v3."],
  ["felix", "add", null, "Felix adds rope to his merged list, based on v2. The server overwrites v2 and keeps v3. Siblings: v3 and v4."],
  ["felix", "remove", "stove", "Felix had merged v3 in his previous reply, so he has seen stove. He removes it, based on v4, which overwrites every sibling. One value: v5."],
  ["noor", "add", null, "Noor still only knows v3, which contains stove. She adds map based on v3, so her write is concurrent with v4 and v5. The server keeps v5, adds v6, and returns both. Noor merges them by taking the union."],
  ["felix", "read", null, "Felix reads, gets the same two siblings, and merges them the same way. Both now see the same list. The next write from either of them, based on v6, will collapse the siblings into one value."],
];

// ---------------------------------------------------------------- model 2
export const VV_NODES = ["A", "B", "C"];
const VALS = { A: ["21°", "22°", "20°"], B: ["19°", "18°", "17°"], C: ["23°", "24°", "25°"] };
export const fmtVV = (v) => VV_NODES.map((k) => `${k}${v[k] || 0}`).join(" ");

export function vvStore({ seed = 4, delay = 380 } = {}) {
  const sim = new Sim({ seed, delay, jitter: 0.1 });
  sim.events = [];
  for (const id of VV_NODES) sim.addNode(id, { vv: { A: 0, B: 0, C: 0 }, vals: [{ val: "20°", vv: { A: 0, B: 0, C: 0 } }], writes: 0 });

  function event(node, kind, note) {
    const ev = { ev: "e" + (sim.events.length + 1), node: node.id, vv: { ...node.vv }, vals: node.vals.map((x) => x.val), kind, note, t: sim.t };
    sim.events.push(ev);
    sim.mark(node.id, ev.ev, node.vals.length > 1 ? "hint" : kind === "write" ? "write" : "repl", { ev: ev.ev });
    return ev;
  }

  /** A client reads this replica's current value(s) and writes a new one over all of them. */
  sim.write = (id) => {
    const node = sim.node(id);
    const val = VALS[id][node.writes++ % VALS[id].length];
    node.vv = { ...node.vv, [id]: node.vv[id] + 1 };
    node.vals = [{ val, vv: { ...node.vv } }];
    return event(node, "write", `${id} writes ${val}`);
  };
  sim.sync = (from, to) => {
    const src = sim.node(from);
    sim.send(from, to, "sync", { vals: src.vals.map((x) => ({ val: x.val, vv: { ...x.vv } })) }, { label: fmtVV(src.vv), cls: "sync" });
  };
  sim.on("sync", (node, m) => {
    let vals = node.vals;
    for (const s of m.payload.vals) {
      if (vals.some((x) => ["after", "equal"].includes(compareVV(x.vv, s.vv)))) continue; // already have it, or something newer
      vals = vals.filter((x) => compareVV(x.vv, s.vv) !== "before"); // drop what the incoming value supersedes
      vals.push(s);
    }
    node.vals = vals;
    node.vv = vals.reduce((acc, x) => mergeVV(acc, x.vv), node.vv);
    event(node, "sync", `${node.id} receives from ${m.from}`);
  });
  sim.compare = (a, b) => {
    const A = sim.events.find((e) => e.ev === a), B = sim.events.find((e) => e.ev === b);
    return { A, B, rel: compareVV(A.vv, B.vv) };
  };
  return sim;
}

export const VV_EXAMPLE = [["write", "A"], ["sync", "A", "B"], ["write", "B"], ["write", "C"], ["sync", "B", "C"], ["write", "C"]];
