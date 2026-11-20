// Chapter 7: the anomaly lab. Transactions as side-by-side columns, a stepper
// that runs them one operation at a time in a chosen interleaving, the stored
// rows (with versions), optional lock table and graph, and a serializability verdict.
import { el, prefersReducedMotion } from "../charts.js";
import { TxnDB, Driver, LEVELS, SETUP_TXID, serialCheck, defaultLabel } from "../engines/ch7-txn.js";

const h = (tag, attrs = {}, html) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function mountLab(fig, cfg) {
  const mount = fig.querySelector(".lab-mount") || fig;
  fig.classList.add("lab");
  const st = {
    sc: cfg.scenarios[0],
    level: cfg.level || cfg.levels[0].id,
    fixes: new Set(),
    sched: 0,
    db: null, drv: null, timer: null,
    seenVid: new Set(), seenLog: 0, lastEvs: [], lastTx: -1, lastPc: -1,
  };

  // ---------- controls ----------
  const groups = h("div");
  mount.appendChild(groups);
  const group = (label) => { const g = h("div", { class: "lab-group" }); if (label) g.appendChild(h("span", { class: "lab-label" }, label)); groups.appendChild(g); return g; };
  const pressBtns = (g, items, isOn, onPick) => items.map((it) => {
    const b = h("button", { class: "btn", type: "button" }, esc(it.label));
    b.addEventListener("click", () => { onPick(it); });
    g.appendChild(b);
    return { b, it, sync: () => b.setAttribute("aria-pressed", String(isOn(it))) };
  });
  const syncers = [];

  if (cfg.scenarios.length > 1) {
    const g = group(cfg.scenarioLabel || "Scenario");
    syncers.push(...pressBtns(g, cfg.scenarios.map((s) => ({ label: s.name, s })), (it) => it.s === st.sc, (it) => { st.sc = it.s; st.sched = 0; reset(); }));
  }
  if (cfg.levels.length > 1) {
    const g = group("Isolation");
    syncers.push(...pressBtns(g, cfg.levels, (it) => it.id === st.level, (it) => { st.level = it.id; reset(); }));
  }
  const fixBoxes = [];
  if (cfg.fixes && cfg.fixes.length) {
    const g = group("Fixes");
    for (const f of cfg.fixes) {
      const lab = h("label", { class: "btn check" });
      const cb = h("input", { type: "checkbox" });
      lab.appendChild(cb); lab.appendChild(h("span", {}, esc(f.label)));
      cb.addEventListener("change", () => { if (cb.checked) st.fixes.add(f.id); else st.fixes.delete(f.id); reset(); });
      g.appendChild(lab);
      fixBoxes.push({ f, cb, lab });
    }
  }
  const schedGroup = group("Interleaving");
  const blurb = h("p", { class: "lab-blurb" });
  groups.appendChild(blurb);

  const runRow = h("div", { class: "btn-row" });
  const bStep = h("button", { class: "btn primary", type: "button" }, "Step");
  const bRun = h("button", { class: "btn", type: "button" }, "Run to the end");
  const bReset = h("button", { class: "btn", type: "button" }, "Reset");
  runRow.append(bStep, bRun, bReset);
  mount.appendChild(runRow);

  const grid = h("div", { class: "tx-grid" });
  mount.appendChild(grid);

  const storeH = h("p", { class: "lab-h" });
  const store = h("div", { class: "kv" });
  mount.append(storeH, store);

  let locksBox = null, graphBox = null, graphH = null;
  if (cfg.locks || cfg.graph) {
    const pair = h("div", { class: "lab-pair" });
    if (cfg.locks) { const d = h("div"); d.appendChild(h("p", { class: "lab-h" }, "Lock table")); locksBox = h("div", { class: "table-wrap", style: "margin:0" }); d.appendChild(locksBox); pair.appendChild(d); }
    if (cfg.graph) { const d = h("div", { class: "graph" }); graphH = h("p", { class: "lab-h" }); d.appendChild(graphH); graphBox = h("div"); d.appendChild(graphBox); pair.appendChild(d); }
    mount.appendChild(pair);
  }

  mount.appendChild(h("p", { class: "lab-h" }, "What happened"));
  const log = h("ol", { class: "steps", "aria-live": "polite" });
  mount.appendChild(log);
  const verdict = h("div", { class: "verdict", "aria-live": "polite" });
  mount.appendChild(verdict);

  // ---------- lifecycle ----------
  function programs() { return st.sc.build(st.fixes, st.level); }

  function reset() {
    stop();
    const db = new TxnDB({ initial: st.sc.initial, level: st.level });
    for (const p of programs()) db.addTxn(p.name, p.ops, p.role);
    st.db = db;
    st.drv = new Driver(db, st.sc.schedules[st.sched].order);
    st.seenVid = new Set();
    for (const vs of db.versions.values()) for (const v of vs) st.seenVid.add(v.id);
    st.seenLog = 0; st.lastEvs = []; st.lastTx = -1;
    log.innerHTML = "";
    buildSchedules();
    render();
  }

  function buildSchedules() {
    schedGroup.querySelectorAll("button").forEach((b) => b.remove());
    st.sc.schedules.forEach((s, k) => {
      const b = h("button", { class: "btn", type: "button", "aria-pressed": String(k === st.sched) }, esc(s.name));
      b.addEventListener("click", () => { st.sched = k; reset(); });
      schedGroup.appendChild(b);
    });
    for (const x of fixBoxes) {
      const applies = !st.sc.fixes || st.sc.fixes.includes(x.f.id);
      x.cb.disabled = !applies;
      x.lab.title = applies ? "" : "Does not apply to this scenario";
      if (!applies && x.cb.checked) { x.cb.checked = false; st.fixes.delete(x.f.id); }
    }
    blurb.textContent = st.sc.blurb || "";
    blurb.hidden = !st.sc.blurb;
    syncers.forEach((s) => s.sync());
  }

  function record(r) {
    if (!r) return;
    st.lastEvs = r.evs || [];
    st.lastTx = r.tx;
  }
  function stepOnce() {
    if (st.db.finished()) return false;
    const r = st.drv.next();
    record(r);
    return !!r;
  }
  function stepTx(i) {
    stop();
    if (!st.db.runnable(i)) return;
    const refocus = grid.contains(document.activeElement);
    st.drv.take(i);
    record({ tx: i, evs: st.db.step(i) });
    render();
    if (refocus) { const b = grid.querySelectorAll(".tx-col .btn")[i]; if (b && !b.disabled) b.focus(); else bStep.focus(); }
  }
  function stop() { if (st.timer) { clearTimeout(st.timer); st.timer = null; bRun.textContent = "Run to the end"; } }
  function runAll() {
    if (st.timer || prefersReducedMotion()) { stop(); while (stepOnce()); render(); return; }
    bRun.textContent = "Finish now";
    const tick = () => {
      if (!stepOnce()) { stop(); render(); return; }
      render();
      if (st.db.finished()) { stop(); return; }
      st.timer = setTimeout(tick, 520);
    };
    tick();
  }
  bStep.addEventListener("click", () => { stop(); stepOnce(); render(); });
  bRun.addEventListener("click", runAll);
  bReset.addEventListener("click", reset);

  // ---------- rendering ----------
  const statusText = { idle: "not started", active: "running", waiting: "blocked", committed: "committed", aborted: "aborted" };

  function render() {
    const db = st.db;
    // columns
    grid.style.setProperty("--n", db.txns.length);
    grid.innerHTML = "";
    db.txns.forEach((t, i) => {
      const col = h("div", { class: "tx-col", "data-status": t.status });
      const head = h("div", { class: "tx-head" });
      head.appendChild(h("span", { class: "tx-name" }, esc(t.name)));
      if (t.role) head.appendChild(h("span", { class: "tx-role" }, esc(t.role)));
      col.appendChild(head);
      col.appendChild(h("div", { class: "tx-meta" }, `${t.txid !== null ? `txid ${t.txid} · ` : ""}<b>${statusText[t.status]}</b>`));
      const ol = h("ol", { class: "tx-ops" });
      t.ops.forEach((op, k) => {
        const res = t.results[k];
        let cls = "pending", text = op.label || defaultLabel(op);
        if (res) { cls = res.state; text = res.text; }
        if (k === t.pc && !res && (t.status === "idle" || t.status === "active")) cls = "next";
        if (!res && (t.status === "aborted" || t.status === "committed")) cls = "dead";
        if (res && res.state === "done" && i === st.lastTx && k === t.pc - 1) cls += " last";
        ol.appendChild(h("li", { class: cls }, esc(text)));
      });
      col.appendChild(ol);
      const nb = h("button", { class: "btn", type: "button", "aria-label": `Run the next step of ${t.name}` }, t.status === "waiting" ? "Blocked" : `Next in ${esc(t.name)}`);
      nb.disabled = !db.runnable(i);
      nb.addEventListener("click", () => stepTx(i));
      col.appendChild(nb);
      grid.appendChild(col);
    });

    renderStore();
    if (locksBox) renderLocks();
    if (graphBox) renderGraph();
    renderLog();
    renderVerdict();
    bStep.disabled = db.finished();
    bRun.disabled = db.finished() && !st.timer;
  }

  function history() { return cfg.history === true || (cfg.history !== false && LEVELS[st.level].mvcc); }

  function renderStore() {
    const db = st.db, hist = history();
    storeH.innerHTML = hist ? "Stored rows <span>every version, newest last</span>" : "Stored rows <span>committed value, plus any uncommitted write</span>";
    store.innerHTML = "";
    const order = st.sc.keys || [];
    const keys = [...order.filter((k) => db.versions.has(k)), ...[...db.versions.keys()].filter((k) => !order.includes(k)).sort()];
    const live = db.txns.filter((t) => db.live(t));
    const mode = LEVELS[st.level].read;
    for (const k of keys) {
      const vs = db.versions.get(k);
      let shown = vs;
      if (!hist) {
        let lastC = -1;
        vs.forEach((v, j) => { if (!v.aborted && db.committedSeq(v.by) !== null) lastC = j; });
        shown = vs.filter((v, j) => j >= lastC);
      }
      const seen = new Map();
      for (const t of live) { const v = db.visible(t, k, mode); if (v) { if (!seen.has(v.id)) seen.set(v.id, []); seen.get(v.id).push(t.name); } }
      store.appendChild(h("span", { class: "kv-key" }, esc(k)));
      const box = h("div", { class: "kv-vers" });
      const lastCommitted = [...vs].reverse().find((v) => !v.aborted && db.committedSeq(v.by) !== null);
      for (const v of shown) {
        const committed = db.committedSeq(v.by) !== null;
        const cls = ["ver"];
        if (v.aborted) cls.push("aborted"); else if (!committed) cls.push("uncommitted"); else if (v !== lastCommitted) cls.push("old");
        if (!st.seenVid.has(v.id)) { cls.push("enter"); st.seenVid.add(v.id); }
        const by = v.by === SETUP_TXID ? "setup" : (db.tx(v.by)?.name || v.by);
        let meta;
        if (hist) meta = `created_by ${v.by}${v.xmax ? ` · deleted_by ${v.xmax}` : ""}${v.aborted ? " · aborted" : ""}`;
        else meta = v.aborted ? `${by}, rolled back` : committed ? "committed" : `${by}, uncommitted`;
        const chip = h("span", { class: cls.join(" "), title: hist ? `Written by ${by}` : "" });
        chip.appendChild(h("span", { class: "val" }, esc(v.value === null ? "deleted" : v.value)));
        chip.appendChild(h("span", { class: "meta" }, esc(meta)));
        for (const n of seen.get(v.id) || []) chip.appendChild(h("span", { class: "seen", title: `${n} reads this version` }, `${esc(n)} sees`));
        box.appendChild(chip);
      }
      store.appendChild(box);
    }
  }

  function renderLocks() {
    const db = st.db;
    const rows = db.lockTable();
    const name = (i) => db.txns[i].name;
    let html = '<table class="locks"><tr><th>Locked</th><th>Mode</th><th>Held by</th><th>Waiting</th></tr>';
    if (!rows.length) html += '<tr class="none"><td colspan="4">No locks held</td></tr>';
    for (const r of rows) html += `<tr><td class="mono">${esc(r.res)}</td><td>${r.mode}</td><td>${r.holders.map(name).join(", ")}</td><td class="w">${r.waiters.map(name).join(", ")}</td></tr>`;
    locksBox.innerHTML = html + "</table>";
  }

  function renderGraph() {
    const db = st.db;
    const ssi = LEVELS[st.level].ssi;
    graphH.textContent = ssi ? "Read-write conflicts (an arrow means: read a value the other transaction then overwrote)" : "Wait-for graph (an arrow means: waits for)";
    const n = db.txns.length, W = 320, H = 132;
    const pos = db.txns.map((_, i) => n === 3 ? [[60, 96], [160, 30], [260, 96]][i] : [[70, 66], [250, 66]][i] || [70 + i * 90, 66]);
    graphBox.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": graphH.textContent }, graphBox);
    const defs = el("defs", {}, svg);
    const marker = (id, color) => { const m = el("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs); el("path", { d: "M0,0 L10,5 L0,10 z", style: `fill:${color}` }, m); };
    const uid = fig.id || "lab";
    marker(`${uid}-a-o`, "var(--orange)"); marker(`${uid}-a-r`, "var(--red)"); marker(`${uid}-a-p`, "var(--purple)");
    let edges = [];
    const dl = st.lastEvs.find((e) => e.kind === "deadlock");
    const sa = st.lastEvs.find((e) => e.ssi);
    if (ssi) {
      edges = db.rwEdges().map((e) => ({ ...e, color: "purple", label: e.key.slice(e.key.lastIndexOf(":") + 1) }));
      if (sa) {
        const c = sa.ssi;
        edges.push({ from: c.from, to: c.pivot, color: "red", label: c.keys[0].slice(c.keys[0].lastIndexOf(":") + 1) });
        edges.push({ from: c.pivot, to: c.to, color: "red", label: c.keys[1].slice(c.keys[1].lastIndexOf(":") + 1) });
      }
    } else {
      edges = db.waitEdges().map((e) => ({ ...e, color: "orange", label: "" }));
      if (dl) dl.cycle.forEach((c, j) => edges.push({ from: c, to: dl.cycle[(j + 1) % dl.cycle.length], color: "red", label: j === 0 ? "deadlock" : "" }));
    }
    // de-duplicate by from/to, red wins
    const key = (e) => e.from + ">" + e.to;
    const best = new Map();
    for (const e of edges) if (!best.has(key(e)) || e.color === "red") best.set(key(e), e);
    edges = [...best.values()];
    const R = 19;
    for (const e of edges) {
      const [x1, y1] = pos[e.from], [x2, y2] = pos[e.to];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len, bend = 22;
      const mx = (x1 + x2) / 2 + nx * bend, my = (y1 + y2) / 2 + ny * bend;
      const a = Math.atan2(my - y1, mx - x1), b = Math.atan2(y2 - my, x2 - mx);
      const sx = x1 + Math.cos(a) * R, sy = y1 + Math.sin(a) * R, ex = x2 - Math.cos(b) * (R + 2), ey = y2 - Math.sin(b) * (R + 2);
      const color = `var(--${e.color})`;
      el("path", { d: `M${sx},${sy} Q${mx},${my} ${ex},${ey}`, class: "gedge", style: `stroke:${color}`, "marker-end": `url(#${uid}-a-${e.color[0]})` }, svg);
      if (e.label) { const t = el("text", { x: (sx + 2 * mx + ex) / 4 + nx * 10, y: (sy + 2 * my + ey) / 4 + ny * 10 + 3, class: "glabel", style: `fill:${color}` }, svg); t.textContent = e.label; }
    }
    db.txns.forEach((t, i) => {
      const g = el("g", { class: `gnode ${t.status}` }, svg);
      el("circle", { cx: pos[i][0], cy: pos[i][1], r: R }, g);
      const tx = el("text", { x: pos[i][0], y: pos[i][1] }, g); tx.textContent = t.name;
    });
    if (!edges.length) { const t = el("text", { x: W / 2, y: H - 4, class: "gempty", "text-anchor": "middle" }, svg); t.textContent = ssi ? "no conflicts yet" : "nobody is waiting"; }
  }

  function renderLog() {
    const evs = st.db.events;
    log.querySelectorAll("li.current").forEach((li) => li.classList.remove("current"));
    for (let k = st.seenLog; k < evs.length; k++) {
      const e = evs[k];
      const cls = ["enter", "current"];
      if (e.kind === "abort" && e.why !== undefined) cls.push("bad");
      if (e.kind === "deadlock") cls.push("bad");
      if (e.kind === "wait") cls.push("warn");
      log.appendChild(h("li", { class: cls.join(" ") }, esc(e.text)));
    }
    st.seenLog = evs.length;
    log.scrollTop = log.scrollHeight;
    if (evs.length) log.querySelector("li.hint")?.remove();
    else if (!log.children.length) log.appendChild(h("li", { class: "hint" }, "Press Step to follow the interleaving above, or use a transaction's own button to choose the order yourself."));
  }

  function renderVerdict() {
    const db = st.db;
    verdict.className = "verdict";
    if (!db.finished()) {
      const w = db.txns.filter((t) => t.status === "waiting");
      verdict.innerHTML = w.length ? `${w.map((t) => esc(t.name)).join(" and ")} cannot continue until the lock holder commits or aborts. Step the other transaction.` : "";
      return;
    }
    const sc = serialCheck(st.sc.initial, db);
    const ctx = { state: db.state(), tx: Object.fromEntries(db.txns.map((t) => [t.name, t])), db };
    const parts = [];
    if (sc.ok) parts.push(sc.order.length === 0 ? "<strong>Serializable</strong>: nothing committed." : sc.order.length === 1 ? `<strong>Serializable</strong>: the same outcome as running ${sc.order[0]} alone.` : `<strong>Serializable</strong>: the same outcome as running ${sc.order.join(", then ")}, one at a time.`);
    else parts.push("<strong>Not serializable</strong>: no serial order of the committed transactions produces these reads and this final state.");
    let inv = null;
    if (st.sc.invariant) { inv = st.sc.invariant.ok(ctx); parts.push(esc(st.sc.invariant.text(ctx, inv))); }
    const killed = db.txns.filter((t) => t.status === "aborted" && t.kind !== "app");
    if (killed.length) parts.push(`The database aborted ${killed.map((t) => esc(t.name)).join(" and ")}; the application should retry ${killed.length > 1 ? "them" : "it"}.`);
    verdict.classList.add(sc.ok && inv !== false ? "good" : "bad");
    verdict.innerHTML = parts.join(" ");
  }

  reset();
  return { reset };
}
