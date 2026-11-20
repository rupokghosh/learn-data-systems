// Chapter 10, lesson 1: a Unix log pipeline step by step, and hash table vs sort memory.
import { el, logScale, logTicks, responsive, slider, prefersReducedMotion } from "../charts.js";
import { SAMPLE_LOG, FIELDS, parseLines, runPipeline } from "../engines/ch10-pipeline.js";
import { esc, makeLoop } from "./ch10-util.js";

/* ------------------------------------------------------------------ */
/* Pipeline step-through                                               */
/* ------------------------------------------------------------------ */
{
  const root = document.getElementById("pipe");
  const stagesEl = root.querySelector(".pipe-stages");
  const outEl = root.querySelector(".pipe-out");
  const text = root.querySelector("textarea");
  const o = (k) => root.querySelector(`[data-out="${k}"]`);
  const st = { field: "path", stage: 0, headN: 5, lines: [...SAMPLE_LOG] };
  let stages = [];
  text.value = SAMPLE_LOG.join("\n");

  const explain = {
    cat: (s) => `<span class="mono">cat</span> reads the file and writes each line to its standard output. ${s.n} lines enter the pipe; the next program reads them from its standard input.`,
    awk: () => `<span class="mono">awk</span> splits each line on whitespace and prints only field <span class="mono">$${FIELDS[st.field].n}</span>, the ${FIELDS[st.field].label}. Everything else is dropped early, so every later stage handles less data.`,
    sort: () => `<span class="mono">sort</span> puts identical values next to each other. The shaded bands are the runs of equal lines. On a file larger than memory, sort writes sorted chunks to temporary files and merges them.`,
    uniq: (s) => `<span class="mono">uniq -c</span> collapses each run of adjacent equal lines into one line with a count. It only compares a line with the one before it, which is why the sort had to come first. ${s.n} distinct values remain.`,
    sortn: () => `<span class="mono">sort -rn</span> orders the lines by their leading number, largest first. Same program as before, different flags.`,
    head: () => `<span class="mono">head</span> keeps the first ${st.headN === 1 ? "line" : `${st.headN} lines`} and then exits. That is the report: the most frequent ${FIELDS[st.field].label} values in this log.`,
  };

  function compute() { stages = runPipeline(st.lines, FIELDS[st.field].n, st.headN); }

  function lineHTML(stage, i, line, out) {
    if (stage.id === "cat") {
      const parts = line.trim().split(/(\s+)/);
      let idx = 0;
      return parts.map((p) => (/^\s+$/.test(p) ? p : (++idx === FIELDS[st.field].n ? `<span class="fld">${esc(p)}</span>` : esc(p)))).join("");
    }
    if (stage.id === "uniq" || stage.id === "sortn" || stage.id === "head") {
      const m = line.match(/^(\s*\d+)(.*)$/);
      return m ? `<span class="cnt">${esc(m[1])}</span>${esc(m[2])}` : esc(line);
    }
    return line === "" ? " " : esc(line);
  }

  function render(animate = false) {
    const cur = stages[st.stage];
    stagesEl.innerHTML = stages.map((s, i) => `${i ? '<span class="pipe-bar" aria-hidden="true">|</span>' : ""}<button type="button" class="pipe-stage${i === st.stage ? " current" : i < st.stage ? " done" : ""}" data-i="${i}" aria-pressed="${i === st.stage}">${esc(s.cmd)}</button>`).join("");
    // Bands of equal adjacent lines after sort.
    let band = 0;
    const lines = cur.out.map((l, i) => {
      if (cur.id === "sort" && i > 0 && l !== cur.out[i - 1]) band ^= 1;
      const cls = cur.id === "sort" && band ? "ln g1" : "ln";
      const delay = animate ? ` style="transition-delay:${Math.min(i * 16, 320)}ms"` : "";
      return `<span class="${cls}"${delay}>${lineHTML(cur, i, l, cur.out)}</span>`;
    });
    outEl.classList.toggle("enter", animate && !prefersReducedMotion());
    outEl.innerHTML = lines.length ? lines.join("") : `<span class="empty">no lines</span>`;
    o("label").textContent = `Output of stage ${st.stage + 1}: ${cur.cmd}`;
    o("count").textContent = `${cur.out.length} line${cur.out.length === 1 ? "" : "s"}`;
    o("explain").innerHTML = explain[cur.id]({ n: cur.out.length });
    root.querySelector('[data-act="prev"]').disabled = st.stage === 0;
    root.querySelector('[data-act="next"]').disabled = st.stage === stages.length - 1;
  }

  function go(i, animate = true) { st.stage = Math.max(0, Math.min(stages.length - 1, i)); render(animate); }

  const loop = makeLoop(root.querySelector('[data-act="play"]'), async () => {
    if (st.stage >= stages.length - 1) go(0); else go(st.stage + 1);
    return st.stage < stages.length - 1;
  }, 1300);

  stagesEl.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) { loop.stop(); go(+b.dataset.i); } });
  root.querySelector('[data-act="prev"]').addEventListener("click", () => { loop.stop(); go(st.stage - 1); });
  root.querySelector('[data-act="next"]').addEventListener("click", () => { loop.stop(); go(st.stage + 1); });
  root.querySelectorAll("[data-field]").forEach((b) => b.addEventListener("click", () => {
    st.field = b.dataset.field;
    root.querySelectorAll("[data-field]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    compute(); render(false);
  }));
  slider(root.querySelector("#pipe-head"), (v) => String(v), (v) => { st.headN = v; compute(); if (stages.length) render(false); });
  text.addEventListener("input", () => { st.lines = parseLines(text.value).slice(0, 200); compute(); render(false); });
  root.querySelector('[data-act="restore"]').addEventListener("click", () => {
    text.value = SAMPLE_LOG.join("\n"); st.lines = [...SAMPLE_LOG]; compute(); render(false);
  });
  compute(); render(false);
}

