// Run one workload through the toy LSM-tree and the toy B-tree and count what
// each engine actually did. Pure logic, no DOM. Every number comes from the
// simulation; nothing here is a closed-form formula.
import { LSM } from "./lsm.js";
import { BTree } from "./btree.js";

function rng(seed = 7) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const KEY_BYTES = 16;     // assumed key size inside a record
const REF_BYTES = 8;             // a page reference in an interior page

/**
 * params: writes, overwrite (0..1), recordSize, pageSize, memtableBytes,
 *         btreeFlushEvery, lookups, seed, snapshots
 */
export function runWorkload({
  writes = 20000, overwrite = 0.5, recordSize = 100, pageSize = 4096,
  memtableBytes = 64 * 1024, btreeFlushEvery = 1, lookups = 400, seed = 7, snapshots = 60,
} = {}) {
  const rand = rng(seed);
  const memEntries = Math.max(2, Math.floor(memtableBytes / recordSize));
  const perBlock = Math.max(1, Math.floor(pageSize / recordSize));
  const sizeOf = () => recordSize;
  const lsm = new LSM({
    memtableLimit: memEntries, strategy: "leveled", l0Limit: 4,
    baseLevelEntries: memEntries * 4, levelRatio: 10, tableEntries: memEntries,
    bitsPerKey: 10, hashes: 7, sizeOf, blockEntries: perBlock, keepTrace: false,
  });
  const bt = new BTree({
    maxLeafKeys: Math.max(3, perBlock), maxInternalKeys: Math.max(3, Math.floor(pageSize / (KEY_BYTES + REF_BYTES))),
    pageSize, walRecordBytes: recordSize, flushEvery: btreeFlushEvery,
  });

  const keys = [];               // every key written so far
  const keySet = new Set();
  const newKey = () => { let k; do { k = Math.floor(rand() * 2 ** 40); } while (keySet.has(k)); keySet.add(k); keys.push(k); return k; };
  const every = Math.max(1, Math.floor(writes / snapshots));
  const series = [{ n: 0, logical: 0, lsm: 0, btree: 0 }];
  let updates = 0;

  for (let i = 1; i <= writes; i++) {
    let k;
    if (keys.length && rand() < overwrite) { k = keys[Math.floor(rand() * keys.length)]; updates++; }
    else k = newKey();
    lsm.put(k, i);
    bt.insert(k, i);
    if (i % every === 0 || i === writes) {
      series.push({ n: i, logical: lsm.logicalBytes, lsm: lsm.physicalBytes, btree: bt.physicalBytes });
    }
  }
  bt.checkpoint(); // write back whatever is still dirty, so the comparison is fair

  // Reads: half for keys that exist, half for keys that were never written.
  const lr = { hitPages: 0, hitTables: 0, missPages: 0, missTables: 0, fps: 0, bloomNo: 0 };
  const br = { hitPages: 0, missPages: 0 };
  const half = Math.max(1, Math.floor(lookups / 2));
  for (let j = 0; j < half; j++) {
    const k = keys[Math.floor(rand() * keys.length)];
    const a = lsm.get(k); lr.hitPages += a.pagesRead; lr.hitTables += a.tablesConsidered; lr.fps += a.falsePositives; lr.bloomNo += a.bloomNo;
    const b = bt.get(k); br.hitPages += b.pagesRead;
  }
  for (let j = 0; j < half; j++) {
    let k; do { k = Math.floor(rand() * 2 ** 40); } while (keySet.has(k));
    const a = lsm.get(k); lr.missPages += a.pagesRead; lr.missTables += a.tablesConsidered; lr.fps += a.falsePositives; lr.bloomNo += a.bloomNo;
    const b = bt.get(k); br.missPages += b.pagesRead;
  }

  // Range scans of `scanLen` consecutive keys.
  const sorted = [...keys].sort((a, b) => a - b);
  const scans = 40, scanLen = Math.min(100, sorted.length);
  let lsmScan = 0, btScan = 0;
  for (let j = 0; j < scans; j++) {
    const s = Math.floor(rand() * Math.max(1, sorted.length - scanLen));
    const lo = sorted[s], hi = sorted[s + scanLen - 1];
    lsmScan += lsm.scan(lo, hi).blocks;
    btScan += bt.scan(lo, hi).pages;
  }

  const live = keySet.size * recordSize;
  const logical = writes * recordSize;
  return {
    params: { writes, overwrite, recordSize, pageSize, memtableBytes, memEntries, perBlock, btreeFlushEvery },
    logical, live, updates, distinctKeys: keySet.size, series,
    lsm: {
      physical: lsm.physicalBytes, wal: lsm.walBytesWritten, flush: lsm.flushBytesWritten, compaction: lsm.compactionBytesWritten,
      files: lsm.filesWritten, avgFile: (lsm.flushBytesWritten + lsm.compactionBytesWritten) / Math.max(1, lsm.filesWritten),
      largestCompaction: lsm.largestCompaction, compactions: lsm.compactions,
      disk: lsm.diskBytes, tables: lsm.tableCount, levels: lsm.levels.map((l) => l.length),
      readHit: lr.hitPages / half, readMiss: lr.missPages / half,
      tablesHit: lr.hitTables / half, tablesMiss: lr.missTables / half,
      falsePositives: lr.fps, bloomNo: lr.bloomNo, lookups: half * 2,
      scan: lsmScan / scans, scanLen,
      liveCheck: lsm.liveBytes,
    },
    btree: {
      physical: bt.physicalBytes, wal: bt.walBytes, pages: bt.pagesWritten * pageSize, pageWrites: bt.pagesWritten,
      largestFlush: bt.largestFlush * pageSize, largestFlushPages: bt.largestFlush,
      disk: bt.diskBytes, pageCount: bt.pageCount, depth: bt.depth(), splits: bt.splits,
      readHit: br.hitPages / half, readMiss: br.missPages / half,
      scan: btScan / scans,
      fill: (keySet.size * recordSize) / bt.diskBytes,
    },
    _engines: { lsm, bt, keys },
  };
}
