// Chapter 6, lesson 4: a small deterministic discrete-event model of request routing.
// Three routing styles (any node forwards, a routing tier, partition-aware clients),
// a coordination service that holds the partition map, and partition moves that
// open a window in which some components still route by an old map.
import { hash32 } from "./ch6-partition.js";

export const NODES = ["A", "B", "C"];
export const NPARTS = 6;
export const partOf = (key) => hash32(key) % NPARTS;
const INITIAL = ["A", "A", "B", "B", "C", "C"];

const NAMES = ["ana", "bo", "cleo", "dev", "eli", "fay", "gus", "hana", "ivo", "jun", "kai", "lin", "mo", "nia", "oto", "pia", "quin", "rae", "sol", "tam", "uma", "vik", "wen", "xia", "yan", "zed"];
/** One example key per partition, in partition order. */
export const KEYS = (() => {
  const out = new Array(NPARTS).fill(null);
  for (const n of NAMES) { const k = "cart:" + n; const p = partOf(k); if (!out[p]) out[p] = k; }
  return out;
})();

export const HOP_MS = 520, COPY_MS = 1500, REGISTER_MS = 420;
export const LABEL = { client: "Client", router: "Routing tier", zk: "ZooKeeper", A: "Node A", B: "Node B", C: "Node C" };

