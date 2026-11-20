// Chapter 12, lesson 1: a system of record whose change log feeds derived systems.
// DOM-free and deterministic. Time is in simulated milliseconds.
import { rng } from "../charts.js";

export const STATIONS = ["Canal Basin", "Market Hall", "Riverside", "Old Mill", "Hilltop", "Tannery Yard"];
// Returns land downhill: Hilltop rarely gets bikes back, Riverside gets many.
const RETURN_WEIGHT = [1.2, 1.1, 1.8, 1.0, 0.25, 0.9];

/** A tiny bike-sharing world that emits consistent events (no ride ends before it starts). */
export function createWorld(seed = 7) {
  const r = rng(seed);
  const bikes = [];
  for (let i = 0; i < 24; i++) bikes.push({ id: "B-" + (101 + i), at: null, flagged: false, rider: null, placed: false });
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const weighted = () => {
    const total = RETURN_WEIGHT.reduce((a, b) => a + b, 0);
    let x = r() * total;
    for (let i = 0; i < RETURN_WEIGHT.length; i++) { x -= RETURN_WEIGHT[i]; if (x <= 0) return i; }
    return RETURN_WEIGHT.length - 1;
  };
  let placed = 0;
  function next() {
    // The first events put the fleet on the street, so the log alone describes the whole state.
    if (placed < bikes.length) {
      const b = bikes[placed]; b.at = placed % STATIONS.length; placed++;
      return { type: "add", bike: b.id, station: STATIONS[b.at] };
    }
    const docked = bikes.filter((b) => b.at !== null && !b.flagged);
    const riding = bikes.filter((b) => b.at === null);
    const flagged = bikes.filter((b) => b.flagged);
    const x = r();
    if (x < 0.07 && docked.length > 2) {
      const b = pick(docked); b.flagged = true;
      return { type: "flag", bike: b.id, station: STATIONS[b.at] };
    }
    if (x < 0.11 && flagged.length) {
      const b = pick(flagged); b.flagged = false;
      return { type: "fix", bike: b.id, station: STATIONS[b.at] };
    }
    if ((x < 0.58 && docked.length) || !riding.length) {
      const b = pick(docked);
      const station = STATIONS[b.at];
      b.rider = "R-" + String(10 + Math.floor(r() * 80));
      b.at = null;
      return { type: "start", bike: b.id, station, rider: b.rider };
    }
    const b = pick(riding);
    b.at = weighted();
    const ev = { type: "end", bike: b.id, station: STATIONS[b.at], rider: b.rider, minutes: 4 + Math.floor(r() * 22) };
    b.rider = null;
    return ev;
  }
  return { next, bikes };
}

export function describe(ev) {
  if (ev.type === "start") return `start ${ev.bike} @ ${ev.station}`;
  if (ev.type === "end") return `end ${ev.bike} @ ${ev.station}`;
  if (ev.type === "add") return `new ${ev.bike} @ ${ev.station}`;
  if (ev.type === "flag") return `broken ${ev.bike} @ ${ev.station}`;
  return `fixed ${ev.bike} @ ${ev.station}`;
}

// ---------- Derived systems: each is a pure function of the log ----------
const countDocked = (rideableOnly) => ({
  init: () => ({ docked: Object.fromEntries(STATIONS.map((s) => [s, new Set()])), flagged: new Set(), last: null }),
  apply(st, ev) {
    if (ev.type === "start") st.docked[ev.station].delete(ev.bike);
    if (ev.type === "end" || ev.type === "add") st.docked[ev.station].add(ev.bike);
    if (ev.type === "flag") st.flagged.add(ev.bike);
    if (ev.type === "fix") st.flagged.delete(ev.bike);
    st.last = ev.station;
    return st;
  },
  count(st, station) {
    let n = 0;
    for (const b of st.docked[station]) if (!rideableOnly || !st.flagged.has(b)) n++;
    return n;
  },
  total(st) { return STATIONS.reduce((a, s) => a + this.count(st, s), 0); },
});

const searchV1 = {
  ...countDocked(false), title: "Station search", short: "Search",
  lag: 700, from: "beginning",
  summary(st) { return [`${this.total(st)} bikes available`, st.last ? `${st.last}: ${this.count(st, st.last)}` : ""]; },
};
const searchV2 = {
  ...countDocked(true), title: "Station search", short: "Search",
  lag: 700, from: "beginning",
  summary(st) { return [`${this.total(st)} rideable bikes`, st.last ? `${st.last}: ${this.count(st, st.last)}` : ""]; },
};

