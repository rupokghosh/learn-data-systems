// Chapter 12, lesson 3: a payment retried after a network fault, with and without an end-to-end operation ID.
import { el, prefersReducedMotion } from "../charts.js";
import { paymentScript, FAULTS, LANES } from "../engines/ch12-correct.js";

const root = document.getElementById("e2e");
const svg = root.querySelector(".seq svg");
const tbody = root.querySelector(".db-rows tbody");
const now = root.querySelector(".seq-now");
const verdict = root.querySelector(".verdict");
const charged = root.querySelector('[data-out="charged"]');
const idBox = root.querySelector("#e2e-id");
const faultBtns = [...root.querySelectorAll("[data-fault]")];
const btnPlay = root.querySelector('[data-act="play"]');
const btnStep = root.querySelector('[data-act="step"]');
const btnReset = root.querySelector('[data-act="reset"]');

const W = 410, LX = [70, 205, 340], TOP = 44, ROW = 31;
let fault = "response", script, shown = 0, timer = null, gen = 0;

function build() {
  script = paymentScript(fault, idBox.checked);
  const h = TOP + script.steps.length * ROW + 12;
  svg.setAttribute("viewBox", `0 0 ${W} ${h}`);
  svg.innerHTML = "";
  el("defs", {}, svg).innerHTML = `
    <marker id="sq-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--ink-3)"/></marker>`;
  LANES.forEach((name, i) => {
    el("text", { x: LX[i], y: 18, "text-anchor": "middle", class: "lane-name" }, svg).textContent = name;
    el("line", { x1: LX[i], x2: LX[i], y1: 28, y2: h - 4, class: "lifeline" }, svg);
  });
  script.steps.forEach((s, i) => {
    const y = TOP + i * ROW;
    const g = el("g", { class: "row-g hidden" }, svg);
    if (s.kind === "msg") {
      const x1 = LX[s.from], x2 = LX[s.to], dir = Math.sign(x2 - x1);
      const sx = x1 + dir * 3, ex = s.lost ? x1 + (x2 - x1) * 0.6 : x2 - dir * 3, ey = s.lost ? y + 11 : y + 18;
      el("line", { x1: sx, y1: y, x2: ex, y2: ey, class: "m" + (s.lost ? " lost" : ""), "marker-end": s.lost ? null : "url(#sq-a)" }, g);
      if (s.lost) {
        el("line", { x1: ex - 5, y1: ey - 5, x2: ex + 5, y2: ey + 5, class: "x" }, g);
        el("line", { x1: ex - 5, y1: ey + 5, x2: ex + 5, y2: ey - 5, class: "x" }, g);
      }
      el("text", { x: (x1 + x2) / 2, y: y - 3, "text-anchor": "middle", class: "ml" + (s.lost ? " lost" : "") }, g).textContent = s.label + (s.lost ? " (lost)" : "");
      g._path = { sx, sy: y, ex, ey };
    } else {
      const w = Math.min(196, s.label.length * 6.2 + 16);
      const cx = LX[s.lane];
      const x = s.lane === 0 ? 4 : s.lane === 2 ? W - 4 - w : cx - w / 2;
      const eg = el("g", { class: "ev " + (s.tone || "") }, g);
      el("rect", { x, y: y - 6, width: w, height: 20, rx: 4 }, eg);
      el("text", { x: x + w / 2, y: y + 8, "text-anchor": "middle" }, eg).textContent = s.label;
    }
  });
  const dot = el("circle", { r: 5, class: "dg-dot", opacity: 0 }, svg);
  svg._dot = dot;
}

function renderState() {
  const rows = [...svg.querySelectorAll(".row-g")];
  rows.forEach((g, i) => { g.classList.toggle("hidden", i >= shown); g.classList.toggle("past", i < shown - 1); });
  const step = script.steps[shown - 1];
  const snap = step ? step.rows : [];
  tbody.innerHTML = snap.length
    ? snap.map((r, i) => `<tr class="${i > 0 ? "dup" : ""}"><td>${r.id}</td><td>€${r.amount}</td><td>${r.op}</td></tr>`).join("")
    : `<tr class="empty"><td colspan="3">no rows yet</td></tr>`;
  charged.textContent = "€" + snap.reduce((a, r) => a + r.amount, 0);
  now.textContent = step ? `${shown}. ${step.text}` : "Press Play to send the payment.";
  btnStep.disabled = shown >= script.steps.length;
  if (shown >= script.steps.length) finish(); else verdict.hidden = true;
}

function finish() {
  verdict.hidden = false;
  const twice = script.charged > 40;
  const id = idBox.checked;
  let cls = twice ? "bad" : "good", text;
  if (twice) text = "Lena paid €80 for one seat. Each attempt was a correct, atomic transaction; the database simply had no way to know the second one was a retry of the first.";
  else if (fault === "none") { cls = ""; text = "Nothing failed, so both designs behave the same. Now lose the reply."; }
  else if (fault === "request") { cls = ""; text = "Retrying was harmless because the first request never arrived. The browser cannot tell this case apart from a lost reply, which is the whole problem."; }
  else text = `Charged once. The retry carried the same ${id ? "operation ID" : "ID"}, the unique index turned it into a no-op, and the server returned the original result.`;
  verdict.className = `verdict ${cls}`;
  verdict.textContent = text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function animate(g) {
  const p = g._path, dot = svg._dot;
  if (!p || prefersReducedMotion()) return Promise.resolve();
  dot.setAttribute("opacity", 1);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const myGen = gen;
  return new Promise((res) => {
    const t0 = performance.now();
    const frame = (n) => {
      if (myGen !== gen) { dot.setAttribute("opacity", 0); return res(); }
      const t = Math.min(1, (n - t0) / 420), e = ease(t);
      dot.setAttribute("cx", p.sx + (p.ex - p.sx) * e);
      dot.setAttribute("cy", p.sy + (p.ey - p.sy) * e);
      if (t < 1) requestAnimationFrame(frame); else { dot.setAttribute("opacity", 0); res(); }
    };
    requestAnimationFrame(frame);
  });
}

async function play() {
  stop();
  if (shown >= script.steps.length) { shown = 0; renderState(); }
  const myGen = ++gen;
  btnPlay.textContent = "Playing…";
  btnPlay.disabled = true;
  while (shown < script.steps.length && myGen === gen) {
    const g = svg.querySelectorAll(".row-g")[shown];
    await animate(g);
    if (myGen !== gen) return;
    shown++;
    renderState();
    await sleep(prefersReducedMotion() ? 700 : 520);
  }
  if (myGen === gen) { btnPlay.textContent = "Play again"; btnPlay.disabled = false; }
}
function stop() { gen++; svg._dot?.setAttribute("opacity", 0); btnPlay.disabled = false; btnPlay.textContent = "Play"; }

function restart(autoplay) {
  stop(); build(); shown = 0; renderState();
  faultBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.fault === fault)));
  if (autoplay) play();
}

btnPlay.addEventListener("click", play);
btnStep.addEventListener("click", () => { stop(); if (shown < script.steps.length) { shown++; renderState(); } });
btnReset.addEventListener("click", () => restart(false));
faultBtns.forEach((b) => b.addEventListener("click", () => { fault = b.dataset.fault; restart(true); }));
idBox.addEventListener("change", () => restart(true));
FAULTS.forEach((f) => { const b = faultBtns.find((x) => x.dataset.fault === f.key); if (b) b.textContent = f.label; });
restart(false);
