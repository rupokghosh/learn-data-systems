// Lesson: Modes of dataflow. One order placed three ways, drawn as space-time diagrams.
import { scenario, messageAt, FAULT } from "../engines/ch4-dataflow.js";
import { el, prefersReducedMotion } from "../charts.js";

const root = document.getElementById("dataflow");
const grid = root.querySelector(".df-grid");
const faultBox = root.querySelector("#df-fault");
const idemBox = root.querySelector("#df-idem");
const playBtn = root.querySelector("#df-play");

const MODES = [
  { id: "db", title: "Through a database" },
  { id: "rpc", title: "Through a service call" },
  { id: "broker", title: "Through a message broker" },
];
const W = 250, H = 336, TOP = 44, BOTTOM = 326, X0 = 38, X1 = 212;
const y = (t) => TOP + (t / 100) * (BOTTOM - TOP);

const panels = MODES.map((m) => {
  const d = document.createElement("div");
  d.className = "df-panel";
  d.innerHTML = `<p class="df-title"><span>${m.title}</span><small></small></p>`;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${m.title}: space-time diagram of placing an order` }, d);
  const verdict = document.createElement("div");
  verdict.className = "verdict";
  d.appendChild(verdict);
  grid.appendChild(d);
  return { ...m, node: d, svg, verdict, counter: d.querySelector("small") };
});

function laneX(i, n) { return n === 1 ? (X0 + X1) / 2 : X0 + (i * (X1 - X0)) / (n - 1); }

function drawPanel(p, sc, t, final) {
  const svg = p.svg;
  svg.textContent = "";
  const n = sc.lanes.length;
  const defs = el("defs", {}, svg);
  const mk = el("marker", { id: `df-arr-${p.id}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" }, defs);
  el("path", { d: "M0,0 L10,5 L0,10 z", style: "fill:var(--accent)" }, mk);

  // fault band on the link that drops
  if (faultBox.checked) {
    const [a, b] = sc.faultLink;
    const xa = laneX(a, n), xb = laneX(b, n);
    el("rect", { x: Math.min(xa, xb), y: y(FAULT.from), width: Math.abs(xb - xa), height: y(FAULT.to) - y(FAULT.from), class: "df-fault" }, svg);
    const lbl = el("text", { x: (xa + xb) / 2, y: y(FAULT.to) - 18, "text-anchor": "middle", class: "df-fault-label" }, svg);
    lbl.textContent = "link down";
  }
  // lanes
  sc.lanes.forEach((name, i) => {
    const x = laneX(i, n);
    el("line", { x1: x, y1: TOP - 6, x2: x, y2: BOTTOM, class: "df-lane" }, svg);
    const tx = el("text", { x, y: 20, "text-anchor": i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle", class: "df-lane-label" }, svg);
    if (i === 0 && n > 1) tx.setAttribute("x", x - 30);
    if (i === n - 1 && n > 1) tx.setAttribute("x", x + 36);
    tx.textContent = name;
  });
  el("text", { x: 4, y: TOP - 12, class: "df-msg-label" }, svg).textContent = "time ↓";

  // messages (an order exists once the message or note that creates it has happened)
  let orders = 0;
  for (const m of sc.events.filter((e) => e.kind === "msg")) {
    const st = messageAt(m, t);
    if (!st.visible) continue;
    if (m.creates && st.done) orders++;
    const xa = laneX(m.from, n), xb = laneX(m.to, n);
    const ya = y(m.t0), yb = y(m.t1);
    const xh = xa + (xb - xa) * st.frac, yh = ya + (yb - ya) * st.frac;
    el("line", { x1: xa, y1: ya, x2: xh, y2: yh, class: "df-msg" + (m.lost !== undefined ? " dead" : ""), "marker-end": st.done ? `url(#df-arr-${p.id})` : null }, svg);
    if (st.dead) {
      el("line", { x1: xh - 5, y1: yh - 5, x2: xh + 5, y2: yh + 5, class: "df-x" }, svg);
      el("line", { x1: xh - 5, y1: yh + 5, x2: xh + 5, y2: yh - 5, class: "df-x" }, svg);
    } else if (!st.done) {
      el("circle", { cx: xh, cy: yh, r: 3.5, class: "df-head" }, svg);
    }
    const right = xb > xa;
    const lab = el("text", { x: xa + (right ? 6 : -6), y: ya - 4, "text-anchor": right ? "start" : "end", class: "df-msg-label" }, svg);
    lab.textContent = m.label;
  }
  // notes
  for (const e of sc.events.filter((x) => x.kind === "note")) {
    if (t < e.t) continue;
    const x = laneX(e.lane, n);
    const last = e.lane === n - 1 && n > 1;
    const first = e.lane === 0;
    el("circle", { cx: x, cy: y(e.t), r: 3, class: `df-note-dot ${e.cls}` }, svg);
    const tx = el("text", { x: first ? x + 7 : last ? x - 7 : x, y: y(e.t) + (first || last ? 4 : 15), "text-anchor": first ? "start" : last ? "end" : "middle", class: `df-note ${e.cls}` }, svg);
    tx.textContent = e.text;
    if (e.creates) orders++;
  }
  // time cursor while animating
  if (!final) el("line", { x1: 0, y1: y(t), x2: W, y2: y(t), class: "df-time" }, svg);

  p.counter.textContent = `orders created: ${orders}`;
  if (final) { p.verdict.className = `verdict ${sc.verdict.cls}`; p.verdict.textContent = sc.verdict.text; }
  else { p.verdict.className = "verdict"; p.verdict.textContent = ""; }
}

let raf = 0;
function render(t, final) {
  const opts = { fault: faultBox.checked, idem: idemBox.checked };
  panels.forEach((p) => drawPanel(p, scenario(p.id, opts), t, final));
}

function play() {
  cancelAnimationFrame(raf);
  if (prefersReducedMotion()) { render(100, true); return; }
  const DURATION = 7000; // explanatory step-through: time runs at a steady pace
  const t0 = performance.now();
  const frame = (now) => {
    const t = Math.min(100, ((now - t0) / DURATION) * 100);
    render(t, t >= 100);
    if (t < 100) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}

playBtn.addEventListener("click", play);
const instant = () => { cancelAnimationFrame(raf); render(100, true); };
faultBox.addEventListener("change", instant);
idemBox.addEventListener("change", instant);
render(0, false);
panels.forEach((p) => { p.verdict.textContent = ""; });
