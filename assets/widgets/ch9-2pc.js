// Chapter 9, lesson 3: step through two-phase commit and inject crashes.
import { el, prefersReducedMotion } from "../charts.js";
import { TwoPC } from "../engines/ch9-2pc.js";

const root = document.getElementById("tpc");
const svg = root.querySelector("svg");
const stepsEl = root.querySelector(".steps");
const verdict = root.querySelector(".verdict");
const noBox = root.querySelector("#tpc-no");
const NAMES = ["Order service", "Payment ledger", "Inventory store"];
const WORK = ["order 4471 row", "account 88 balance", "SKU lamp-02 count"];
const tx = new TwoPC(NAMES);

const C = { x: 220, y: 12, w: 200, h: 100 };
const PX = [10, 225, 440], PY = 210, PW = 190, PH = 120;
const anchor = (who) => (who === "c" ? [C.x + C.w / 2, C.y + C.h] : [PX[who] + PW / 2, PY]);

// ---------- static drawing ----------
svg.textContent = "";
PX.forEach((_, i) => {
  const [x1, y1] = anchor("c"), [x2, y2] = anchor(i);
  el("line", { x1, y1, x2, y2, class: "dg-edge" }, svg);
});
function nodeBox(x, y, w, h, title) {
  const g = el("g", { class: "tp-node" }, svg);
  el("rect", { class: "box", x, y, width: w, height: h, rx: 9 }, g);
  el("text", { x: x + 12, y: y + 20, class: "lbl" }, g).textContent = title;
  const state = el("text", { x: x + 12, y: y + 38, class: "state" }, g);
  const extra = el("text", { x: x + 12, y: y + 54, class: "tp-lock" }, g);
  const logs = [0, 1, 2].map((k) => el("text", { x: x + 12, y: y + 72 + k * 14, class: "mono" }, g));
  return { g, state, extra, logs };
}
const cBox = nodeBox(C.x, C.y, C.w, C.h, "Coordinator");
cBox.logs.forEach((t, k) => t.setAttribute("y", C.y + 66 + k * 13));
const pBox = PX.map((x, i) => nodeBox(x, PY, PW, PH, NAMES[i]));
const msgLayer = el("g", {}, svg);

// ---------- render state ----------
function render() {
  const c = tx.coord;
  const phase = {
    idle: "Asked to commit",
    preparing: `Collecting votes (${Object.keys(c.votes).length} of 3)`,
    decided: `Decided ${(c.decision || "").toUpperCase()}, sending it`,
    done: `Finished: ${(c.decision || "").toUpperCase()}`,
  }[c.phase];
  cBox.g.setAttribute("class", "tp-node" + (c.up ? (c.decision ? " decided-" + c.decision : "") : " down"));
  cBox.state.textContent = c.up ? phase : "DOWN, its log survives";
  cBox.extra.textContent = "";
  const cl = c.log.slice(-3);
  cBox.logs.forEach((t, k) => { t.textContent = cl[k] ? "log: " + cl[k] : ""; });

  tx.parts.forEach((p, i) => {
    const b = pBox[i];
    const label = { active: "Working", prepared: "Prepared: in doubt", committed: "Committed", aborted: "Aborted" }[p.state];
    b.g.setAttribute("class", "tp-node " + (p.up ? p.state : "down"));
    b.state.textContent = p.up ? label + (p.voteNo && p.state === "active" ? " (will vote no)" : "") : "DOWN, " + { active: "nothing durable", prepared: "prepared on disk", committed: "committed on disk", aborted: "aborted on disk" }[p.state];
    const locks = tx.holdsLocks(p);
    b.extra.setAttribute("class", "tp-lock " + (locks ? "held" : "free"));
    b.extra.textContent = locks ? "locks held: " + WORK[i] : "no locks held";
    const pl = p.log.slice(-3);
    b.logs.forEach((t, k) => { t.textContent = pl[k] || ""; });
  });

  // verdict
  const doubt = tx.parts.filter((p) => p.state === "prepared");
  const out = tx.outcome();
  if (!tx.atomic()) { verdict.className = "verdict bad"; verdict.textContent = "Atomicity is broken."; }
  else if (out === "committed") { verdict.className = "verdict good"; verdict.textContent = "Committed on all three. The order, the charge, and the stock change happened together."; }
  else if (out === "aborted") { verdict.className = "verdict good"; verdict.textContent = "Aborted on all three. Nothing happened anywhere, which is also an atomic outcome."; }
  else if (doubt.length && !c.up) {
    verdict.className = "verdict bad";
    verdict.textContent = `${names(doubt)} ${doubt.length > 1 ? "are" : "is"} in doubt. ${doubt.length > 1 ? "They" : "It"} promised to commit if asked, so aborting alone could break atomicity, and committing alone could too. Until the coordinator restarts, the locked rows stay blocked for every other transaction.`;
  } else if (tx.parts.some((p) => p.state === "committed") && doubt.length) {
    verdict.className = "verdict bad";
    verdict.textContent = `Some participants have committed while ${names(doubt)} still ${doubt.length > 1 ? "wait" : "waits"}. The only allowed outcome now is commit; it arrives when the message gets through.`;
  } else { verdict.className = "verdict"; verdict.textContent = "The transaction is in progress."; }

  // controls
  root.querySelectorAll("[data-node]").forEach((btn) => {
    const who = btn.dataset.node === "c" ? "c" : +btn.dataset.node;
    const up = who === "c" ? c.up : tx.parts[who].up;
    btn.setAttribute("aria-pressed", !up);
    btn.textContent = (up ? "Crash " : "Restart ") + (who === "c" ? "coordinator" : NAMES[who].toLowerCase());
  });
  const ag = tx.agenda();
  root.querySelector('[data-act="next"]').disabled = ag.kind === "wait" || ag.kind === "none";
}

