// Chapter 11, lesson 2: the dual-write race versus CDC, and an event-sourced parcel tracker.
import { el } from "../charts.js";
import { priceRace, decide, apply, fold, describe, changelog, compact } from "../engines/ch11-cdc.js";
import { say, radio, tween, esc } from "./ch11-util.js";

/* ------------------------------------------------------------------
   1. Dual writes versus change data capture
   ------------------------------------------------------------------ */
{
  const root = document.getElementById("race");
  const svg = root.querySelector("svg");
  const verdict = root.querySelector(".verdict");
  const delayIn = root.querySelector("#race-delay");
  const runBtn = root.querySelector('[data-act="run"]');
  const modeNote = root.querySelector(".c11-mode-note");

  const LANES = { A: { y: 42, name: "Client A" }, B: { y: 100, name: "Client B" }, db: { y: 172, name: "Database" }, idx: { y: 244, name: "Search index" } };
  const X0 = 112, X1 = 512, TMAX = 290;
  const x = (t) => X0 + (t / TMAX) * (X1 - X0);
  let mode = "dual", race, anim = null;

  // static layer: arrow markers, lane lines, names
  const defs = el("defs", {}, svg);
  for (const [id, color] of [["a", "--accent"], ["b", "--orange"], ["cdc", "--purple"], ["ack", "--ink-4"]]) {
    const m = el("marker", { id: `race-${id}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0,0 L10,5 L0,10 z", style: `fill:var(${color})` }, m);
  }
  const stat = el("g", { class: "c11-st" }, svg);
  for (const L of Object.values(LANES)) {
    el("line", { x1: X0 - 4, x2: X1 + 6, y1: L.y, y2: L.y, class: "axis" }, stat);
    const t = el("text", { x: 0, y: L.y + 4, class: "lane-name" }, stat);
    t.textContent = L.name;
  }
  const tl = el("text", { x: X1 + 6, y: 278, "text-anchor": "end" }, stat);
  tl.textContent = "time →";
  const layer = el("g", { class: "c11-st" }, svg);

  function draw(now) {
    layer.textContent = "";
    for (const m of race.msgs) {
      if (now < m.t0) continue;
      const p = { x: x(m.t0), y: LANES[m.from].y }, q = { x: x(m.t1), y: LANES[m.to].y };
      const f = Math.min(1, (now - m.t0) / (m.t1 - m.t0));
      const end = { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
      el("line", { x1: p.x, y1: p.y, x2: end.x, y2: end.y, class: `msg ${m.cls}`, "marker-end": f >= 1 ? `url(#race-${m.cls})` : null }, layer);
      if (f < 1) el("circle", { cx: end.x, cy: end.y, r: 4, style: `fill:var(${m.cls === "a" ? "--accent" : m.cls === "b" ? "--orange" : m.cls === "cdc" ? "--purple" : "--ink-4"})` }, layer);
      if (m.cls !== "ack") {
        const lx = p.x + (q.x - p.x) * 0.5, ly = p.y + (q.y - p.y) * 0.5;
        const t = el("text", { x: lx + 5, y: ly - 3, class: `lbl ${m.cls}` }, layer);
        t.textContent = m.label;
      }
    }
    for (const ap of race.applies) {
      if (!ap.by || ap.t > now) continue;
      const L = LANES[ap.lane];
      el("circle", { cx: x(ap.t), cy: L.y, r: 3.5, style: "fill:var(--ink)" }, layer);
      const t = el("text", { x: x(ap.t), y: L.y + 17, "text-anchor": "middle", class: "val" }, layer);
      t.textContent = ap.lane === "db" && mode === "cdc" ? `#${ap.lsn}: ${ap.value}` : String(ap.value);
    }
    if (now < race.end) el("line", { x1: x(now), x2: x(now), y1: 20, y2: 262, class: "playhead" }, layer);
    // current values on the right
    const done = now >= race.end;
    const dbV = race.valueAt("db", now), idxV = race.valueAt("idx", now);
    const mismatch = done && dbV !== idxV;
    for (const [lane, v] of [["db", dbV], ["idx", idxV]]) {
      const y = LANES[lane].y;
      el("rect", { x: 540, y: y - 16, width: 96, height: 32, rx: 6, class: `box${done ? (mismatch ? " bad" : " good") : ""}` }, layer);
      const t = el("text", { x: 588, y: y + 5, "text-anchor": "middle", class: "val" }, layer);
      t.textContent = `price ${v}`;
    }
  }

  function conclude() {
    const { db, idx } = race.final;
    if (mode === "dual") {
      const ord = race.order("idx").join(" then ");
      if (db !== idx) say(verdict, `The database applied A then B and holds ${db}. The index received ${ord} and holds ${idx}. Every write succeeded and no error was raised, yet the two systems now disagree, and they stay that way until someone edits the listing again.`, "bad");
      else say(verdict, `This time the index also applied A then B, so both hold ${db}. Nothing in the design made that happen; drag the delay past about 75 ms and the same code leaves them inconsistent.`, "good");
    } else {
      say(verdict, `The index applies the database's own log, entry 1 then entry 2, so it ends at ${idx}, the same as the database. A slow connector only makes the index lag behind; it cannot reorder the writes.`, "good");
    }
  }

  function setup(animate) {
    anim?.finish();
    race = priceRace({ mode, delay: +delayIn.value });
    modeNote.textContent = mode === "dual"
      ? "Each client writes the database, waits for the acknowledgement, then writes the index itself."
      : "Clients write only the database. A connector reads the database's log and applies each entry to the index, in log order.";
    if (!animate) { draw(race.end); conclude(); return; }
    say(verdict, "Running…");
    anim = tween(0, race.end, 3600, draw, conclude);
  }

  const delayOut = delayIn.closest(".control").querySelector("output");
  delayIn.addEventListener("input", () => { delayOut.textContent = `${delayIn.value} ms`; setup(false); });
  delayOut.textContent = `${delayIn.value} ms`;
  runBtn.addEventListener("click", () => setup(true));
  radio([...root.querySelectorAll("[data-mode]")], "mode", (v) => { mode = v; setup(true); });
  setup(false);
}

/* ------------------------------------------------------------------
   2. Event-sourced parcel tracker, its change stream, and compaction
   ------------------------------------------------------------------ */
{
  const root = document.getElementById("parcels");
  const evOut = root.querySelector('[data-out="events"]');
  const stOut = root.querySelector('[data-out="state"]');
  const clOut = root.querySelector('[data-out="changelog"]');
  const verdict = root.querySelector(".verdict");
  const uptoIn = root.querySelector("#pk-upto");
  const uptoOut = uptoIn.closest(".control").querySelector("output");
  const compactBtn = root.querySelector('[data-act="compact"]');
  const stat = (k) => root.querySelector(`[data-stat="${k}"]`);

  const SEED = [
    { type: "Registered", id: "PX-101", dest: "Harbour St 4" },
    { type: "Registered", id: "PX-102", dest: "Mill Lane 9" },
    { type: "Scanned", id: "PX-101", hub: "Utrecht hub" },
    { type: "Registered", id: "PX-103", dest: "Kade 17" },
    { type: "Scanned", id: "PX-102", hub: "Utrecht hub" },
    { type: "Scanned", id: "PX-101", hub: "Arnhem depot" },
    { type: "OutForDelivery", id: "PX-101" },
  ];
  let events, parcel = "PX-101", compacted = false, freshSeq = 0;

  function reset() {
    events = SEED.map((e) => ({ ...e }));
    compacted = false;
    freshSeq = 0;
    uptoIn.max = events.length;
    uptoIn.value = events.length;
    render();
    say(verdict, "Seven events so far. The table on the right is not stored anywhere: it is recomputed by applying the events in order.");
  }

  function render() {
    const k = +uptoIn.value;
    uptoOut.textContent = `${k} of ${events.length} events`;
    evOut.innerHTML = events.map((e, i) => {
      const cls = ["c11-ev", i >= k ? "future" : "", i === k - 1 ? "cur" : "", i + 1 === freshSeq ? "enter" : ""].join(" ");
      const text = e.type === "Registered" && e.redacted ? "Registered, to [redacted]" : describe(e);
      return `<div class="${cls}"><span class="n">${i + 1}</span><span><span class="t">${esc(e.id)}</span> ${esc(text)}</span></div>`;
    }).join("");
    if (freshSeq) evOut.scrollTop = evOut.scrollHeight;

    const state = fold(events, k);
    const touched = k > 0 ? events[k - 1].id : null;
    const rows = [...state.entries()].map(([id, s]) =>
      `<tr class="${id === touched ? "changed" : ""}"><td>${esc(id)}</td><td>${esc(s.status)}</td><td>${esc(s.location)}</td><td>${s.attempts}</td></tr>`).join("");
    stOut.innerHTML = `<tr><th>Parcel</th><th>Status</th><th>Location</th><th>Failed</th></tr>${rows || `<tr><td colspan="4" class="muted">no parcels yet</td></tr>`}`;

    const cl = changelog(events);
    const kept = new Set(compact(cl));
    clOut.innerHTML = cl.map((r) => {
      const gone = compacted && !kept.has(r);
      const v = r.value === null ? "tombstone" : r.value;
      return `<span class="rec${gone ? " gone" : ""}${r.value === null ? " warn" : ""}${r.seq === freshSeq ? " enter" : ""}" title="change ${r.seq}"><span class="k">${esc(r.key)}</span><span class="v">${esc(v)}</span></span>`;
    }).join("");
    stat("events").textContent = events.length;
    stat("changes").textContent = cl.length;
    stat("kept").textContent = kept.size;
    compactBtn.setAttribute("aria-pressed", String(compacted));
  }

  function command(type) {
    const state = fold(events);
    const ev = decide(state, { type, id: parcel });
    if (ev.error) { say(verdict, `Command rejected: ${esc(ev.error)} A command is checked against the current state first; only if it is valid does it become an event, and an event is a fact that is never rejected later.`, "bad"); return; }
    const atEnd = +uptoIn.value === events.length;
    events.push(ev);
    freshSeq = events.length;
    uptoIn.max = events.length;
    if (atEnd) uptoIn.value = events.length;
    render();
    say(verdict, `Appended event ${events.length}: ${esc(parcel)} ${esc(describe(ev).toLowerCase())}. The log grew by one line; the state of ${esc(parcel)} was recomputed from it.`);
  }

  function erase() {
    const state = fold(events);
    if (!state.has(parcel)) { say(verdict, `${esc(parcel)} is already gone.`, "bad"); return; }
    for (const e of events) if (e.id === parcel && e.type === "Registered") { e.redacted = true; }
    events.push({ type: "Erased", id: parcel });
    freshSeq = events.length;
    uptoIn.max = events.length;
    uptoIn.value = events.length;
    render();
    say(verdict, `The recipient asked for their data to be deleted. Appending an "erased" event is not enough, because the registration event earlier in the log still contains the address. The address in the registration event had to be rewritten, which breaks the promise that the log is immutable. In the change stream, a tombstone lets compaction remove ${esc(parcel)} completely.`, "bad");
  }

  root.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("click", () => command(b.dataset.cmd)));
  root.querySelector('[data-act="erase"]').addEventListener("click", erase);
  root.querySelector('[data-act="reset"]').addEventListener("click", reset);
  compactBtn.addEventListener("click", () => {
    compacted = !compacted;
    freshSeq = 0;
    render();
    const cl = changelog(events);
    say(verdict, compacted
      ? `Compaction keeps only the newest record for each parcel: ${compact(cl).length} of ${cl.length}. A new consumer that reads the compacted stream from the start still ends up with the full current table. The event log itself cannot be compacted this way: older events carry history the newest one does not.`
      : "Showing every record in the change stream.");
  });
  radio([...root.querySelectorAll("[data-parcel]")], "parcel", (v) => { parcel = v; });
  uptoIn.addEventListener("input", () => {
    freshSeq = 0;
    render();
    const k = +uptoIn.value;
    say(verdict, k < events.length
      ? `State as of event ${k}. Replaying a prefix of the log shows what the system believed at that moment, which is how you debug or audit an event-sourced system.`
      : "State as of the latest event.");
  });
  reset();
}
