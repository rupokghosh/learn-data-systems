// A toy B-tree of fixed-size pages (B+-tree flavour: values live in leaf pages,
// interior pages hold separator keys and page references). Pure logic, no DOM.
// Counts pages read, pages written, and write-ahead log bytes.

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export class BTree {
  constructor({
    maxLeafKeys = 3, maxInternalKeys = 3,
    pageSize = 4096, walRecordBytes = 0,
    flushEvery = 1,          // write dirty pages back after this many writes
  } = {}) {
    Object.assign(this, { maxLeafKeys, maxInternalKeys, pageSize, walRecordBytes, flushEvery });
    this.pages = new Map();
    this.nextId = 1;
    this.root = this.newPage(true).id;
    this.size = 0;
    this.pagesRead = 0;
    this.pagesWritten = 0;
    this.walBytes = 0;
    this.splits = 0;
    this.writes = 0;
    this.dirty = new Set();
    this.opsSinceFlush = 0;
    this.largestFlush = 0;    // most pages written back in one go
  }

  newPage(leaf) {
    const p = { id: this.nextId++, leaf, keys: [], vals: leaf ? [] : null, children: leaf ? null : [] };
    this.pages.set(p.id, p);
    return p;
  }
  page(id) { return this.pages.get(id); }
  max(p) { return p.leaf ? this.maxLeafKeys : this.maxInternalKeys; }

  /** Child index to follow: the number of separators that are <= key. */
  childIndex(p, key) {
    let lo = 0, hi = p.keys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cmp(p.keys[m], key) <= 0) lo = m + 1; else hi = m; }
    return lo;
  }

  /** Page ids from the root down to the leaf that should hold `key`. */
  pathTo(key) {
    const path = [];
    let p = this.page(this.root);
    for (;;) {
      path.push(p.id);
      if (p.leaf) return path;
      p = this.page(p.children[this.childIndex(p, key)]);
    }
  }

  get(key) {
    const path = this.pathTo(key);
    this.pagesRead += path.length;
    const leaf = this.page(path[path.length - 1]);
    const i = leaf.keys.findIndex((k) => cmp(k, key) === 0);
    return { found: i >= 0, value: i >= 0 ? leaf.vals[i] : null, path, pagesRead: path.length, leaf: leaf.id, slot: i };
  }

  /**
   * Insert or overwrite. Descends root to leaf, writes into the leaf, and if a
   * page overflows splits it in two and pushes a separator key into the parent.
   * Splitting the root adds a new root: the only way the tree grows deeper.
   */
  insert(key, value) {
    const path = this.pathTo(key);
    this.pagesRead += path.length;
    this.walBytes += this.walRecordBytes;
    const leaf = this.page(path[path.length - 1]);
    const touched = new Set([leaf.id]);
    const splits = [];
    let newRoot = null, updated = false;
    let i = 0;
    while (i < leaf.keys.length && cmp(leaf.keys[i], key) < 0) i++;
    if (i < leaf.keys.length && cmp(leaf.keys[i], key) === 0) {
      leaf.vals[i] = value;
      updated = true;
    } else {
      leaf.keys.splice(i, 0, key);
      leaf.vals.splice(i, 0, value);
      this.size++;
      let node = leaf, d = path.length - 1;
      while (node.keys.length > this.max(node)) {
        const right = this.newPage(node.leaf);
        const mid = Math.floor(node.keys.length / 2);
        let sep;
        if (node.leaf) {
          right.keys = node.keys.splice(mid);
          right.vals = node.vals.splice(mid);
          sep = right.keys[0];                 // copied up
        } else {
          sep = node.keys[mid];                // moved up
          right.keys = node.keys.splice(mid + 1);
          node.keys.splice(mid);
          right.children = node.children.splice(mid + 1);
        }
        this.splits++;
        touched.add(node.id); touched.add(right.id);
        const split = { page: node.id, right: right.id, separator: sep, leaf: node.leaf, parent: null };
        splits.push(split);
        if (d === 0) {
          const r = this.newPage(false);
          r.keys = [sep];
          r.children = [node.id, right.id];
          this.root = r.id;
          newRoot = r.id;
          split.parent = r.id;
          touched.add(r.id);
          break;
        }
        const parent = this.page(path[d - 1]);
        const ci = parent.children.indexOf(node.id);
        parent.keys.splice(ci, 0, sep);
        parent.children.splice(ci + 1, 0, right.id);
        split.parent = parent.id;
        touched.add(parent.id);
        node = parent;
        d--;
      }
    }
    for (const id of touched) this.dirty.add(id);
    this.writes++;
    this.opsSinceFlush++;
    let flushed = 0;
    if (this.opsSinceFlush >= this.flushEvery) flushed = this.checkpoint();
    return { path, updated, splits, newRoot, touched: [...touched], flushed };
  }

  /** Write every dirty page back to its place on disk. Returns pages written. */
  checkpoint() {
    const n = this.dirty.size;
    this.pagesWritten += n;
    this.largestFlush = Math.max(this.largestFlush, n);
    this.dirty.clear();
    this.opsSinceFlush = 0;
    return n;
  }

  get physicalBytes() { return this.walBytes + this.pagesWritten * this.pageSize; }
  get pageCount() { return this.pages.size; }
  get diskBytes() { return this.pages.size * this.pageSize; }
  depth() { let d = 1, p = this.page(this.root); while (!p.leaf) { p = this.page(p.children[0]); d++; } return d; }

  /** Pages grouped by level, root first, each level left to right. */
  levels() {
    const out = [];
    let row = [this.root];
    while (row.length) {
      out.push(row.map((id) => this.page(id)));
      const next = [];
      for (const id of row) { const p = this.page(id); if (!p.leaf) next.push(...p.children); }
      row = next;
    }
    return out;
  }

  /** Range scan [lo, hi]: descend once, then walk leaf pages left to right. */
  scan(lo, hi) {
    const leaves = this.levels().at(-1);
    const startLeaf = this.pathTo(lo).at(-1);
    let i = leaves.findIndex((p) => p.id === startLeaf), pages = this.depth();
    while (i + 1 < leaves.length && leaves[i + 1].keys.length && cmp(leaves[i + 1].keys[0], hi) <= 0) { i++; pages++; }
    return { pages };
  }

  /** In-order keys from the leaves. */
  keys() {
    const out = [];
    const walk = (id) => { const p = this.page(id); if (p.leaf) out.push(...p.keys); else p.children.forEach(walk); };
    walk(this.root);
    return out;
  }

  /** Structural invariants. Returns a list of problems (empty when healthy). */
  check() {
    const errs = [];
    let leafDepth = -1;
    const walk = (id, lo, hi, depth) => {
      const p = this.page(id);
      if (!p) { errs.push(`missing page ${id}`); return; }
      for (let i = 1; i < p.keys.length; i++) if (cmp(p.keys[i - 1], p.keys[i]) >= 0) errs.push(`page ${id} keys not sorted`);
      for (const k of p.keys) {
        if (lo !== undefined && cmp(k, lo) < 0) errs.push(`page ${id} key ${k} below ${lo}`);
        if (hi !== undefined && cmp(k, hi) >= 0) errs.push(`page ${id} key ${k} not below ${hi}`);
      }
      if (p.keys.length > this.max(p)) errs.push(`page ${id} overfull`);
      if (id !== this.root && p.keys.length < 1) errs.push(`page ${id} empty`);
      if (p.leaf) {
        if (leafDepth === -1) leafDepth = depth;
        else if (leafDepth !== depth) errs.push(`leaf ${id} at depth ${depth}, expected ${leafDepth}`);
        if (p.vals.length !== p.keys.length) errs.push(`leaf ${id} vals mismatch`);
      } else {
        if (p.children.length !== p.keys.length + 1) errs.push(`page ${id} child count`);
        p.children.forEach((c, i) => walk(c, i === 0 ? lo : p.keys[i - 1], i === p.keys.length ? hi : p.keys[i], depth + 1));
      }
    };
    walk(this.root, undefined, undefined, 1);
    return errs;
  }
}
