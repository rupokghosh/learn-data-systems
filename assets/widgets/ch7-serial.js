// Chapter 7, lesson 4: the same workloads under two-phase locking and SSI,
// and a contention simulation that runs thousands of transactions through the engine.
import { mountLab } from "./ch7-lab.js";
import { simulate } from "../engines/ch7-txn.js";
import { el, logScale, linear, niceTicks, responsive, slider, fmt } from "../charts.js";

const lifeguards = {
  id: "skew", name: "Lifeguard breaks",
  blurb: "At least one lifeguard must stay on duty. Noor and Theo each count the guards on duty and go on break only if two or more are there.",
  initial: { "guard:ivy": "off duty", "guard:noor": "on duty", "guard:theo": "on duty" },
  keys: ["guard:ivy", "guard:noor", "guard:theo"],
  build: () => ["noor", "theo"].map((g, i) => ({
    name: "T" + (i + 1), role: `${g[0].toUpperCase() + g.slice(1)} asks for a break`,
    ops: [
      { op: "scan", prefix: "guard:", where: (v) => v === "on duty", as: "on", label: "count guards on duty" },
      { op: "write", key: "guard:" + g, value: "break", if: (L) => L.on.length >= 2, label: `if 2 or more: ${g} goes on break`, skip: "only 1 on duty: request refused" },
      { op: "commit" },
    ],
  })),
  schedules: [
    { name: "Interleaved", order: [0, 1, 0, 1, 0, 1] },
    { name: "One after the other", order: [0, 0, 0, 1, 1, 1] },
  ],
  invariant: {
    ok: ({ state }) => Object.values(state).filter((v) => v === "on duty").length >= 1,
    text: ({ state }, ok) => { const n = Object.values(state).filter((v) => v === "on duty").length; return ok ? `${n} lifeguard${n > 1 ? "s" : ""} on duty.` : "Nobody is watching the pool."; },
  },
};

const audit = {
  id: "audit", name: "Audit during a restock",
  blurb: "A stock audit reads three bins while a restock adds 100 bolts. There is no anomaly to prevent here; watch who has to wait.",
  initial: { "bin:bolts": 40, "bin:nuts": 55, "bin:washers": 70 },
  keys: ["bin:bolts", "bin:nuts", "bin:washers"],
  build: () => [
    { name: "T1", role: "Stock audit", ops: [
      { op: "read", key: "bin:bolts", as: "b" },
      { op: "read", key: "bin:nuts", as: "n" },
      { op: "read", key: "bin:washers", as: "w" },
      { op: "commit" },
    ] },
    { name: "T2", role: "Restock bolts", ops: [
      { op: "read", key: "bin:bolts", as: "b" },
      { op: "write", key: "bin:bolts", value: (L) => L.b + 100, label: "write bolts = read + 100" },
      { op: "commit" },
    ] },
  ],
  schedules: [{ name: "Restock during the audit", order: [0, 1, 1, 0, 0, 1, 0] }],
};

const signup = {
  id: "phantom", name: "Handle signup",
  blurb: "Ana and Ben both check that no account uses @river, then insert one. Under two-phase locking the check takes a range lock on the accounts index.",
  initial: { "acct:1001": "@juno", "acct:1002": "@pike" },
  keys: ["acct:1001", "acct:1002"],
  build: () => [["Ana", 1003], ["Ben", 1004]].map(([who, id], i) => ({
    name: "T" + (i + 1), role: `${who} signs up`,
    ops: [
      { op: "scan", prefix: "acct:", where: (v) => v === "@river", as: "m", label: "find accounts with @river" },
      { op: "write", key: "acct:" + id, value: "@river", if: (L) => L.m.length === 0, label: `if none: insert acct:${id}`, skip: "handle taken: signup refused" },
      { op: "commit" },
    ],
  })),
  schedules: [
    { name: "Interleaved", order: [0, 1, 0, 1, 0, 1] },
    { name: "One after the other", order: [0, 0, 0, 1, 1, 1] },
  ],
  invariant: {
    ok: ({ state }) => Object.values(state).filter((v) => v === "@river").length <= 1,
    text: ({ state }, ok) => ok ? "At most one account owns @river." : "Two accounts share @river.",
  },
};

mountLab(document.getElementById("lab-serial"), {
  scenarios: [lifeguards, audit, signup],
  scenarioLabel: "Workload",
  levels: [
    { id: "2pl", label: "Two-phase locking" },
    { id: "ssi", label: "Serializable snapshot isolation" },
  ],
  level: "2pl",
  locks: true,
  graph: true,
  history: false,
});

