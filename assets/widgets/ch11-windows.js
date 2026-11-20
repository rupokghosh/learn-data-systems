// Chapter 11, lesson 3: the windowing lab.
import { el, linear, responsive, niceTicks } from "../charts.js";
import { genEvents, run, truth, hopFor, OUTAGE } from "../engines/ch11-windows.js";
import { say, radio, tween } from "./ch11-util.js";

const root = document.getElementById("winlab");
const chart = root.querySelector(".chart");
const verdict = root.querySelector(".verdict");
const sizeIn = root.querySelector("#wl-size");
const lagIn = root.querySelector("#wl-lag");
const lateIn = root.querySelector("#wl-late");
const nowIn = root.querySelector("#wl-now");
const outageIn = root.querySelector("#wl-outage");
const playBtn = root.querySelector('[data-act="play"]');
const out = (k) => root.querySelector(`[data-stat="${k}"]`);
const labelOf = (input) => input.closest(".control").querySelector("output");
const sizeLabel = root.querySelector('label[for="wl-size"] span');

const END = 170; // seconds of processing time shown; the input itself covers 0 to 120 s of event time
const opts = { type: "tumbling", policy: "drop", by: "event" };
let events = [], width = 0, anim = null;

function regenerate() {
  events = genEvents({ seed: 5, lateShare: +lateIn.value / 100, outage: outageIn.checked });
}

function current(until) {
  const o = { ...opts, size: +sizeIn.value, gap: +sizeIn.value, lag: +lagIn.value, end: END };
  return { o, r: run(events, o, until), t: truth(events, o) };
}

/** Fill in empty fixed windows so a window with no events still shows as zero. */
function gridWindows(r, t, o, until) {
  if (o.type === "session") return r.windows;
  const hop = hopFor(o.type, o.size);
  const have = new Map(r.windows.map((w) => [w.start.toFixed(3), w]));
  const list = [];
  const maxStart = o.by === "event" ? 120 : END;
  for (let s = 0; s < maxStart - 1e-9; s += hop) {
    const k = s.toFixed(3);
    let w = have.get(k);
    if (!w) {
      const closed = o.by === "processing" ? s + o.size <= until : s + o.size <= r.watermark;
      w = { start: s, end: s + o.size, count: 0, first: 0, corrections: 0, dropped: 0, emitted: closed || until >= END, emittedAt: s + o.size };
    }
    w.truth = t.get(k)?.count ?? 0;
    list.push(w);
  }
  return list;
}

