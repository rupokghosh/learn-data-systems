// Chapter 12, lesson 1: a system of record, its change log, and derived systems built from it.
import { el, prefersReducedMotion } from "../charts.js";
import { createDataflow, describe, KINDS, SEARCH_V2 } from "../engines/ch12-dataflow.js";

const root = document.getElementById("dataflow");
const svg = root.querySelector("svg");
const verdict = root.querySelector(".verdict");
const stepsEl = root.querySelector(".steps");
const btnWrite = root.querySelector('[data-act="write"]');
const btnAuto = root.querySelector('[data-act="auto"]');
const btnRebuild = root.querySelector('[data-act="rebuild"]');
const btnReset = root.querySelector('[data-act="reset"]');
const toggles = [...root.querySelectorAll("[data-kind]")];

const ORDER = ["search", "cache", "warehouse", "model", "notify"];
const LOG_X = 148, LOG_W = 224, ROW_H = 24, ROW_GAP = 3, ROWS = 12, LOG_Y = 28;
const BOX_X = 420, BOX_W = 280, BOX_H = 64, BOX_GAP = 12, BOX_Y = 12;
const AUTO_EVERY = 1200, TRAVEL = 520;

// ---------- static frame ----------
svg.innerHTML = "";
el("defs", {}, svg).innerHTML = `<marker id="df-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--ink-3)"/></marker>`;
function node(x, y, w, h, label, sub) {
  const g = el("g", { class: "dg-node" }, svg);
  el("rect", { x, y, width: w, height: h, rx: 8 }, g);
  el("text", { x: x + 12, y: y + 22 }, g).textContent = label;
  el("text", { x: x + 12, y: y + 40, class: "sub" }, g).textContent = sub;
  return g;
}
node(0, 28, 120, 52, "Riders' app", "rentals and returns");
node(0, 140, 120, 64, "Rides database", "system of record");
el("text", { x: 12, y: 222, class: "head", style: "font-size:11px" }, svg).textContent = "the only place";
el("text", { x: 12, y: 236, class: "head", style: "font-size:11px" }, svg).textContent = "writes go";
el("line", { x1: 60, y1: 82, x2: 60, y2: 136, class: "dg-edge", "marker-end": "url(#df-arr)" }, svg);
el("line", { x1: 122, y1: 172, x2: LOG_X - 4, y2: 172, class: "dg-edge", "marker-end": "url(#df-arr)" }, svg);
el("text", { x: LOG_X, y: 16, class: "head" }, svg).textContent = "Change log, in commit order";
const gFlows = el("g", {}, svg);
const gLog = el("g", {}, svg);
const gBoxes = el("g", {}, svg);
const gPkts = el("g", {}, svg);

// ---------- state ----------
let df, simNow, nextAuto, auto, rebuild, fresh, searchDef, raf = null, lastReal = null, visible = true;

function reset() {
  df = createDataflow({ seed: 7, history: 70 });
  // The starting systems were built long ago and are fully caught up.
  for (const k of ["search", "cache"]) df.addConsumer(k, -2e6);
  df.advance(0);
  simNow = 0; nextAuto = AUTO_EVERY; auto = false; rebuild = null; fresh = new Map(); searchDef = KINDS.search;
  btnAuto.setAttribute("aria-pressed", "false");
  btnRebuild.disabled = false;
  btnRebuild.textContent = "Rebuild search as v2";
  toggles.forEach((b) => { b.setAttribute("aria-pressed", String(df.consumers.has(b.dataset.kind))); b.disabled = false; });
  setSteps(-1);
  say("Two derived systems are running. Write some events, then switch on more derived systems.");
  render();
}

function say(text, cls = "") { verdict.className = `verdict ${cls}`; verdict.textContent = text; }
function setSteps(i) {
  [...stepsEl.children].forEach((li, j) => { li.classList.toggle("current", j === i); li.style.opacity = i < 0 || j <= i ? 1 : 0.4; });
}