export const KINDS = {
  search: searchV1,
  cache: {
    title: "Bike locator cache", short: "Cache", lag: 200, from: "beginning",
    init: () => ({ where: {}, last: null }),
    apply(st, ev) {
      if (ev.type === "start") st.where[ev.bike] = "in use";
      if (ev.type === "end" || ev.type === "add") st.where[ev.bike] = ev.station;
      st.last = ev.bike;
      return st;
    },
    summary(st) {
      const inUse = Object.values(st.where).filter((v) => v === "in use").length;
      return [`${inUse} bikes out on rides`, st.last ? `${st.last} → ${st.where[st.last] ?? "docked"}` : ""];
    },
  },
  warehouse: {
    title: "Analytics warehouse", short: "Warehouse", lag: 300, batch: 4000, from: "beginning",
    init: () => ({ rides: 0, minutes: 0 }),
    apply(st, ev) { if (ev.type === "end") { st.rides++; st.minutes += ev.minutes; } return st; },
    summary(st) { return [`${st.rides} completed rides`, st.rides ? `average ${(st.minutes / st.rides).toFixed(1)} min` : ""]; },
  },
  model: {
    title: "Rebalancing model", short: "Model", lag: 1800, from: "beginning",
    init: () => ({ flow: Object.fromEntries(STATIONS.map((s) => [s, 0])), seen: 0 }),
    apply(st, ev) {
      // Exponentially decayed net outflow per station.
      for (const s of STATIONS) st.flow[s] *= 0.97;
      if (ev.type === "start") st.flow[ev.station] += 1;
      if (ev.type === "end") st.flow[ev.station] -= 1;
      st.seen++;
      return st;
    },
    summary(st) {
      if (st.seen < 5) return ["learning…", ""];
      const top = STATIONS.reduce((a, b) => (st.flow[b] > st.flow[a] ? b : a));
      return [`Send a van to ${top}`, "it is draining fastest"];
    },
  },
  notify: {
    title: "Ride receipts", short: "Receipts", lag: 400, from: "head",
    init: () => ({ sent: 0, last: null }),
    apply(st, ev) { if (ev.type === "end") { st.sent++; st.last = ev; } return st; },
    summary(st) { return [`${st.sent} receipts sent`, st.last ? `${st.last.rider}: ${st.last.minutes} min ride` : "only new rides"]; },
  },
};
export const SEARCH_V2 = searchV2;

export const REPLAY_GAP = 45;   // ms per event when catching up on history
const MIN_GAP = 60;             // ms per event when processing live

export function createDataflow({ seed = 7, history = 70 } = {}) {
  const world = createWorld(seed);
  const log = [];
  for (let i = 0; i < history; i++) log.push({ offset: i, at: -1e6 + i * 1000, ...world.next() });
  const consumers = new Map();

  function append(t) {
    const ev = { offset: log.length, at: t, ...world.next() };
    log.push(ev);
    return ev;
  }

  /** Start a derived system. It reads the log from offset 0 (rebuild) or from the head (side effects). */
  function addConsumer(kind, t, opts = {}) {
    const def = opts.def || KINDS[kind];
    const from = opts.from || def.from;
    const c = {
      id: opts.id || kind, kind, def, version: opts.version || 1,
      offset: from === "head" ? log.length : 0,
      startedAt: t, historyEnd: log.length, lastAt: t, state: def.init(), applied: 0,
    };
    consumers.set(c.id, c);
    return c;
  }
  const removeConsumer = (id) => consumers.delete(id);

  function applyAt(c, offset, lastAt) {
    const ev = log[offset];
    if (ev.at < c.startedAt) return lastAt + REPLAY_GAP;          // catching up on history
    if (c.def.batch) return Math.ceil(Math.max(lastAt, ev.at + c.def.lag) / c.def.batch) * c.def.batch;
    return Math.max(lastAt + MIN_GAP, ev.at + c.def.lag);
  }

  /** Apply every event whose turn has come, in log order, for every consumer. */
  function advance(t) {
    const applied = [];
    for (const c of consumers.values()) {
      while (c.offset < log.length) {
        const at = applyAt(c, c.offset, c.lastAt);
        if (at > t) break;
        c.state = c.def.apply(c.state, log[c.offset]);
        c.lastAt = at; c.offset++; c.applied++;
        applied.push({ id: c.id, offset: c.offset - 1 });
      }
    }
    return applied;
  }

  /** The next few events a consumer will apply, with their scheduled times. */
  function upcoming(c, max = 4) {
    const out = [];
    let last = c.lastAt;
    for (let o = c.offset; o < log.length && out.length < max; o++) {
      const at = applyAt(c, o, last);
      out.push({ ev: log[o], at, live: log[o].at >= c.startedAt });
      last = at;
    }
    return out;
  }

  function status(c) {
    const behind = log.length - c.offset;
    const replaying = c.offset < c.historyEnd && log[c.offset]?.at < c.startedAt;
    return { behind, replaying, done: c.offset, of: c.historyEnd };
  }

  return { log, consumers, world, append, addConsumer, removeConsumer, advance, upcoming, status };
}
