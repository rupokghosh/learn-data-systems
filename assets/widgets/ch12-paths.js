// Chapter 12, lesson 2: slide the boundary between the write path and the read path.
import { el, logScale, logTicks, fmt, responsive, slider } from "../charts.js";
import { simulate, DESIGNS, CACHE_TTL } from "../engines/ch12-paths.js";

const root = document.getElementById("paths");
const strip = root.querySelector(".wr-strip");
const desc = root.querySelector(".wr-desc");
const chart = root.querySelector(".chart");
const verdict = root.querySelector(".verdict");
const out = (k) => root.querySelector(`[data-out="${k}"]`);

const RATIOS = [0.1, 0.3, 1, 3, 10, 30, 100];
const memo = new Map();
const results = (i) => { if (!memo.has(i)) memo.set(i, simulate(RATIOS[i])); return memo.get(i); };

// Pipeline stages from a raw save to pixels on a screen. For each design: w = on save, r = on read, c = on read and then cached.
const STAGES = [
  { name: "Store the save", plan: ["w", "w", "w", "w", "w"] },
  { name: "Find nearby listings", plan: ["r", "w", "w", "w", "w"] },
  { name: "Rank the top 10", plan: ["r", "r", "c", "w", "w"] },
  { name: "Assemble the list", plan: ["r", "r", "c", "r", "w"] },
  { name: "Deliver to the screen", plan: ["r", "r", "r", "r", "w"] },
];
const WHEN = { w: "on save", r: "on read", c: `on a miss, kept ${CACHE_TTL} s` };
strip.innerHTML = STAGES.map((s) => `<div class="wr-stage"><b>${s.name}</b><span></span></div>`).join("");
const stageEls = [...strip.children];

const st = { design: 0, ratio: 2 };

function update() {
  const rows = results(st.ratio);
  const d = rows[st.design];
  stageEls.forEach((elm, i) => {
    const p = STAGES[i].plan[st.design];
    elm.className = "wr-stage " + (p === "w" ? "w" : "r");
    elm.querySelector("span").textContent = WHEN[p];
  });
  desc.innerHTML = `<b>On save:</b> ${d.write} <b>On read:</b> ${d.read}`;
  out("perWrite").textContent = fmt(d.perWrite);
  out("perRead").textContent = fmt(d.perRead);
  out("total").textContent = fmt(d.perSecond) + "/s";
  out("stale").textContent = (d.staleShare * 100).toFixed(d.staleShare > 0 && d.staleShare < 0.1 ? 1 : 0) + "%";
  out("age").textContent = d.maxAge === 0 ? "none" : d.maxAge < 1 ? `${d.maxAge * 1000} ms` : `${d.maxAge} s`;
  out("storage").textContent = fmt(d.storage);
  draw();
  const best = rows.reduce((a, b) => (b.perSecond < a.perSecond ? b : a));
  const fresh = rows.filter((r) => r.staleShare === 0).reduce((a, b) => (b.perSecond < a.perSecond ? b : a));
  let msg = `At ${fmt(RATIOS[st.ratio])} page views per save, the least total work is <strong>${best.name.toLowerCase()}</strong> (${fmt(best.perSecond)} records per second).`;
  if (best.staleShare > 0) msg += ` If every read must reflect every save, the cheapest exact option is ${fresh.name.toLowerCase()} at ${fmt(fresh.perSecond)}.`;
  if (d.key === "cache") msg += ` The cache gets more effective as reads grow, but it is the only design whose staleness is set by a timer instead of by how fast changes propagate.`;
  if (d.key === "push") msg += ` Pushing keeps open pages current without them asking, at the price of a connection per open page and work on every save even if nobody looks.`;
  verdict.innerHTML = msg;
}

let lastW = 0;
function draw(w = lastW) {
  lastW = w;
  if (!w) return;
  const rows = results(st.ratio);
  const labelW = w < 480 ? 0 : 150;
  const rowH = w < 480 ? 46 : 30;
  const h = rows.length * rowH + 28;
  const x = logScale([10, 1e7], [labelW, w - 8]);
  chart.innerHTML = "";
  const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, height: h, role: "img", "aria-label": "Records touched per second for each design" }, chart);
  const grid = el("g", { class: "grid" }, svg);
  for (const t of logTicks(10, 1e7)) {
    el("line", { x1: x(t), x2: x(t), y1: 4, y2: h - 22 }, grid);
    el("text", { x: x(t), y: h - 6, "text-anchor": "middle" }, svg).textContent = fmt(t, 0);
  }
  rows.forEach((r, i) => {
    const on = i === st.design;
    const y = 4 + i * rowH + (labelW ? 4 : 18);
    const lab = el("text", labelW ? { x: 0, y: y + 13 } : { x: 0, y: y - 5 }, svg);
    lab.setAttribute("style", `fill:${on ? "var(--ink)" : "var(--ink-3)"};font-size:12px;font-weight:${on ? 600 : 400}`);
    lab.textContent = r.short + (r.staleShare > 0 ? " (may lag)" : "");
    const end = x(Math.max(10, r.perSecond));
    el("rect", { x: labelW, y, width: Math.max(2, end - labelW), height: 18, rx: 3, style: `fill:${on ? "var(--accent)" : "var(--ink-3)"};opacity:${on ? 1 : 0.35}` }, svg);
    const inside = end > w - 64;
    const v = el("text", { x: inside ? end - 6 : end + 6, y: y + 13, "text-anchor": inside ? "end" : "start", style: `font-family:var(--mono);font-size:11px;fill:${inside ? "var(--bg)" : "var(--ink)"}` }, svg);
    v.textContent = fmt(r.perSecond) + "/s";
  });
}

const ratioIn = root.querySelector("#wr-ratio");
const designIn = root.querySelector("#wr-design");
slider(designIn, (v) => DESIGNS[v].name, (v) => { st.design = v; update(); });
slider(ratioIn, (v) => `${fmt(RATIOS[v])} per save`, (v) => { st.ratio = v; update(); });
responsive(chart, draw);
update();
