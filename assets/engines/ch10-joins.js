// Chapter 10: where records go in three batch join strategies. DOM-free.
//
// Data: listening events (user, track) joined with a users table (user, plan).
// Three join tasks. Partition function for user n: n mod 3.

export const USERS = [
  { n: 1, plan: "free" }, { n: 2, plan: "plus" }, { n: 3, plan: "free" }, { n: 4, plan: "family" },
  { n: 5, plan: "plus" }, { n: 6, plan: "free" }, { n: 7, plan: "plus" }, { n: 8, plan: "family" },
];
const BASE_EVENTS = [1, 4, 2, 7, 3, 5, 8, 1, 6, 2, 4, 3, 7, 5, 1, 8, 2, 6, 4, 3, 1, 5, 7, 2];
export const HOT_USER = 3;
export const HOT_EXTRA = 30;
export const TASKS = 3;
export const part = (n) => n % TASKS;

export function makeEvents(skew) {
  const ev = BASE_EVENTS.map((n, i) => ({ id: `e${i}`, kind: "event", n, hot: false }));
  if (skew) {
    // Interleave the hot user's extra events through the log, as a busy account would.
    const out = [];
    let h = 0;
    for (let i = 0; i < ev.length; i++) {
      out.push(ev[i]);
      while (h < HOT_EXTRA && h * ev.length < (i + 1) * HOT_EXTRA) { out.push({ id: `h${h}`, kind: "event", n: HOT_USER, hot: true }); h++; }
    }
    out.forEach((e) => { if (e.n === HOT_USER) e.hot = true; });
    return out;
  }
  return ev;
}
const userRecs = (skew) => USERS.map((u) => ({ id: `u${u.n}`, kind: "user", n: u.n, plan: u.plan, hot: skew && u.n === HOT_USER }));

const order = (a, b) => a.n - b.n || (a.kind === b.kind ? 0 : a.kind === "user" ? -1 : 1);

/**
 * Returns where every record starts (sources) and ends (tasks), plus counters.
 * strategy: "sortmerge" | "broadcast" | "partitioned".
 */
export function plan(strategy, { skew = false, split = false } = {}) {
  const events = makeEvents(skew);
  const users = userRecs(skew);
  const useSplit = split && skew && strategy === "sortmerge";
  const sources = [];
  const tasks = Array.from({ length: TASKS }, (_, t) => ({ id: t, mem: [], stream: [], memNote: "" }));

  if (strategy === "partitioned") {
    for (let p = 0; p < TASKS; p++) {
      sources.push({ id: `E${p}`, label: `Events, partition ${p + 1}`, sub: `machine ${"ABC"[p]} · users where n mod 3 = ${p}`, lanes: [events.filter((e) => part(e.n) === p)] });
    }
    sources.push({ id: "U", label: "Users, 3 partition files", sub: "machine D · same partitioning", lanes: [0, 1, 2].map((p) => users.filter((u) => part(u.n) === p)) });
    for (let p = 0; p < TASKS; p++) {
      tasks[p].label = `Map task ${p + 1}`;
      tasks[p].sub = `machine ${"ABC"[p]} · partition ${p + 1}`;
      tasks[p].mem = users.filter((u) => part(u.n) === p).map((u) => ({ ...u, net: true }));
      tasks[p].stream = events.filter((e) => part(e.n) === p).map((e) => ({ ...e, net: false }));
      tasks[p].memNote = "hash table: users of this partition";
    }
  } else {
    // Events in three blocks, assigned in log order (not by user).
    const blocks = [[], [], []];
    events.forEach((e, i) => blocks[i % TASKS].push(e));
    blocks.forEach((b, i) => sources.push({ id: `E${i}`, label: `Events, block ${i + 1}`, sub: `machine ${"ABC"[i]}`, lanes: [b] }));
    sources.push({ id: "U", label: "Users table", sub: "machine D · one file", lanes: [users] });

    if (strategy === "broadcast") {
      for (let t = 0; t < TASKS; t++) {
        tasks[t].label = `Map task ${t + 1}`;
        tasks[t].sub = `machine ${"ABC"[t]} · block ${t + 1}`;
        tasks[t].mem = users.map((u) => ({ ...u, id: `${u.id}@${t}`, from: u.id, net: true }));
        tasks[t].stream = blocks[t].map((e) => ({ ...e, net: false }));
        tasks[t].memNote = "hash table: the whole users table";
      }
    } else {
      // Reduce-side sort-merge join. Every record is shuffled to the reducer for its key.
      let rr = 0;
      const arrive = [];
      for (const b of blocks) for (const e of b) arrive.push(e);
      for (const e of arrive) {
        let t = part(e.n);
        if (useSplit && e.n === HOT_USER) t = rr++ % TASKS;
        tasks[t].stream.push({ ...e, net: true });
      }
      for (const u of users) {
        if (useSplit && u.n === HOT_USER) {
          for (let t = 0; t < TASKS; t++) tasks[t].stream.push({ ...u, id: t === 0 ? u.id : `${u.id}@${t}`, from: t === 0 ? undefined : u.id, net: true });
        } else tasks[part(u.n)].stream.push({ ...u, net: true });
      }
      for (let t = 0; t < TASKS; t++) {
        tasks[t].label = `Reducer ${t + 1}`;
        tasks[t].sub = useSplit ? `keys with n mod 3 = ${t}, plus a slice of user ${HOT_USER}` : `keys with n mod 3 = ${t}`;
        tasks[t].arrived = [...tasks[t].stream];
        tasks[t].stream.sort(order);
        tasks[t].memNote = "in memory: one user record at a time";
      }
    }
  }
  for (const t of tasks) if (!t.arrived) t.arrived = t.stream;

  // Counters
  const all = tasks.flatMap((t) => [...t.mem, ...t.stream]);
  const network = all.filter((r) => r.net).length;
  const memPerTask = tasks.map((t) => (strategy === "sortmerge" ? 1 : t.mem.length));
  const work = tasks.map((t) => t.mem.length + t.stream.length);
  const sorted = [...work].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const slowest = Math.max(...work);
  const joined = tasks.reduce((s, t) => s + t.stream.filter((r) => r.kind === "event").length, 0);
  return {
    strategy, skew, split: useSplit, sources, tasks,
    stats: { network, maxMem: Math.max(...memPerTask), memPerTask, work, median, slowest, ratio: slowest / median, joined, events: events.length },
  };
}
