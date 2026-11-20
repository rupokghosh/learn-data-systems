// Chapter 12, lesson 4: a scoring model whose decisions shape its own training data.
import { el, linear, responsive, slider } from "../charts.js";
import { feedbackSim, GROUPS } from "../engines/ch12-ethics.js";

const root = document.getElementById("feedback");
const chart = root.querySelector(".chart");
const verdict = root.querySelector(".verdict");
const learnBox = root.querySelector("#fb-learn");
const out = (k) => root.querySelector(`[data-out="${k}"]`);
const COLORS = ["var(--accent)", "var(--orange)"];
const st = { threshold: 50, explore: 0, learns: true };
let res;

const pct = (v) => Math.round(v * 100) + "%";

function update() {
  res = feedbackSim({ threshold: st.threshold, learns: st.learns, explore: st.explore });
  const first = res[0], last = res[res.length - 1];
  const gap0 = first[0].rate - first[1].rate, gap1 = last[0].rate - last[1].rate;
  out("gap0").textContent = Math.round(gap0 * 100) + " pts";
  out("gap1").textContent = Math.round(gap1 * 100) + " pts";
  out("denied").textContent = `${last[1].worthyDenied} of ${last[1].worthy}`;
  out("repay").textContent = `${pct(last[0].meanP)} / ${pct(last[1].meanP)}`;
  const delta = Math.round((gap1 - gap0) * 100);
  let msg;
  if (delta >= 5) msg = `The gap grew by ${delta} points in 20 rounds, although people in both neighbourhoods are equally likely to repay.`;
  else if (delta <= -5) msg = st.explore > 0
    ? `The gap shrank by ${-delta} points. Trial loans let some Southmere applicants build the history the score was waiting for.`
    : `The gap narrowed by ${-delta} points, but only because newcomers with longer files moved in. Everyone denied in round 1 who stayed is still denied.`;
  else msg = `The gap barely moves. Without new evidence, the first round's verdict on Southmere simply repeats itself.`;
  if (st.learns && st.explore === 0) msg += ` Each round, the model counts denied Southmere applicants as "did not repay", lowers the area's weight, and denies more of them next time.`;
  else if (!st.learns && st.explore === 0) msg += ` The area weight is frozen here, but denied applicants still cannot add a repaid loan to their file.`;
  verdict.className = "verdict " + (delta >= 5 ? "bad" : delta <= -5 ? "good" : "");
  verdict.textContent = msg;
  draw();
}

let lastW = 0;
function draw(w = lastW) {
  lastW = w;
  if (!w || !res) return;
  const narrow = w < 480;
  const h = 240, padL = 36, padR = narrow ? 44 : 100, padT = 10, padB = 26;
  const x = linear([1, res.length], [padL, w - padR]);
  const y = linear([0, 1], [h - padB, padT]);
  chart.innerHTML = "";
  const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, height: h, role: "img", "aria-label": "Approval rate per round for each neighbourhood" }, chart);
  const grid = el("g", { class: "grid" }, svg);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    el("line", { x1: padL, x2: w - padR, y1: y(t), y2: y(t) }, grid);
    el("text", { x: padL - 6, y: y(t) + 4, "text-anchor": "end" }, svg).textContent = pct(t);
  }
  for (const r of [1, 5, 10, 15, 20]) el("text", { x: x(r), y: h - 8, "text-anchor": "middle" }, svg).textContent = r === 1 ? (narrow ? "1" : "round 1") : r;
  [0, 1].forEach((g) => {
    const pts = res.map((s, i) => `${x(i + 1)},${y(s[g].rate)}`).join(" ");
    el("polyline", { points: pts, style: `fill:none;stroke:${COLORS[g]};stroke-width:2;stroke-linejoin:round` }, svg);
    const lastR = res[res.length - 1][g].rate;
    el("circle", { cx: x(res.length), cy: y(lastR), r: 3.5, style: `fill:${COLORS[g]}` }, svg);
    const other = res[res.length - 1][1 - g].rate;
    const ly = y(lastR) + (Math.abs(lastR - other) < 0.08 ? (lastR >= other ? -6 : 12) : 4);
    const t = el("text", { x: x(res.length) + 8, y: ly, style: `fill:${COLORS[g]};font-size:12px` }, svg);
    t.textContent = narrow ? pct(lastR) : `${GROUPS[g]} ${pct(lastR)}`;
  });
}

slider(root.querySelector("#fb-thr"), (v) => v, (v) => { st.threshold = v; update(); });
slider(root.querySelector("#fb-exp"), (v) => (v === 0 ? "none" : v + "%"), (v) => { st.explore = v / 100; update(); });
learnBox.addEventListener("change", () => { st.learns = learnBox.checked; update(); });
responsive(chart, draw);