// ---------- layout helpers ----------
const boxY = (kind) => BOX_Y + ORDER.indexOf(kind) * (BOX_H + BOX_GAP);
const head = () => df.log.length;
function rowY(offset) {
  const i = head() - 1 - offset;
  return i < ROWS ? LOG_Y + i * (ROW_H + ROW_GAP) + ROW_H / 2 : LOG_Y + ROWS * (ROW_H + ROW_GAP) - 4;
}
function curve(y0, x1, y1) {
  const x0 = LOG_X + LOG_W + 2, mx = (x0 + x1) / 2;
  return { d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`, p: [x0, y0, mx, y0, mx, y1, x1, y1] };
}
function bez(p, t) {
  const u = 1 - t;
  return [u * u * u * p[0] + 3 * u * u * t * p[2] + 3 * u * t * t * p[4] + t * t * t * p[6],
          u * u * u * p[1] + 3 * u * u * t * p[3] + 3 * u * t * t * p[5] + t * t * t * p[7]];
}
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Which consumers sit in which slot: normally one per kind; during a rebuild, search has two.
function slots() {
  const out = [];
  for (const kind of ORDER) {
    const y = boxY(kind);
    if (kind === "search" && rebuild && rebuild.phase < 4) {
      out.push({ kind, id: "search", x: BOX_X, w: BOX_W / 2 - 4, y, half: true, label: "Search v1" });
      out.push({ kind, id: "search2", x: BOX_X + BOX_W / 2 + 4, w: BOX_W / 2 - 4, y, half: true, label: "Search v2" });
    } else {
      out.push({ kind, id: kind, x: BOX_X, w: BOX_W, y, half: false, label: KINDS[kind].title + (kind === "search" && rebuild ? " v2" : "") });
    }
  }
  return out;
}

// ---------- render ----------
function render() {
  // Log rows, newest first.
  gLog.innerHTML = "";
  const n = Math.min(ROWS, head());
  for (let i = 0; i < n; i++) {
    const ev = df.log[head() - 1 - i];
    const y = LOG_Y + i * (ROW_H + ROW_GAP);
    const g = el("g", { class: "log-row" + (fresh.has(ev.offset) ? " fresh" : "") }, gLog);
    el("rect", { x: LOG_X, y, width: LOG_W, height: ROW_H, rx: 4 }, g);
    el("text", { x: LOG_X + 8, y: y + 16, class: "off" }, g).textContent = "#" + ev.offset;
    el("text", { x: LOG_X + 40, y: y + 16 }, g).textContent = describe(ev);
  }
  if (head() > ROWS) el("text", { x: LOG_X + 8, y: LOG_Y + ROWS * (ROW_H + ROW_GAP) + 10, class: "head", style: "font-size:11px" }, gLog)
    .textContent = `… ${head() - ROWS} older events, kept`;

  gFlows.innerHTML = ""; gBoxes.innerHTML = ""; gPkts.innerHTML = "";
  const motion = !prefersReducedMotion();
  for (const s of slots()) {
    const c = df.consumers.get(s.id);
    const midY = s.y + BOX_H / 2;
    el("path", { d: curve(LOG_Y + 150, s.x, midY).d, class: "flow" + (c ? "" : " off") }, gFlows);
    const serving = rebuild && rebuild.phase < 4 && ((s.id === "search" && rebuild.phase < 3) || (s.id === "search2" && rebuild.phase >= 3));
    const building = s.id === "search2" && rebuild && rebuild.phase < 3;
    const g = el("g", { class: "box" + (c ? "" : " off") + (serving ? " serving" : "") + (building ? " building" : "") }, gBoxes);
    el("rect", { x: s.x, y: s.y, width: s.w, height: BOX_H, rx: 8, class: "frame" }, g);
    if (!c) {
      el("text", { x: s.x + 12, y: s.y + 22, class: "t" }, g).textContent = s.label;
      el("text", { x: s.x + 12, y: s.y + 42, class: "s2" }, g).textContent = s.kind === "notify"
        ? "Off. Would start at the head of the log." : "Off. Turn it on to build it from the log.";
      continue;
    }
    const st = df.status(c);
    const [l1, l2] = c.def.summary(c.state);
    const title = s.label + (serving ? (s.half ? " · serving" : "") : "");
    el("text", { x: s.x + 12, y: s.y + 20, class: "t" }, g).textContent = title;
    el("text", { x: s.x + 12, y: s.y + 38, class: "s1" }, g).textContent = l1;
    let stText, stCls = "st";
    if (st.replaying) { stText = s.half ? `replaying ${st.done}/${st.of}` : `replaying history ${st.done} / ${st.of}`; stCls += " replay"; }
    else if (st.behind > 0) { stText = `${st.behind} behind`; stCls += " behind"; }
    else stText = s.half ? `in sync, #${c.offset - 1}` : `in sync at #${c.offset - 1}`;
    if (s.half) el("text", { x: s.x + 12, y: s.y + 55, class: stCls }, g).textContent = stText;
    else {
      el("text", { x: s.x + s.w - 12, y: s.y + 20, class: stCls, "text-anchor": "end" }, g).textContent = stText;
      el("text", { x: s.x + 12, y: s.y + 55, class: "s2" }, g).textContent = l2;
    }
    if (st.replaying) {
      el("rect", { x: s.x + 1, y: s.y + BOX_H - 4, width: s.w - 2, height: 3, class: "bar-bg" }, g);
      el("rect", { x: s.x + 1, y: s.y + BOX_H - 4, width: (s.w - 2) * (st.done / Math.max(1, st.of)), height: 3, class: "bar-fg" }, g);
    }
    // Events travelling from the log to this system.
    if (motion) for (const u of df.upcoming(c, 6)) {
      if (!u.live) continue;
      const travel = Math.min(TRAVEL, c.def.lag);
      const t = 1 - (u.at - simNow) / travel;
      if (t < 0 || t > 1) continue;
      const [x, y] = bez(curve(rowY(u.ev.offset), s.x, midY).p, easeInOut(t));
      el("circle", { cx: x, cy: y, r: 4.5, class: "pkt" }, gPkts);
    }
  }
}