function draw(w, until = +nowIn.value) {
  width = w;
  const { o, r, t } = current(until);
  const wins = gridWindows(r, t, o, until);
  const H = 356, L = 8, R = w - 8;
  const x = linear([0, END], [L, R]);
  const svg = el("svg", { viewBox: `0 0 ${w} ${H}`, class: "c11-lab", role: "img", "aria-label": "Events placed by event time and by processing time, with windows and per-window counts." });

  const Y = { evAxis: 44, prAxis: 140, band: 180, bandH: o.type === "hopping" ? 26 : 16, barTop: 240, barBase: 336 };
  // axes
  const ticks = niceTicks(0, END, Math.max(4, Math.floor(w / 70)));
  for (const [y, label] of [[Y.evAxis, "Event time (when the gate scanned)"], [Y.prAxis, "Processing time (when it was handled)"]]) {
    el("line", { x1: L, x2: R, y1: y, y2: y, class: "axis" }, svg);
    for (const v of ticks) {
      el("line", { x1: x(v), x2: x(v), y1: y, y2: y + 4, class: "axis" }, svg);
      const tt = el("text", { x: x(v), y: y + 15, "text-anchor": "middle" }, svg); tt.textContent = `${v}s`;
    }
    const lt = el("text", { x: L, y: y - 30, class: "title" }, svg); lt.textContent = label;
  }
  // outage band on the processing axis
  if (outageIn.checked) {
    el("rect", { x: x(OUTAGE[0]), y: Y.prAxis - 22, width: x(OUTAGE[1]) - x(OUTAGE[0]), height: 22, class: "outage" }, svg);
    const ot = el("text", { x: (x(OUTAGE[0]) + x(OUTAGE[1])) / 2, y: Y.prAxis - 25, "text-anchor": "middle", style: "fill:var(--red)" }, svg);
    ot.textContent = "processor down";
  }
  // events: connector, dot on each axis
  const gl = el("g", {}, svg), gd = el("g", {}, svg);
  for (const e of events) {
    const seen = e.p <= until;
    const st = r.status.get(e.id);
    const cls = !seen ? "unseen" : st === "dropped" ? "dropped" : st === "corr" ? "corr" : "";
    const jy = (e.id % 3) * 5;
    if (seen) el("line", { x1: x(e.t), y1: Y.evAxis - 8 - jy, x2: x(e.p), y2: Y.prAxis - 8 - jy, class: `link${e.veryLate ? " late" : ""}` }, gl);
    el("circle", { cx: x(e.t), cy: Y.evAxis - 8 - jy, r: 2.6, class: `ev ${cls}` }, gd);
    if (seen) el("circle", { cx: x(e.p), cy: Y.prAxis - 8 - jy, r: 2.6, class: `ev ${cls}` }, gd);
  }
  // processing clock
  if (until < END) {
    el("line", { x1: x(until), x2: x(until), y1: Y.prAxis - 26, y2: Y.prAxis + 4, class: "now" }, svg);
  }

  // window bands
  const bt = el("text", { x: L, y: Y.band - 8, class: "title" }, svg);
  bt.textContent = o.type === "sliding" ? `Sliding windows: one ${o.size}s window ending at every second` : `Windows by ${o.by === "event" ? "event" : "processing"} time`;
  if (o.type !== "sliding") {
    for (const [i, wd] of wins.entries()) {
      const row = o.type === "hopping" ? i % 2 : 0;
      const y = Y.band + row * 13;
      const hgt = o.type === "hopping" ? 11 : 16;
      const cls = !wd.emitted ? "win" : wd.corrections ? "win corrected" : "win fired";
      el("rect", { x: x(wd.start) + 0.5, y, width: Math.max(2, x(wd.end) - x(wd.start) - 1), height: hgt, rx: 2, class: cls }, svg);
    }
  }
  // watermark (event-time clocks only)
  if (o.by === "event" && Number.isFinite(r.watermark) && r.watermark > 0 && until < END) {
    const wx = x(r.watermark);
    el("line", { x1: wx, x2: wx, y1: Y.evAxis - 26, y2: Y.evAxis + 2, class: "wm" }, svg);
    el("line", { x1: wx, x2: wx, y1: Y.band - 2, y2: Y.band + Y.bandH + 2, class: "wm" }, svg);
    const wt = el("text", { x: wx + 4, y: Y.evAxis - 18, class: "wmlbl" }, svg); wt.textContent = "watermark";
  }

  // per-window results
  const maxC = Math.max(4, ...wins.map((v) => Math.max(v.count, v.truth ?? 0)));
  const y = linear([0, maxC], [Y.barBase, Y.barTop]);
  el("line", { x1: L, x2: R, y1: Y.barBase, y2: Y.barBase, class: "axis" }, svg);
  const rt = el("text", { x: L, y: Y.barTop - 14, class: "title" }, svg);
  rt.textContent = "Count per window: published vs. true";
  const hop = hopFor(o.type, o.size);
  if (o.type === "sliding") {
    const pts = (f) => wins.map((v) => `${x(v.end)},${y(f(v))}`).join(" ");
    el("polyline", { points: pts((v) => v.truth ?? 0), class: "curve truth-c" }, svg);
    const shown = wins.filter((v) => v.emitted);
    if (shown.length) el("polyline", { points: shown.map((v) => `${x(v.end)},${y(v.count)}`).join(" "), class: "curve got" }, svg);
  } else {
    for (const v of wins) {
      let x0, x1;
      if (o.type === "hopping") { const mid = (v.start + v.end) / 2; x0 = x(mid - hop / 2) + 1; x1 = x(mid + hop / 2) - 1; }
      else if (o.type === "session") { x0 = x(v.start) - 1.5; x1 = Math.max(x(v.end) + 1.5, x0 + 3); }
      else { x0 = x(v.start) + 1; x1 = x(v.end) - 1; }
      const bw = Math.max(2, x1 - x0);
      if (v.emitted) {
        const first = v.first ?? v.count;
        el("rect", { x: x0, y: y(first), width: bw, height: Y.barBase - y(first), class: "bar" }, svg);
        if (v.count > first) el("rect", { x: x0, y: y(v.count), width: bw, height: y(first) - y(v.count), class: "bar corr" }, svg);
      } else if (v.count) {
        el("rect", { x: x0, y: y(v.count), width: bw, height: Y.barBase - y(v.count), class: "bar", style: "fill-opacity:0.25" }, svg);
      }
      if (o.type !== "session" && (v.emitted || until >= END)) el("line", { x1: x0, x2: x0 + bw, y1: y(v.truth), y2: y(v.truth), class: "truth" }, svg);
      if (bw >= 16 && v.emitted) { const ct = el("text", { x: x0 + bw / 2, y: y(Math.max(v.count, v.truth ?? 0)) - 4, "text-anchor": "middle" }, svg); ct.textContent = v.count; }
    }
    if (o.type === "session") {
      for (const s of t) {
        el("line", { x1: x(s.start) - 1.5, x2: Math.max(x(s.end) + 1.5, x(s.start) + 1.5), y1: Y.barBase + 6, y2: Y.barBase + 6, class: "truth" }, svg);
      }
      const st = el("text", { x: R, y: Y.barBase + 18, "text-anchor": "end" }, svg);
      st.textContent = `true sessions (black): ${t.length}, found so far: ${wins.length}`;
    }
  }
  chart.replaceChildren(svg);
  stats(o, r, t, wins, until);
}

