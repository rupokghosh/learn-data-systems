// Chapter 2: pure logic shared by the widgets. No DOM access, so it can be tested in Node.

const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

/* ---------- Normalization: renaming a city ---------- */

/** Which duplicated-text rows a rename must touch, and how many land before a crash. */
export function planRename(profiles, oldName, crash) {
  const targets = profiles.filter((p) => p.city === oldName).map((p) => p.id);
  const applied = crash ? Math.floor(targets.length / 2) : targets.length;
  return { targets, applied, done: targets.slice(0, applied), missed: targets.slice(applied) };
}

/* ---------- Query languages: loop versus planned query ---------- */

export const matches = (item, q) => item.price < q.maxPrice && item.inStock;

/** Split the table into contiguous chunks, one per worker. */
export function seqScanLanes(n, workers) {
  const w = Math.max(1, Math.min(workers, n));
  const size = Math.ceil(n / w);
  return range(0, w).map((k) => range(k * size, Math.min(n, (k + 1) * size))).filter((l) => l.length);
}

/** Walk a price index in ascending order and stop at the first entry that is too expensive. */
export function indexScanLane(items, q) {
  const order = items.map((_, i) => i).sort((a, b) => items[a].price - items[b].price || a - b);
  const lane = [];
  for (const i of order) {
    lane.push(i);
    if (items[i].price >= q.maxPrice) break;
  }
  return lane;
}

/** A toy planner: cost is the number of steps, one row examined per worker per step. */
export function choosePlan(items, q, { workers, hasIndex }) {
  const lanes = seqScanLanes(items.length, workers);
  const longest = Math.max(...lanes.map((l) => l.length));
  const seq = lanes.length > 1
    ? { kind: "parallel", lanes, scanSteps: longest, steps: longest + 1 }
    : { kind: "seq", lanes, scanSteps: longest, steps: longest };
  if (!hasIndex) return { chosen: seq, other: null };
  const lane = indexScanLane(items, q);
  const idx = { kind: "index", lanes: [lane], scanSteps: lane.length, steps: lane.length };
  return idx.steps < seq.steps ? { chosen: idx, other: seq } : { chosen: seq, other: idx };
}

/** For each step, which item each lane examines. Results come out in the order they are found. */
export function simulate(items, q, lanes) {
  const longest = Math.max(0, ...lanes.map((l) => l.length));
  const ticks = [];
  const results = [];
  for (let t = 0; t < longest; t++) {
    const tick = [];
    lanes.forEach((lane, li) => {
      if (t < lane.length) {
        const i = lane[t];
        const hit = matches(items[i], q);
        tick.push({ lane: li, item: i, hit });
        if (hit) results.push(i);
      }
    });
    ticks.push(tick);
  }
  return { ticks, results };
}

/* ---------- Graph: following WITHIN edges ---------- */

/** Follow WITHIN edges from a place up to a Country, then one more hop to its Continent. */
export function climb(graph, start) {
  const path = [];
  let cur = start;
  const seen = new Set([cur]);
  while (graph.nodes[cur] && graph.nodes[cur].label !== "Country") {
    const e = graph.edges.find((x) => x.type === "WITHIN" && x.from === cur);
    if (!e || seen.has(e.to)) return { path, country: null, continent: null, end: cur };
    path.push(e);
    cur = e.to;
    seen.add(cur);
  }
  if (!graph.nodes[cur]) return { path, country: null, continent: null, end: cur };
  const c = graph.edges.find((x) => x.type === "WITHIN" && x.from === cur && graph.nodes[x.to]?.label === "Continent");
  if (c) path.push(c);
  return { path, country: cur, continent: c ? c.to : null, end: c ? c.to : cur };
}

/** Evaluate the cross-continent pattern for one person. */
export function evaluatePerson(graph, pid) {
  const bornEdge = graph.edges.find((e) => e.type === "BORN_IN" && e.from === pid) || null;
  const livesEdge = graph.edges.find((e) => e.type === "LIVES_IN" && e.from === pid) || null;
  const born = bornEdge ? climb(graph, bornEdge.to) : null;
  const lives = livesEdge ? climb(graph, livesEdge.to) : null;
  const match = !!(born?.continent && lives?.continent && born.continent !== lives.continent);
  return { bornEdge, livesEdge, born, lives, match };
}

export function runQuery(graph) {
  return Object.keys(graph.nodes)
    .filter((id) => graph.nodes[id].label === "Person")
    .map((id) => ({ id, ...evaluatePerson(graph, id) }));
}

/** Point a person's BORN_IN or LIVES_IN edge somewhere else (or add it if missing). Returns a new graph. */
export function setEdge(graph, pid, type, to) {
  const edges = graph.edges.filter((e) => !(e.type === type && e.from === pid));
  edges.push({ id: `${pid}-${type}-${to}`, from: pid, to, type });
  return { nodes: graph.nodes, edges };
}
