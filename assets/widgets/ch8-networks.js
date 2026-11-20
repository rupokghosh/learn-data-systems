// Chapter 8, lesson 1: the six fates of a request, and choosing a timeout.
import { el, linear, logScale, ms, fmt, responsive, slider } from "../charts.js";
import { requestFate, timeoutExperiment } from "../engines/ch8-sim.js";
import { spaceTime, makeSweep } from "./ch8-spacetime.js";

/* ---------- Six fates of one request ---------- */
{
  const root = document.getElementById("fates");
  const svg = root.querySelector("svg");
  const hide = root.querySelector("#fate-hide");
  const verdict = root.querySelector(".verdict");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const buttons = [...root.querySelectorAll("[data-fate]")];

  const STORY = {
    "req-lost": "The request was dropped on the way. The server never heard of it, so a retry would be harmless. The client cannot know that.",
    "req-delayed": "The request sat in a congested queue. It reaches the server long after the client gave up, and the server still does the work.",
    "server-crash": "The request reached a machine that had already stopped. Nothing ran, and nothing will ever answer.",
    "server-pause": "The server was alive but frozen in a garbage collection pause. It handled the request when it woke up and answered too late.",
    "resp-lost": "The server did the work, then its answer was dropped. If the client retries, the work happens twice.",
    "resp-delayed": "The server answered promptly, but the answer was stuck behind other traffic and arrived after the client had moved on.",
  };

  let fate = "resp-lost";
  let trace = requestFate(fate);

  const draw = (upto = Infinity) => spaceTime(svg, trace, {
    upto,
    hide: hide.checked ? new Set(["server"]) : new Set(),
    markers: [{ t: trace.timeoutAt, label: "timeout: 1 s after sending", color: "var(--red)", always: true }],
    rowSub: { client: "waits up to 1 s", server: "remote node" },
    tick: (t) => `${+t.toFixed(1)} s`,
  });
  const sweep = makeSweep(draw, { duration: 2400 });

  function showFacts() {
    const late = trace.events.find((e) => e.kind === "late");
    out("reached").textContent = trace.fate === "req-lost" ? "no" : trace.fate === "server-crash" ? "yes, but it was down" : "yes";
    out("work").textContent = trace.executed ? "yes" : "no";
    out("before").textContent = "nothing";
    out("after").textContent = late ? `a late answer at ${late.t.toFixed(1)} s` : "nothing, ever";
    verdict.className = "verdict";
    verdict.textContent = hide.checked
      ? "From where the client sits, every fate looks identical until the deadline: a request went out and nothing came back. Switch the view off to see which one it was."
      : STORY[trace.fate];
  }
  function pending() {
    for (const k of ["reached", "work", "before", "after"]) out(k).textContent = "…";
    verdict.textContent = "";
  }

  function run(animate) {
    trace = requestFate(fate);
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.fate === fate)));
    if (animate) { pending(); sweep.play(trace.t0, trace.t1, showFacts); }
    else { sweep.finish(); draw(); showFacts(); }
  }

  buttons.forEach((b) => b.addEventListener("click", () => { fate = b.dataset.fate; run(true); }));
  root.querySelector("[data-replay]").addEventListener("click", () => run(true));
  hide.addEventListener("change", () => { sweep.finish(); draw(); showFacts(); });
  run(false);
}