/* ------------------------------------------------------------------ */
/* Memory: in-memory hash table vs external sort                       */
/* ------------------------------------------------------------------ */
{
  const root = document.getElementById("mem");
  const chart = root.querySelector(".chart");
  const verdict = root.querySelector(".verdict");
  const o = (k) => root.querySelector(`[data-out="${k}"]`);
  const OVERHEAD = 48;          // bytes per hash table entry beyond the key itself (pointers, counter, slack)
  const REPEATS = 10;           // each distinct key appears this many times in the log, on average
  const SORT_BUFFER = 1e9;      // sort -S 1G
  const st = { keys: 1e6, keyBytes: 40, ramGB: 16 };

  const bytes = (b) => {
    const u = ["B", "kB", "MB", "GB", "TB", "PB"];
    let i = 0; while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
    return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(b >= 10 ? 0 : 1)} ${u[i]}`;
  };
  const keyFmt = (k) => (k >= 1e9 ? `${+(k / 1e9).toFixed(1)} billion` : k >= 1e6 ? `${+(k / 1e6).toFixed(1)} million` : k >= 1e3 ? `${Math.round(k / 1e3)} thousand` : String(Math.round(k)));
  const hashMem = (k) => k * (st.keyBytes + OVERHEAD);
  const sortInput = (k) => k * REPEATS * (st.keyBytes + 1);
  const sortMem = (k) => Math.min(sortInput(k), SORT_BUFFER);

  let W = 0;
  function draw(width = W) {
    W = width; if (!W) return;
    const h = 250, left = 54, right = 10, top = 10, bottom = 30;
    const x = logScale([1e3, 1e10], [left, W - right]);
    const y = logScale([1e4, 1e15], [h - bottom, top]);
    chart.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${W} ${h}`, height: h, role: "img", "aria-label": "Memory needed by a hash table and by an external sort as the number of distinct keys grows" }, chart);
    const grid = el("g", { class: "grid" }, svg);
    for (const t of logTicks(1e4, 1e15).filter((_, i) => i % 2 === 0)) {
      el("line", { x1: left, x2: W - right, y1: y(t), y2: y(t) }, grid);
      el("text", { x: left - 6, y: y(t) + 4, "text-anchor": "end" }, svg).textContent = bytes(t);
    }
    for (const t of logTicks(1e3, 1e10).filter((_, i) => W > 420 || i % 2 === 0)) {
      el("text", { x: x(t), y: h - 10, "text-anchor": "middle" }, svg).textContent = keyFmt(t).replace(" thousand", "k").replace(" million", "M").replace(" billion", "B");
    }
    el("text", { x: W - right, y: h - bottom - 6, "text-anchor": "end" }, svg).textContent = "distinct keys";
    const ram = st.ramGB * 1e9;
    el("line", { x1: left, x2: W - right, y1: y(ram), y2: y(ram), style: "stroke:var(--red);stroke-width:1.5;stroke-dasharray:5 4" }, svg);
    el("text", { x: left + 6, y: y(ram) - 6, style: "fill:var(--red)" }, svg).textContent = `machine memory ${st.ramGB} GB`;
    const path = (f) => { let d = ""; for (let i = 0; i <= 70; i++) { const k = 10 ** (3 + (7 * i) / 70); d += `${i ? "L" : "M"}${x(k).toFixed(1)},${y(f(k)).toFixed(1)}`; } return d; };
    el("path", { d: path(hashMem), style: "fill:none;stroke:var(--accent);stroke-width:2" }, svg);
    el("path", { d: path(sortMem), style: "fill:none;stroke:var(--green);stroke-width:2" }, svg);
    const kx = x(st.keys);
    el("line", { x1: kx, x2: kx, y1: top, y2: h - bottom, style: "stroke:var(--ink-4);stroke-width:1" }, svg);
    el("circle", { cx: kx, cy: y(hashMem(st.keys)), r: 4.5, style: "fill:var(--accent)" }, svg);
    el("circle", { cx: kx, cy: y(sortMem(st.keys)), r: 4.5, style: "fill:var(--green)" }, svg);
  }

  function update() {
    const hm = hashMem(st.keys), input = sortInput(st.keys), ram = st.ramGB * 1e9;
    const runs = input > SORT_BUFFER ? Math.ceil(input / SORT_BUFFER) : 0;
    const passes = runs ? Math.max(1, Math.ceil(Math.log(runs) / Math.log(16))) : 0;
    o("hash").textContent = bytes(hm);
    o("sortmem").textContent = bytes(sortMem(st.keys));
    o("spill").textContent = runs ? `${runs.toLocaleString("en-US")} runs, ${bytes(input)}` : "none";
    o("passes").textContent = runs ? String(passes) : "0";
    const fits = hm < ram * 0.8;
    verdict.className = `verdict ${fits ? "good" : "bad"}`;
    verdict.innerHTML = fits
      ? `The hash table fits: ${bytes(hm)} for ${keyFmt(st.keys)} keys. Counting in memory is the simpler and faster choice here.`
      : `The hash table needs ${bytes(hm)} and the machine has ${st.ramGB} GB. It will swap or crash. The sort never holds more than its 1 GB buffer: it spills ${runs.toLocaleString("en-US")} sorted runs to disk and merges them in ${passes} pass${passes === 1 ? "" : "es"}, reading the disk sequentially.`;
    draw();
  }

  const keyIn = root.querySelector("#mem-keys");
  slider(keyIn, (v) => keyFmt(10 ** v), (v) => { st.keys = 10 ** v; update(); });
  slider(root.querySelector("#mem-bytes"), (v) => `${v} bytes`, (v) => { st.keyBytes = v; update(); });
  slider(root.querySelector("#mem-ram"), (v) => `${2 ** v} GB`, (v) => { st.ramGB = 2 ** v; update(); });
  responsive(chart, draw);
}
