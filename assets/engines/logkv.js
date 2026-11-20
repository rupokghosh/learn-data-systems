// A toy append-only log with an in-memory hash index (in the spirit of Bitcask).
// Pure logic, no DOM. Every record lives in a segment; the active (newest)
// segment takes appends, and freezes once it holds `segmentRecords` records.

/** Bytes a record takes on disk, encoded as "key,value\n". A tombstone is "key,\0\n". */
export function recordBytes(key, value, tombstone = false) {
  return String(key).length + (tombstone ? 1 : String(value).length) + 2;
}

export class LogKV {
  constructor({ segmentRecords = 6 } = {}) {
    this.segmentRecords = segmentRecords;
    this.nextSegId = 1;
    this.segments = [];          // oldest first; the last one is active
    this.index = new Map();      // key -> { seg, pos, offset }
    this.bytesWritten = 0;       // every byte ever appended, including by compaction
    this.recordsRead = 0;        // cumulative, across gets and recovery
    this.openSegment();
  }

  openSegment() {
    const s = { id: this.nextSegId++, records: [], bytes: 0, frozen: false, merged: false };
    this.segments.push(s);
    return s;
  }

  get active() { return this.segments[this.segments.length - 1]; }
  segment(id) { return this.segments.find((s) => s.id === id); }

  append(key, value, tombstone) {
    const seg = this.active;
    const bytes = recordBytes(key, value, tombstone);
    const rec = { key, value: tombstone ? null : String(value), tombstone, offset: seg.bytes, bytes };
    seg.records.push(rec);
    seg.bytes += bytes;
    this.bytesWritten += bytes;
    const pos = seg.records.length - 1;
    let froze = null;
    if (seg.records.length >= this.segmentRecords) {
      seg.frozen = true;
      froze = seg;
      this.openSegment();
    }
    return { seg: seg.id, pos, rec, froze };
  }

  set(key, value) {
    const r = this.append(key, value, false);
    this.index.set(key, { seg: r.seg, pos: r.pos, offset: r.rec.offset });
    return r;
  }

  /** Deleting appends a tombstone and forgets the key in the index. */
  delete(key) {
    const existed = this.index.has(key);
    const r = this.append(key, null, true);
    this.index.delete(key);
    return { ...r, existed };
  }

  /**
   * With the index: one hash lookup, one record read.
   * Without: read the whole log from the start and keep the last match.
   */
  get(key, { useIndex = true } = {}) {
    if (useIndex) {
      const loc = this.index.get(key);
      if (!loc) return { found: false, value: null, recordsRead: 0, bytesRead: 0, read: [], hit: null };
      const rec = this.segment(loc.seg).records[loc.pos];
      this.recordsRead += 1;
      return { found: true, value: rec.value, recordsRead: 1, bytesRead: rec.bytes, read: [{ seg: loc.seg, pos: loc.pos }], hit: { seg: loc.seg, pos: loc.pos } };
    }
    const read = [];
    let hit = null, bytesRead = 0;
    for (const seg of this.segments) {
      seg.records.forEach((rec, pos) => {
        read.push({ seg: seg.id, pos });
        bytesRead += rec.bytes;
        if (rec.key === key) hit = { seg: seg.id, pos, rec };
      });
    }
    this.recordsRead += read.length;
    const found = !!hit && !hit.rec.tombstone;
    return { found, value: found ? hit.rec.value : null, recordsRead: read.length, bytesRead, read, hit: hit ? { seg: hit.seg, pos: hit.pos } : null, deleted: !!hit && hit.rec.tombstone };
  }

  /** Which records are still the latest version of a live key. */
  isLive(segId, pos) {
    const rec = this.segment(segId)?.records[pos];
    if (!rec || rec.tombstone) return false;
    const loc = this.index.get(rec.key);
    return !!loc && loc.seg === segId && loc.pos === pos;
  }

  /**
   * Compact and merge every frozen segment into fresh frozen segments that keep
   * only the latest live record per key. Overwritten records and tombstones go.
   * The active segment is untouched, so writes could continue meanwhile.
   */
  compact() {
    const frozen = this.segments.filter((s) => s.frozen);
    if (!frozen.length) return null;
    const before = { segments: frozen.length, records: 0, bytes: 0 };
    const kept = [], dropped = [];
    for (const seg of frozen) {
      before.records += seg.records.length;
      before.bytes += seg.bytes;
      seg.records.forEach((rec, pos) => {
        if (this.isLive(seg.id, pos)) kept.push({ seg: seg.id, pos, rec });
        else dropped.push({ seg: seg.id, pos, rec, reason: rec.tombstone ? "tombstone" : this.index.has(rec.key) ? "overwritten" : "deleted" });
      });
    }
    const outputs = [];
    let cur = null;
    for (const k of kept) {
      if (!cur || cur.records.length >= this.segmentRecords) {
        cur = { id: this.nextSegId++, records: [], bytes: 0, frozen: true, merged: true };
        outputs.push(cur);
      }
      const rec = { ...k.rec, offset: cur.bytes };
      cur.records.push(rec);
      cur.bytes += rec.bytes;
      this.bytesWritten += rec.bytes;
      this.index.set(rec.key, { seg: cur.id, pos: cur.records.length - 1, offset: rec.offset });
    }
    this.segments = [...outputs, ...this.segments.filter((s) => !s.frozen)];
    const after = { segments: outputs.length, records: kept.length, bytes: outputs.reduce((a, s) => a + s.bytes, 0) };
    return { before, after, kept, dropped, inputs: frozen.map((s) => s.id), outputs: outputs.map((s) => s.id) };
  }

  /** Lose the in-memory index, then rebuild it by reading every segment, oldest first. */
  crashAndRecover() {
    this.index = new Map();
    let n = 0;
    for (const seg of this.segments) {
      seg.records.forEach((rec, pos) => {
        n++;
        if (rec.tombstone) this.index.delete(rec.key);
        else this.index.set(rec.key, { seg: seg.id, pos, offset: rec.offset });
      });
    }
    this.recordsRead += n;
    return { recordsRead: n };
  }

  get diskBytes() { return this.segments.reduce((a, s) => a + s.bytes, 0); }
  get diskRecords() { return this.segments.reduce((a, s) => a + s.records.length, 0); }
  get liveBytes() {
    let b = 0;
    for (const loc of this.index.values()) b += this.segment(loc.seg).records[loc.pos].bytes;
    return b;
  }
}