/* ---------- Timeout explorer ---------- */
{
  const root = document.getElementById("timeouts");
  const chart = root.querySelector(".chart");
  const verdict = root.querySelector(".verdict");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const toSeconds = (v) => 0.005 * 1000 ** (v / 100); // slider 0..100 maps to 5 ms .. 5 s
  let timeout = 0.3, congestion = 0.3, res = null, width = 0;

  function update() {
    res = timeoutExperiment({ timeout, congestion });
    out("false").textContent = res.falsePerHour >= 10 ? fmt(res.falsePerHour, 0) : res.falsePerHour.toFixed(1);
    out("rate").textContent = `${(res.falseRate * 100).toFixed(res.falseRate < 0.01 ? 2 : 1)}%`;
    out("detect").textContent = ms(res.detectMean * 1000);
    out("worst").textContent = ms(res.detectWorst * 1000);
    let cls = "", text;
    if (res.falsePerHour > 60) {
      cls = "bad";
      text = `Healthy nodes get declared dead about ${fmt(res.falsePerHour, 0)} times an hour. Each false alarm can trigger a failover, move load onto the survivors, and run some actions twice.`;
    } else if (res.detectMean > 2) {
      cls = "bad";
      text = `False alarms are rare, but a node that really crashed goes unnoticed for about ${ms(res.detectMean * 1000)} on average. Every request routed to it in that window waits and fails.`;
    } else if (res.falsePerHour === 0) {
      text = `No false alarms in this sample, and a crash is noticed in about ${ms(res.detectMean * 1000)}. Raise the congestion and see whether that still holds.`;
    } else {
      text = `A workable middle: roughly ${res.falsePerHour >= 10 ? fmt(res.falsePerHour, 0) : res.falsePerHour.toFixed(1)} false alarms an hour against about ${ms(res.detectMean * 1000)} to notice a real crash. Neither number can reach zero without making the other worse.`;
    }
    verdict.className = `verdict ${cls}`;
    verdict.textContent = text;
    draw();
  }

  function draw(w = width) {
    width = w;
    if (!w || !res) return;
    const h = 220, padB = 24, padT = 30, padL = 4, padR = 8;
    const lo = 0.0005, hi = 5;
    const x = logScale([lo, hi], [padL, w - padR]);
    const BINS = Math.max(28, Math.min(64, Math.floor(w / 10)));
    const counts = new Array(BINS).fill(0);
    const llo = Math.log10(lo), lhi = Math.log10(hi);
    for (const v of res.samples) {
      const i = Math.floor(((Math.log10(Math.min(hi * 0.999, Math.max(lo, v))) - llo) / (lhi - llo)) * BINS);
      counts[i]++;
    }
    const ys = linear([0, Math.sqrt(Math.max(...counts))], [h - padB, padT]);
    const y = (c) => ys(Math.sqrt(c)); // square-root scale keeps the rare slow pings visible
    chart.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, height: h, role: "img",
      "aria-label": "Histogram of ping round-trip times on a log scale, with the timeout marked" }, chart);
    const bw = (w - padL - padR) / BINS;
    counts.forEach((c, i) => {
      if (!c) return;
      const left = 10 ** (llo + (i / BINS) * (lhi - llo));
      const late = left >= timeout;
      el("rect", { x: padL + i * bw + 0.5, y: y(c), width: Math.max(1, bw - 1.5), height: h - padB - y(c), rx: 1.5,
        style: `fill:${late ? "var(--red)" : "var(--ink-3)"};opacity:${late ? 0.85 : 0.4}` }, svg);
    });
    el("line", { x1: padL, x2: w - padR, y1: h - padB, y2: h - padB, style: "stroke:var(--line-2)" }, svg);
    for (const t of [0.001, 0.01, 0.1, 1]) {
      const tx = el("text", { x: x(t), y: h - 6, "text-anchor": "middle" }, svg);
      tx.textContent = ms(t * 1000);
    }
    const marks = [
      { v: res.p99, label: "p99", color: "var(--ink-3)", row: 0 },
      { v: res.p999, label: "p99.9", color: "var(--ink-3)", row: 1 },
    ];
    for (const m of marks) {
      const px = x(m.v);
      el("line", { x1: px, x2: px, y1: padT - 4, y2: h - padB, style: `stroke:${m.color};stroke-dasharray:3 3` }, svg);
      const t = el("text", { x: px, y: 10 + m.row * 12, "text-anchor": px > w - 40 ? "end" : "middle", style: `fill:${m.color}` }, svg);
      t.textContent = m.label;
    }
    const tx = x(timeout);
    el("line", { x1: tx, x2: tx, y1: padT - 10, y2: h - padB, style: "stroke:var(--red);stroke-width:2" }, svg);
    const tl = el("text", { x: tx + (tx > w - 120 ? -6 : 6), y: padT + 22, "text-anchor": tx > w - 120 ? "end" : "start",
      style: "fill:var(--red);font-weight:600;paint-order:stroke;stroke:var(--bg);stroke-width:4px" }, svg);
    tl.textContent = `timeout ${ms(timeout * 1000)}`;
  }

  slider(root.querySelector("#to-timeout"), (v) => ms(toSeconds(v) * 1000), (v) => { timeout = toSeconds(v); if (res) update(); });
  slider(root.querySelector("#to-congestion"), (v) => (v < 25 ? `quiet (${v}%)` : v < 65 ? `busy (${v}%)` : `congested (${v}%)`), (v) => { congestion = v / 100; if (res) update(); });
  update();
  responsive(chart, draw);
}
