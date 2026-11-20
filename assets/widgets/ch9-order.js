// Chapter 9, lesson 2: a space-time diagram with live Lamport timestamps,
// and total order broadcast to three replicas.
import { el, prefersReducedMotion } from "../charts.js";
import { analyse, relation, totalOrder, clockConditionHolds } from "../engines/ch9-lamport.js";
import { Broadcast } from "../engines/ch9-tob.js";

/* =========================================================
   1. Space-time diagram
   ========================================================= */
{
  const root = document.getElementById("spacetime");
  const svg = root.querySelector("svg");
  const info = root.querySelector('[data-out="info"]');
  const strip = root.querySelector(".st-order");
  const verdict = root.querySelector(".verdict");
  const P = ["A", "B", "C"];
  const X0 = 70, X1 = 624, LY = [44, 116, 188], R = 10, MAXEV = 30;
  const x = (t) => X0 + (t / 100) * (X1 - X0);
  const tOf = (px) => ((px - X0) / (X1 - X0)) * 100;

  let events = [], messages = [], seq = 0, mode = "local", pending = null, focus = null, pinned = null;
  let history = [];

  const EXAMPLE = () => {
    const ev = [
      ["A", 8, "local"], ["A", 22, "send", "m1"], ["B", 40, "recv", "m1"], ["B", 14, "local"],
      ["C", 10, "local"], ["C", 28, "local"], ["C", 46, "local"], ["B", 56, "send", "m2"],
      ["C", 72, "recv", "m2"], ["A", 48, "local"], ["A", 66, "send", "m3"], ["B", 84, "recv", "m3"], ["C", 88, "local"],
    ];
    events = []; messages = []; seq = 0;
    const sends = {};
    for (const [p, t, kind, m] of ev) {
      const e = { id: "e" + ++seq, proc: P.indexOf(p), t, kind };
      events.push(e);
      if (kind === "send") sends[m] = e.id;
      if (kind === "recv") messages.push({ id: m, send: sends[m], recv: e.id });
    }
  };

  const free = (proc, t) => {
    const taken = events.filter((e) => e.proc === proc).map((e) => e.t);
    for (let d = 0; d <= 12; d++) for (const s of [1, -1]) {
      const c = t + d * s;
      if (c >= 2 && c <= 98 && taken.every((u) => Math.abs(u - c) >= 4)) return c;
    }
    return null;
  };

  function snapshot() { history.push(JSON.stringify({ events, messages, seq })); if (history.length > 40) history.shift(); }

  function addLocal(proc, t) {
    const c = free(proc, t);
    if (c === null || events.length >= MAXEV) return;
    snapshot();
    events.push({ id: "e" + ++seq, proc, t: c, kind: "local" });
  }

  function addMessage(from, t1, to, t2) {
    if (events.length + 2 > MAXEV) return;
    const a = free(from, t1);
    if (a === null) return;
    const b = free(to, Math.max(t2, a + 6));
    if (b === null || b <= a) return;
    snapshot();
    const s = { id: "e" + ++seq, proc: from, t: a, kind: "send" };
    const r = { id: "e" + ++seq, proc: to, t: b, kind: "recv" };
    events.push(s, r);
    messages.push({ id: "m" + seq, send: s.id, recv: r.id });
  }

  function toSvg(e) {
    const p = svg.createSVGPoint();
    p.x = e.clientX; p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  }

  let inf = new Map();

  function render() {
    inf = analyse(3, events, messages);
    const order = totalOrder(inf);
    svg.textContent = "";
    LY.forEach((y, p) => {
      const t = el("text", { x: 0, y: y + 4, class: "lbl" }, svg); t.textContent = "Node " + P[p];
      el("line", { x1: X0, x2: X1, y1: y, y2: y, class: "lane-line" }, svg);
      const hit = el("rect", { x: X0, y: y - 32, width: X1 - X0, height: 64, class: "lane-hit" }, svg);
      hit.addEventListener("click", (e) => {
        const t2 = Math.round(Math.max(0, Math.min(100, tOf(toSvg(e).x))));
        if (pinned) { pinned = null; paint(); return; }
        if (mode === "local") addLocal(p, t2);
        else if (!pending || pending.proc === p) pending = { proc: p, t: t2 };
        else { addMessage(pending.proc, pending.t, p, t2); pending = null; }
        render();
      });
    });
    const tl = el("text", { x: X1, y: 228, class: "tiny", "text-anchor": "end" }, svg); tl.textContent = "time on each node →";
    const defs = el("defs", {}, svg);
    const mk = el("marker", { id: "st-arr", viewBox: "0 0 10 10", refX: 10, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0,0 L10,5 L0,10 z", style: "fill:var(--ink-3)" }, mk);
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const m of messages) {
      const a = byId.get(m.send), b = byId.get(m.recv);
      const x1 = x(a.t), y1 = LY[a.proc], x2 = x(b.t), y2 = LY[b.proc];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      el("line", { x1: x1 + ux * R, y1: y1 + uy * R, x2: x2 - ux * (R + 1), y2: y2 - uy * (R + 1), class: "st-msg", "data-send": m.send, "data-recv": m.recv, "marker-end": "url(#st-arr)" }, svg);
    }
    if (pending) el("circle", { cx: x(pending.t), cy: LY[pending.proc], r: R + 3, class: "st-pending" }, svg);
    for (const e of events) {
      const g = el("g", { class: "st-ev", tabindex: 0, role: "button", "data-id": e.id, "aria-label": `Event on node ${P[e.proc]}, ${e.kind}, Lamport timestamp ${inf.get(e.id).lamport}` }, svg);
      el("circle", { cx: x(e.t), cy: LY[e.proc], r: R }, g);
      const t = el("text", { x: x(e.t), y: LY[e.proc] + 3.5, "text-anchor": "middle" }, g);
      t.textContent = inf.get(e.id).lamport;
      g.addEventListener("pointerenter", (ev) => { if (ev.pointerType === "mouse") { focus = e.id; paint(); } });
      g.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse" && focus === e.id) { focus = null; paint(); } });
      g.addEventListener("click", () => { pinned = pinned === e.id ? null : e.id; if (pending) { pending = null; render(); } else paint(); });
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pinned = pinned === e.id ? null : e.id; paint(); } });
    }

    // Lamport total order strip
    strip.innerHTML = order.length
      ? order.map((id, k) => {
          const v = inf.get(id);
          return (k ? '<span class="lt">&lt;</span>' : "") + `<span class="rec" data-id="${id}"><span class="k">${v.lamport}</span><span class="v">${P[v.proc]}</span></span>`;
        }).join("")
      : '<span class="note">No events yet.</span>';

    const ok = clockConditionHolds(inf);
    verdict.className = "verdict " + (ok ? "good" : "bad");
    verdict.textContent = ok
      ? `${events.length} events, ${messages.length} message${messages.length === 1 ? "" : "s"}. Every arrow, and every step along a line, goes from a smaller timestamp to a larger one. So sorting by (timestamp, node) gives one total order that never puts an effect before its cause.`
      : "The clock condition is violated.";

    root.querySelectorAll("[data-mode]").forEach((btn) => btn.setAttribute("aria-pressed", btn.dataset.mode === mode));
    root.querySelector('[data-act="undo"]').disabled = !history.length;
    paint();
  }

  // Highlights only: no rebuilding, so hovering stays cheap and stable.
  function paint() {
    let sel = pinned || focus;
    if (sel && !inf.has(sel)) sel = null;
    const rel = (id) => (!sel ? "" : id === sel ? "self" : { before: "before", after: "after", concurrent: "conc" }[relation(inf, id, sel)]);
    svg.classList.toggle("st-dim", !!sel);
    svg.querySelectorAll(".st-ev").forEach((g) => g.setAttribute("class", "st-ev " + rel(g.dataset.id)));
    svg.querySelectorAll(".st-msg").forEach((l) => {
      const a = rel(l.dataset.send), b = rel(l.dataset.recv);
      const hot = sel && ((["before", "self"].includes(a) && ["before", "self"].includes(b)) || (["after", "self"].includes(a) && b === "after"));
      l.setAttribute("class", "st-msg" + (hot ? " hot" : ""));
    });
    strip.querySelectorAll(".rec").forEach((r) => r.setAttribute("class", "rec " + rel(r.dataset.id)));

    if (pending) info.textContent = `Sending from node ${P[pending.proc]} at the dashed circle. Now click another node's line, further right, where the message arrives.`;
    else if (sel) {
      const me = inf.get(sel);
      const all = events.filter((e) => e.id !== sel);
      const b = all.filter((e) => relation(inf, e.id, sel) === "before").length;
      const a = all.filter((e) => relation(inf, e.id, sel) === "after").length;
      const conc = all.filter((e) => relation(inf, e.id, sel) === "concurrent");
      const lower = conc.filter((e) => inf.get(e.id).lamport < me.lamport).sort((p, q) => inf.get(p.id).lamport - inf.get(q.id).lamport)[0];
      let txt = `This event on node ${P[me.proc]} has Lamport timestamp ${me.lamport}. ${b} event${b === 1 ? "" : "s"} happened before it (blue), ${a} happened after it (green), and ${conc.length} ${conc.length === 1 ? "is" : "are"} concurrent with it (dashed).`;
      if (lower) txt += ` Look at the event on node ${P[inf.get(lower.id).proc]} with timestamp ${inf.get(lower.id).lamport}: its number is smaller, yet it did not happen before this one. A lower Lamport timestamp does not prove causality.`;
      info.textContent = txt;
    } else info.textContent = "Hover over an event, or tap it, to see which events could have influenced it and which it could have influenced.";
  }

  strip.addEventListener("pointerover", (e) => { const r = e.target.closest(".rec"); if (r && e.pointerType === "mouse" && focus !== r.dataset.id) { focus = r.dataset.id; paint(); } });
  strip.addEventListener("pointerleave", () => { if (focus) { focus = null; paint(); } });
  strip.addEventListener("click", (e) => { const r = e.target.closest(".rec"); if (r) { pinned = pinned === r.dataset.id ? null : r.dataset.id; paint(); } });

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.mode) { mode = b.dataset.mode; pending = null; }
    if (b.dataset.act === "example") { snapshot(); EXAMPLE(); pinned = null; pending = null; }
    if (b.dataset.act === "clear") { snapshot(); events = []; messages = []; pinned = null; pending = null; }
    if (b.dataset.act === "undo" && history.length) { ({ events, messages, seq } = JSON.parse(history.pop())); pinned = null; pending = null; }
    render();
  });

  EXAMPLE();
  render();
}