const names = (ps) => (ps.length <= 1 ? ps.map((p) => p.name).join("") : ps.slice(0, -1).map((p) => p.name).join(", ") + " and " + ps[ps.length - 1].name);
const lines = [];
function logLine(text) {
  lines.push(text);
  if (lines.length > 7) lines.shift();
  stepsEl.innerHTML = lines.map((l, k) => `<li class="${k === lines.length - 1 ? "current" : ""}">${l}</li>`).join("");
}

// ---------- animation (queued; a newer click hurries the current one) ----------
let queued = 0, chain = Promise.resolve();
function enqueue(fn) {
  queued++;
  chain = chain.then(async () => { try { await fn(); } finally { queued--; } });
}
const hurry = () => queued > 1;

function animateLeg(msgs) {
  if (!msgs.length || prefersReducedMotion()) return Promise.resolve();
  const pills = msgs.map((m) => {
    const g = el("g", { class: "tp-msg" }, msgLayer);
    el("rect", { x: -32, y: -10, width: 64, height: 20, rx: 10 }, g);
    const t = el("text", { x: 0, y: 4, "text-anchor": "middle" }, g);
    t.textContent = m.label;
    return { m, g, t, a: anchor(m.from), b: anchor(m.to) };
  });
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const DUR = 750;
  return new Promise((res) => {
    const t0 = performance.now();
    const frame = (now) => {
      const t = hurry() ? 1 : Math.min(1, (now - t0) / DUR);
      for (const p of pills) {
        const stop = p.m.lost ? 0.6 : 1;
        const k = ease(Math.min(t / stop, 1)) * stop;
        p.g.setAttribute("transform", `translate(${p.a[0] + (p.b[0] - p.a[0]) * k},${p.a[1] + (p.b[1] - p.a[1]) * k})`);
        if (p.m.lost && t >= stop) { p.g.setAttribute("class", "tp-msg lost"); p.t.textContent = "lost"; p.g.setAttribute("opacity", Math.max(0, 1 - (t - stop) / (1 - stop))); }
      }
      if (t < 1) requestAnimationFrame(frame);
      else { msgLayer.textContent = ""; res(); }
    };
    requestAnimationFrame(frame);
  });
}

async function doStep() {
  const ag = tx.agenda();
  const before = snapshotView();
  const r = tx.step();
  if (r.idle) { logLine(r.text); render(); return; }
  const out = r.msgs.filter((m) => m.from === "c");
  const back = r.msgs.filter((m) => m.from !== "c");
  logLine(r.text);
  if (out.length && ag.kind === "send") {
    // Show the old state while the decision travels, then the new one.
    restoreView(before);
    await animateLeg(out);
    render();
    await animateLeg(back);
  } else {
    render();
    await animateLeg(out);
    await animateLeg(back);
  }
}

// Minimal snapshot so the boxes do not change before the message arrives.
function snapshotView() { return JSON.stringify({ parts: tx.parts, coord: { ...tx.coord, acked: [...tx.coord.acked] } }); }
function restoreView(json) {
  const saved = { parts: tx.parts, coord: tx.coord };
  const v = JSON.parse(json);
  tx.parts = v.parts;
  tx.coord = { ...v.coord, acked: new Set(v.coord.acked) };
  render();
  tx.parts = saved.parts;
  tx.coord = saved.coord;
}

// ---------- controls ----------
let playing = false, playTimer = null;
function setPlaying(v) {
  playing = v;
  clearTimeout(playTimer);
  root.querySelector('[data-act="play"]').setAttribute("aria-pressed", v);
  if (v) tickPlay();
}
// Each automatic step goes through the same queue as the reader's clicks,
// so a crash clicked mid-play lands between two steps.
function tickPlay() {
  if (!playing) return;
  const k = tx.agenda().kind;
  if (k === "wait" || k === "none") { setPlaying(false); return; }
  enqueue(doStep);
  chain.then(() => { if (playing) playTimer = setTimeout(tickPlay, prefersReducedMotion() ? 1100 : 600); });
}

root.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.act === "next") { setPlaying(false); enqueue(doStep); }
  else if (b.dataset.act === "play") setPlaying(!playing);
  else if (b.dataset.act === "reset") {
    setPlaying(false);
    enqueue(() => { tx.reset(); lines.length = 0; stepsEl.innerHTML = ""; logLine("Each service has done its part of order 4471 and holds locks on what it touched. The application asks the coordinator to commit."); render(); });
  } else if (b.dataset.node) {
    const who = b.dataset.node === "c" ? "c" : +b.dataset.node;
    enqueue(() => {
      const up = who === "c" ? tx.coord.up : tx.parts[who].up;
      logLine(up ? tx.crash(who) : tx.restart(who));
      render();
    });
  }
});
noBox.addEventListener("change", () => {
  tx.parts[1].voteNo = noBox.checked;
  render();
});

logLine("Each service has done its part of order 4471 and holds locks on what it touched. The application asks the coordinator to commit.");
render();
