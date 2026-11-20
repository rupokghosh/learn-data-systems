// Chapter 12, lesson 2: where to put the boundary between the write path and the read path.
// Feature: "Trending near you" in a second-hand marketplace. A listing trends when people save it.
// One pass over a seeded workload runs all five designs side by side and counts records touched.
import { rng } from "../charts.js";

export const GRID = 16;            // 16 x 16 neighbourhood cells
export const LISTINGS = 3000;
export const USERS = 1200;
export const ONLINE = 300;         // users with the page open (for push)
export const TOP = 10;
export const WRITES_PER_SEC = 10;  // saves per second
export const DURATION = 120;       // simulated seconds
export const CACHE_TTL = 10;       // seconds
export const STREAM_LAG = 0.5;     // seconds for a stream processor to update a view

export const DESIGNS = [
  { key: "scan", name: "Scan on every read", short: "Scan",
    write: "Store the save.", read: "Scan every listing, filter by distance, sort." },
  { key: "index", name: "Index by area and saves", short: "Index",
    write: "Store the save and move the listing in an index.", read: "Take the top of nine area index ranges and merge." },
  { key: "cache", name: "Cache the answer per area", short: "Cache",
    write: "Store the save and update the index.", read: "Serve from cache; on a miss, query the index and fill the cache." },
  { key: "view", name: "Maintain a top-10 view per area", short: "View",
    write: "A stream processor updates the nine area views that contain the listing.", read: "Read one precomputed list." },
  { key: "push", name: "Push view changes to open pages", short: "Push",
    write: "Update the views, then push each change to every client showing that area.", read: "Open pages already hold the list; only a fresh page load fetches it." },
];

const cellOf = (x, y) => y * GRID + x;
function areaCells(c) {
  const x = c % GRID, y = Math.floor(c / GRID), out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < GRID && ny < GRID) out.push(cellOf(nx, ny));
  }
  return out;
}

/** Runs the workload once and returns per-design counters. readsPerWrite can be fractional. */
export function simulate(readsPerWrite, seed = 12) {
  const r = rng(seed);
  // Population is denser near the centre of town.
  const randCell = () => {
    const g = () => Math.min(GRID - 1, Math.max(0, Math.round(GRID / 2 - 0.5 + (r() + r() + r() - 1.5) * GRID / 2.2)));
    return cellOf(g(), g());
  };
  const listingCell = Array.from({ length: LISTINGS }, randCell);
  const saves = new Float64Array(LISTINGS);
  const userCell = Array.from({ length: USERS }, randCell);
  const AREAS = GRID * GRID;
  const areaOf = Array.from({ length: AREAS }, (_, c) => areaCells(c));

  // Online users: how many open pages show each area.
  const openPages = new Int32Array(AREAS);
  for (let u = 0; u < ONLINE; u++) openPages[userCell[u]]++;

  // Exact top list per area (the truth), and the time it last changed.
  const top = Array.from({ length: AREAS }, () => []);
  const lastChange = new Float64Array(AREAS).fill(-Infinity);
  // Popularity is skewed: a few listings attract most saves.
  const pop = Array.from({ length: LISTINGS }, () => r() ** 3);
  const cum = []; let acc = 0; for (const p of pop) { acc += p; cum.push(acc); }
  const pickListing = () => { const x = r() * acc; let lo = 0, hi = LISTINGS - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; } return lo; };

  const c = Object.fromEntries(DESIGNS.map((d) => [d.key, { writeWork: 0, readWork: 0, reads: 0, writes: 0, stale: 0 }]));
  const cache = new Map(); // area -> { at, version }
  const version = new Int32Array(AREAS);

  const readsPerSec = WRITES_PER_SEC * readsPerWrite;
  const rate = WRITES_PER_SEC + readsPerSec;
  const pRead = readsPerSec / rate;
  let t = 0;
  while (t < DURATION) {
    t += -Math.log(1 - r()) / rate;
    if (r() >= pRead) {
      // ---- a save (write) ----
      const l = pickListing();
      saves[l]++;
      for (const a of areaOf[listingCell[l]]) {
        const list = top[a];
        const i = list.indexOf(l);
        let changed = false;
        if (i >= 0) {
          let j = i;
          while (j > 0 && saves[list[j - 1]] < saves[l]) { list[j] = list[j - 1]; j--; }
          list[j] = l;
          changed = true; // the shown save count changed even if the order did not
        } else if (list.length < TOP || saves[l] > saves[list[list.length - 1]]) {
          list.push(l);
          list.sort((x, y) => saves[y] - saves[x]);
          if (list.length > TOP) list.pop();
          changed = true;
        }
        if (changed) { lastChange[a] = t; version[a]++; c.push.writeWork += openPages[a]; }
      }
      const areasPerListing = areaOf[listingCell[l]].length;
      c.scan.writeWork += 1;
      c.index.writeWork += 2;
      c.cache.writeWork += 2;
      c.view.writeWork += 2 + areasPerListing;
      c.push.writeWork += 2 + areasPerListing;
      for (const d of DESIGNS) c[d.key].writes++;
    } else {
      // ---- a page view (read) ----
      const u = Math.floor(r() * USERS);
      const a = userCell[u];
      c.scan.readWork += LISTINGS;
      c.index.readWork += areaOf[a].length * TOP;
      // Cache
      const hit = cache.get(a);
      if (hit && t - hit.at < CACHE_TTL) {
        c.cache.readWork += TOP;
        if (hit.version !== version[a]) c.cache.stale++;
      } else {
        c.cache.readWork += areaOf[a].length * TOP + TOP; // query the index, then write the cache entry
        cache.set(a, { at: t, version: version[a] });
      }
      // Views maintained by a stream processor lag a little behind.
      c.view.readWork += TOP;
      const lagging = lastChange[a] > t - STREAM_LAG;
      if (lagging) { c.view.stale++; c.push.stale++; }
      // Pages already open were kept current by pushes; a fresh page load still fetches the list once.
      c.push.readWork += u < ONLINE ? 0 : TOP;
      for (const d of DESIGNS) c[d.key].reads++;
    }
  }

  const storage = {
    scan: LISTINGS,
    index: LISTINGS * 2,
    cache: LISTINGS * 2 + cache.size * TOP,
    view: LISTINGS * 2 + AREAS * TOP,
    push: LISTINGS * 2 + AREAS * TOP + ONLINE * TOP,
  };

  return DESIGNS.map((d) => {
    const k = c[d.key];
    const perWrite = k.writes ? k.writeWork / k.writes : 0;
    const perRead = k.reads ? k.readWork / k.reads : 0;
    return {
      ...d,
      perWrite, perRead,
      perSecond: perWrite * WRITES_PER_SEC + perRead * readsPerSec,
      staleShare: k.reads ? k.stale / k.reads : 0,
      maxAge: d.key === "scan" || d.key === "index" ? 0 : d.key === "cache" ? CACHE_TTL : STREAM_LAG,
      storage: storage[d.key],
      reads: k.reads, writes: k.writes,
    };
  });
}