/* =========================================================
   2. Total order broadcast
   ========================================================= */
{
  const root = document.getElementById("tob");
  const svg = root.querySelector("svg");
  const cols = root.querySelector(".tob-cols");
  const verdict = root.querySelector(".verdict");
  const SEQX = 18, SEQW = 132, SEQY = 74, SEQH = 52;
  const RX = 488, RW = 134, RH = 40, RY = [14, 80, 146];
  const UNIT_MS = 650;

  let b, raf = null, last = 0, paused = false, seed = 7, entered = new Set();

  svg.textContent = "";
  const seqG = el("g", { class: "dg-node active" }, svg);
  el("rect", { x: SEQX, y: SEQY, width: SEQW, height: SEQH, rx: 8 }, seqG);
  el("text", { x: SEQX + 12, y: SEQY + 22 }, seqG).textContent = "Sequencer";
  el("text", { x: SEQX + 12, y: SEQY + 39, class: "sub" }, seqG).textContent = "stamps #1, #2, #3 ...";
  const lines = RY.map((y) => el("line", { x1: SEQX + SEQW, y1: SEQY + SEQH / 2, x2: RX, y2: y + RH / 2, class: "dg-edge" }, svg));
  const reps = RY.map((y, i) => {
    const g = el("g", { class: "dg-node" }, svg);
    el("rect", { x: RX, y, width: RW, height: RH, rx: 8 }, g);
    el("text", { x: RX + 12, y: y + 17 }, g).textContent = "Replica " + (i + 1);
    const sub = el("text", { x: RX + 12, y: y + 32, class: "sub" }, g);
    return { g, sub };
  });
  const pills = el("g", {}, svg);

  function reset() {
    b = new Broadcast({ seed: seed++, ordered: root.querySelector('[data-act="order"]').getAttribute("aria-pressed") === "true" });
    entered = new Set();
    render();
  }

  function pos(f) {
    const p = Math.max(0, Math.min(1, (b.now - f.sentAt) / (f.arriveAt - f.sentAt)));
    const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    const x1 = SEQX + SEQW, y1 = SEQY + SEQH / 2, x2 = RX, y2 = RY[f.replica] + RH / 2;
    return [x1 + (x2 - x1) * e, y1 + (y2 - y1) * e];
  }

  function render() {
    pills.textContent = "";
    if (!prefersReducedMotion()) {
      for (const f of b.inflight) {
        const [px, py] = pos(f);
        const g = el("g", { class: "tob-pill", transform: `translate(${px - 30},${py - 9})` }, pills);
        el("rect", { width: 60, height: 18, rx: 9 }, g);
        el("text", { x: 30, y: 12.5, "text-anchor": "middle" }, g).textContent = `#${f.msg.seq} ${f.msg.sender}`;
      }
    }
    lines.forEach((l, i) => l.setAttribute("class", "dg-edge" + (b.inflight.some((f) => f.replica === i) ? " active" : "")));
    reps.forEach((r, i) => {
      const n = b.inflight.filter((f) => f.replica === i).length;
      r.sub.textContent = n ? `${n} on the way` : "idle";
    });
    const sig = JSON.stringify(b.replicas.map((r) => [r.held.map((m) => m.seq), r.delivered.length])) + b.ordered;
    if (sig !== cols.dataset.sig) {
      cols.dataset.sig = sig;
      cols.innerHTML = b.replicas.map((r, i) => {
        const chip = (m, cls) => {
          const key = `${i}:${m.seq}:${cls}`;
          const isNew = !entered.has(key);
          entered.add(key);
          return `<span class="rec ${cls}${isNew ? " enter" : ""}"><span class="k">#${m.seq}</span><span class="v">${m.sender} ${m.seat}${cls.startsWith("d") ? (m.granted ? " ok" : " taken") : ""}</span></span>`;
        };
        const seats = Object.entries(r.seats).map(([s, h]) => `${s}: <b>${h}</b>`).join(", ") || "none yet";
        return `<div class="tob-col"><h4>Replica ${i + 1}</h4>
          ${b.ordered ? `<p class="lane-label"><span>Held back, waiting for #${r.next}</span></p><div class="lane">${r.held.map((m) => chip(m, "warn")).join("")}</div>` : ""}
          <p class="lane-label"><span>Delivered, in this order</span></p><div class="lane">${r.delivered.map((m) => chip(m, "d" + (m.granted ? "" : " rej"))).join("")}</div>
          <p class="tob-seat">Seats: ${seats}</p></div>`;
      }).join("");
      const done = !b.inflight.length && b.seq > 0;
      const dis = b.disagreements();
      if (!b.seq) { verdict.className = "verdict"; verdict.textContent = "Send some claims. Two people want seat 12A; whoever is delivered first gets it."; }
      else if (!done) { verdict.className = "verdict"; verdict.textContent = "Messages are still in flight. Copies of the same message reach the replicas at different times."; }
      else if (dis.length) {
        const s = dis[0];
        verdict.className = "verdict bad";
        verdict.textContent = `The replicas disagree about seat ${s}: ` + b.replicas.map((r, i) => `replica ${i + 1} gave it to ${r.seats[s]}`).join(", ") + ". Each one applied the claims in the order they happened to arrive.";
      } else if (b.logsAgree()) {
        verdict.className = "verdict good";
        verdict.textContent = "Every replica delivered the same messages in the same order, so every replica made the same decisions" + (b.ordered ? ", even though the copies arrived in different orders." : ". This time the arrival order happened to match; try again.");
      } else { verdict.className = "verdict"; verdict.textContent = "The delivery orders differ between replicas, although the seat outcomes happen to match this time."; }
    }
    root.querySelector('[data-act="pause"]').textContent = paused ? "Play" : "Pause";
    root.querySelector('[data-act="step"]').disabled = !paused || !b.inflight.length;
  }

  function loop(now) {
    const dt = Math.min(100, now - last);
    last = now;
    if (!paused && b.inflight.length) b.advanceTo(b.now + dt / UNIT_MS);
    render();
    raf = b.inflight.length && !paused ? requestAnimationFrame(loop) : null;
  }
  function kick() { if (!raf && !paused) { last = performance.now(); raf = requestAnimationFrame(loop); } }

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const a = btn.dataset.act;
    if (a === "ann") b.broadcast("Ann", "12A");
    if (a === "ben") b.broadcast("Ben", "12A");
    if (a === "both") { b.broadcast("Ann", "12A"); b.broadcast("Ben", "12A"); }
    if (a === "cy") b.broadcast("Cy", "14C");
    if (a === "order") { btn.setAttribute("aria-pressed", btn.getAttribute("aria-pressed") !== "true"); reset(); }
    if (a === "reset") reset();
    if (a === "pause") { paused = !paused; }
    if (a === "step" && b.inflight.length) b.advanceTo(b.nextArrival());
    render();
    kick();
  });

  reset();
}
