// Chapter 9: a linearizability checker for a single read/write register.
// DOM-free. An operation is { id, client, type: "w" | "r", value, start, end }.
// A write stores `value`; a read returned `value`.
//
// The checker searches for a total order of all operations that
//   1. respects real time: if a ends before b starts, a comes first, and
//   2. is legal for a register: every read returns the most recent write
//      in that order (or the initial value if there is none).
// It is a depth-first search over "which operation takes effect next",
// with memoization on (set of operations placed, current register value).

/** a must take effect before b because a finished before b began. */
export const precedes = (a, b) => a.end < b.start;

/**
 * @returns {{ ok: boolean, order: number[], points: number[], explored: number,
 *             stuck?: { placed: number[], value: any, blocked: number[] } }}
 * order: indexes into ops in linearization order (when ok).
 * points: linearization time for each op (indexed like ops) when ok.
 * stuck: the deepest partial order the search reached when not ok, the register
 *        value at that point, and the operations that could not go next.
 */
export function check(ops, initial = 0) {
  const n = ops.length;
  if (n > 20) throw new Error("too many operations for the checker");
  const full = n === 0 ? 0 : 2 ** n - 1;
  const failed = new Set();
  const order = [];
  let explored = 0;
  let best = { placed: [], value: initial, blocked: [] };

  // must[i]: bitmask of operations that must precede i.
  const must = ops.map((a) => ops.reduce((m, b, j) => (precedes(b, a) ? m + 2 ** j : m), 0));
  const has = (mask, i) => Math.floor(mask / 2 ** i) % 2 === 1;
  const covers = (mask, req) => {
    for (let j = 0; j < n; j++) if (has(req, j) && !has(mask, j)) return false;
    return true;
  };

  function dfs(mask, value) {
    explored++;
    if (mask === full) return true;
    const key = mask + "|" + value;
    if (failed.has(key)) return false;
    const blocked = [];
    for (let i = 0; i < n; i++) {
      if (has(mask, i) || !covers(mask, must[i])) continue;
      const op = ops[i];
      if (op.type === "r" && op.value !== value) { blocked.push(i); continue; }
      order.push(i);
      if (dfs(mask + 2 ** i, op.type === "w" ? op.value : value)) return true;
      order.pop();
    }
    if (blocked.length && order.length >= best.placed.length) best = { placed: [...order], value, blocked };
    failed.add(key);
    return false;
  }

  const ok = dfs(0, initial);
  if (!ok) return { ok, order: [], points: [], explored, stuck: best };
  return { ok, order: [...order], points: pointsFor(ops, order), explored };
}

/**
 * Choose a time inside each operation's interval so that the times increase
 * along the linearization order. Prefers the middle of each bar when possible.
 */
export function pointsFor(ops, order) {
  const m = order.length;
  const lo = new Array(m), hi = new Array(m);
  for (let k = 0; k < m; k++) {
    const op = ops[order[k]];
    lo[k] = Math.max(op.start, k ? lo[k - 1] : -Infinity);
  }
  for (let k = m - 1; k >= 0; k--) {
    const op = ops[order[k]];
    hi[k] = Math.min(op.end, k < m - 1 ? hi[k + 1] : Infinity);
  }
  const points = new Array(ops.length);
  let prev = -Infinity;
  for (let k = 0; k < m; k++) {
    const op = ops[order[k]];
    const mid = (op.start + op.end) / 2;
    let t = Math.min(Math.max(mid, lo[k]), hi[k]);
    t = Math.min(Math.max(t, prev), hi[k]);
    points[order[k]] = t;
    prev = t;
  }
  return points;
}

/** Preset histories. Times run from 0 to 100. Clients are 0, 1, 2. */
export const PRESETS = {
  ok: [
    { client: 0, type: "w", value: 1, start: 4, end: 26 },
    { client: 1, type: "r", value: 0, start: 8, end: 18 },
    { client: 2, type: "r", value: 1, start: 16, end: 34 },
    { client: 1, type: "r", value: 1, start: 38, end: 52 },
    { client: 0, type: "w", value: 2, start: 44, end: 70 },
    { client: 2, type: "r", value: 2, start: 58, end: 78 },
    { client: 1, type: "r", value: 2, start: 76, end: 92 },
  ],
  stale: [
    { client: 0, type: "w", value: 1, start: 6, end: 28 },
    { client: 1, type: "r", value: 1, start: 34, end: 50 },
    { client: 2, type: "r", value: 0, start: 56, end: 74 },
  ],
  flip: [
    { client: 0, type: "w", value: 1, start: 6, end: 80 },
    { client: 1, type: "r", value: 1, start: 14, end: 32 },
    { client: 2, type: "r", value: 0, start: 40, end: 58 },
  ],
};
