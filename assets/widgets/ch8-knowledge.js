// Chapter 8, lesson 3: fencing tokens, and safety versus liveness.
import { el, linear, responsive, slider } from "../charts.js";
import { fencingScenario, PROPERTY_TRACES, propertyStatus } from "../engines/ch8-sim.js";
import { spaceTime, makeSweep } from "./ch8-spacetime.js";

/* ---------- Fencing tokens ---------- */
{
  const root = document.getElementById("fencing");
  const svg = root.querySelector("svg");
  const verdict = root.querySelector(".verdict");
  const fenceBtn = root.querySelector("[data-fence]");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  let pause = 11, fencing = false, trace = null;

  const draw = (upto = Infinity) => spaceTime(svg, trace, {
    upto, rowGap: 74,
    markers: [{ t: trace.leaseEnd, label: "client 1 lease expires", color: "var(--red)", always: true }],
    rowSub: { st: fencing ? "checks tokens" : "accepts any write" },
    tick: (v) => `${v} s`,
  });
  const sweep = makeSweep(draw, { duration: 3200 });

  function say() {
    const acc = trace.history.filter((h) => h.accepted);
    out("file").textContent = trace.final;
    out("accepted").textContent = acc.map((h) => h.who).join(", then ") || "none";
    out("rejected").textContent = trace.history.filter((h) => !h.accepted).map((h) => h.who).join(", ") || "none";
    const texts = {
      safe: ["good", "client 1 finished inside its lease, so the lock did its job. Lengthen the pause until it outlives the lease."],
      "late-but-ordered": ["", "client 1 wrote after its lease expired, but before client 2 did. The writes land in lock order, so nothing is lost this time. That was luck, not design."],
      corrupted: ["bad", "client 2 held the lock and saved its edit. Then client 1 woke up, still believing it held the lock, and overwrote that edit. Storage had no way to tell the two clients apart. Turn on fencing tokens."],
      fenced: ["good", "client 1 woke up and sent its write with token 33. Storage had already accepted token 34, so it refused the stale write and told client 1. The paused client could not do harm, however long it slept."],
    };
    const [cls, text] = texts[trace.outcome];
    verdict.className = `verdict ${cls}`;
    verdict.textContent = text;
  }

  function update(animate) {
    trace = fencingScenario({ pause, fencing });
    if (animate) {
      for (const k of ["file", "accepted", "rejected"]) out(k).textContent = "…";
      verdict.textContent = "";
      sweep.play(trace.t0, trace.t1, say);
    } else { sweep.finish(); draw(); say(); }
  }

  slider(root.querySelector("#fence-pause"), (v) => `${v.toFixed(1)} s`, (v) => { pause = v; if (trace) update(false); });
  fenceBtn.addEventListener("click", () => {
    fencing = !fencing;
    fenceBtn.setAttribute("aria-pressed", String(fencing));
    update(false);
  });
  root.querySelector("[data-play]").addEventListener("click", () => update(true));
  update(false);
}

