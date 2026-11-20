// Chapter 6: DOM-free key-value partitioning logic.
// Key generators for several workloads, key-range and hash routing,
// salting of hot keys, and which partitions a range query must touch.
import { rng } from "../charts.js";

/** 32-bit FNV-1a followed by the MurmurHash3 finalizer, so similar keys scatter. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export const NPART = 8;
export const pad = (n, w) => String(n).padStart(w, "0");
export const userKey = (n) => "u" + pad(n, 6);

const DAY = "2026-11-19T";
export function fmtTime(msOfDay) {
  const h = Math.floor(msOfDay / 3600000), m = Math.floor(msOfDay / 60000) % 60;
  const s = Math.floor(msOfDay / 1000) % 60, x = msOfDay % 1000;
  return `${DAY}${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(x, 3)}`;
}
const START = (14 * 3600 + 20 * 60) * 1000; // 14:20:00 on the simulated day

// Range boundaries: partition i holds keys >= bounds[i-1] and < bounds[i].
const USER_BOUNDS = [1, 2, 3, 4, 5, 6, 7].map((i) => userKey(i * 125000));
const HOUR_BOUNDS = [8, 9, 10, 11, 12, 13, 14].map((h) => DAY + pad(h, 2));
const SENSOR_BOUNDS = [1, 2, 3, 4, 5, 6, 7].map((i) => "s" + pad(i * 25, 3));

export const CELEB = "u618034";
const ZIPF_N = 20000, ZIPF_S = 1.1;
let zipfCdf = null;
function zipf() {
  if (zipfCdf) return zipfCdf;
  zipfCdf = new Float64Array(ZIPF_N);
  let acc = 0;
  for (let i = 0; i < ZIPF_N; i++) { acc += 1 / Math.pow(i + 1, ZIPF_S); zipfCdf[i] = acc; }
  for (let i = 0; i < ZIPF_N; i++) zipfCdf[i] /= acc;
  return zipfCdf;
}
/** The user who holds popularity rank r (1 = most popular). */
export const zipfUser = (r) => userKey(hash32("rank:" + r) % 1000000);

const USER_QUERY = { label: "user IDs u300000 to u339999", lo: "u300000", hi: "u339999" };

export const WORKLOADS = {
  uniform: {
    label: "Uniform user IDs",
    bounds: USER_BOUNDS,
    rangeRule: "p0 holds u000000 to u124999, p1 holds u125000 to u249999, and so on up to p7.",
    query: USER_QUERY,
    hotKey: null,
    make(rand) { return () => userKey(Math.floor(rand() * 1e6)); },
  },
  time: {
    label: "Timestamps",
    bounds: HOUR_BOUNDS,
    rangeRule: "p0 holds events before 08:00, p1 holds 08:00 to 08:59, and so on; p7 holds 14:00 onward.",
    query: { label: "events from 14:00 to 14:30", lo: DAY + "14:00", hi: DAY + "14:30" },
    hotKey: null,
    make(rand) { let t = START; return () => { t += 1 + Math.floor(rand() * 30); return fmtTime(t); }; },
  },
  sensor: {
    label: "Sensor, then timestamp",
    bounds: SENSOR_BOUNDS,
    rangeRule: "p0 holds sensors s000 to s024, p1 holds s025 to s049, and so on; each sensor's readings are sorted by time.",
    query: { label: "sensor s137 from 14:00 to 14:30", lo: "s137|" + DAY + "14:00", hi: "s137|" + DAY + "14:30", partKey: "s137" },
    hotKey: null,
    partKey: (k) => k.slice(0, 4),
    make(rand) {
      let t = START;
      return () => { t += 1 + Math.floor(rand() * 30); return "s" + pad(Math.floor(rand() * 200), 3) + "|" + fmtTime(t); };
    },
  },
  celeb: {
    label: "One celebrity key",
    bounds: USER_BOUNDS,
    rangeRule: "p0 holds u000000 to u124999, p1 holds u125000 to u249999, and so on up to p7.",
    query: USER_QUERY,
    hotKey: CELEB,
    make(rand) { return () => (rand() < 0.5 ? CELEB : userKey(Math.floor(rand() * 1e6))); },
  },
  zipf: {
    label: "Zipf-like skew",
    bounds: USER_BOUNDS,
    rangeRule: "p0 holds u000000 to u124999, p1 holds u125000 to u249999, and so on up to p7.",
    query: USER_QUERY,
    hotKey: zipfUser(1),
    make(rand) {
      const cdf = zipf();
      return () => {
        const u = rand();
        let lo = 0, hi = ZIPF_N - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
        return zipfUser(lo + 1);
      };
    },
  },
};

export function rangePart(key, bounds) {
  let p = 0;
  while (p < bounds.length && key >= bounds[p]) p++;
  return p;
}

/** The partition a key is stored in. scheme: "range" or "hash". */
export function route(key, scheme, wl) {
  if (scheme === "range") return rangePart(key, wl.bounds);
  const k = wl.partKey && !key.includes("#") ? wl.partKey(key) : key;
  return hash32(k) % NPART;
}

/** Splits a hot key into n keys by appending a random two-digit suffix. */
export const saltKey = (key, rand, n) => key + "#" + pad(Math.floor(rand() * n), 2);

/** Distinct partitions that the n salted versions of a key land in. */
export function saltedSpread(key, n, scheme, wl) {
  const s = new Set();
  for (let i = 0; i < n; i++) s.add(route(key + "#" + pad(i, 2), scheme, wl));
  return [...s].sort((a, b) => a - b);
}

/** Partitions a range query must contact. */
export function rangeTouches(wl, scheme) {
  const q = wl.query;
  if (scheme === "range") {
    const a = rangePart(q.lo, wl.bounds), b = rangePart(q.hi, wl.bounds);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  if (q.partKey) return [hash32(q.partKey) % NPART];
  return Array.from({ length: NPART }, (_, i) => i);
}

/**
 * A stream of writes for one configuration. Keeps a sliding window of the
 * last `window` writes and counts how many landed on each partition.
 */
export function createStream({ workload, scheme, salt = false, saltN = 8, seed = 7, window = 3000 }) {
  const wl = WORKLOADS[workload];
  const rand = rng(seed);
  const next = wl.make(rand);
  const buf = new Int8Array(window).fill(-1);
  const counts = new Array(NPART).fill(0);
  let pos = 0, total = 0, hotWrites = 0;
  const hotBuf = new Uint8Array(window);
  function write() {
    let key = next();
    const hot = wl.hotKey !== null && key === wl.hotKey;
    if (hot && salt) key = saltKey(key, rand, saltN);
    const p = route(key, scheme, wl);
    if (buf[pos] >= 0) { counts[buf[pos]]--; hotWrites -= hotBuf[pos]; }
    buf[pos] = p; hotBuf[pos] = hot ? 1 : 0;
    counts[p]++; hotWrites += hot ? 1 : 0;
    pos = (pos + 1) % window;
    total++;
    return { key, p, hot };
  }
  for (let i = 0; i < window; i++) write(); // start at steady state
  return {
    wl, write, counts,
    get filled() { return Math.min(total, window); },
    get hotShare() { return hotWrites / Math.min(total, window); },
  };
}
