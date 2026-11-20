// Chapter 6, lesson 2: DOM-free model of secondary indexes on a partitioned dataset.
// Listings are partitioned by ID range. A secondary index on city is kept either
// per partition (local, document-partitioned) or partitioned by term (global).
import { rng } from "../charts.js";

export const NP = 4;
export const CITIES = ["Accra", "Kyoto", "Lima", "Lisbon", "Oslo"];
export const ID_RANGES = ["100 to 199", "200 to 299", "300 to 399", "400 to 499"];
export const TERM_RANGES = ["A to J", "K", "L", "M to Z"];

/** Listings are partitioned by ID range: 100 to 199 in partition 0, and so on. */
export const docPartition = (id) => Math.floor(id / 100) - 1;

/** The global index is partitioned by the first letter of the term. */
export function termPartition(city) {
  const c = city[0].toUpperCase();
  if (c <= "J") return 0;
  if (c === "K") return 1;
  if (c === "L") return 2;
  return 3;
}

export function createStore(seed = 11, perPartition = 5) {
  const rand = rng(seed);
  const docs = new Map(); // id -> city (the source of truth)
  const global = new Map(CITIES.map((c) => [c, new Set()])); // applied global index
  for (let p = 0; p < NP; p++) {
    const used = new Set();
    while (used.size < perPartition) used.add(100 * (p + 1) + Math.floor(rand() * 100));
    for (const id of used) {
      const city = CITIES[Math.floor(rand() * CITIES.length)];
      docs.set(id, city);
      global.get(city).add(id);
    }
  }

  /** Local index of one partition: city -> sorted ids. Always in step with its documents. */
  function localIndex(p) {
    const m = new Map();
    for (const [id, city] of docs) if (docPartition(id) === p) {
      if (!m.has(city)) m.set(city, []);
      m.get(city).push(id);
    }
    for (const ids of m.values()) ids.sort((a, b) => a - b);
    return m;
  }

  /** Entries of the global index stored on partition p (applied state). */
  function globalPart(p) {
    const m = new Map();
    for (const c of CITIES) if (termPartition(c) === p) m.set(c, [...global.get(c)].sort((a, b) => a - b));
    return m;
  }

  /** Documents of one partition, sorted by id. */
  const docsIn = (p) => [...docs].filter(([id]) => docPartition(id) === p).sort((a, b) => a[0] - b[0]);

  /** A read by city. Returns the partitions contacted and the result. */
  function query(city, mode) {
    const truth = [...docs].filter(([, c]) => c === city).map(([id]) => id).sort((a, b) => a - b);
    if (mode === "local") {
      const parts = Array.from({ length: NP }, (_, p) => p);
      return { parts, ids: truth, truth, missing: [], extra: [] };
    }
    const ids = [...global.get(city)].sort((a, b) => a - b);
    const missing = truth.filter((id) => !global.get(city).has(id));
    const extra = ids.filter((id) => docs.get(id) !== city);
    return { parts: [termPartition(city)], ids, truth, missing, extra };
  }

  /**
   * Writes a listing. Returns the partition holding the document and, for a
   * global index, the index operations that must reach other partitions.
   */
  function write(id, city, mode) {
    const old = docs.get(id) ?? null;
    docs.set(id, city);
    const docPart = docPartition(id);
    const ops = [];
    if (mode === "global" && old !== city) {
      if (old) ops.push({ part: termPartition(old), city: old, id, op: "remove" });
      ops.push({ part: termPartition(city), city, id, op: "add" });
    }
    if (mode === "local") syncGlobal(); // keep the unused global copy consistent
    const touched = new Set([docPart, ...ops.map((o) => o.part)]);
    return { docPart, old, ops, touched: [...touched].sort((a, b) => a - b) };
  }

  /** Applies one asynchronous global index operation when it arrives. */
  function applyOp(o) {
    if (o.op === "add") global.get(o.city).add(o.id);
    else global.get(o.city).delete(o.id);
  }

  /** Rebuilds the global index from the documents (used when switching modes). */
  function syncGlobal() {
    for (const c of CITIES) global.get(c).clear();
    for (const [id, c] of docs) global.get(c).add(id);
  }

  /** An unused id in a random partition. */
  function freshId(rand2) {
    for (;;) {
      const id = 100 + Math.floor(rand2() * 400);
      if (!docs.has(id)) return id;
    }
  }

  return { docs, localIndex, globalPart, docsIn, query, write, applyOp, syncGlobal, freshId };
}