// ---------- the rebuild ----------
function startRebuild() {
  if (rebuild) return;
  if (!df.consumers.has("search")) { say("Turn the station search on first, so there is a v1 to replace."); return; }
  rebuild = { phase: 1, at: simNow };
  df.addConsumer("search", simNow, { id: "search2", def: SEARCH_V2, version: 2 });
  btnRebuild.disabled = true;
  btnRebuild.textContent = "Rebuilding…";
  toggles.find((b) => b.dataset.kind === "search").disabled = true;
  if (!auto) toggleAuto(true);
  setSteps(0);
  say("Search v2 counts only rideable bikes, so it cannot be patched from v1. It replays the whole log from offset 0. Meanwhile v1 keeps answering every search.");
  ensureLoop();
}
function stepRebuild() {
  if (!rebuild || rebuild.phase >= 4) return;
  const v2 = df.consumers.get("search2");
  const st = df.status(v2);
  if (rebuild.phase === 1 && !st.replaying && st.behind <= 1) {
    rebuild.phase = 2; rebuild.at = simNow; setSteps(1);
    say("v2 has caught up with the head of the log and is now processing new writes as they arrive, side by side with v1.");
  } else if (rebuild.phase === 2 && simNow - rebuild.at > 2500) {
    rebuild.phase = 3; rebuild.at = simNow; setSteps(2);
    say("Reads now go to v2. v1 is still running, so switching back would be instant if v2 turned out to be wrong.", "good");
  } else if (rebuild.phase === 3 && simNow - rebuild.at > 3000) {
    rebuild.phase = 4; setSteps(3);
    df.removeConsumer("search");
    const v2c = df.consumers.get("search2");
    df.consumers.delete("search2");
    v2c.id = "search";
    df.consumers.set("search", v2c);
    searchDef = SEARCH_V2;
    btnRebuild.textContent = "Rebuilt: v2 serving";
    toggles.find((b) => b.dataset.kind === "search").disabled = false;
    say("v1 is retired. The migration never touched the system of record, and no reader saw a half-built index.", "good");
  }
}

// ---------- loop ----------
function needsLoop() {
  if (auto || fresh.size) return true;
  if (rebuild && rebuild.phase < 4) return true;
  for (const c of df.consumers.values()) if (df.status(c).behind > 0) return true;
  return false;
}
function tick(real) {
  raf = null;
  const dt = lastReal == null ? 16 : Math.min(100, real - lastReal);
  lastReal = real;
  simNow += dt;
  if (auto) while (simNow >= nextAuto) { write(nextAuto); nextAuto += AUTO_EVERY; }
  for (const [o, until] of fresh) if (simNow > until) fresh.delete(o);
  df.advance(simNow);
  stepRebuild();
  render();
  if (visible && needsLoop()) raf = requestAnimationFrame(tick); else lastReal = null;
}
function ensureLoop() { if (raf == null && visible) { lastReal = null; raf = requestAnimationFrame(tick); } }

function write(t = simNow) {
  const ev = df.append(t);
  fresh.set(ev.offset, t + 700);
}

function toggleAuto(on = !auto) {
  auto = on;
  btnAuto.setAttribute("aria-pressed", String(auto));
  if (auto) nextAuto = simNow + 200;
  ensureLoop();
}

btnWrite.addEventListener("click", () => { write(); render(); ensureLoop(); });
btnAuto.addEventListener("click", () => toggleAuto());
btnRebuild.addEventListener("click", startRebuild);
btnReset.addEventListener("click", () => { if (raf) cancelAnimationFrame(raf); raf = null; reset(); });

const MSG_ON = {
  search: "A fresh search index replays the log from offset 0, then keeps up with new writes.",
  cache: "The cache is rebuilt from the log instead of being filled by the app, so the app never writes to it directly.",
  warehouse: "The warehouse replays every past ride, then loads new events in batches every 4 seconds, so it is always a little behind.",
  model: "The rebalancing model replays history to learn which stations drain, then lags almost two seconds behind live writes.",
  notify: "Receipts start at the head of the log, not at offset 0: replaying history here would email riders about rides they took weeks ago.",
};
toggles.forEach((b) => b.addEventListener("click", () => {
  const k = b.dataset.kind;
  if (df.consumers.has(k)) {
    df.removeConsumer(k);
    b.setAttribute("aria-pressed", "false");
    say("Switched off and its state thrown away. Nothing is lost: the log still holds everything needed to build it again.");
  } else {
    df.addConsumer(k, simNow, k === "search" ? { def: searchDef } : {});
    b.setAttribute("aria-pressed", "true");
    say(MSG_ON[k]);
  }
  render();
  ensureLoop();
}));

reset();

new IntersectionObserver((entries) => {
  visible = entries[0].isIntersecting;
  if (visible && needsLoop()) ensureLoop();
}).observe(root);
