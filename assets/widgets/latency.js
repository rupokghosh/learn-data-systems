// Lesson 4: response-time distribution and tail latency amplification.
import { el, logScale, linear, niceTicks, fmt, ms, responsive, slider, rng, normal } from "../charts.js";

/* ---------- Histogram ---------- */
{
  const root = document.getElementById("latency");
  const chart = root.querySelector(".chart");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const N = 1000;
  let seed = 3, slowRate = 0.02, data = [], stats = {};

  const MARKERS = [
    { key: "mean", label: "mean", color: "var(--ink-2)", dash: "4 3" },
    { key: "p50", label: "p50", color: "var(--accent)" },
    { key: "p95", label: "p95", color: "var(--orange)" },
    { key: "p99", label: "p99", color: "var(--red)" },
    { key: "p999", label: "p99.9", color: "var(--purple)" },
  ];

  function generate() {
    const r = rng(seed);
    data = Array.from({ length: N }, () => {
      let v = Math.exp(Math.log(45) + 0.42 * normal(r));
      if (r() < slowRate) v += Math.exp(Math.log(650) + 0.6 * normal(r));
      return Math.min(9500, Math.max(6, v));
    });
    const sorted = [...data].sort((a, b) => a - b);
    const q = (p) => sorted[Math.ceil(p * N) - 1];
    stats = { mean: data.reduce((a, b) => a + b, 0) / N, p50: q(0.5), p95: q(0.95), p99: q(0.99), p999: q(0.999) };
    for (const m of MARKERS) out(m.key).textContent = ms(stats[m.key]);
  }

  let width = 0;
  function draw(w = width) {
    width = w;
    if (!w) return;
    const h = 248, padB = 26, padT = 48;
    const x = logScale([5, 10000], [0, w]);
    const BINS = Math.max(24, Math.min(56, Math.floor(w / 12)));
    const counts = new Array(BINS).fill(0);
    const lo = Math.log10(5), hi = Math.log10(10000);
    for (const v of data) counts[Math.min(BINS - 1, Math.floor(((Math.log10(v) - lo) / (hi - lo)) * BINS))]++;
    const ys = linear([0, Math.sqrt(Math.max(...counts))], [h - padB, padT]);
    const y = (c) => ys(Math.sqrt(c)); // square-root scale keeps rare slow requests visible
    chart.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, height: h, role: "img", "aria-label": "Histogram of response times" }, chart);
    const bw = w / BINS;
    counts.forEach((c, i) => {
      if (!c) return;
      const mid = 10 ** (lo + ((i + 0.5) / BINS) * (hi - lo));
      const tail = mid > stats.p95;
      el("rect", { x: i * bw + 1, y: y(c), width: Math.max(1, bw - 2), height: h - padB - y(c), rx: 2,
        style: `fill:${tail ? "var(--orange)" : "var(--ink-3)"};opacity:${tail ? 0.85 : 0.4}` }, svg);
    });
    el("line", { x1: 0, x2: w, y1: h - padB, y2: h - padB, style: "stroke:var(--line)" }, svg);
    for (const t of [10, 30, 100, 300, 1000, 3000, 10000]) {
      const tx = el("text", { x: x(t), y: h - 8, "text-anchor": t === 10000 ? "end" : "middle" }, svg);
      tx.textContent = ms(t);
    }
    // Marker lines with labels on up to three rows: each label takes the first row where it fits.
    const rowEnds = [-Infinity, -Infinity, -Infinity];
    [...MARKERS].sort((a, b) => stats[a.key] - stats[b.key]).forEach((m) => {
      const px = x(stats[m.key]);
      const lw = m.label.length * 7 + 6;
      const anchor = px > w - 30 ? "end" : "middle";
      const left = anchor === "end" ? px - lw : px - lw / 2;
      let row = rowEnds.findIndex((end) => end <= left);
      if (row < 0) row = rowEnds.indexOf(Math.min(...rowEnds));
      rowEnds[row] = left + lw;
      el("line", { x1: px, x2: px, y1: padT - 4, y2: h - padB, style: `stroke:${m.color};stroke-width:2${m.dash ? `;stroke-dasharray:${m.dash}` : ""}` }, svg);
      const t = el("text", { x: px, y: 12 + row * 14, "text-anchor": anchor, style: `fill:${m.color};font-weight:600` }, svg);
      t.textContent = m.label;
    });
  }

  slider(root.querySelector("#slow-rate"), (v) => `${v}%`, (v) => { slowRate = v / 100; generate(); draw(); });
  root.querySelector("[data-resample]").addEventListener("click", () => { seed++; generate(); draw(); });
  responsive(chart, draw);
}

