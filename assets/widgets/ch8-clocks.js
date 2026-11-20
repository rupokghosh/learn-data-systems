// Chapter 8, lesson 2: drifting clocks break last-write-wins; a paused leader outlives its lease.
import { el, linear, niceTicks, responsive, slider } from "../charts.js";
import { lwwScenario, leaseScenario, LWW_SYNC_AT } from "../engines/ch8-sim.js";
import { spaceTime, makeSweep } from "./ch8-spacetime.js";

const signedMs = (s) => `${s >= 0 ? "+" : "−"}${Math.round(Math.abs(s) * 1000)} ms`;

/* ---------- Three clocks, one thermostat ---------- */
{
  const root = document.getElementById("lww");
  const chart = root.querySelector(".chart");
  const svg = root.querySelector(".scroll-x svg");
  const verdict = root.querySelector(".verdict");
  const note = root.querySelector('[data-out="jump"]');
  const ntpBtn = root.querySelector("[data-ntp]");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const NODES = [
    { id: "A", color: "var(--ink-3)" },
    { id: "B", color: "var(--accent)" },
    { id: "C", color: "var(--orange)" },
  ];
  const T_END = 8;
  let opts = { skew: 0.3, drift: 0.01, gap: 0.2, ntp: false };
  let trace = null, width = 0;

  function update() {
    trace = lwwScenario(opts);
    const [p, t] = trace.writes;
    const gapMs = Math.round((t.t - p.t) * 1000);
    out("first").textContent = `Priya, by ${gapMs} ms`;
    out("stamp").textContent = trace.winner.who === "Priya"
      ? `Priya (${p.ts.toFixed(3)} > ${t.ts.toFixed(3)})`
      : `Tomas (${t.ts.toFixed(3)} > ${p.ts.toFixed(3)})`;
    out("final").textContent = `${trace.final.A}° (${trace.winner.who}'s)`;
    const disagree = Math.round((trace.clocks.B.read(p.t) - trace.clocks.C.read(p.t)) * 1000);
    if (trace.anomaly) {
      verdict.className = "verdict bad";
      verdict.textContent = `Tomas set the thermostat ${gapMs} ms after Priya, but node C's clock was ${disagree} ms behind node B's, so his write carries the smaller timestamp. All three nodes quietly throw it away. Nobody sees an error.`;
    } else {
      verdict.className = "verdict good";
      verdict.textContent = `The timestamps agree with what really happened, so Tomas's later write wins everywhere. It only worked because the writes were ${gapMs} ms apart while B and C disagreed by ${Math.abs(disagree)} ms.`;
    }
    if (opts.ntp) {
      const jb = trace.clocks.B.jumps[0], jc = trace.clocks.C.jumps[0];
      const dir = (j) => (j.to < j.from ? `jumped back ${Math.round((j.from - j.to) * 1000)} ms` : `jumped forward ${Math.round((j.to - j.from) * 1000)} ms`);
      note.textContent = `At the sync, node B's time-of-day clock ${dir(jb)} and node C's ${dir(jc)}. A monotonic clock on the same machines would not have jumped at all: it is only ever slewed, which is why it is the right clock for timeouts and the wrong one for comparing machines.`;
    } else {
      note.textContent = "Without synchronization the clocks wander apart for good. Real quartz drifts far more slowly than this slider allows, but it keeps going for hours and days, not seconds.";
    }
    drawChart();
    spaceTime(svg, trace, {
      rowGap: 92,
      rowSub: Object.fromEntries(NODES.map((n) => [n.id, `clock ${signedMs(trace.clocks[n.id].read(p.t) - p.t)}`])),
      ticks: Array.from({ length: 12 }, (_, i) => Math.ceil(trace.t0 * 5) / 5 + i * 0.2).filter((v) => v <= trace.t1),
      tick: (v) => `${v.toFixed(1)} s`,
    });
  }

  function drawChart(w = width) {
    width = w;
    if (!w || !trace) return;
    const h = 200, padL = 52, padR = 22, padT = 26, padB = 24;
    const x = linear([0, T_END], [padL, w - padR]);
    let maxErr = 0.05;
    const series = NODES.map((n) => {
      const c = trace.clocks[n.id];
      const pts = [];
      for (let t = 0; t <= T_END + 1e-9; t += 0.05) {
        // Sample both sides of a sync so the step shows as a vertical jump.
        if (opts.ntp && Math.abs(t - LWW_SYNC_AT) < 0.025) pts.push([LWW_SYNC_AT, c.read(LWW_SYNC_AT, false) - LWW_SYNC_AT]);
        const e = c.read(t) - t;
        pts.push([t, e]);
        maxErr = Math.max(maxErr, Math.abs(e));
      }
      return { ...n, pts };
    });
    const ticks = niceTicks(-maxErr, maxErr, 4);
    const lim = Math.max(Math.abs(ticks[0]), Math.abs(ticks[ticks.length - 1]), maxErr);
    const y = linear([-lim, lim], [h - padB, padT]);
    chart.innerHTML = "";
    const s = el("svg", { viewBox: `0 0 ${w} ${h}`, height: h, role: "img",
      "aria-label": "Clock error of nodes A, B and C over eight seconds of true time" }, chart);
    const g = el("g", { class: "grid" }, s);
    for (const t of ticks) {
      el("line", { x1: padL, x2: w - padR, y1: y(t), y2: y(t), style: t === 0 ? "stroke:var(--ink-4)" : "" }, g);
      const tx = el("text", { x: padL - 6, y: y(t) + 4, "text-anchor": "end" }, s);
      tx.textContent = t === 0 ? "exact" : signedMs(t).replace(" ms", "");
    }
    for (let t = 0; t <= T_END; t += 2) {
      const tx = el("text", { x: x(t), y: h - 6, "text-anchor": "middle" }, s);
      tx.textContent = `${t} s`;
    }
    const vmarks = [
      { t: trace.writes[0].t, label: "Priya", color: "var(--ink-2)", anchor: "end", dx: -3 },
      { t: trace.writes[1].t, label: "Tomas", color: "var(--ink-2)", anchor: "start", dx: 3 },
    ];
    if (opts.ntp) vmarks.push({ t: LWW_SYNC_AT, label: "NTP sync", color: "var(--purple)", anchor: "middle", dx: 0 });
    for (const m of vmarks) {
      el("line", { x1: x(m.t), x2: x(m.t), y1: padT - 8, y2: h - padB, style: `stroke:${m.color};stroke-dasharray:3 3;opacity:0.7` }, s);
      const tx = el("text", { x: x(m.t) + m.dx, y: padT - 12, "text-anchor": m.anchor, style: `fill:${m.color}` }, s);
      tx.textContent = m.label;
    }
    for (const sr of series) {
      const d = sr.pts.map(([t, e], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(e).toFixed(1)}`).join("");
      el("path", { d, style: `fill:none;stroke:${sr.color};stroke-width:2;stroke-linejoin:round` }, s);
      const last = sr.pts[sr.pts.length - 1];
      const tx = el("text", { x: w - padR + 5, y: y(last[1]) + 4, style: `fill:${sr.color};font-weight:600` }, s);
      tx.textContent = sr.id;
    }
  }

  slider(root.querySelector("#lww-skew"), (v) => `${v} ms`, (v) => { opts.skew = v / 1000; if (trace) update(); });
  slider(root.querySelector("#lww-drift"), (v) => `${v} ms per s`, (v) => { opts.drift = v / 1000; if (trace) update(); });
  slider(root.querySelector("#lww-gap"), (v) => `${v} ms`, (v) => { opts.gap = v / 1000; if (trace) update(); });
  ntpBtn.addEventListener("click", () => {
    opts.ntp = !opts.ntp;
    ntpBtn.setAttribute("aria-pressed", String(opts.ntp));
    update();
  });
  update();
  responsive(chart, drawChart);
}

/* ---------- The lease that ran out mid-request ---------- */
{
  const root = document.getElementById("lease");
  const svg = root.querySelector("svg");
  const verdict = root.querySelector(".verdict");
  const playBtn = root.querySelector("[data-play]");
  let pause = 4, trace = null;

  const draw = (upto = Infinity) => spaceTime(svg, trace, {
    upto, rowGap: 74,
    markers: [{ t: trace.leaseEnd, label: "node-1 lease expires", color: "var(--red)", always: true }],
    rowSub: { n1: "lease until 10.0 s" },
    tick: (v) => `${v} s`,
  });
  const sweep = makeSweep(draw, { duration: 3200 });

  function say() {
    const w1 = trace.storageLog.find((w) => w.from === "n1");
    const late = (w1.t - trace.leaseEnd).toFixed(1);
    const renewed = trace.msgs.some((m) => m.label === "renewed");
    if (trace.outcome === "safe") {
      verdict.className = "verdict good";
      verdict.textContent = pause === 0
        ? "No pause: node-1 writes with time to spare and renews its lease. This is the case the code was written for."
        : `The pause ended in time. node-1's write landed before the lease expired${renewed ? ", and it renewed" : ". Its renewal came too late, so it stepped aside and node-2 took over cleanly"}. Push the pause past ${(trace.leaseEnd - trace.pauseAt - 0.2).toFixed(1)} s.`;
    } else if (trace.outcome === "overlap") {
      verdict.className = "verdict bad";
      verdict.textContent = `node-1's write arrived ${+late ? `${late} s after` : "just as"} its lease ${+late ? "had expired" : "expired"}, while node-2 was already taking over. For a moment two nodes acted as leader.`;
    } else {
      verdict.className = "verdict bad";
      verdict.textContent = `node-2 became leader and wrote plan B. Then node-1 woke up, still sure of the lease check it made before the pause, and overwrote it with plan A, ${late} s after its lease had expired. Storage now holds stale data.`;
    }
  }

  function update(animate) {
    trace = leaseScenario({ pause });
    if (animate) { verdict.textContent = ""; sweep.play(trace.t0, trace.t1, say); }
    else { sweep.finish(); draw(); say(); }
  }

  slider(root.querySelector("#lease-pause"), (v) => `${v.toFixed(1)} s`, (v) => { pause = v; if (trace) update(false); });
  playBtn.addEventListener("click", () => update(true));
  update(false);
}
