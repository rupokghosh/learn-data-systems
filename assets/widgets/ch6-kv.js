// Chapter 6, lesson 1: a live stream of writes routed to 8 partitions.
import { el, responsive, prefersReducedMotion, slider } from "../charts.js";
import { WORKLOADS, NPART, createStream, rangeTouches, saltedSpread } from "../engines/ch6-partition.js";

const root = document.getElementById("kv-stream");
const chart = root.querySelector(".chart");
const verdict = root.querySelector(".verdict");
const out = (name) => root.querySelector(`[data-out="${name}"]`);
const saltBox = root.querySelector("#kv-salt");
const saltInput = root.querySelector("#kv-saltn");
const pauseBtn = root.querySelector("[data-act=pause]");

const TICK_MS = 120, WRITES_PER_TICK = 40, DOTS_PER_TICK = 2;
const s = { workload: "uniform", scheme: "range", salt: false, saltN: 8, paused: false, visible: false };
let stream = null;
let seed = 7;

function rebuild() {
  seed++;
  stream = createStream({ workload: s.workload, scheme: s.scheme, salt: s.salt, saltN: s.saltN, seed });
  syncControls();
  update();
}

// ---------- chart ----------
let g = null; // geometry and element handles from the last layout
function layout(width) {
  chart.innerHTML = "";
  const h = 262, axisW = 40, top = 52, base = 206;
  const svg = el("svg", { viewBox: `0 0 ${width} ${h}`, height: h, role: "img", "aria-label": "Share of recent writes on each of 8 partitions" }, chart);
  const y = (share) => base - share * (base - top);
  const slot = (width - axisW) / NPART;
  const bw = Math.min(46, slot * 0.62);
  const cx = (p) => axisW + slot * p + slot / 2;

  const grid = el("g", {}, svg);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    el("line", { x1: axisW, x2: width, y1: y(t), y2: y(t), style: "stroke:var(--line)" }, grid);
    const tx = el("text", { x: axisW - 6, y: y(t) + 4, "text-anchor": "end", class: "ch6-axis" }, grid);
    tx.textContent = `${t * 100}%`;
  }
  // incoming writes label and router
  const src = el("text", { x: width / 2, y: 14, "text-anchor": "middle", class: "ch6-src" }, svg);
  const bars = [], vals = [], marks = [];
  for (let p = 0; p < NPART; p++) {
    bars.push(el("rect", { x: cx(p) - bw / 2, width: bw, y: base, height: 0, rx: 3, class: "ch6-bar" }, svg));
    vals.push(el("text", { x: cx(p), y: base - 4, "text-anchor": "middle", class: "ch6-val" }, svg));
    const lb = el("text", { x: cx(p), y: base + 16, "text-anchor": "middle", class: "ch6-axis" }, svg);
    lb.textContent = "p" + p;
    marks.push(el("rect", { x: cx(p) - bw / 2, y: base + 30, width: bw, height: 9, rx: 2, class: "ch6-mark" }, svg));
  }
  const ml = el("text", { x: axisW - 6, y: base + 38, "text-anchor": "end", class: "ch6-axis" }, svg);
  ml.textContent = "scan";
  const fair = el("line", { x1: axisW, x2: width, y1: y(1 / NPART), y2: y(1 / NPART), class: "ch6-fair" }, svg);
  // Labelled in the axis column: at the right end it collided with the bar values, which sit near this line.
  const fl = el("text", { x: axisW - 6, y: y(1 / NPART) + 4, "text-anchor": "end", class: "ch6-axis" }, svg);
  fl.textContent = "fair";
  const dots = el("g", {}, svg);
  g = { y, cx, bars, vals, marks, src, dots, fair, top };
  update();
}

function update() {
  if (!g || !stream) return;
  const total = stream.filled;
  const touched = new Set(rangeTouches(stream.wl, s.scheme));
  let hottest = 0;
  for (let p = 0; p < NPART; p++) {
    const share = stream.counts[p] / total;
    if (stream.counts[p] > stream.counts[hottest]) hottest = p;
    const yy = g.y(share);
    g.bars[p].setAttribute("y", yy);
    g.bars[p].setAttribute("height", Math.max(0, g.y(0) - yy));
    g.bars[p].classList.toggle("hot", share > 2 / NPART);
    g.vals[p].setAttribute("y", Math.min(yy, g.y(0)) - 4);
    g.vals[p].textContent = Math.round(share * 100) + "%";
    g.marks[p].classList.toggle("on", touched.has(p));
  }
  const maxShare = stream.counts[hottest] / total;
  out("hot").textContent = `p${hottest}: ${Math.round(maxShare * 100)}%`;
  out("ratio").textContent = `${(maxShare * NPART).toFixed(1)}×`;
  out("scan").textContent = `${touched.size} of ${NPART}`;
  out("query").textContent = stream.wl.query.label;
  out("rule").textContent = s.scheme === "range"
    ? stream.wl.rangeRule
    : stream.wl.partKey
      ? "partition = hash(sensor ID) mod 8. Only the sensor part of the key is hashed; readings stay sorted by time inside the partition."
      : "partition = hash(key) mod 8. Neighbouring keys land on unrelated partitions.";
  const wl = stream.wl;
  if (wl.hotKey) {
    if (s.salt) {
      const spread = saltedSpread(wl.hotKey, s.saltN, s.scheme, wl);
      out("reads").textContent = `${s.saltN} keys on ${spread.length} ${spread.length === 1 ? "partition" : "partitions"}`;
    } else out("reads").textContent = "1 key on 1 partition";
  } else out("reads").textContent = "no single hot key";
  verdictFor(hottest, maxShare);
}

