// Chapter 3, lesson 3: an interactive B-tree and a capacity calculator.
import { el, rng, fmt, responsive, slider, prefersReducedMotion } from "../charts.js";
import { BTree } from "../engines/btree.js";
import { makePlayer, fmtBytes } from "./ch3-util.js";

/* ---------- Interactive B-tree ---------- */
{
  const root = document.getElementById("btree");
  const wrap = root.querySelector(".bt");
  const input = root.querySelector("#bt-key");
  const verdict = root.querySelector(".verdict");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);

  const MAXK = 3, CELL = 26, PAGE_H = 26, LEVEL_H = 66, GAP = 12, TOP = 22, SIDE = 8;
  const PAGE_W = MAXK * CELL;
  const player = makePlayer();
  const svg = el("svg", { role: "img", "aria-label": "B-tree pages, root at the top, leaves at the bottom" }, wrap);
  const gEdges = el("g", { class: "bt-edges" }, svg);
  const gPages = el("g", {}, svg);
  const nodes = new Map();          // page id -> <g>
  let tree, rand, pos = new Map(), lastPages = null, hl = {}, cw = 0;

  const say = (html, cls = "") => { verdict.className = `verdict ${cls}`; verdict.innerHTML = html; };

  function reset() {
    player.settle();
    tree = new BTree({ maxLeafKeys: MAXK, maxInternalKeys: MAXK });
    rand = rng(8);
    [50, 20, 80, 35, 65, 10, 90, 42, 58].forEach((k) => tree.insert(k, k));
    nodes.forEach((g) => g.remove());
    nodes.clear();
    lastPages = null;
    hl = {};
    draw({ instant: true });
    say("Nine keys are already in. Each page holds at most three keys. Insert a key that lands in a full leaf to see a split.");
  }

  function layout() {
    const levels = tree.levels();
    const leaves = levels[levels.length - 1];
    const p = new Map();
    leaves.forEach((pg, i) => p.set(pg.id, { x: i * (PAGE_W + GAP), y: (levels.length - 1) * LEVEL_H }));
    for (let d = levels.length - 2; d >= 0; d--) {
      for (const pg of levels[d]) {
        const a = p.get(pg.children[0]), b = p.get(pg.children[pg.children.length - 1]);
        p.set(pg.id, { x: (a.x + b.x) / 2, y: d * LEVEL_H });
      }
    }
    const width = leaves.length * (PAGE_W + GAP) - GAP;
    return { p, width, height: (levels.length - 1) * LEVEL_H + PAGE_H, levels };
  }

  function fillPage(g, pg, h) {
    g.textContent = "";
    const cls = ["bt-page"];
    if (h.path?.includes(pg.id)) cls.push("on-path");
    if (h.split?.has(pg.id)) cls.push("split");
    if (h.miss === pg.id) cls.push("miss");
    g.setAttribute("class", cls.join(" "));
    el("rect", { class: "frame", x: 0, y: 0, width: PAGE_W, height: PAGE_H, rx: 4 }, g);
    for (let i = 0; i < MAXK; i++) {
      const k = pg.keys[i];
      let slot = "";
      if (k !== undefined) {
        if (h.sep?.get(pg.id) === k) slot = "sep";
        else if (h.found?.leaf === pg.id && h.found.key === k) slot = "found";
        else if (h.newKey?.leaf === pg.id && h.newKey.key === k) slot = "newkey";
      }
      el("rect", { class: `slot ${slot}`, x: i * CELL + 1.5, y: 1.5, width: CELL - 3, height: PAGE_H - 3, rx: 3 }, g);
      if (i > 0) el("line", { class: "div", x1: i * CELL, x2: i * CELL, y1: 4, y2: PAGE_H - 4 }, g);
      if (k !== undefined) {
        const t = el("text", { class: `key${slot === "sep" || slot === "found" ? " inv" : ""}`, x: i * CELL + CELL / 2, y: 17 }, g);
        t.textContent = k;
      }
    }
    const id = el("text", { class: "pid", x: 1, y: -5 }, g);
    id.textContent = `${pg.leaf ? "leaf" : pg.id === tree.root ? "root" : "page"} ${pg.id}`;
  }

  const place = (g, x, y) => { g.style.transform = `translate(${x}px, ${y}px)`; };

  /**
   * Draw the tree. opts.origins: Map(new page id -> {x,y}) where a new page starts
   * before sliding into place. opts.instant: no movement.
   */
  function draw(opts = {}) {
    const L = layout();
    cw = wrap.clientWidth || cw || 600;
    const svgW = Math.max(cw, L.width + SIDE * 2);
    const ox = (svgW - L.width) / 2;
    const svgH = L.height + TOP + 8;
    svg.setAttribute("width", svgW);
    svg.setAttribute("height", svgH);
    svg.setAttribute("viewBox", `0 0 ${svgW} ${svgH}`);
    const old = pos;
    pos = new Map([...L.p].map(([id, q]) => [id, { x: q.x + ox, y: q.y + TOP }]));
    const animate = !opts.instant && !prefersReducedMotion();

    for (const [id, g] of nodes) if (!tree.page(id)) { g.remove(); nodes.delete(id); }
    for (const level of L.levels) for (const pg of level) {
      let g = nodes.get(pg.id);
      const to = pos.get(pg.id);
      if (!g) {
        g = el("g", {}, gPages);
        nodes.set(pg.id, g);
        fillPage(g, pg, hl);
        const from = opts.origins?.get(pg.id);
        g.style.transition = "none";
        place(g, (from || to).x, (from || to).y);
        g.style.opacity = animate && !from ? "0" : "1";
        g.getBoundingClientRect();
        g.style.transition = "";
      } else {
        fillPage(g, pg, hl);
        if (!animate) g.style.transition = "none";
      }
      place(g, to.x, to.y);
      g.style.opacity = "1";
      if (!animate) { g.getBoundingClientRect(); g.style.transition = ""; }
    }

    // Edges: drawn at final positions, hidden while pages move.
    gEdges.textContent = "";
    for (const level of L.levels) for (const pg of level) {
      if (pg.leaf) continue;
      const a = pos.get(pg.id);
      pg.children.forEach((c, i) => {
        const b = pos.get(c);
        const on = hl.path && hl.path.indexOf(c) > 0 && hl.path[hl.path.indexOf(c) - 1] === pg.id;
        el("path", { class: `bt-edge${on ? " on-path" : ""}`, d: `M${a.x + i * CELL},${a.y + PAGE_H} L${b.x + PAGE_W / 2},${b.y}` }, gEdges);
      });
    }
    const moved = animate && [...pos].some(([id, q]) => old.has(id) && (old.get(id).x !== q.x || old.get(id).y !== q.y));
    if (moved || (animate && opts.origins?.size)) {
      gEdges.classList.add("hide");
      setTimeout(() => gEdges.classList.remove("hide"), 340);
    } else gEdges.classList.remove("hide");

    out("keys").textContent = String(tree.size);
    out("pages").textContent = String(tree.pageCount);
    out("depth").textContent = String(tree.depth());
    out("read").textContent = lastPages === null ? "none yet" : `${lastPages}`;
    return old;
  }

  function scrollToPage(id) {
    const q = pos.get(id);
    if (!q || wrap.scrollWidth <= wrap.clientWidth) return;
    wrap.scrollTo({ left: Math.max(0, q.x - wrap.clientWidth / 2 + PAGE_W / 2), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  function readKey() {
    const v = parseInt(input.value, 10);
    if (!Number.isFinite(v) || v < 0 || v > 999) { say("Type a whole number from 0 to 999."); return null; }
    return v;
  }

  function descentFrames(path) {
    return path.map((_, i) => () => { hl = { path: path.slice(0, i + 1) }; draw({ instant: true }); scrollToPage(path[i]); });
  }

  function describeSplits(res, key) {
    if (!res.splits.length) return "";
    const parts = res.splits.map((s, i) => {
      const what = s.leaf ? `leaf ${s.page}` : `page ${s.page}`;
      const verb = s.leaf ? "copied up" : "moved up";
      const lead = i === 0 ? `It overflowed ${what}, so the page split into ${s.page} and new page ${s.right}` : `That overflowed ${what} too, which split into ${s.page} and ${s.right}`;
      return `${lead}; separator <strong>${s.separator}</strong> was ${verb} into page ${s.parent}.`;
    });
    if (res.newRoot) parts.push(`The root itself split, so new root page ${res.newRoot} was added on top. The tree grew one level, at the root, and every leaf is still the same distance from it.`);
    return " " + parts.join(" ");
  }

  function insert(key, animate = true) {
    player.settle();
    const path = tree.pathTo(key);
    const final = () => {
      const before = new Map(pos);
      const res = tree.insert(key, key);
      lastPages = path.length;
      const origins = new Map();
      for (const s of res.splits) origins.set(s.right, before.get(s.page));
      const leaf = tree.pathTo(key).at(-1);
      hl = {
        split: new Set(res.splits.flatMap((s) => [s.page, s.right])),
        sep: new Map(res.splits.map((s) => [s.parent, s.separator])),
        newKey: { leaf, key },
        path: res.splits.length ? null : [leaf],
      };
      draw({ origins, instant: !animate });
      scrollToPage(leaf);
      if (res.updated) say(`${key} was already in leaf ${leaf}. Its value was overwritten in place: same page, same position on disk. Pages read on the way down: ${path.length}.`);
      else say(`Walked ${path.length} page${path.length === 1 ? "" : "s"} from root to leaf ${path.at(-1)} and inserted <strong>${key}</strong>.${res.splits.length ? describeSplits(res, key) : " The leaf had room, so nothing else changed."}`, res.splits.length ? "" : "good");
    };
    player.play(animate ? descentFrames(path) : [], 260, final);
  }

  function lookup(key) {
    player.settle();
    const res = tree.get(key);
    const final = () => {
      lastPages = res.pagesRead;
      hl = { path: res.path, found: res.found ? { leaf: res.leaf, key } : null, miss: res.found ? null : res.leaf };
      draw({ instant: true });
      say(res.found
        ? `Found <strong>${key}</strong> in leaf ${res.leaf} after reading ${res.pagesRead} page${res.pagesRead === 1 ? "" : "s"}: one per level. At each page, the separators said which child covers ${key}.`
        : `Read ${res.pagesRead} page${res.pagesRead === 1 ? "" : "s"} down to leaf ${res.leaf}, the only place ${key} could be. It is not there, so it does not exist.`, res.found ? "good" : "");
    };
    player.play(descentFrames(res.path), 260, final);
  }

  function insertRandom() {
    player.settle();
    const before = new Map(pos);
    const added = [], origins = new Map(), split = new Set(), sep = new Map();
    let splits = 0, grew = false;
    for (let i = 0; i < 5; i++) {
      let k, tries = 0;
      do { k = 1 + Math.floor(rand() * 99); tries++; } while (tree.get(k).found && tries < 200);
      if (tree.get(k).found) break;
      const res = tree.insert(k, k);
      added.push(k);
      splits += res.splits.length;
      if (res.newRoot) grew = true;
      for (const s of res.splits) {
        origins.set(s.right, before.get(s.page) || origins.get(s.page));
        split.add(s.page); split.add(s.right); sep.set(s.parent, s.separator);
      }
    }
    lastPages = tree.depth();
    for (const [id] of origins) if (!origins.get(id)) origins.delete(id);
    hl = { split, sep };
    draw({ origins });
    say(added.length
      ? `Inserted ${added.join(", ")}. That caused ${splits} page split${splits === 1 ? "" : "s"}${grew ? ", including a root split that added a level" : ""}. Orange pages took part in a split; blue cells are separators that were pushed up.`
      : "Every number from 1 to 99 is already in the tree. Reset to start over.");
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const a = b.dataset.act;
    if (a === "insert") { const k = readKey(); if (k !== null) insert(k); }
    else if (a === "lookup") { const k = readKey(); if (k !== null) lookup(k); }
    else if (a === "random") insertRandom();
    else if (a === "reset") reset();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const k = readKey();
    if (k !== null) insert(k, false);
  });

  reset();
  responsive(wrap, () => { if (!player.busy) draw({ instant: true }); });
}

/* ---------- Capacity calculator ---------- */
{
  const root = document.getElementById("capacity");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const PAGE = [1, 2, 4, 8, 16, 32, 64].map((k) => k * 1024);
  const KEY = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
  const REF = 8;
  const s = { page: 8192, key: 16, depth: 4, fill: 0.7 };

  function update() {
    const raw = Math.floor(s.page / (s.key + REF));
    const b = Math.max(2, Math.floor(raw * s.fill));
    const leafPages = b ** (s.depth - 1);
    const data = leafPages * s.page * s.fill;
    let interior = 0;
    const rows = [];
    for (let i = 1; i <= s.depth; i++) {
      const pages = b ** (i - 1);
      const bytes = pages * s.page;
      if (i < s.depth) interior += bytes;
      rows.push(`<tr><td>${i === 1 ? "1 (root)" : i === s.depth ? `${i} (leaves)` : i}</td><td>${fmt(pages)}</td><td>${fmtBytes(bytes)}</td><td>${i < s.depth ? "interior: keys and page references" : "leaf: keys and values"}</td></tr>`);
    }
    out("b").textContent = `${b}`;
    out("leaves").textContent = fmt(leafPages);
    out("data").textContent = fmtBytes(data);
    out("reads").textContent = `${s.depth}`;
    out("rows").innerHTML = rows.join("");
    const v = root.querySelector(".verdict");
    const cacheable = interior <= 64 * 1024 ** 3;
    v.className = `verdict ${cacheable ? "good" : ""}`;
    v.innerHTML = s.depth === 1
      ? "A one-level tree is a single page. Add levels to see the fan-out."
      : `A page of ${fmtBytes(s.page)} fits about ${raw} separator keys with their page references; at ${Math.round(s.fill * 100)}% full that is a branching factor of ${b}. Everything above the leaves adds up to <strong>${fmtBytes(interior)}</strong>${cacheable ? ", small enough to stay in memory, so a lookup typically costs a single disk read: the leaf." : ", which is more memory than most servers would spend on it, so some interior reads will go to disk."}`;
  }

  slider(root.querySelector("#cap-page"), (i) => fmtBytes(PAGE[i]), (i) => { s.page = PAGE[i]; update(); });
  slider(root.querySelector("#cap-key"), (i) => `${KEY[i]} B`, (i) => { s.key = KEY[i]; update(); });
  slider(root.querySelector("#cap-depth"), (v) => `${v} level${v === 1 ? "" : "s"}`, (v) => { s.depth = v; update(); });
  slider(root.querySelector("#cap-fill"), (v) => `${v}%`, (v) => { s.fill = v / 100; update(); });
}