function stats(o, r, t, wins, until) {
  const dropped = [...r.status.values()].filter((s) => s === "dropped").length;
  const corr = wins.reduce((s, v) => s + (v.emitted ? v.corrections : 0), 0);
  const revised = wins.filter((v) => v.emitted && v.corrections).length;
  const emitted = wins.filter((v) => v.emitted);
  const wrong = o.type === "session"
    ? Math.abs(t.length - wins.length)
    : emitted.filter((v) => v.count !== v.truth).length;
  const waits = emitted.filter((v) => !v.atEnd && v.emittedAt != null).map((v) => v.emittedAt - (o.type === "session" ? v.end + o.gap : v.end));
  const wait = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;
  out("seen").textContent = r.processed;
  out("dropped").textContent = dropped;
  out("corr").textContent = corr;
  out("wrong").textContent = o.type === "session" ? `${wins.length} vs ${t.length}` : `${wrong} of ${emitted.length}`;
  root.querySelector('[data-stat-label="wrong"]').textContent = o.type === "session" ? "Sessions found vs. true" : "Windows with a wrong count";
  out("wait").textContent = `${wait.toFixed(1)} s`;

  if (until < END) { say(verdict, `Processing clock at ${until.toFixed(0)} s. ${r.processed} scans handled so far.`); return; }
  if (o.by === "processing") {
    say(verdict, `Windows are cut by the processor's clock, so each scan is counted when it was handled, not when it happened. ${outageIn.checked ? "The outage leaves the windows between 50 s and 70 s nearly empty and dumps the whole backlog into the next one: a traffic spike that never happened at the gates." : "Delays smear counts into later windows, and very late scans land in windows long after the fact. Turn on the processor outage to see how bad it gets."} Nothing is ever late, which is exactly the problem.`, wrong ? "bad" : "");
  } else if (o.policy === "drop") {
    say(verdict, dropped
      ? `${dropped} scan${dropped === 1 ? " arrived" : "s arrived"} after the watermark had passed ${dropped === 1 ? "its" : "their"} window and ${dropped === 1 ? "was" : "were"} dropped, so ${o.type === "session" ? "the published session counts miss them" : `${wrong} published count${wrong === 1 ? " is" : "s are"} too low`}. A larger watermark lag catches more stragglers, but every result then waits longer (now ${wait.toFixed(1)} s on average).`
      : `No scan was dropped. The price is latency: each window waited ${wait.toFixed(1)} s on average after it ended before its count was published.`, dropped ? "bad" : "good");
  } else {
    say(verdict, corr
      ? `Every final count matches the truth, but ${revised} window${revised === 1 ? " was" : "s were"} published and then revised (${corr} correction${corr === 1 ? "" : "s"}, orange). Whatever consumes these results must accept updates to numbers it has already seen.`
      : `No late scans arrived after their window was published, so no corrections were needed. Results waited ${wait.toFixed(1)} s on average.`, corr ? "" : "good");
  }
}

function redraw() { if (width) draw(width); }

// controls
const syncSize = () => {
  sizeLabel.textContent = opts.type === "session" ? "Session gap" : "Window size";
  labelOf(sizeIn).textContent = `${sizeIn.value} s`;
};
sizeIn.addEventListener("input", () => { syncSize(); redraw(); });
lagIn.addEventListener("input", () => { labelOf(lagIn).textContent = `${lagIn.value} s`; redraw(); });
lateIn.addEventListener("input", () => { labelOf(lateIn).textContent = `${lateIn.value}%`; regenerate(); redraw(); });
outageIn.addEventListener("change", () => { regenerate(); redraw(); });
nowIn.addEventListener("input", () => { anim?.finish(); anim = null; playBtn.textContent = "Play"; labelOf(nowIn).textContent = `${(+nowIn.value).toFixed(0)} s`; redraw(); });
radio([...root.querySelectorAll("[data-type]")], "type", (v) => {
  const wasSession = opts.type === "session";
  opts.type = v;
  sizeIn.min = v === "session" ? 1 : 5;
  sizeIn.max = v === "session" ? 10 : 30;
  if (v === "session" && !wasSession) sizeIn.value = 3;
  if (v !== "session" && wasSession) sizeIn.value = 10;
  syncSize();
  redraw();
});
radio([...root.querySelectorAll("[data-policy]")], "policy", (v) => { opts.policy = v; redraw(); });
radio([...root.querySelectorAll("[data-by]")], "by", (v) => { opts.by = v; redraw(); });

playBtn.addEventListener("click", () => {
  if (anim && !anim.over) { anim.finish(); anim = null; return; }
  const from = +nowIn.value >= END ? 0 : +nowIn.value;
  playBtn.textContent = "Skip to end";
  anim = tween(from, END, (END - from) * 60, (v) => {
    nowIn.value = v;
    labelOf(nowIn).textContent = `${v.toFixed(0)} s`;
    if (width) draw(width, v);
  }, () => { playBtn.textContent = "Play"; });
});

labelOf(lagIn).textContent = `${lagIn.value} s`;
labelOf(lateIn).textContent = `${lateIn.value}%`;
labelOf(nowIn).textContent = `${(+nowIn.value).toFixed(0)} s`;
syncSize();
regenerate();
responsive(chart, (w) => draw(w));