// ---------------------------------------------------------------------------
// Contention simulation
// ---------------------------------------------------------------------------
{
  const root = document.getElementById("contention");
  const charts = [...root.querySelectorAll(".chart")];
  const verdict = root.querySelector(".verdict");
  const ROWS = [2, 3, 4, 6, 8, 16, 32, 64, 128];
  const cache = new Map();
  const st = { clients: 8, ro: 0.5 };
  const COLORS = { "2pl": "var(--orange)", ssi: "var(--accent)" };

  function results() {
    const key = `${st.clients}|${st.ro}`;
    if (!cache.has(key)) {
      const out = { "2pl": [], ssi: [] };
      for (const level of ["2pl", "ssi"]) for (const rows of ROWS) out[level].push({ rows, ...simulate({ level, rows, clients: st.clients, readOnly: st.ro, ticks: 800, seed: 11 }) });
      cache.set(key, out);
    }
    return cache.get(key);
  }

  const PANELS = [
    { title: "Throughput (commits per 100 ticks)", get: (r) => r.throughput, fmt: (v) => fmt(v, 0) },
    { title: "Mean latency (ticks, retries included)", get: (r) => r.latency, fmt: (v) => fmt(v, 0) },
    { title: "Time lost: blocked (2PL) or aborted (SSI)", get: (r, level) => (level === "2pl" ? r.blockedShare : r.abortRate) * 100, fmt: (v) => Math.round(v) + "%", max: 100 },
  ];

  function draw() {
    const res = results();
    charts.forEach((box, p) => {
      const P = PANELS[p];
      const w = box.clientWidth;
      if (!w) return;
      const H = 170, top = 10, bottom = 26, left = 40, right = 14;
      const x = logScale([2, 128], [left, w - right]);
      const vals = ["2pl", "ssi"].flatMap((l) => res[l].map((r) => P.get(r, l)));
      const ymax = P.max || Math.max(...vals) * 1.1 || 1;
      const y = linear([0, ymax], [H - bottom, top]);
      box.innerHTML = "";
      const svg = el("svg", { viewBox: `0 0 ${w} ${H}`, height: H, role: "img", "aria-label": P.title }, box);
      const grid = el("g", { class: "grid" }, svg);
      for (const t of niceTicks(0, ymax, 4)) {
        el("line", { x1: left, x2: w - right, y1: y(t), y2: y(t) }, grid);
        const tx = el("text", { x: left - 6, y: y(t) + 4, "text-anchor": "end" }, svg); tx.textContent = P.fmt(t);
      }
      for (const t of [2, 4, 8, 16, 32, 64, 128]) {
        const tx = el("text", { x: x(t), y: H - bottom + 16, "text-anchor": "middle" }, svg); tx.textContent = t;
      }
      for (const level of ["2pl", "ssi"]) {
        const pts = res[level].map((r) => [x(r.rows), y(P.get(r, level))]);
        el("path", { d: "M" + pts.map((q) => q.join(",")).join(" L"), style: `fill:none;stroke:${COLORS[level]};stroke-width:2` }, svg);
        for (const q of pts) el("circle", { cx: q[0], cy: q[1], r: 2.5, style: `fill:${COLORS[level]}` }, svg);
      }
    });
    const a = res["2pl"][2], b = res.ssi[2], c = res["2pl"].at(-1), d = res.ssi.at(-1);
    verdict.innerHTML = `With 4 hot rows, two-phase locking clients spend ${Math.round(a.blockedShare * 100)}% of their time waiting for locks and hit ${a.deadlocks} deadlocks, while SSI aborts ${Math.round(b.abortRate * 100)}% of its attempts. Throughput: ${fmt(a.throughput, 0)} against ${fmt(b.throughput, 0)}. Spread over 128 rows, both lose almost nothing (${fmt(c.throughput, 0)} against ${fmt(d.throughput, 0)}).`;
  }

  slider(root.querySelector("#sim-clients"), (v) => `${v}`, (v) => { st.clients = v; draw(); });
  slider(root.querySelector("#sim-ro"), (v) => `${Math.round(v * 100)}%`, (v) => { st.ro = v; draw(); });
  charts.forEach((c, i) => { const t = c.previousElementSibling; if (t) t.textContent = PANELS[i].title; });
  responsive(charts[0], () => draw());
}