export function createRouting({ mode = "tier", notifyDelay = 1800, probe = true } = {}) {
  let t = 0, seq = 0, rid = 0, rr = 0;
  const msgs = [];      // messages in flight
  const timers = [];    // { at, fn }
  const log = [];
  const owns = { A: new Set([0, 1]), B: new Set([2, 3]), C: new Set([4, 5]) };
  const hint = { A: {}, B: {}, C: {} }; // where a node sent a partition it gave away
  // A map has an owner and a version per partition; v is the newest entry, shown as the map version.
  const mk = (v, owner, ver = owner.map(() => v)) => ({ v, owner: [...owner], ver: [...ver] });
  let epoch = 7; // version counter for gossiped changes
  const zk = mk(7, INITIAL);
  const maps = { router: mk(7, INITIAL), client: mk(7, INITIAL), A: mk(7, INITIAL), B: mk(7, INITIAL), C: mk(7, INITIAL) };
  const moving = new Map(); // partition -> { from, to }
  const reqs = new Map();
  const stats = { sent: 0, done: 0, redirected: 0, lastHops: null, lastKey: null, lastRedirected: false };
  const cfg = { notifyDelay, probe };

  const say = (text, kind = "") => { log.push({ t, text, kind }); if (log.length > 60) log.shift(); };
  const ownerOf = (p) => NODES.find((n) => owns[n].has(p));
  const holders = () => (mode === "any" ? NODES : mode === "tier" ? ["router"] : ["client"]);
  const latestV = () => (mode === "any" ? epoch : zk.v);

  function send(from, to, kind, data = {}, delay = HOP_MS) {
    const m = { id: ++seq, from, to, kind, data, sendT: t, arriveT: t + delay };
    msgs.push(m);
    if (data.rid) reqs.get(data.rid).hops++;
    return m;
  }
  const later = (ms, fn) => timers.push({ at: t + ms, fn });

  // ---------- requests ----------
  function request(key, { via } = {}) {
    const id = ++rid, p = partOf(key);
    reqs.set(id, { key, p, hops: 0, redirected: false });
    stats.sent++;
    const data = { rid: id, key, p, path: ["client"] };
    if (mode === "any") {
      const contact = via || NODES[rr++ % NODES.length];
      say(`Client sends get(${key}) to node ${contact}; any node will do.`);
      send("client", contact, "req", data);
    } else if (mode === "tier") {
      say(`Client sends get(${key}) to the routing tier.`);
      send("client", "router", "req", data);
    } else {
      const to = maps.client.owner[p];
      say(`Client looks up P${p} in its map v${maps.client.v}: node ${to}. It sends get(${key}) there directly.`);
      send("client", to, "req", data);
    }
    return id;
  }

  function onReq(m) {
    const { rid: id, key, p, path } = m.data;
    const at = m.to;
    if (at === "router") {
      const to = maps.router.owner[p];
      say(`Routing tier looks up P${p} in map v${maps.router.v}: node ${to}.`);
      send("router", to, "req", { ...m.data, path: [...path, "router"] });
      return;
    }
    if (owns[at].has(p)) {
      say(`Node ${at} owns P${p} and serves get(${key}).`, "ok");
      const back = [...path];
      send(at, back.pop(), "res", { rid: id, key, path: back });
      return;
    }
    const r = reqs.get(id);
    // In the any-node style the first node forwarding to the owner is normal coordination.
    // Reaching a second node that does not own the partition means someone routed by a stale map.
    if (mode !== "any" || path.length > 1) r.redirected = true;
    let next = hint[at][p] ?? maps[at].owner[p];
    if (!next || next === at) next = ownerOf(p);
    if (mode === "any") {
      say(hint[at][p]
        ? `Node ${at} handed P${p} to ${next} and forwards get(${key}) there.`
        : `Node ${at} does not own P${p}. Its map says node ${next}, so it forwards the request.`, "warn");
      send(at, next, "req", { ...m.data, path: [...path, at] });
    } else {
      const back = [...path];
      const requester = back.pop();
      say(`Node ${at} no longer owns P${p}. It replies "moved to ${next}".`, "warn");
      send(at, requester, "moved", { rid: id, key, p, next, path: back });
    }
  }

  function onRes(m) {
    const { rid: id, key, path } = m.data;
    if (m.to !== "client") {
      const back = [...path];
      send(m.to, back.pop(), "res", { rid: id, key, path: back });
      return;
    }
    const r = reqs.get(id);
    stats.done++;
    stats.lastHops = r.hops;
    stats.lastKey = key;
    stats.lastRedirected = r.redirected;
    if (r.redirected) stats.redirected++;
    say(`Client has the value of ${key} after ${r.hops} hops${r.redirected ? ", including a detour through the old owner" : ""}.`, r.redirected ? "warn" : "ok");
    reqs.delete(id);
  }

  function onMoved(m) {
    const { rid: id, key, p, next, path } = m.data;
    const who = m.to === "router" ? "Routing tier" : "Client";
    const behind = maps[m.to].v < zk.v ? ` Its own map stays at v${maps[m.to].v} until ZooKeeper's notification arrives.` : "";
    say(`${who} retries get(${key}) at node ${next}.${behind}`, "warn");
    send(m.to, next, "req", { rid: id, key, p, path: [...path, m.to] });
  }

  // ---------- partition moves ----------
  function move(p, target) {
    const from = ownerOf(p);
    if (moving.has(p) || from === target) return false;
    moving.set(p, { from, to: target });
    say(`Rebalancing: node ${from} starts copying P${p} to node ${target}, and keeps serving it meanwhile.`);
    send(from, target, "copy", { p, from, to: target }, COPY_MS);
    return true;
  }

  function onCopy(m) {
    const { p, from, to } = m.data;
    owns[from].delete(p); owns[to].add(p);
    hint[from][p] = to;
    delete hint[to][p];
    moving.delete(p);
    say(`Handoff: node ${to} now owns P${p}. Node ${from} remembers where it went.`);
    if (mode === "any") {
      const v = ++epoch;
      for (const n of [from, to]) { maps[n].owner[p] = to; maps[n].ver[p] = v; maps[n].v = Math.max(maps[n].v, v); }
      for (const n of NODES) if (n !== from && n !== to) {
        say(`Node ${to} gossips map v${v} to node ${n}.`);
        send(to, n, "gossip", { map: mk(maps[to].v, maps[to].owner, maps[to].ver) }, cfg.notifyDelay);
      }
    } else {
      say(`Node ${to} records the new owner of P${p} in ZooKeeper.`);
      send(to, "zk", "register", { p, owner: to }, REGISTER_MS);
    }
    if (cfg.probe) {
      later(80, () => {
        const third = NODES.find((n) => n !== from && n !== to);
        say(`A request for ${KEYS[p]} arrives during the move.`);
        request(KEYS[p], { via: third });
      });
    }
  }

  function onRegister(m) {
    const { p, owner } = m.data;
    zk.v++; zk.owner[p] = owner;
    const sub = mode === "tier" ? "router" : "client";
    say(`ZooKeeper writes map v${zk.v} (P${p} on ${owner}) and notifies the ${sub === "router" ? "routing tier" : "client"}, which watches it.`);
    send("zk", sub, "notify", { map: mk(zk.v, zk.owner) }, cfg.notifyDelay);
  }

  function onMap(m) {
    const cur = maps[m.to], inc = m.data.map;
    if (m.kind === "gossip") {
      // merge entry by entry, keeping whichever version of each partition is newer
      inc.owner.forEach((o, p) => { if (inc.ver[p] > cur.ver[p]) { cur.owner[p] = o; cur.ver[p] = inc.ver[p]; } });
      cur.v = Math.max(...cur.ver);
    } else if (inc.v > cur.v) maps[m.to] = mk(inc.v, inc.owner);
    const who = m.to === "router" ? "Routing tier" : m.to === "client" ? "Client" : `Node ${m.to}`;
    say(`${who} now has map v${maps[m.to].v}.`, "ok");
  }

  const HANDLERS = { req: onReq, res: onRes, moved: onMoved, copy: onCopy, register: onRegister, notify: onMap, gossip: onMap };

  /** Advances simulated time by dt milliseconds, delivering messages in order. */
  function advance(dt) {
    const end = t + dt;
    for (;;) {
      // earliest event first; ties go to messages, then to the older message
      let mi = -1, ti = -1, best = Infinity;
      msgs.forEach((m, i) => {
        if (m.arriveT > end) return;
        if (m.arriveT < best || (m.arriveT === best && m.id < msgs[mi].id)) { best = m.arriveT; mi = i; }
      });
      timers.forEach((x, i) => { if (x.at <= end && x.at < best) { best = x.at; ti = i; mi = -1; } });
      if (mi < 0 && ti < 0) break;
      t = best;
      if (ti >= 0) { const [x] = timers.splice(ti, 1); x.fn(); }
      else { const [m] = msgs.splice(mi, 1); HANDLERS[m.kind](m); }
    }
    t = end;
  }

  /** Components whose map disagrees with where partitions actually live. */
  function stale() {
    return holders().filter((h) => maps[h].owner.some((o, p) => o !== ownerOf(p)));
  }

  return {
    mode, cfg, request, move, advance, stale, holders, ownerOf, latestV,
    get t() { return t; },
    get msgs() { return msgs; },
    get busy() { return msgs.length > 0 || timers.length > 0; },
    get log() { return log; },
    get stats() { return stats; },
    get moving() { return moving; },
    owns, maps, zk,
  };
}
