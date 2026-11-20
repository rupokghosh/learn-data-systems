// A toy LSM-tree: a sorted memtable plus a write-ahead log, flushed to immutable
// sorted string tables (SSTables), merged by compaction. Pure logic, no DOM.
// It counts every byte it writes and every block it reads, so callers can show
// write, read, and space amplification that come from the simulation itself.

export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 32-bit string hash (FNV-1a with a seed, plus a final mix). */
export function hashString(str, seed = 0) {
  let h = (2166136261 ^ seed) >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

/** A Bloom filter with m bits and k hash functions (double hashing). */
export class BloomFilter {
  constructor(m, k) {
    this.m = Math.max(1, m | 0);
    this.k = Math.max(1, k | 0);
    this.bits = new Uint8Array(this.m);
    this.count = 0;
  }
  positions(key) {
    const h1 = hashString(key, 0x9747b28c);
    const h2 = hashString(key, 0x85ebca6b) | 1;
    const out = [];
    for (let i = 0; i < this.k; i++) out.push(((h1 + Math.imul(i, h2)) >>> 0) % this.m);
    return out;
  }
  add(key) {
    for (const p of this.positions(key)) this.bits[p] = 1;
    this.count++;
  }
  mightContain(key) {
    return this.positions(key).every((p) => this.bits[p] === 1);
  }
  get setBits() { let n = 0; for (const b of this.bits) n += b; return n; }
  /** The textbook estimate of the false positive rate after n insertions. */
  expectedFalsePositiveRate(n = this.count) {
    return (1 - Math.exp((-this.k * n) / this.m)) ** this.k;
  }
}

export const defaultSize = (key, value, tomb) => String(key).length + (tomb ? 1 : String(value).length) + 2;

let tableSeq = 0;

export class SSTable {
  constructor(entries, { level = 0, bitsPerKey = 4, hashes = 2, sizeOf = defaultSize, blockEntries = 4, id } = {}) {
    this.id = id ?? ++tableSeq;
    this.level = level;
    this.entries = entries; // sorted by key, unique keys
    this.minKey = entries[0]?.key;
    this.maxKey = entries[entries.length - 1]?.key;
    this.bytes = entries.reduce((a, e) => a + sizeOf(e.key, e.value, e.tomb), 0);
    this.bloom = new BloomFilter(Math.max(8, Math.ceil(bitsPerKey * entries.length)), hashes);
    for (const e of entries) this.bloom.add(e.key);
    // Sparse index: the first key of every block. A lookup reads one block.
    this.sparse = [];
    for (let i = 0; i < entries.length; i += blockEntries) this.sparse.push({ key: entries[i].key, at: i });
  }
  covers(key) { return cmp(key, this.minKey) >= 0 && cmp(key, this.maxKey) <= 0; }
  find(key) {
    let lo = 0, hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cmp(this.entries[mid].key, key);
      if (c === 0) return this.entries[mid];
      if (c < 0) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }
}

/**
 * Merge sorted runs, newest run first, like the merge step of mergesort.
 * When the same key appears in several runs, the newest version wins.
 * Tombstones are dropped only when `dropTombstones` (nothing older exists below).
 * Returns the merged entries and, if asked, a step-by-step trace.
 */
export function mergeRuns(runs, { dropTombstones = false, trace = false } = {}) {
  const heads = runs.map(() => 0);
  const out = [];
  const steps = trace ? [] : null;
  let stale = 0, tombsDropped = 0;
  for (;;) {
    let best = -1;
    for (let r = 0; r < runs.length; r++) {
      if (heads[r] >= runs[r].length) continue;
      if (best === -1 || cmp(runs[r][heads[r]].key, runs[best][heads[best]].key) < 0) best = r;
    }
    if (best === -1) break;
    const key = runs[best][heads[best]].key;
    // Every run whose head has this key: the lowest run index is the newest.
    for (let r = 0; r < runs.length; r++) {
      if (heads[r] >= runs[r].length || cmp(runs[r][heads[r]].key, key) !== 0) continue;
      const e = runs[r][heads[r]];
      let kept = false, reason;
      if (r !== best) { stale++; reason = "older"; }
      else if (e.tomb && dropTombstones) { tombsDropped++; reason = "tombstone"; }
      else { kept = true; out.push({ key: e.key, value: e.value, tomb: e.tomb }); reason = "newest"; }
      if (steps) steps.push({ run: r, idx: heads[r], key, kept, reason });
      heads[r]++;
    }
  }
  return { entries: out, steps, stale, tombsDropped };
}

export class LSM {
  constructor({
    memtableLimit = 4,        // entries before a flush
    strategy = "leveled",     // "leveled" or "tiered"
    l0Limit = 3,              // leveled: L0 tables before L0 merges into L1
    baseLevelEntries = 12,    // leveled: capacity of L1 in entries
    levelRatio = 4,           // leveled: each level holds this many times more
    tableEntries = 6,         // leveled: max entries per SSTable in L1 and below
    tierSize = 3,             // tiered: tables per level before they merge down
    bitsPerKey = 4, hashes = 2, bloom = true,
    sizeOf = defaultSize, blockEntries = 4,
    keepTrace = true,
  } = {}) {
    Object.assign(this, { memtableLimit, strategy, l0Limit, baseLevelEntries, levelRatio, tableEntries, tierSize, bitsPerKey, hashes, bloom, sizeOf, blockEntries, keepTrace });
    this.mem = new Map();
    this.wal = [];            // records since the last flush (the log on disk)
    this.walSize = 0;
    this.levels = [[]];       // levels[i] = tables; L0 is newest first
    this.logicalBytes = 0;
    this.walBytesWritten = 0;
    this.flushBytesWritten = 0;
    this.compactionBytesWritten = 0;
    this.filesWritten = 0;
    this.largestCompaction = 0;
    this.compactions = 0;
    this.reads = { gets: 0, considered: 0, bloomChecks: 0, bloomNo: 0, tablesRead: 0, falsePositives: 0, rangeSkips: 0, memHits: 0 };
  }

  get physicalBytes() { return this.walBytesWritten + this.flushBytesWritten + this.compactionBytesWritten; }

  tableOpts(level) {
    return { level, bitsPerKey: this.bitsPerKey, hashes: this.hashes, sizeOf: this.sizeOf, blockEntries: this.blockEntries };
  }

  put(key, value) { return this.write(key, value, false); }
  delete(key) { return this.write(key, null, true); }

  write(key, value, tomb) {
    const bytes = this.sizeOf(key, value, tomb);
    this.logicalBytes += bytes;
    this.walBytesWritten += bytes;
    this.walSize += bytes;
    if (this.keepTrace) this.wal.push({ key, value, tomb });
    this.mem.set(key, { key, value, tomb });
    const events = [];
    if (this.mem.size >= this.memtableLimit) events.push(...this.flush());
    return { events };
  }

  memtableSorted() { return [...this.mem.values()].sort((a, b) => cmp(a.key, b.key)); }

  flush() {
    if (!this.mem.size) return [];
    const table = new SSTable(this.memtableSorted(), this.tableOpts(0));
    this.flushBytesWritten += table.bytes;
    this.filesWritten++;
    this.levels[0].unshift(table);
    this.mem.clear();
    this.wal = [];
    this.walSize = 0;
    return [{ type: "flush", table }, ...this.maybeCompact()];
  }

  levelEntries(i) { return (this.levels[i] || []).reduce((a, t) => a + t.entries.length, 0); }
  levelCapacity(i) { return this.baseLevelEntries * this.levelRatio ** (i - 1); }
  isBottom(level) {
    for (let j = level + 1; j < this.levels.length; j++) if (this.levels[j].length) return false;
    return true;
  }

  maybeCompact() {
    const events = [];
    if (this.strategy === "leveled") {
      if (this.levels[0].length >= this.l0Limit) events.push(this.compactLevel(0));
      for (let i = 1; i < this.levels.length; i++) {
        if (this.levelEntries(i) > this.levelCapacity(i)) events.push(this.compactLevel(i));
      }
    } else {
      for (let i = 0; i < this.levels.length; i++) {
        if (this.levels[i].length >= this.tierSize) events.push(this.compactLevel(i));
      }
    }
    return events;
  }

  /**
   * Leveled: merge all of level i (and all of level i+1) into level i+1, split
   * into non-overlapping tables. Tiered: merge the tables of level i into one
   * new table on top of level i+1. (Real engines compact a few tables at a
   * time; merging whole levels keeps the toy easy to follow.)
   */
  compactLevel(i) {
    const to = i + 1;
    if (!this.levels[to]) this.levels[to] = [];
    let inputs, runs;
    if (this.strategy === "leveled") {
      const lower = this.levels[to];
      inputs = [...this.levels[i], ...lower];
      runs = i === 0 ? this.levels[0].map((t) => t.entries) : [this.levels[i].flatMap((t) => t.entries)];
      if (lower.length) runs.push(lower.flatMap((t) => t.entries));
    } else {
      inputs = [...this.levels[i]];
      runs = inputs.map((t) => t.entries);
    }
    const bottom = this.strategy === "leveled" ? this.isBottom(to) : this.isBottom(to) && this.levels[to].length === 0;
    const merged = mergeRuns(runs, { dropTombstones: bottom, trace: this.keepTrace });
    const outTables = [];
    if (merged.entries.length) {
      if (this.strategy === "leveled") {
        for (let s = 0; s < merged.entries.length; s += this.tableEntries) {
          outTables.push(new SSTable(merged.entries.slice(s, s + this.tableEntries), this.tableOpts(to)));
        }
      } else {
        outTables.push(new SSTable(merged.entries, this.tableOpts(to)));
      }
    }
    const written = outTables.reduce((a, t) => a + t.bytes, 0);
    this.compactionBytesWritten += written;
    this.filesWritten += outTables.length;
    this.largestCompaction = Math.max(this.largestCompaction, written);
    this.compactions++;
    this.levels[i] = [];
    if (this.strategy === "leveled") this.levels[to] = outTables;
    else this.levels[to] = [...outTables, ...this.levels[to]];
    while (this.levels.length > 1 && !this.levels[this.levels.length - 1].length) this.levels.pop();
    return {
      type: "compact", from: i, to, inputs: inputs.map((t) => ({ id: t.id, level: t.level, entries: t.entries })),
      runs, output: outTables, steps: merged.steps, stale: merged.stale, tombsDropped: merged.tombsDropped, bytes: written,
    };
  }

  /** Read path: memtable, then tables newest to oldest. */
  get(key) {
    const r = this.reads;
    r.gets++;
    const steps = [];
    let pagesRead = 0, bloomNo = 0, fps = 0, tablesConsidered = 0;
    const done = (entry, where) => ({
      found: !!entry && !entry.tomb, deleted: !!entry && entry.tomb, value: entry && !entry.tomb ? entry.value : null,
      where, steps, pagesRead, bloomNo, falsePositives: fps, tablesConsidered,
    });
    if (this.mem.has(key)) {
      steps.push({ where: "memtable", hit: true });
      r.memHits++;
      return done(this.mem.get(key), "memtable");
    }
    steps.push({ where: "memtable", hit: false });
    for (let i = 0; i < this.levels.length; i++) {
      for (const t of this.levels[i]) {
        if (!t.covers(key)) { steps.push({ table: t.id, level: i, check: "range" }); r.rangeSkips++; continue; }
        tablesConsidered++; r.considered++;
        if (this.bloom) {
          r.bloomChecks++;
          if (!t.bloom.mightContain(key)) { steps.push({ table: t.id, level: i, check: "bloom-no" }); r.bloomNo++; bloomNo++; continue; }
        }
        pagesRead++; r.tablesRead++;
        const e = t.find(key);
        if (!e) {
          steps.push({ table: t.id, level: i, check: this.bloom ? "false-positive" : "read-miss" });
          if (this.bloom) { r.falsePositives++; fps++; }
          continue;
        }
        steps.push({ table: t.id, level: i, check: "hit", entry: e });
        return done(e, t.id);
      }
    }
    return done(null, null);
  }

  /**
   * Range scan [lo, hi]: Bloom filters cannot help, so every table whose key
   * range overlaps must be read (at least one block each), plus the memtable.
   */
  scan(lo, hi) {
    let blocks = 0, tables = 0;
    for (const lvl of this.levels) for (const t of lvl) {
      if (cmp(t.maxKey, lo) < 0 || cmp(t.minKey, hi) > 0) continue;
      tables++;
      let first = -1, last = -1;
      t.entries.forEach((e, i) => { if (cmp(e.key, lo) >= 0 && cmp(e.key, hi) <= 0) { if (first < 0) first = i; last = i; } });
      blocks += first < 0 ? 1 : Math.floor(last / this.blockEntries) - Math.floor(first / this.blockEntries) + 1;
    }
    return { blocks, tables };
  }

  /** Every key's newest version, as a Map. Used for live-data size and tests. */
  snapshot() {
    const m = new Map();
    for (let i = this.levels.length - 1; i >= 0; i--) {
      for (let j = this.levels[i].length - 1; j >= 0; j--) for (const e of this.levels[i][j].entries) m.set(e.key, e);
    }
    for (const e of this.mem.values()) m.set(e.key, e);
    return m;
  }

  get diskBytes() {
    let b = this.walSize;
    for (const lvl of this.levels) for (const t of lvl) b += t.bytes;
    return b;
  }
  get tableCount() { return this.levels.reduce((a, l) => a + l.length, 0); }
  get liveBytes() {
    let b = 0;
    for (const e of this.snapshot().values()) if (!e.tomb) b += this.sizeOf(e.key, e.value, false);
    return b;
  }
}
