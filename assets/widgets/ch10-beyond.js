// Chapter 10, lesson 4: chained MapReduce vs a dataflow engine, and Pregel supersteps.
import { el, linear, niceTicks, responsive, slider, prefersReducedMotion } from "../charts.js";
import { timelines, STAGES, GRAPH, createPregel } from "../engines/ch10-dataflow.js";
import { makeLoop, sleep } from "./ch10-util.js";

/* ------------------------------------------------------------------ */
/* Timeline: materialized intermediate state vs pipelined dataflow      */
/* ------------------------------------------------------------------ */
{
  const root = document.getElementById("flow");
  const chart = root.querySelector(".chart");
  const verdict = root.querySelector(".verdict");
  const o = (k) => root.querySelector(`[data-out="${k}"]`);
  const failIn = root.querySelector("#flow-fail");
  const st = { sizeGB: 200, replication: 3, failure: false };
  const FILL = {
    startup: "var(--ink-4)", read: "var(--purple)", compute: "var(--accent)", write: "var(--orange)",
    spill: "var(--green)", recompute: "var(--red)",
  };
  const NAMES = { startup: "job startup", read: "read from DFS", compute: "compute", write: "write to DFS, replicated", spill: "local spill", recompute: "recompute after failure", wait: "waiting" };
  const secs = (s) => (s >= 120 ? `${(s / 60).toFixed(s >= 600 ? 0 : 1)} min` : `${Math.round(s)} s`);
  const gb = (g) => (g >= 1000 ? `${(g / 1000).toFixed(1)} TB` : `${Math.round(g)} GB`);

  let W = 0;
  function draw(width = W) {
    W = width; if (!W) return;
    const T = timelines(st);
    const maxT = Math.max(T.mr.total, T.df.total) * 1.04;
    const left = W < 480 ? 26 : 62, right = 12, rowH = 20, gap = 6, groupGap = 34, top = 22;
    const groupH = 3 * rowH + 2 * gap;
    const h = top + groupH + groupGap + groupH + 30;
    const x = linear([0, maxT], [left, W - right]);
    chart.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${W} ${h}`, height: h, role: "img", "aria-label": `Timeline. Chained MapReduce takes ${secs(T.mr.total)}, the dataflow engine takes ${secs(T.df.total)}.` }, chart);
    const defs = el("defs", {}, svg);
    const pat = el("pattern", { id: "flow-hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    el("line", { x1: 0, y1: 0, x2: 0, y2: 6, style: "stroke:var(--line-2);stroke-width:2" }, pat);
    const grid = el("g", { class: "grid" }, svg);
    for (const t of niceTicks(0, maxT, W < 480 ? 3 : 6)) {
      el("line", { x1: x(t), x2: x(t), y1: top - 4, y2: h - 22 }, grid);
      el("text", { x: x(t), y: h - 6, "text-anchor": "middle" }, svg).textContent = secs(t);
    }
    const group = (plan, y0, title) => {
      el("text", { x: 0, y: y0 - 8, style: "fill:var(--ink);font-size:12px;font-weight:500" }, svg).textContent = `${title}: ${secs(plan.total)}`;
      for (let i = 0; i < 3; i++) {
        const y = y0 + i * (rowH + gap);
        el("text", { x: 0, y: y + 14, style: "fill:var(--ink-3);font-size:11px" }, svg).textContent = left > 30 ? `Stage ${i + 1}` : `${i + 1}`;
      }
      for (const s of plan.segments) {
        const y = y0 + s.stage * (rowH + gap);
        const wSeg = Math.max(x(s.t1) - x(s.t0), s.t1 > s.t0 ? 1 : 0);
        const r = el("rect", { x: x(s.t0), y, width: wSeg, height: rowH, rx: 2, style: s.kind === "wait" ? "fill:url(#flow-hatch)" : `fill:${FILL[s.kind]}` }, svg);
        el("title", {}, r).textContent = `${STAGES[s.stage]}: ${NAMES[s.kind]}, ${secs(s.t1 - s.t0)}`;
      }
      el("line", { x1: x(plan.total), x2: x(plan.total), y1: y0 - 4, y2: y0 + groupH + 4, style: "stroke:var(--ink);stroke-width:1.5" }, svg);
    };
    group(T.mr, top + 10, "Chained MapReduce jobs");
    group(T.df, top + 10 + groupH + groupGap, "Dataflow engine");

    o("mr").textContent = secs(T.mr.total);
    o("df").textContent = secs(T.df.total);
    o("mrb").textContent = gb(T.mr.dfsBytes);
    o("dfb").textContent = gb(T.df.dfsBytes);
    const speed = T.mr.total / T.df.total;
    const mrFailCost = st.failure ? timelines({ ...st, failure: true }).mr.total - timelines({ ...st, failure: false }).mr.total : 0;
    const dfFailCost = st.failure ? timelines({ ...st, failure: true }).df.total - timelines({ ...st, failure: false }).df.total : 0;
    verdict.className = "verdict";
    verdict.innerHTML = st.failure
      ? `The dataflow engine is still ${speed.toFixed(1)}× faster, but look at the red segments. MapReduce re-ran one task from its materialized input in ${secs(mrFailCost)}. The dataflow engine kept no durable copy of the lost partition, so it recomputed it from the original input through every stage: ${secs(dfFailCost)}.`
      : `The dataflow engine finishes ${speed.toFixed(1)}× sooner and writes ${gb(T.mr.dfsBytes - T.df.dfsBytes)} less to the distributed filesystem. Most of the gap is the replicated writes between jobs and the time each job spends waiting for the previous one to finish completely.`;
  }

  slider(root.querySelector("#flow-size"), (v) => gb(v), (v) => { st.sizeGB = v; draw(); });
  slider(root.querySelector("#flow-rep"), (v) => `${v}×`, (v) => { st.replication = v; draw(); });
  failIn.addEventListener("change", () => { st.failure = failIn.checked; draw(); });
  responsive(chart, draw);
}

/* ------------------------------------------------------------------ */
/* Pregel supersteps                                                    */
/* ------------------------------------------------------------------ */
{
  const root = document.getElementById("pregel");
  const svg = root.querySelector("svg");
  const verdict = root.querySelector(".verdict");
  const o = (k) => root.querySelector(`[data-out="${k}"]`);
  const WCOL = ["var(--purple)", "var(--green)", "var(--ink-3)"];
  const R = 19;
  const pos = new Map(GRAPH.nodes.map((n) => [n.id, n]));
  const st = { mode: "hops", source: "A", busy: false };
  let pg;

  // Static parts
  const gEdges = el("g", {}, svg);
  const edgeEls = new Map();
  for (const [a, b] of GRAPH.edges) {
    const p = pos.get(a), q = pos.get(b);
    edgeEls.set(a + b, el("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: "pg-edge" }, gEdges));
  }
  const gMsgs = el("g", {}, svg);
  const vEls = new Map();
  for (const n of GRAPH.nodes) {
    const g = el("g", { class: "pg-v", tabindex: 0, role: "button", "aria-label": `Vertex ${n.id}` }, svg);
    el("circle", { cx: n.x, cy: n.y, r: R }, g);
    el("circle", { cx: n.x + R * 0.72, cy: n.y - R * 0.72, r: 4.5, class: "w", style: `fill:${WCOL[n.w]}` }, g);
    const val = el("text", { x: n.x, y: n.y + 5, class: "val" }, g);
    el("text", { x: n.x, y: n.y + R + 14, class: "name" }, g).textContent = n.id;
    const inbox = el("text", { x: n.x - R - 4, y: n.y - R + 2, "text-anchor": "end", style: "fill:var(--orange);font:500 11px var(--sans)" }, g);
    vEls.set(n.id, { g, val, inbox });
    const pick = () => { if (st.mode !== "hops") return; st.source = n.id; reset(); };
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  }

  const show = (v) => (v === Infinity ? "∞" : String(v));

  function paint(changed = []) {
    const s = pg.state;
    for (const n of GRAPH.nodes) {
      const v = vEls.get(n.id);
      v.val.textContent = show(s.value.get(n.id));
      v.g.classList.toggle("changed", changed.includes(n.id));
      v.g.classList.toggle("source", st.mode === "hops" && n.id === st.source);
      // Vertices pick the source, which only exists in hops mode.
      v.g.classList.toggle("static", st.mode !== "hops");
      if (st.mode === "hops") { v.g.setAttribute("tabindex", 0); v.g.setAttribute("role", "button"); }
      else { v.g.removeAttribute("tabindex"); v.g.removeAttribute("role"); }
      const mail = s.inbox.get(n.id)?.length || 0;
      v.inbox.textContent = mail ? `${mail} msg` : "";
    }
    o("total").textContent = String(s.totalMessages);
    o("cross").textContent = String(s.totalCross);
    root.querySelector('[data-act="step"]').disabled = s.halted;
  }

  async function travel(sent) {
    gMsgs.innerHTML = "";
    edgeEls.forEach((e) => e.classList.remove("busy"));
    if (!sent.length) return;
    for (const m of sent) (edgeEls.get(m.from + m.to) || edgeEls.get(m.to + m.from)).classList.add("busy");
    if (prefersReducedMotion()) return;
    const dots = sent.map((m) => {
      const g = el("g", {}, gMsgs);
      el("circle", { r: 9, class: "pg-msg" }, g);
      el("text", { y: 3.5, "text-anchor": "middle", style: "fill:var(--bg);font:500 10px var(--mono)" }, g).textContent = show(m.val);
      return { g, p: pos.get(m.from), q: pos.get(m.to) };
    });
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const dur = 750;
    await new Promise((res) => {
      const t0 = performance.now();
      const frame = (now) => {
        const t = Math.min(1, (now - t0) / dur), e = ease(t);
        for (const d of dots) {
          // Start and stop at the circle edges.
          const dx = d.q.x - d.p.x, dy = d.q.y - d.p.y, len = Math.hypot(dx, dy);
          const a = R / len, b = 1 - R / len, k = a + (b - a) * e;
          d.g.setAttribute("transform", `translate(${d.p.x + dx * k},${d.p.y + dy * k})`);
        }
        if (t < 1 && pg.state.superstep === gen) requestAnimationFrame(frame); else res();
      };
      requestAnimationFrame(frame);
    });
    gMsgs.innerHTML = "";
  }
  let gen = 0;

  function describe(r) {
    const s = pg.state;
    if (r.superstep === 0) {
      return st.mode === "hops"
        ? `Superstep 0: vertex ${st.source} sets its distance to 0 and sends 1 to each neighbor. Every other vertex starts at ∞ and votes to halt.`
        : `Superstep 0: every vertex takes its own name as its label and sends it to all neighbors. ${r.sent.length} messages, ${r.cross} of them between workers.`;
    }
    if (s.halted) {
      const unreach = st.mode === "hops" ? [...s.value].filter(([, v]) => v === Infinity).map(([k]) => k) : [];
      const tail = st.mode === "hops"
        ? (unreach.length ? ` Vertices ${unreach.join(", ")} are still at ∞: no path reaches them.` : "")
        : ` Each connected component now carries the smallest name in it.`;
      return `Superstep ${r.superstep}: the messages that arrived improve nothing, so no vertex sends anything. All vertices have voted to halt and the job ends.${tail}`;
    }
    return `Superstep ${r.superstep}: ${r.changed.length ? `${r.changed.join(", ")} found a smaller value in their mail, updated, and` : "nobody improved, and"} sent ${r.sent.length} message${r.sent.length === 1 ? "" : "s"}, ${r.cross} across workers. They will be read in superstep ${r.superstep + 1}.`;
  }

  async function doStep() {
    if (pg.state.halted) return false;
    if (st.busy) { gen = -1; return true; }
    st.busy = true;
    const r = pg.step();
    gen = pg.state.superstep;
    paint(r.changed);
    o("now").textContent = `${r.sent.length} (${r.cross} cross)`;
    o("ss").textContent = String(r.superstep);
    verdict.textContent = describe(r);
    verdict.className = `verdict${pg.state.halted ? " good" : ""}`;
    // Mail badges appear once the messages arrive.
    const mine = pg;
    const inboxes = [...vEls.values()].map((v) => [v.inbox, v.inbox.textContent]);
    inboxes.forEach(([t]) => (t.textContent = ""));
    await travel(r.sent);
    st.busy = false;
    if (pg !== mine) return false;
    inboxes.forEach(([t, txt]) => (t.textContent = txt));
    return !pg.state.halted;
  }

  function reset() {
    loop.stop();
    gen = -1;
    gMsgs.innerHTML = "";
    edgeEls.forEach((e) => e.classList.remove("busy"));
    pg = createPregel(GRAPH, st.mode, st.source);
    paint();
    o("now").textContent = "0";
    o("ss").textContent = "not started";
    verdict.className = "verdict";
    verdict.textContent = st.mode === "hops"
      ? `Find the number of hops from vertex ${st.source} to every other vertex. Click a vertex to change the source.`
      : "Label every vertex with the smallest vertex name in its connected component.";
  }

  const loop = makeLoop(root.querySelector('[data-act="play"]'), doStep, 450);
  root.querySelector('[data-act="step"]').addEventListener("click", () => { loop.stop(); doStep(); });
  root.querySelector('[data-act="reset"]').addEventListener("click", reset);
  root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    st.mode = b.dataset.mode;
    root.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    reset();
  }));
  reset();
}
