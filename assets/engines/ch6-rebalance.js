// Chapter 6, lesson 3: DOM-free rebalancing strategies.
// Three ways to assign 1,000 keys to nodes, and an exact count of the keys
// that change owner when a node is added or removed.
import { hash32, pad } from "./ch6-partition.js";

export const NKEYS = 1000;
export const KEYS = Array.from({ length: NKEYS }, (_, i) => "item:" + pad(i, 4));
export const KEY_HASH = KEYS.map((k) => hash32(k));
export const NODE_IDS = ["A", "B", "C", "D", "E", "F", "G", "H"];
export const MIN_NODES = 2, MAX_NODES = 8;
export const NUM_PARTITIONS = 64;

// ---------- hash mod N ----------
function modN(nodes) {
  return { name: "modn", nodes: [...nodes], owners: KEY_HASH.map((h) => nodes[h % nodes.length]) };
}

// ---------- fixed number of partitions ----------
export const KEY_PART = KEY_HASH.map((h) => (h >>> 7) % NUM_PARTITIONS);

function fixedInit(nodes) {
  const assign = Array.from({ length: NUM_PARTITIONS }, (_, p) => nodes[p % nodes.length]);
  return fixedState(nodes, assign, []);
}
function fixedState(nodes, assign, moved) {
  return { name: "fixed", nodes: [...nodes], assign, movedParts: moved, owners: KEY_PART.map((p) => assign[p]) };
}
const countBy = (arr, nodes) => { const m = new Map(nodes.map((n) => [n, 0])); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };

/** New node steals whole partitions, one at a time, from whichever node has the most. */
function fixedAdd(st, node) {
  const nodes = [...st.nodes, node];
  const assign = [...st.assign];
  const target = Math.floor(NUM_PARTITIONS / nodes.length);
  const moved = [];
  for (let i = 0; i < target; i++) {
    const c = countBy(assign, st.nodes);
    const donor = st.nodes.reduce((a, b) => (c.get(b) > c.get(a) ? b : a));
    let p = -1;
    for (let q = NUM_PARTITIONS - 1; q >= 0; q--) if (assign[q] === donor) { p = q; break; }
    assign[p] = node;
    moved.push(p);
  }
  return fixedState(nodes, assign, moved);
}

/** A leaving node hands each of its partitions to whichever remaining node has the fewest. */
function fixedRemove(st, node) {
  const nodes = st.nodes.filter((n) => n !== node);
  const assign = [...st.assign];
  const moved = [];
  for (let p = 0; p < NUM_PARTITIONS; p++) {
    if (assign[p] !== node) continue;
    const c = countBy(assign.filter((x) => x !== node), nodes);
    const taker = nodes.reduce((a, b) => (c.get(b) < c.get(a) ? b : a));
    assign[p] = taker;
    moved.push(p);
  }
  return fixedState(nodes, assign, moved);
}

// ---------- consistent hashing ring ----------
export const tokenPos = (node, t) => hash32(`node:${node}#token:${t}`);

function ring(nodes, tokens) {
  const toks = [];
  for (const n of nodes) for (let t = 0; t < tokens; t++) toks.push({ pos: tokenPos(n, t), node: n });
  toks.sort((a, b) => a.pos - b.pos);
  const owners = KEY_HASH.map((h) => {
    let lo = 0, hi = toks.length; // first token with pos >= h, wrapping to the first token
    while (lo < hi) { const m = (lo + hi) >> 1; if (toks[m].pos < h) lo = m + 1; else hi = m; }
    return toks[lo === toks.length ? 0 : lo].node;
  });
  return { name: "ring", nodes: [...nodes], tokens, toks, owners };
}

// ---------- cluster: all three strategies side by side ----------
export function createCluster({ nodes = 4, tokens = 8 } = {}) {
  let ids = NODE_IDS.slice(0, nodes);
  let st = { modn: modN(ids), fixed: fixedInit(ids), ring: ring(ids, tokens) };
  let last = null;

  function diff(before, after) {
    const moved = [];
    for (let i = 0; i < NKEYS; i++) if (before.owners[i] !== after.owners[i]) moved.push(i);
    return moved;
  }

  function change(kind) {
    let next, node;
    if (kind === "add") {
      if (ids.length >= MAX_NODES) return null;
      node = NODE_IDS.find((n) => !ids.includes(n));
      next = [...ids, node];
    } else {
      if (ids.length <= MIN_NODES) return null;
      node = ids[ids.length - 1];
      next = ids.filter((n) => n !== node);
    }
    const ns = {
      modn: modN(next),
      fixed: kind === "add" ? fixedAdd(st.fixed, node) : fixedRemove(st.fixed, node),
      ring: ring(next, st.ring.tokens),
    };
    const moved = {};
    for (const k of Object.keys(ns)) moved[k] = diff(st[k], ns[k]);
    // The fewest keys a scheme could move: on add, a fair share for the new node;
    // on remove, exactly the keys the leaving node held under that scheme.
    const ideal = {};
    for (const k of Object.keys(ns)) ideal[k] = kind === "add"
      ? Math.round(NKEYS / next.length)
      : st[k].owners.filter((o) => o === node).length;
    last = { kind, node, moved, ideal, before: st, nodesBefore: ids.length, nodesAfter: next.length };
    ids = next;
    st = ns;
    return last;
  }

  function setTokens(t) {
    st.ring = ring(ids, t);
    last = null;
  }

  function loads(k) {
    const c = countBy(st[k].owners, ids);
    return ids.map((n) => ({ node: n, keys: c.get(n) }));
  }

  return {
    get nodes() { return [...ids]; },
    get state() { return st; },
    get last() { return last; },
    change, setTokens, loads,
  };
}