function verdictFor(hot, share) {
  const w = s.workload, r = s.scheme === "range";
  const x = (share * NPART).toFixed(1);
  let cls = "good", msg = "";
  const spread = stream.wl.hotKey && s.salt ? saltedSpread(stream.wl.hotKey, s.saltN, s.scheme, stream.wl) : null;
  if (w === "uniform") msg = r
    ? "Random IDs fall evenly across the ranges, and the scan over a block of IDs reads a single partition."
    : "The load is just as even, but the scan over a block of IDs must now ask all 8 partitions, because neighbouring IDs were scattered by the hash.";
  else if (w === "time") {
    if (r) { cls = "bad"; msg = "Every new event carries a later timestamp than the one before, so every write lands in p7, the partition that holds the newest range. Seven partitions sit idle. Put something in front of the timestamp (try Sensor, then timestamp) or hash the key."; }
    else msg = "Hashing spreads the writes evenly, but the half-hour scan, which used to read one partition, now has to ask all 8.";
  } else if (w === "sensor") msg = r
    ? "Sensors write at similar rates, so the load spreads across the ranges, and one sensor's half hour of readings is a contiguous slice of one partition."
    : "Only the sensor ID is hashed. Load still spreads, and one sensor's readings stay together and sorted by time, so the scan touches one partition. That is a compound key.";
  else if (!s.salt) {
    cls = "bad";
    msg = w === "celeb"
      ? `Half of all writes carry the same key, and one key lives in exactly one partition. p${hot} carries ${x} times its fair share under either scheme. Try salting the hot key.`
      : `A few users get most of the traffic. The single most popular one puts p${hot} at ${x} times its fair share, under either scheme.`;
  } else if (r) {
    cls = "bad";
    msg = `A suffix sorts right next to the original key, so all ${s.saltN} salted keys stay inside one range and p${hot} is still hot. With key ranges the random part has to go at the front of the key instead.`;
  } else {
    msg = `The hot key is now ${s.saltN} keys spread over ${spread.length} partitions. The price is on the read side: reading that user means fetching all ${s.saltN} keys and merging them, and the application has to remember which keys are salted.`;
    if (spread.length < 4) cls = "";
  }
  verdict.className = "verdict " + cls;
  verdict.textContent = msg;
}

// ---------- the live stream ----------
function flyDot(p, hot) {
  if (prefersReducedMotion() || !g) return;
  const x0 = chart.clientWidth / 2, y0 = 22, x1 = g.cx(p), y1 = Math.max(g.top, Math.min(g.y(stream.counts[p] / stream.filled), g.y(0)) - 14);
  const dot = el("circle", { r: 3.5, class: "ch6-dot" + (hot ? " hot" : "") }, g.dots);
  dot.style.transform = `translate(${x0}px, ${y0}px)`;
  dot.getBoundingClientRect();
  dot.style.transition = "transform 520ms var(--ease-in-out), opacity 180ms ease 440ms";
  dot.style.transform = `translate(${x1}px, ${y1}px)`;
  dot.style.opacity = "0";
  setTimeout(() => dot.remove(), 700);
}

function tick() {
  if (s.paused || !s.visible || !stream) return;
  let last = null;
  const pickAt = new Set(Array.from({ length: DOTS_PER_TICK }, (_, i) => Math.floor(((i + 0.5) * WRITES_PER_TICK) / DOTS_PER_TICK)));
  for (let i = 0; i < WRITES_PER_TICK; i++) {
    last = stream.write();
    if (pickAt.has(i)) flyDot(last.p, last.hot);
  }
  if (g) g.src.textContent = `${short(last.key)}  →  p${last.p}`;
  update();
}
const short = (k) => k.replace("2026-11-19T", "");
setInterval(tick, TICK_MS);

new IntersectionObserver((entries) => { s.visible = entries[0].isIntersecting; }).observe(root);

// ---------- controls ----------
function syncControls() {
  root.querySelectorAll("[data-wl]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.wl === s.workload)));
  root.querySelectorAll("[data-scheme]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scheme === s.scheme)));
  const can = !!WORKLOADS[s.workload].hotKey;
  saltBox.disabled = !can;
  saltBox.closest("label").classList.toggle("is-off", !can);
  saltInput.disabled = !can || !s.salt;
  pauseBtn.textContent = s.paused ? "Resume stream" : "Pause stream";
  pauseBtn.setAttribute("aria-pressed", String(s.paused));
}

root.querySelectorAll("[data-wl]").forEach((b) => b.addEventListener("click", () => { s.workload = b.dataset.wl; rebuild(); }));
root.querySelectorAll("[data-scheme]").forEach((b) => b.addEventListener("click", () => { s.scheme = b.dataset.scheme; rebuild(); }));
saltBox.addEventListener("change", () => { s.salt = saltBox.checked; rebuild(); });
slider(saltInput, (v) => `${v} keys`, (v) => { if (s.saltN !== v) { s.saltN = v; if (stream) rebuild(); } });
pauseBtn.addEventListener("click", () => { s.paused = !s.paused; syncControls(); });

rebuild();
responsive(chart, layout);
