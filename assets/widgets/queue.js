// Lesson 5: utilization vs response time (simple queueing model).
import { el, linear, fmt, ms, responsive, slider } from "../charts.js";

const root = document.getElementById("queue");
const chart = root.querySelector(".chart");
const out = (k) => root.querySelector(`[data-out="${k}"]`);
const verdict = root.querySelector(".verdict");
const PER_SERVER = 200;            // requests per second one server can handle
const S = 1000 / PER_SERVER;       // service time in ms
const YMAX = 200;

let rate = 520, servers = 4, width = 0;

const mean = (u) => S / (1 - u);
const p99 = (u) => (S * Math.log(100)) / (1 - u);

function draw(w = width) {
  width = w;
  if (!w) return;
  const u = rate / (servers * PER_SERVER);
  const over = u >= 1;
  out("util").textContent = over ? `${Math.round(u * 100)}%` : `${Math.round(u * 100)}%`;
  out("cap").textContent = `${fmt(servers * PER_SERVER)}/s`;
  out("mean").textContent = over ? "∞" : ms(mean(u));
  out("p99").textContent = over ? "∞" : ms(p99(u));

  let cls = "good", msg = "Comfortable. There is plenty of headroom for a traffic spike.";
  if (over) { cls = "bad"; msg = "Overloaded. Requests arrive faster than they can be served, so the queue grows without limit. Add servers or shed load."; }
  else if (u > 0.85) { cls = "bad"; msg = "Danger zone. A small increase in traffic now causes a huge jump in response time."; }
  else if (u > 0.6) { cls = ""; msg = "Getting steep. Response time is starting to climb faster than load."; }
  verdict.className = `verdict ${cls}`;
  verdict.textContent = msg;

  const h = 240, padL = 44, padB = 28, padT = 12;
  const x = linear([0, 1], [padL, w - 10]);
  const y = linear([0, YMAX], [h - padB, padT]);
  chart.innerHTML = "";
  const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, height: h, role: "img", "aria-label": "Response time rises sharply as utilization approaches 100 percent" }, chart);
  const g = el("g", { class: "grid" }, svg);
  for (const t of [0, 50, 100, 150, 200]) {
    el("line", { x1: padL, x2: w - 10, y1: y(t), y2: y(t) }, g);
    const tx = el("text", { x: padL - 6, y: y(t) + 4, "text-anchor": "end" }, svg); tx.textContent = `${t} ms`;
  }
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const tx = el("text", { x: x(t), y: h - 8, "text-anchor": t === 1 ? "end" : "middle" }, svg); tx.textContent = `${t * 100}%`;
  }
  // danger band
  el("rect", { x: x(0.85), y: padT, width: x(1) - x(0.85), height: h - padB - padT, style: "fill:var(--red-soft);opacity:.7" }, svg);
  const curve = (f) => {
    let d = "";
    for (let i = 0; i <= 400; i++) {
      const uu = (i / 400) * 0.995;
      const v = f(uu);
      if (v > YMAX) { d += `L${x(uu)},${y(YMAX)}`; break; }
      d += `${i ? "L" : "M"}${x(uu)},${y(v)}`;
    }
    return d;
  };
  el("path", { d: curve(p99), style: "fill:none;stroke:var(--red);stroke-width:2.5" }, svg);
  el("path", { d: curve(mean), style: "fill:none;stroke:var(--accent);stroke-width:2.5" }, svg);

  const cu = Math.min(u, 0.995);
  const mx = x(cu);
  el("line", { x1: mx, x2: mx, y1: padT, y2: h - padB, style: "stroke:var(--ink-2);stroke-dasharray:3 3" }, svg);
  if (!over) {
    for (const [f, c] of [[mean, "var(--accent)"], [p99, "var(--red)"]]) {
      const v = f(u);
      if (v <= YMAX) el("circle", { cx: mx, cy: y(v), r: 5.5, style: `fill:${c};stroke:var(--surface);stroke-width:2` }, svg);
    }
  }
  const lbl = el("text", { x: mx + (mx > w - 90 ? -6 : 6), y: padT + 12, "text-anchor": mx > w - 90 ? "end" : "start", style: "fill:var(--ink);font-weight:600" }, svg);
  lbl.textContent = over ? "you are past 100%" : "you are here";
}

slider(root.querySelector("#rate"), (v) => `${fmt(v)}/s`, (v) => { rate = v; draw(); });
slider(root.querySelector("#servers"), (v) => String(v), (v) => { servers = v; draw(); });
responsive(chart, draw);
