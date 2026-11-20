// Chapter 3, lesson 4: the same workload through the toy LSM-tree and the toy B-tree.
import { el, linear, fmt, responsive, slider } from "../charts.js";
import { runWorkload } from "../engines/workload.js";
import { fmtBytes } from "./ch3-util.js";

const root = document.getElementById("arena");
const chart = root.querySelector(".chart");
const tbody = root.querySelector('[data-out="table"]');
const verdict = root.querySelector(".verdict");

const WRITES = [1000, 2000, 5000, 10000, 20000, 50000];
const RECORD = [32, 64, 100, 256, 512, 1024];
const PAGE = [1, 2, 4, 8, 16].map((k) => k * 1024);
const MEM = [16, 32, 64, 128, 256, 1024].map((k) => k * 1024);
const FLUSH = [1, 10, 100, 1000, 10000];
const p = { writes: 20000, overwrite: 0.5, recordSize: 100, pageSize: 4096, memtableBytes: 65536, btreeFlushEvery: 100 };
let res = null, width = 0, timer = 0;

const x2 = (v) => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}×`;
const n1 = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

function run() {
  res = runWorkload({ ...p, lookups: 400, seed: 7 });
  table();
  draw();
}

function row(label, a, b, better) {
  const wa = better === "lsm" ? " win" : "", wb = better === "btree" ? " win" : "";
  return `<tr><td>${label}</td><td class="lsm${wa}">${a}</td><td class="bt${wb}">${b}</td></tr>`;
}
const pickBetter = (a, b) => (a < b * 0.95 ? "lsm" : b < a * 0.95 ? "btree" : "");

function table() {
  const r = res, L = r.lsm, B = r.btree;
  const waL = L.physical / r.logical, waB = B.physical / r.logical;
  const saL = L.disk / r.live, saB = B.disk / r.live;
  tbody.innerHTML = [
    row("Bytes the application wrote", fmtBytes(r.logical), fmtBytes(r.logical), ""),
    row("Bytes written to disk", `${fmtBytes(L.physical)}<small>log ${fmtBytes(L.wal)} · flushes ${fmtBytes(L.flush)} · compaction ${fmtBytes(L.compaction)}</small>`,
      `${fmtBytes(B.physical)}<small>log ${fmtBytes(B.wal)} · pages ${fmtBytes(B.pages)}</small>`, pickBetter(L.physical, B.physical)),
    row("<strong>Write amplification</strong>", x2(waL), x2(waB), pickBetter(waL, waB)),
    row("How it reaches the disk", L.files
      ? `${fmt(L.files)} sequential file write${L.files === 1 ? "" : "s"}<small>average ${fmtBytes(L.avgFile)} each</small>`
      : `only the log so far<small>the memtable has not been flushed yet</small>`,
      `${fmt(B.pageWrites)} random page writes<small>${fmtBytes(r.params.pageSize)} each</small>`, ""),
    row("Largest single burst", L.compactions
      ? `${fmtBytes(L.largestCompaction)}<small>one compaction, ${(100 * L.largestCompaction / L.physical).toFixed(0)}% of all disk writes</small>`
      : `none yet<small>no compaction has run</small>`,
      `${fmtBytes(B.largestFlush)}<small>${B.largestFlushPages === 1 ? "one page at a time" : `one write-back of ${fmt(B.largestFlushPages)} dirty pages`}</small>`, ""),
    row("Point read, key exists", `${n1(L.readHit)} block reads<small>${n1(L.tablesHit)} tables in key range</small>`, `${n1(B.readHit)} page reads<small>root to leaf</small>`, pickBetter(L.readHit, B.readHit)),
    row("Point read, key missing", `${n1(L.readMiss)} block reads<small>Bloom filters skipped ${fmt(L.bloomNo)} tables in ${L.lookups} reads</small>`, `${n1(B.readMiss)} page reads`, pickBetter(L.readMiss, B.readMiss)),
    row(`Range scan, ${L.scanLen} keys`, `${n1(L.scan)} block reads<small>every overlapping table</small>`, `${n1(B.scan)} page reads<small>descend once, walk leaves</small>`, pickBetter(L.scan, B.scan)),
    row("Disk space used", `${fmtBytes(L.disk)}<small>${L.tables} SSTable${L.tables === 1 ? "" : "s"}, per level: ${L.levels.join(" / ")}</small>`, `${fmtBytes(B.disk)}<small>${fmt(B.pageCount)} pages, ${Math.round(B.fill * 100)}% full on average</small>`, pickBetter(L.disk, B.disk)),
    row("Live data", fmtBytes(r.live), fmtBytes(r.live), ""),
    row("<strong>Space amplification</strong>", x2(saL), x2(saB), pickBetter(saL, saB)),
  ].join("");

  const lines = [];
  lines.push(`For every byte the application wrote, the LSM-tree wrote <strong>${x2(waL)}</strong> and the B-tree <strong>${x2(waB)}</strong>.`);
  if (waB > waL) lines.push(`The B-tree pays a whole ${fmtBytes(r.params.pageSize)} page to change one ${r.params.recordSize}-byte record${p.btreeFlushEvery > 1 ? ", unless several changes to the same page land in one write-back batch" : ""}.`);
  else lines.push("Here compaction rewrote data more often than the B-tree rewrote pages.");
  lines.push(saL < saB ? `The B-tree also uses more disk: split pages are left partly empty.` : `The LSM-tree uses more disk right now: older versions are waiting for compaction.`);
  verdict.innerHTML = lines.join(" ");
}

function draw(w = width) {
  width = w;
  if (!w || !res) return;
  const h = 230, padL = 58, padR = 64, padB = 26, padT = 10;
  const s = res.series;
  const maxY = Math.max(...s.map((d) => Math.max(d.lsm, d.btree, d.logical))) || 1;
  const x = linear([0, res.params.writes], [padL, w - padR]);
  const y = linear([0, maxY], [h - padB, padT]);
  chart.innerHTML = "";
  const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, height: h, role: "img", "aria-label": "Cumulative bytes written to disk by each engine as the workload runs" }, chart);
  const g = el("g", { class: "grid" }, svg);
  for (let i = 0; i <= 4; i++) {
    const v = (maxY * i) / 4;
    el("line", { x1: padL, x2: w - padR, y1: y(v), y2: y(v) }, g);
    const t = el("text", { x: padL - 6, y: y(v) + 4, "text-anchor": "end" }, svg);
    t.textContent = fmtBytes(v, 0);
  }
  for (const f of [0, 0.5, 1]) {
    const v = res.params.writes * f;
    const t = el("text", { x: x(v), y: h - 8, "text-anchor": f === 0 ? "start" : f === 1 ? "end" : "middle" }, svg);
    t.textContent = f === 1 ? `${fmt(v)} writes` : fmt(v);
  }
  const series = [
    { key: "logical", label: "app", color: "var(--ink-3)", dash: "4 3" },
    { key: "lsm", label: "LSM", color: "var(--accent)" },
    { key: "btree", label: "B-tree", color: "var(--orange)" },
  ];
  const ends = [];
  for (const sr of series) {
    const d = s.map((pt, i) => `${i ? "L" : "M"}${x(pt.n).toFixed(1)},${y(pt[sr.key]).toFixed(1)}`).join("");
    el("path", { d, style: `fill:none;stroke:${sr.color};stroke-width:2${sr.dash ? `;stroke-dasharray:${sr.dash}` : ""}` }, svg);
    ends.push({ ...sr, y: y(s[s.length - 1][sr.key]) });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  for (const e of ends) {
    const t = el("text", { x: w - padR + 6, y: e.y + 4, style: `fill:${e.color};font-weight:600;font-size:12px` }, svg);
    t.textContent = e.label;
  }
}

function schedule() { clearTimeout(timer); timer = setTimeout(run, 60); }

slider(root.querySelector("#cmp-writes"), (i) => fmt(WRITES[i]), (i) => { p.writes = WRITES[i]; schedule(); });
slider(root.querySelector("#cmp-over"), (v) => `${v}%`, (v) => { p.overwrite = v / 100; schedule(); });
slider(root.querySelector("#cmp-rec"), (i) => fmtBytes(RECORD[i]), (i) => { p.recordSize = RECORD[i]; schedule(); });
slider(root.querySelector("#cmp-page"), (i) => fmtBytes(PAGE[i]), (i) => { p.pageSize = PAGE[i]; schedule(); });
slider(root.querySelector("#cmp-mem"), (i) => fmtBytes(MEM[i]), (i) => { p.memtableBytes = MEM[i]; schedule(); });
slider(root.querySelector("#cmp-flush"), (i) => (FLUSH[i] === 1 ? "every write" : `${fmt(FLUSH[i])} writes`), (i) => { p.btreeFlushEvery = FLUSH[i]; schedule(); });
run();
responsive(chart, draw);
