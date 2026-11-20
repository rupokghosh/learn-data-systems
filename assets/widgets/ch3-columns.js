// Chapter 3, lesson 5: row versus column layout, and bitmap + run-length encoding.
import { rng, prefersReducedMotion } from "../charts.js";
import { layout, pagesForQuery, bitmaps, runLengths, encodedSizes } from "../engines/columnar.js";

/* ---------- Row versus column layout ---------- */
{
  const root = document.getElementById("layout");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const PAGE = 32;
  const COLS = [
    { name: "date_key", short: "date", bytes: 4 },
    { name: "track_id", short: "track", bytes: 4 },
    { name: "listener_id", short: "listener", bytes: 4 },
    { name: "device", short: "device", bytes: 2 },
    { name: "country", short: "country", bytes: 2 },
    { name: "seconds", short: "seconds", bytes: 4 },
  ];
  const ROWS = [
    [20261102, 47, 4821, "phone", "BR", 212], [20261102, 12, 1290, "web", "US", 45],
    [20261102, 31, 7734, "phone", "IN", 180], [20261102, 47, 3310, "tv", "DE", 240],
    [20261103, 58, 4821, "phone", "BR", 31], [20261103, 69, 9055, "car", "US", 199],
    [20261103, 12, 2468, "phone", "JP", 260], [20261103, 31, 1290, "web", "US", 88],
    [20261104, 47, 6102, "phone", "BR", 205], [20261104, 58, 7734, "tv", "IN", 300],
    [20261104, 12, 3310, "phone", "DE", 15], [20261104, 31, 5577, "car", "BR", 174],
    [20261105, 69, 9055, "web", "US", 230], [20261105, 47, 2468, "phone", "JP", 61],
    [20261105, 12, 6102, "tv", "BR", 222], [20261105, 58, 5577, "phone", "IN", 140],
  ];
  const all = new Set(ROWS.map((_, i) => i));
  const where = (col, v) => new Set(ROWS.flatMap((r, i) => (r[col] === v ? [i] : [])));
  const QUERIES = {
    sum: {
      sql: "SELECT SUM(seconds) FROM plays WHERE track_id = 47",
      q: { filterCols: [1], useCols: [5], matches: where(1, 47) },
      result: () => `${[...where(1, 47)].reduce((a, i) => a + ROWS[i][5], 0)} seconds`,
    },
    count: {
      sql: "SELECT COUNT(*) FROM plays WHERE country = 'BR'",
      q: { filterCols: [4], useCols: [], matches: where(4, "BR") },
      result: () => `${where(4, "BR").size} plays`,
    },
    group: {
      sql: "SELECT device, AVG(seconds) FROM plays GROUP BY device",
      q: { filterCols: [3, 5], useCols: [], matches: all },
      result: () => {
        const m = new Map();
        ROWS.forEach((r) => { const a = m.get(r[3]) || [0, 0]; a[0] += r[5]; a[1]++; m.set(r[3], a); });
        return [...m].map(([d, [s, n]]) => `${d} ${Math.round(s / n)}`).join(", ");
      },
    },
    point: {
      sql: "SELECT * FROM plays WHERE play_id = 9",
      q: { filterCols: [], useCols: [0, 1, 2, 3, 4, 5], matches: new Set([8]), pointRow: 8 },
      result: () => ROWS[8].join(", "),
    },
  };
  const pages = { row: layout(COLS, ROWS.length, PAGE, "row"), column: layout(COLS, ROWS.length, PAGE, "column") };
  let current = "sum";

  // Table of the data.
  out("table").innerHTML = `<thead><tr><th>play_id</th>${COLS.map((c, i) => `<th><span class="sw c${i}"></span>${c.name}</th>`).join("")}</tr></thead><tbody>${
    ROWS.map((r, i) => `<tr data-row="${i}"><td>${i + 1}</td>${r.map((v, j) => `<td data-col="${j}">${v}</td>`).join("")}</tr>`).join("")}</tbody>`;
  const trs = [...out("table").querySelectorAll("tbody tr")];

  function diskHtml(mode, res) {
    const fileCount = new Map();
    return pages[mode].map((p, i) => {
      const n = (fileCount.get(p.file) || 0) + 1;
      fileCount.set(p.file, n);
      const label = mode === "row" ? `page ${i + 1}` : `${COLS.find((c) => c.name === p.file).short}${n > 1 ? ` ${n}` : ""}`;
      const read = res.read.has(i);
      const cells = p.cells.map((c) => `<i class="db c${c.col}${read && res.need(c) ? " need" : ""}"></i>`).join("");
      return `<div class="dpage${read ? " read" : ""}"><span class="plabel">${label}</span><div class="dbytes">${cells}</div></div>`;
    }).join("");
  }

  function render() {
    const Q = QUERIES[current];
    const rr = pagesForQuery(pages.row, "row", Q.q);
    const cr = pagesForQuery(pages.column, "column", Q.q);
    out("rowdisk").innerHTML = diskHtml("row", rr);
    out("coldisk").innerHTML = diskHtml("column", cr);
    out("rowcount").textContent = `${rr.read.size} of ${pages.row.length} pages read`;
    out("colcount").textContent = `${cr.read.size} of ${pages.column.length} pages read`;
    out("rowbytes").textContent = `${rr.read.size * PAGE} B`;
    out("colbytes").textContent = `${cr.read.size * PAGE} B`;
    out("need").textContent = `${cr.needed} B`;
    out("sql").textContent = Q.sql;
    out("result").textContent = Q.result();
    const usedCols = new Set([...Q.q.filterCols, ...Q.q.useCols]);
    trs.forEach((tr, i) => {
      tr.classList.toggle("match", Q.q.pointRow !== undefined ? i === Q.q.pointRow : Q.q.matches !== all && Q.q.matches.has(i));
      tr.querySelectorAll("td[data-col]").forEach((td) => td.classList.toggle("use", usedCols.has(+td.dataset.col)));
    });
    const v = root.querySelector(".verdict");
    if (Q.q.pointRow !== undefined) {
      v.className = "verdict bad";
      v.innerHTML = `Fetching one whole row favors the row layout: its fields sit next to each other, so ${rr.read.size} page holds all of them. The column layout must visit ${cr.read.size} separate files and stitch the row back together.`;
    } else {
      v.className = "verdict good";
      v.innerHTML = `The row layout reads every page, because each page mixes all six columns. The column layout reads only the ${usedCols.size === 1 ? "column" : "columns"} the query names: <strong>${Math.round(rr.read.size / cr.read.size * 10) / 10}× less</strong> I/O here, and the gap grows with the number of columns. Fact tables often have hundreds.`;
    }
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-q]");
    if (!b) return;
    current = b.dataset.q;
    root.querySelectorAll("[data-q]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  });
  render();
}

/* ---------- Bitmaps and run-length encoding ---------- */
{
  const root = document.getElementById("rle");
  const strip = root.querySelector(".vstrip");
  const maps = root.querySelector('[data-out="maps"]');
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const sortBtn = root.querySelector('[data-act="sort"]');
  const TRACKS = [12, 31, 47, 58, 69];
  const WEIGHTS = [0.3, 0.25, 0.2, 0.15, 0.1];
  const N = 40;
  const r = rng(12);
  const values = Array.from({ length: N }, () => {
    let u = r(), i = 0;
    while (u > WEIGHTS[i] && i < WEIGHTS.length - 1) { u -= WEIGHTS[i]; i++; }
    return TRACKS[i];
  });
  const vIdx = (v) => TRACKS.indexOf(v);
  let sorted = false;

  // One chip per row, keyed by its original row number so it can move when sorted.
  const chips = values.map((v, i) => {
    const s = document.createElement("span");
    s.className = `vchip v${vIdx(v)}`;
    s.textContent = v;
    s.dataset.row = i;
    s.title = `row ${i + 1}`;
    return s;
  });

  function order() {
    const idx = values.map((_, i) => i);
    return sorted ? idx.sort((a, b) => values[a] - values[b] || a - b) : idx;
  }

  function renderStrip(animate) {
    const first = animate ? new Map(chips.map((c) => [c, c.getBoundingClientRect()])) : null;
    strip.replaceChildren(...order().map((i) => chips[i]));
    if (!first || prefersReducedMotion()) return;
    for (const c of chips) {
      const a = first.get(c), b = c.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (!dx && !dy) continue;
      c.classList.remove("moving");
      c.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    strip.getBoundingClientRect();
    for (const c of chips) { c.classList.add("moving"); c.style.transform = ""; }
  }

  function renderMaps() {
    const ordered = order().map((i) => values[i]);
    const bms = bitmaps(ordered);
    maps.innerHTML = bms.map((m) => {
      const runs = runLengths(m.bits);
      const c = vIdx(m.value);
      const bits = m.bits.map((b) => `<i class="bm-bit${b ? ` c${c}` : ""}"></i>`).join("");
      const rle = runs.map((n, j) => `<span class="${j % 2 ? "one" : ""}">${n}</span>`).join(", ");
      return `<div class="bm"><span class="bm-label">track ${m.value}</span><div class="bm-bits">${bits}</div><div class="bm-rle">${runs.length} runs: ${rle}</div></div>`;
    }).join("");
    const s = encodedSizes(ordered, 4);
    out("raw").textContent = `${s.raw} B`;
    out("bitmap").textContent = `${s.bitmap} B`;
    out("rlesize").textContent = `${s.rle} B`;
    out("ratio").textContent = `${Math.round((s.raw / s.rle) * 10) / 10}×`;
    const v = root.querySelector(".verdict");
    v.className = `verdict ${sorted ? "good" : ""}`;
    v.innerHTML = sorted
      ? `Sorted, each track's rows are contiguous, so each bitmap is a single block of 1s: just two runs, the 0s before the block and the block itself. The run-length encoding shrinks to <strong>${s.rle} bytes</strong>, ${Math.round((s.raw / s.rle) * 10) / 10} times smaller than the raw column.`
      : `In arrival order, the 1s are scattered, so each bitmap breaks into many short runs. Run-length encoding still helps the rarer tracks most, whose bitmaps are mostly long runs of 0s.`;
  }

  sortBtn.addEventListener("click", () => {
    sorted = !sorted;
    sortBtn.setAttribute("aria-pressed", String(sorted));
    renderStrip(true);
    renderMaps();
  });
  renderStrip(false);
  renderMaps();
}