/* ---------- Tail latency amplification ---------- */
{
  const root = document.getElementById("tail");
  const chart = root.querySelector(".chart");
  const calls = root.querySelector(".calls");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const r = rng(11);
  let n = 10, p = 0.01, width = 0;

  const prob = (k) => 1 - (1 - p) ** k;

  function renderCalls(result) {
    calls.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const d = document.createElement("span");
      d.className = "call" + (result?.[i] ? " slow" : "");
      calls.appendChild(d);
    }
  }

  function draw(w = width) {
    width = w;
    if (!w) return;
    out("chance").textContent = `${(prob(n) * 100).toFixed(prob(n) < 0.1 ? 1 : 0)}%`;
    const h = 200, padL = 36, padB = 26, padT = 10;
    const x = linear([1, 100], [padL, w - 8]);
    const y = linear([0, 1], [h - padB, padT]);
    chart.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, height: h, role: "img", "aria-label": "Chance a request is slow versus number of backend calls" }, chart);
    const g = el("g", { class: "grid" }, svg);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      el("line", { x1: padL, x2: w - 8, y1: y(t), y2: y(t) }, g);
      const tx = el("text", { x: padL - 6, y: y(t) + 4, "text-anchor": "end" }, svg); tx.textContent = `${t * 100}%`;
    }
    for (const t of niceTicks(0, 100, 5).filter((t) => t >= 1 || t === 0)) {
      const tx = el("text", { x: x(Math.max(1, t)), y: h - 8, "text-anchor": t === 100 ? "end" : "middle" }, svg); tx.textContent = Math.max(1, t);
    }
    let d = "";
    for (let k = 1; k <= 100; k++) d += `${k === 1 ? "M" : "L"}${x(k)},${y(prob(k))}`;
    el("path", { d, style: "fill:none;stroke:var(--accent);stroke-width:2.5" }, svg);
    el("line", { x1: x(n), x2: x(n), y1: y(prob(n)), y2: h - padB, style: "stroke:var(--ink-3);stroke-dasharray:3 3" }, svg);
    el("line", { x1: padL, x2: x(n), y1: y(prob(n)), y2: y(prob(n)), style: "stroke:var(--ink-3);stroke-dasharray:3 3" }, svg);
    el("circle", { cx: x(n), cy: y(prob(n)), r: 6, style: "fill:var(--accent);stroke:var(--surface);stroke-width:2" }, svg);
  }

  slider(root.querySelector("#calls"), (v) => String(v), (v) => { n = v; renderCalls(); out("result").textContent = ""; draw(); });
  slider(root.querySelector("#p-slow"), (v) => `${v}%`, (v) => { p = v / 100; draw(); });
  root.querySelector("[data-send]").addEventListener("click", () => {
    const result = Array.from({ length: n }, () => r() < p);
    renderCalls(result);
    const slow = result.filter(Boolean).length;
    const o = out("result");
    o.className = `verdict ${slow ? "bad" : "good"}`;
    o.textContent = slow
      ? `${slow} of ${n} calls were slow, so the whole page was slow. The user only sees the slowest call.`
      : `All ${n} calls were fast. Lucky this time. Send a few more.`;
  });
  responsive(chart, draw);
}