/* ---------- Safety versus liveness ---------- */
{
  const root = document.getElementById("props");
  const chart = root.querySelector(".chart");
  let upto = 60, width = 0;
  const T = 120;

  // Rows are HTML so the text wraps on narrow screens; each timeline is a small SVG.
  chart.innerHTML = PROPERTY_TRACES.map((p) => `
    <div class="ch8-prop">
      <p class="ch8-kind ${p.kind}">${p.kind}</p>
      <p class="ch8-ptext">${p.text}</p>
      <div class="ch8-line" data-id="${p.id}"></div>
      <p class="ch8-status" data-status="${p.id}"></p>
    </div>`).join("");

  function drawRow(p, w) {
    const host = chart.querySelector(`[data-id="${p.id}"]`);
    const h = 40, ly = 24;
    const x = linear([0, T], [6, w - 6]);
    const cx = x(upto);
    host.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, height: h, role: "img", "aria-label": `Trace for: ${p.text}` }, host);
    const txt = (x0, y0, s, color, anchor = "middle") => {
      const t = el("text", { x: x0, y: y0, "text-anchor": anchor, style: `font-size:11px;fill:${color}` }, svg);
      t.textContent = s;
    };
    // Observed part of the timeline is solid; the future is faint and dashed.
    el("line", { x1: x(0), x2: cx, y1: ly, y2: ly, style: "stroke:var(--ink-3);stroke-width:1.5" }, svg);
    el("line", { x1: cx, x2: x(T), y1: ly, y2: ly, style: "stroke:var(--line-2);stroke-width:1.5;stroke-dasharray:3 4" }, svg);
    const st = propertyStatus(p, upto);

    if (p.bars) {
      if (st.state === "violated") {
        const o2 = Math.min(upto, ...p.bars.map((b) => b.to));
        el("rect", { x: x(st.at), y: ly - 17, width: Math.max(2, x(o2) - x(st.at)), height: 21, rx: 2, style: "fill:var(--red-soft)" }, svg);
      }
      p.bars.forEach((b) => {
        if (b.from > upto) return;
        const by = ly - 11 + b.lane * 9;
        el("rect", { x: x(b.from), y: by - 3, width: Math.max(1, x(Math.min(b.to, upto)) - x(b.from)), height: 6, rx: 3,
          style: `fill:${b.lane ? "var(--accent)" : "var(--ink-3)"};opacity:0.8` }, svg);
      });
      const first = p.bars[0];
      if (first.from <= upto) txt(x(first.from), ly - 17, "lock holders", "var(--ink-3)", "start");
    }
    if (p.points) {
      p.points.forEach((pt) => {
        if (pt.t > upto) return;
        const bad = p.kind === "safety" && pt.t === p.violatedAt;
        el("circle", { cx: x(pt.t), cy: ly, r: 4, style: `fill:${bad ? "var(--red)" : "var(--ink-3)"};stroke:var(--bg);stroke-width:1.5` }, svg);
        txt(x(pt.t), ly - 9, pt.label, bad ? "var(--red)" : "var(--ink-3)");
      });
    }
    if (p.kind === "liveness" && upto >= p.pendingFrom) {
      const end = Math.min(upto, p.satisfiedAt);
      el("line", { x1: x(p.pendingFrom), x2: x(end), y1: ly + 8, y2: ly + 8, style: "stroke:var(--orange);stroke-width:3;stroke-linecap:round;opacity:0.7" }, svg);
      if (st.state === "satisfied") {
        el("circle", { cx: x(p.satisfiedAt), cy: ly, r: 4.5, style: "fill:var(--green);stroke:var(--bg);stroke-width:1.5" }, svg);
        txt(x(p.satisfiedAt), ly - 9, "answered", "var(--green)", "end");
      }
    }
    if (st.state === "violated") {
      const vx = x(st.at);
      el("line", { x1: vx, x2: vx, y1: ly - 20, y2: ly + 10, style: "stroke:var(--red);stroke-width:2" }, svg);
    }

    const status = chart.querySelector(`[data-status="${p.id}"]`);
    status.className = `ch8-status ${st.state}`;
    status.textContent = {
      holds: "Holds so far.",
      violated: `Violated at t = ${st.at}: ${p.why}. Nothing that happens later can repair it.`,
      pending: `Not satisfied yet, but it still could be. Waiting since t = ${st.since}.`,
      satisfied: `Satisfied at t = ${st.at}. It was never violated, only unfinished.`,
    }[st.state];
  }

  function draw(w = width) {
    width = w;
    if (!w) return;
    for (const p of PROPERTY_TRACES) drawRow(p, w);
  }

  slider(root.querySelector("#props-t"), (v) => `t = ${v}`, (v) => { upto = v; draw(); });
  responsive(chart, draw);
}
