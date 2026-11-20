// Lesson 3: fan-out on read vs fan-out on write.
import { el, logScale, logTicks, fmt, responsive, slider } from "../charts.js";

const root = document.getElementById("fanout");
const chart = root.querySelector(".chart");
const verdict = root.querySelector(".verdict");
const CELEB_FOLLOWERS = 20e6;
const CELEBS_FOLLOWED = 3;

const toLog = (v) => { const n = 10 ** v; const m = 10 ** Math.floor(Math.log10(n)); return Math.round(n / m * 2) / 2 * m; };
const s = { posts: 5000, reads: 300000, followers: 200, celebPosts: 0 };

function compute() {
  const { posts, reads, followers, celebPosts } = s;
  return [
    { key: "pull", name: "Assemble on read", writes: posts + celebPosts, reads: reads * followers },
    { key: "push", name: "Deliver on write", writes: posts * followers + celebPosts * CELEB_FOLLOWERS, reads },
    { key: "hybrid", name: "Hybrid", writes: posts * followers + celebPosts, reads: reads * (1 + CELEBS_FOLLOWED) },
  ].map((r) => ({ ...r, total: r.writes + r.reads }));
}

let lastWidth = 0;
function draw(width = lastWidth) {
  lastWidth = width;
  if (!width) return;
  const rows = compute();
  const best = rows.reduce((a, b) => (b.total < a.total ? b : a));
  const labelW = width < 480 ? 0 : 130;
  const rowH = width < 480 ? 58 : 44;
  const top = 8, h = rows.length * rowH + 30;
  const x = logScale([1e3, 1e10], [labelW, width - 8]);
  chart.innerHTML = "";
  const svg = el("svg", { viewBox: `0 0 ${width} ${h}`, height: h, role: "img", "aria-label": "Operations per second for each approach" }, chart);
  const grid = el("g", { class: "grid" }, svg);
  for (const t of logTicks(1e3, 1e10)) {
    el("line", { x1: x(t), x2: x(t), y1: top, y2: h - 22 }, grid);
    const tx = el("text", { x: x(t), y: h - 6, "text-anchor": "middle" }, svg); tx.textContent = fmt(t, 0);
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH + (labelW ? 8 : 22);
    if (labelW) { const l = el("text", { x: 0, y: y + 15, style: "fill:var(--ink);font-size:13px;font-weight:600" }, svg); l.textContent = r.name; }
    else { const l = el("text", { x: 0, y: y - 6, style: "fill:var(--ink);font-size:12px;font-weight:600" }, svg); l.textContent = r.name; }
    const isBest = r === best;
    el("rect", { x: labelW, y, width: Math.max(2, x(r.total) - labelW), height: 22, rx: 4, style: `fill:${isBest ? "var(--accent)" : "var(--ink-3)"};opacity:${isBest ? 1 : 0.45}` }, svg);
    const end = x(r.total);
    const txt = `${fmt(r.total)}/s`;
    const inside = end > width - 70;
    const v = el("text", { x: inside ? end - 6 : end + 6, y: y + 15, "text-anchor": inside ? "end" : "start", style: `font-family:var(--mono);font-size:12px;fill:${inside ? "var(--bg)" : "var(--ink)"}` }, svg);
    v.textContent = txt;
  });

  root.querySelectorAll("[data-row]").forEach((td) => {
    const r = rows.find((x) => x.key === td.dataset.row);
    td.textContent = td.dataset.col === "w" ? fmt(r.writes) : fmt(r.reads);
  });

  let msg = `<strong>${best.name}</strong> does the least work here: ${fmt(best.total)} operations per second.`;
  if (s.celebPosts > 0) msg += ` Every celebrity post forces "deliver on write" to make ${fmt(CELEB_FOLLOWERS)} mailbox writes.`;
  else if (best.key === "push") msg += " Reads vastly outnumber posts, so doing the work once at write time pays off. Now let a celebrity post.";
  verdict.innerHTML = msg;
}

slider(root.querySelector("#posts"), (v) => fmt(v) + "/s", (v) => { s.posts = v; draw(); });
slider(root.querySelector("#reads"), (v) => fmt(toLog(v)) + "/s", (v) => { s.reads = toLog(v); draw(); });
slider(root.querySelector("#followers"), (v) => fmt(toLog(v)), (v) => { s.followers = toLog(v); draw(); });
slider(root.querySelector("#celeb"), (v) => (v === 0 ? "none" : `${v}/s`), (v) => { s.celebPosts = v; draw(); });
responsive(chart, draw);
