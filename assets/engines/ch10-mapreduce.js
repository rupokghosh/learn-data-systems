// Chapter 10: a step-by-step MapReduce job (count views per product). DOM-free and deterministic.
//
// Phases: ready -> map -> shuffle -> merge -> reduce -> done.
// Each step() advances every task by one unit of work and returns a short description.

export const SPLITS = [
  { nodes: ["A", "D"], records: [["u17", "kettle"], ["u04", "lamp"], ["u17", "mug"], ["u22", "kettle"], ["u09", "rug"]] },
  { nodes: ["B", "A"], records: [["u31", "mug"], ["u04", "kettle"], ["u12", "lamp"], ["u31", "toaster"], ["u22", "mug"]] },
  { nodes: ["C", "B"], records: [["u09", "kettle"], ["u40", "rug"], ["u12", "mug"], ["u17", "toaster"], ["u40", "kettle"]] },
];

/** A deterministic string hash, standing in for Hadoop's key.hashCode(). */
export function hashKey(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h;
}
export const partitionOf = (key, n) => hashKey(key) % n;

const cmpKey = (a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);

export function createJob(splits = SPLITS, nReducers = 2) {
  const s = {
    phase: "ready",
    tick: 0,
    nReducers,
    splits: splits.map((sp, i) => ({ id: i, nodes: sp.nodes, records: sp.records.map(([user, product], j) => ({ id: `in${i}-${j}`, user, product })) })),
    mappers: splits.map((sp, i) => ({ id: i, split: i, node: sp.nodes[0], attempt: 1, pos: 0, sorted: false, status: "waiting", out: Array.from({ length: nReducers }, () => []) })),
    reducers: Array.from({ length: nReducers }, (_, r) => ({ id: r, runs: [], input: [], consumed: 0, out: [], status: "waiting" })),
    fetched: 0,
    emitted: 0,
    shuffled: 0,
    attempts: splits.length,
    lost: 0,
  };

  function step() {
    s.tick++;
    if (s.phase === "ready") s.phase = "map";
    if (s.phase === "map") return mapStep();
    if (s.phase === "shuffle") return shuffleStep();
    if (s.phase === "merge") return mergeStep();
    if (s.phase === "reduce") return reduceStep();
    return { text: "The job has finished." };
  }

  function mapStep() {
    const notes = [];
    for (const m of s.mappers) {
      if (m.status === "failed") {
        m.attempt++; s.attempts++;
        const sp = s.splits[m.split];
        m.node = sp.nodes[(m.attempt - 1) % sp.nodes.length];
        m.status = "running"; m.pos = 0; m.sorted = false;
        notes.push(`map task ${m.id + 1} restarts as attempt ${m.attempt} on node ${m.node}, which holds another replica of the block`);
        continue;
      }
      if (m.status === "done") continue;
      m.status = "running";
      const recs = s.splits[m.split].records;
      if (m.pos < recs.length) {
        const r = recs[m.pos];
        const p = partitionOf(r.product, s.nReducers);
        m.out[p].push({ id: `m${m.id}a${m.attempt}-${m.pos}`, from: r.id, k: r.product, v: 1, p });
        m.pos++; s.emitted++;
      } else if (!m.sorted) {
        m.out.forEach((part) => part.sort(cmpKey));
        m.sorted = true; m.status = "done";
        notes.push(`map task ${m.id + 1} sorts each partition and finishes`);
      }
    }
    if (s.mappers.every((m) => m.status === "done")) {
      s.phase = "shuffle";
      notes.push("every map task is done, so the shuffle can begin");
    }
    return { text: notes.length ? cap(notes.join("; ")) + "." : "Each running map task reads one record and emits (product, 1) into the partition chosen by hashing the product." };
  }

  function shuffleStep() {
    const m = s.mappers[s.fetched];
    for (let r = 0; r < s.nReducers; r++) {
      const run = m.out[r];
      s.reducers[r].runs.push(run);
      s.reducers[r].status = "fetching";
      s.shuffled += run.length;
    }
    m.out = m.out.map(() => []);
    s.fetched++;
    if (s.fetched === s.mappers.length) s.phase = "merge";
    return { text: `Each reducer copies its partition from map task ${m.id + 1}. The partitions arrive already sorted.` };
  }

  function mergeStep() {
    for (const red of s.reducers) {
      red.input = mergeRuns(red.runs);
      red.runs = [];
      red.status = "reducing";
    }
    s.phase = "reduce";
    return { text: "Each reducer merges its sorted runs into one sorted stream, so all values for a key sit next to each other." };
  }

  function reduceStep() {
    const notes = [];
    for (const red of s.reducers) {
      if (red.consumed >= red.input.length) { red.status = "done"; continue; }
      const k = red.input[red.consumed].k;
      let sum = 0, first = red.input[red.consumed].id;
      while (red.consumed < red.input.length && red.input[red.consumed].k === k) { sum += red.input[red.consumed].v; red.consumed++; }
      red.out.push({ id: `out${red.id}-${k}`, from: first, k, v: sum });
      notes.push(`reducer ${red.id + 1} sees ${sum} value${sum === 1 ? "" : "s"} for ${k} and writes (${k}, ${sum})`);
      if (red.consumed >= red.input.length) red.status = "done";
    }
    if (s.reducers.every((r) => r.consumed >= r.input.length)) { s.reducers.forEach((r) => (r.status = "done")); s.phase = "done"; }
    return { text: notes.length ? cap(notes.join("; ")) + "." : "The job has finished." };
  }

  /** Kill a map task. Allowed while the map phase runs. Its local output is lost and it must re-run. */
  function kill(i) {
    if (!canKill(i)) return null;
    const m = s.mappers[i];
    const lostRecs = m.out.flat().length;
    s.lost += lostRecs;
    m.status = "failed"; m.out = m.out.map(() => []); m.pos = 0; m.sorted = false;
    return { text: `Node ${m.node} dies. Map task ${i + 1} loses ${lostRecs} emitted record${lostRecs === 1 ? "" : "s"} from its local disk. The scheduler will re-run it from the start of its input split.` };
  }
  const canKill = (i) => (s.phase === "map" || s.phase === "ready") && s.mappers[i].status !== "failed" && s.phase !== "ready";

  return { state: s, step, kill, canKill, get done() { return s.phase === "done"; } };
}

/** k-way merge of sorted runs (stable: earlier runs win ties). */
export function mergeRuns(runs) {
  const idx = runs.map(() => 0), out = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < runs.length; i++) {
      if (idx[i] >= runs[i].length) continue;
      if (best < 0 || cmpKey(runs[i][idx[i]], runs[best][idx[best]]) < 0) best = i;
    }
    if (best < 0) return out;
    out.push(runs[best][idx[best]++]);
  }
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
