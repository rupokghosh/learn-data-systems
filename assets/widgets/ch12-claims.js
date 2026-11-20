// Chapter 12, lesson 3: enforcing unique handles by routing claims through a partitioned log.
import { prefersReducedMotion } from "../charts.js";
import { makeClaims, runLog, runCheckThenInsert, partitionOf, CLIENTS, WANTS } from "../engines/ch12-correct.js";

const root = document.getElementById("claims");
const lanesEl = root.querySelector(".claim-lanes");
const ownersEl = root.querySelector(".owners tbody");
const verdict = root.querySelector(".verdict");
const clientsEl = root.querySelector(".clients");
const modeBtns = [...root.querySelectorAll("[data-mode]")];
const btnPlay = root.querySelector('[data-act="play"]');
const btnStep = root.querySelector('[data-act="step"]');
const btnSeed = root.querySelector('[data-act="seed"]');
const out = (k) => root.querySelector(`[data-out="${k}"]`);

const HANDLES = [...new Set(Object.values(WANTS).flat())];
clientsEl.innerHTML = CLIENTS.map((c) => `<span><b>${c}</b> wants ${WANTS[c].map((h) => "@" + h).join(" ")}</span>`).join("");

let mode = "log", seed = 1, run, events, pos, timer = null;

/** Turn a run into a list of visible events: arrivals, then decisions. */
function plan() {
  const claims = makeClaims(seed);
  run = mode === "log" ? runLog(claims) : runCheckThenInsert(claims);
  const flat = run.parts.flat();
  events = [];
  if (mode === "log") {
    [...flat].sort((a, b) => a.arrive - b.arrive).forEach((c) => events.push({ type: "arrive", c, text: `@${c.handle} from ${c.client} arrives and is appended to partition ${c.partition}.` }));
    const longest = Math.max(...run.parts.map((p) => p.length));
    for (let k = 0; k < longest; k++) {
      const batch = run.parts.map((p) => p[k]).filter(Boolean);
      events.push({ type: "decide", batch, text: `Each partition's single processor takes entry ${k}: ${batch.map((c) => `@${c.handle} for ${c.client} ${c.granted ? "granted" : "rejected"}`).join("; ")}.` });
    }
  } else {
    const ev = [];
    flat.forEach((c) => {
      ev.push({ t: c.start, type: "arrive", c, text: `${c.client} asks server ${c.partition + 1} for @${c.handle}. The server checks the table: ${c.granted ? "free" : c.reason}.` });
      ev.push({ t: c.end, type: "decide", batch: [c], text: c.granted ? `Server ${c.partition + 1} inserts @${c.handle} for ${c.client}.` : `Server ${c.partition + 1} tells ${c.client} that @${c.handle} is taken.` });
    });
    ev.sort((a, b) => a.t - b.t || (a.type === "decide" ? -1 : 1));
    events.push(...ev);
  }
  pos = 0;
}

function render() {
  const arrived = new Set(), decided = new Set();
  const cursor = new Set();
  const lastEv = events[pos - 1];
  const entering = lastEv && lastEv.type === "arrive" ? lastEv.c.id : null;
  for (let i = 0; i < pos; i++) {
    const e = events[i];
    if (e.type === "arrive") arrived.add(e.c.id);
    else e.batch.forEach((c) => { decided.add(c.id); if (i === pos - 1) cursor.add(c.id); });
  }
  const owners = {};
  const decidedClaims = run.parts.flat().filter((c) => decided.has(c.id) && c.granted);
  decidedClaims.sort((a, b) => (a.end ?? a.offset) - (b.end ?? b.offset));
  for (const c of decidedClaims) (owners[c.handle] ||= []).push(c.client);

  lanesEl.innerHTML = run.parts.map((lane, p) => {
    const label = mode === "log"
      ? `Partition ${p} <span>handles ${HANDLES.filter((h) => partitionOf(h) === p).map((h) => "@" + h).join(" ")}</span>`
      : `App server ${p + 1} <span>any handle</span>`;
    const recs = lane.filter((c) => arrived.has(c.id)).map((c) => {
      let cls = "rec" + (c.id === entering ? " enter" : ""), mark = "";
      if (decided.has(c.id)) {
        if (!c.granted) { cls += " no"; mark = "✗"; }
        else if ((owners[c.handle] || []).length > 1) { cls += " dupe"; mark = "✓ twice!"; }
        else { cls += " ok"; mark = "✓"; }
      } else if (mode === "check") { cls += " warn"; mark = "checking"; }
      if (cursor.has(c.id)) cls += " cursor";
      return `<span class="${cls}"><span class="k">@${c.handle}</span><span class="v">${c.client}</span><span class="mark">${mark}</span></span>`;
    }).join("");
    return `<p class="lane-label">${label}</p><div class="lane">${recs}</div>`;
  }).join("");

  ownersEl.innerHTML = HANDLES.map((h) => {
    const o = owners[h] || [];
    return `<tr class="${o.length > 1 ? "dup" : ""}"><td>@${h}</td><td>${o.length ? o.join(", ") : "—"}</td></tr>`;
  }).join("");

  const all = run.parts.flat();
  const done = all.filter((c) => decided.has(c.id));
  out("claims").textContent = `${arrived.size} / ${all.length}`;
  out("granted").textContent = done.filter((c) => c.granted).length;
  out("rejected").textContent = done.filter((c) => !c.granted).length;
  const dups = Object.values(owners).filter((o) => o.length > 1).length;
  out("dups").textContent = dups;

  const last = events[pos - 1];
  if (pos >= events.length) {
    if (mode === "log") {
      verdict.className = "verdict good";
      verdict.textContent = `Every handle has exactly one owner. Try new network delays: the winners can change, but there is never a tie, because each partition decides in the order of its log.`;
    } else {
      verdict.className = "verdict bad";
      verdict.textContent = `${dups} handle${dups === 1 ? "" : "s"} ended up with two owners. Each server checked, saw the handle free, and inserted, because the other insert had not committed yet.`;
    }
  } else {
    verdict.className = "verdict";
    verdict.textContent = last ? last.text : "Press Play. All claims are sent within the same 150 ms.";
  }
  btnStep.disabled = pos >= events.length;
}

function stop() { clearTimeout(timer); timer = null; btnPlay.textContent = "Play"; }
function play() {
  if (timer) { stop(); return; }
  if (pos >= events.length) { pos = 0; render(); }
  btnPlay.textContent = "Pause";
  const tick = () => {
    pos++; render();
    if (pos < events.length) timer = setTimeout(tick, prefersReducedMotion() ? 900 : 650);
    else stop();
  };
  timer = setTimeout(tick, 150);
}
function restart(autoplay) {
  stop(); plan(); render();
  modeBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  if (autoplay) play();
}

btnPlay.addEventListener("click", play);
btnStep.addEventListener("click", () => { stop(); if (pos < events.length) { pos++; render(); } });
btnSeed.addEventListener("click", () => { seed++; restart(true); });
modeBtns.forEach((b) => b.addEventListener("click", () => { mode = b.dataset.mode; restart(true); }));
restart(false);
