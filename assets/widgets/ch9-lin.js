// Chapter 9, lesson 1: a linearizability checker you can draw on, and a CAP demo.
import { el, prefersReducedMotion } from "../charts.js";
import { check, pointsFor, PRESETS } from "../engines/ch9-lin.js";

/* =========================================================
   1. Linearizability checker
   ========================================================= */
{
  const root = document.getElementById("lin-check");
  const svg = root.querySelector("svg");
  const verdict = root.querySelector(".verdict");
  const orderOut = root.querySelector(".lin-order");
  const editor = root.querySelector(".lin-editor");
  const NAMES = ["A", "B", "C"];
  const W = 640, X0 = 84, X1 = 626, LY = [50, 116, 182], BAR = 28, MINW = 6, MAXOPS = 12;
  const x = (t) => X0 + (t / 100) * (X1 - X0);
  const tOf = (px) => ((px - X0) / (X1 - X0)) * 100;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  let ops = [];
  let nextId = 1;
  let sel = null;
  let mode = "w";
  let drag = null;
  let keepFocus = false;

  const byId = (id) => ops.find((o) => o.id === id);
  const label = (o) => `${NAMES[o.client]} ${o.type === "w" ? "writes" : "reads"} ${o.value}`;

  function load(preset) {
    ops = (PRESETS[preset] || []).map((o) => ({ ...o, id: nextId++ }));
    sel = null;
    render();
  }

  // Free interval around time t on a client's line, excluding one operation.
  function gapAround(client, t, exclude) {
    let lo = 0, hi = 100;
    for (const o of ops) {
      if (o.client !== client || o.id === exclude) continue;
      if (t >= o.start && t <= o.end) return null;
      if (o.end < t) lo = Math.max(lo, o.end + 1);
      if (o.start > t) hi = Math.min(hi, o.start - 1);
    }
    return [lo, hi];
  }

  function addAt(client, t) {
    if (ops.length >= MAXOPS) { say(`The checker holds up to ${MAXOPS} operations. Delete one first.`, "bad"); return; }
    const gap = gapAround(client, t, null);
    if (!gap || gap[1] - gap[0] < MINW) return;
    let start = clamp(t - 8, gap[0], gap[1]);
    let end = Math.min(gap[1], start + 16);
    start = Math.max(gap[0], end - 16);
    const writes = ops.filter((o) => o.type === "w");
    let value;
    if (mode === "w") value = writes.length ? (Math.max(...writes.map((o) => o.value)) % 5) + 1 : 1;
    else {
      const before = writes.filter((o) => o.start <= t).sort((a, b) => b.start - a.start)[0];
      value = before ? before.value : 0;
    }
    const op = { id: nextId++, client, type: mode, value, start, end };
    ops.push(op);
    sel = op.id;
    render();
  }

  function render() {
    svg.textContent = "";
    // lanes
    LY.forEach((y, c) => {
      const t = el("text", { x: 0, y: y + 4, class: "lbl" }, svg); t.textContent = "Client " + NAMES[c];
      el("line", { x1: X0, x2: X1, y1: y, y2: y, class: "lane-line" }, svg);
      const hit = el("rect", { x: X0, y: y - 30, width: X1 - X0, height: 60, class: "lane-hit", "data-client": c }, svg);
      hit.addEventListener("click", (e) => {
        if (drag) return;
        addAt(c, Math.round(clamp(tOf(toSvg(e).x), 0, 100)));
      });
    });
    // axis
    const ay = 226;
    el("line", { x1: X0, x2: X1, y1: ay, y2: ay, class: "axis" }, svg);
    for (let t = 0; t <= 100; t += 20) {
      el("line", { x1: x(t), x2: x(t), y1: ay, y2: ay + 4, class: "axis" }, svg);
    }
    const tl = el("text", { x: X1, y: ay + 16, class: "tiny", "text-anchor": "end" }, svg); tl.textContent = "real time →";
    const t0 = el("text", { x: 0, y: ay + 4, class: "tiny" }, svg); t0.textContent = "register starts at 0";

    const res = check(ops);
    const blocked = new Set(res.ok ? [] : res.stuck.blocked.map((i) => ops[i].id));

    // operations
    for (const o of ops) {
      const y = LY[o.client];
      const cls = ["op", o.type, o.id === sel ? "sel" : "", blocked.has(o.id) ? "blocked" : ""].join(" ");
      const g = el("g", { class: cls, "data-id": o.id, tabindex: 0, role: "button", "aria-label": `${label(o)}, from ${o.start} to ${o.end}` }, svg);
      el("rect", { class: "bar", x: x(o.start), y: y - BAR / 2, width: Math.max(4, x(o.end) - x(o.start)), height: BAR, rx: 5 }, g);
      el("rect", { class: "grip", x: x(o.start) + 2, y: y - 6, width: 2, height: 12, rx: 1 }, g);
      el("rect", { class: "grip", x: x(o.end) - 4, y: y - 6, width: 2, height: 12, rx: 1 }, g);
      const tx = el("text", { x: (x(o.start) + x(o.end)) / 2, y: y + 4, "text-anchor": "middle" }, g);
      tx.textContent = o.type === "w" ? `write ${o.value}` : `read ${o.value}`;
    }

    // linearization points (or the furthest partial order when there is none)
    const order = res.ok ? res.order : res.stuck.placed;
    if (order.length) {
      const pts = res.ok ? res.points : pointsFor(ops, order);
      const coords = order.map((i) => [x(pts[i]), LY[ops[i].client]]);
      el("path", { class: "lin-path", d: "M" + coords.map((p) => p.join(",")).join(" L"), opacity: res.ok ? 0.65 : 0.3 }, svg);
      coords.forEach(([px, py], k) => {
        el("circle", { cx: px, cy: py, r: 4.5, class: "lin-point", opacity: res.ok ? 1 : 0.35 }, svg);
        const n = el("text", { x: px, y: py - BAR / 2 - 5, "text-anchor": "middle", class: "lin-num", opacity: res.ok ? 1 : 0.5 }, svg);
        n.textContent = k + 1;
      });
    }

    // verdict
    if (!ops.length) {
      say("The timeline is empty. Click on a client's line to add an operation.");
      orderOut.textContent = "";
    } else if (res.ok) {
      say("<strong>Linearizable.</strong> Each dot is a moment inside an operation where it could have taken effect. Follow the numbers: the register behaves like a single copy that changes at those instants.", "good");
      orderOut.textContent = res.order.map((i, k) => `${k + 1}. ${label(ops[i])}`).join("   ");
    } else {
      const s = res.stuck;
      const reads = s.blocked.map((i) => `${NAMES[ops[i].client]} read ${ops[i].value}`).join(", ");
      const so = s.placed.length
        ? `The furthest any order gets is ${s.placed.length} operation${s.placed.length > 1 ? "s" : ""} (faint numbers), after which the register holds ${s.value}.`
        : `No operation can go first while the register holds its initial ${s.value}.`;
      say(`<strong>Not linearizable.</strong> The checker tried every order that respects real time. ${so} Every operation allowed next is a read that returned something else: ${reads}.`, "bad");
      orderOut.textContent = "";
    }

    renderEditor();
    if (keepFocus && sel) svg.querySelector(`.op[data-id="${sel}"]`)?.focus();
    keepFocus = false;
  }

  function renderEditor() {
    const o = byId(sel);
    editor.hidden = !o;
    if (!o) return;
    editor.querySelector('[data-out="who"]').textContent = `Client ${NAMES[o.client]}, ${o.start} to ${o.end}:`;
    editor.querySelectorAll("[data-type]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.type === o.type));
    editor.querySelector(".val").textContent = o.value;
    editor.querySelector('[data-out="vlabel"]').textContent = o.type === "w" ? "stores" : "returned";
  }

  function say(html, cls = "") { verdict.className = "verdict " + cls; verdict.innerHTML = html; }

  function toSvg(e) {
    const p = svg.createSVGPoint();
    p.x = e.clientX; p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  }

  svg.addEventListener("pointerdown", (e) => {
    const g = e.target.closest(".op");
    if (!g) return;
    const o = byId(+g.dataset.id);
    const pt = toSvg(e);
    const zone = pt.x - x(o.start) < 9 ? "start" : x(o.end) - pt.x < 9 ? "end" : "move";
    drag = { id: o.id, zone, t0: tOf(pt.x), s0: o.start, e0: o.end, cx: e.clientX, moved: false };
    sel = o.id;
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    render();
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const o = byId(drag.id);
    if (Math.abs(e.clientX - drag.cx) > 3) drag.moved = true;
    if (!drag.moved) return;
    const dt = Math.round(tOf(toSvg(e).x) - drag.t0);
    const gap = gapAround(o.client, (drag.s0 + drag.e0) / 2, o.id) || [0, 100];
    const w = drag.e0 - drag.s0;
    if (drag.zone === "move") {
      o.start = clamp(drag.s0 + dt, gap[0], gap[1] - w);
      o.end = o.start + w;
    } else if (drag.zone === "start") {
      o.start = clamp(drag.s0 + dt, gap[0], o.end - MINW);
    } else {
      o.end = clamp(drag.e0 + dt, o.start + MINW, gap[1]);
    }
    render();
  });
  const endDrag = () => { if (drag) setTimeout(() => { drag = null; }, 0); };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  svg.addEventListener("keydown", (e) => {
    const g = e.target.closest?.(".op");
    if (!g) return;
    const o = byId(+g.dataset.id);
    sel = o.id;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1);
      const gap = gapAround(o.client, (o.start + o.end) / 2, o.id) || [0, 100];
      const w = o.end - o.start;
      o.start = clamp(o.start + d, gap[0], gap[1] - w);
      o.end = o.start + w;
    } else if (e.key === "Delete" || e.key === "Backspace") {
      ops = ops.filter((p) => p.id !== o.id);
      sel = null;
    } else if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    keepFocus = true;
    render();
  });

  editor.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    const o = byId(sel);
    if (!b || !o) return;
    if (b.dataset.type) o.type = b.dataset.type;
    if (b.dataset.act === "dec") o.value = Math.max(0, o.value - 1);
    if (b.dataset.act === "inc") o.value = Math.min(5, o.value + 1);
    if (b.dataset.act === "del") { ops = ops.filter((p) => p.id !== o.id); sel = null; }
    render();
  });

  root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    root.querySelectorAll("[data-mode]").forEach((x2) => x2.setAttribute("aria-pressed", x2 === b));
  }));
  root.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => load(b.dataset.preset)));

  load("ok");
}

/* =========================================================
   2. CAP: two data centres and a link that can be cut
   ========================================================= */
{
  const root = document.getElementById("cap");
  const svg = root.querySelector("svg");
  const log = root.querySelector(".steps");
  const verdict = root.querySelector(".verdict");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const DC = ["Tokyo", "Lisbon"];
  const BX = [20, 400], BY = 26, BW = 220, BH = 128, LINKY = 90;

  let s;
  let flashTimer = null;
  let anim = null;

  function reset(keep = {}) {
    s = { policy: keep.policy || "lin", cut: keep.cut || false, val: [7, 7], counter: 7, latest: 7, pend: [[], []], served: 0, errors: 0, stale: 0, flash: [null, null], lines: [] };
    draw();
  }

  // static drawing
  svg.textContent = "";
  const link = el("line", { x1: BX[0] + BW, x2: BX[1], y1: LINKY, y2: LINKY, class: "cap-link" }, svg);
  const cutMark = el("g", { opacity: 0 }, svg);
  el("line", { x1: 310, y1: LINKY - 12, x2: 330, y2: LINKY + 12, class: "cap-cut" }, cutMark);
  el("line", { x1: 330, y1: LINKY - 12, x2: 310, y2: LINKY + 12, class: "cap-cut" }, cutMark);
  const pendText = el("text", { x: 320, y: LINKY + 34, "text-anchor": "middle", class: "tiny" }, svg);
  const linkText = el("text", { x: 320, y: LINKY - 20, "text-anchor": "middle", class: "tiny" }, svg);
  const dcs = DC.map((name, i) => {
    const g = el("g", { class: "cap-dc" }, svg);
    el("rect", { class: "box", x: BX[i], y: BY, width: BW, height: BH, rx: 10 }, g);
    const t = el("text", { x: BX[i] + 16, y: BY + 26, class: "lbl" }, g); t.textContent = name;
    const role = el("text", { x: BX[i] + 16, y: BY + 44, class: "sub" }, g);
    const big = el("text", { x: BX[i] + 16, y: BY + 92, class: "big" }, g);
    const note = el("text", { x: BX[i] + 16, y: BY + 114, class: "sub" }, g);
    return { g, role, big, note };
  });
  const dot = el("circle", { r: 6, class: "dg-dot", opacity: 0, cy: LINKY }, svg);

  function draw() {
    const lin = s.policy === "lin";
    dcs.forEach((d, i) => {
      d.g.setAttribute("class", "cap-dc" + (s.flash[i] ? " " + s.flash[i] : ""));
      d.role.textContent = lin ? (i === 0 ? "leader: every request is decided here" : "follower: forwards requests to Tokyo") : "accepts reads and writes locally";
      d.big.textContent = "price = " + s.val[i];
      d.note.textContent = s.val[i] === s.latest ? "up to date" : "behind: latest write is " + s.latest;
    });
    link.setAttribute("class", "cap-link" + (s.cut ? " cut" : ""));
    cutMark.setAttribute("opacity", s.cut ? 1 : 0);
    linkText.textContent = s.cut ? "link cut" : "replication link";
    const waiting = s.pend[0].length + s.pend[1].length;
    pendText.textContent = s.cut && !lin && waiting ? `${waiting} write${waiting > 1 ? "s" : ""} waiting to cross` : "";
    root.querySelectorAll("[data-policy]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.policy === s.policy));
    root.querySelector('[data-act="cut"]').setAttribute("aria-pressed", s.cut);
    root.querySelector('[data-act="cut"]').textContent = s.cut ? "Heal the link" : "Cut the link";
    out("served").textContent = s.served;
    out("errors").textContent = s.errors;
    out("stale").textContent = s.stale;
    log.innerHTML = s.lines.map((l, k) => `<li class="${k === s.lines.length - 1 ? "current" : ""}">${l}</li>`).join("");
    if (!s.cut) {
      verdict.className = "verdict";
      verdict.textContent = "While the link is up, both policies give every client an answer, and the answer is current. The choice only bites when the link fails.";
    } else if (lin) {
      verdict.className = "verdict bad";
      verdict.textContent = "Linearizable, but not available: clients in Lisbon get errors until the link heals. Nobody ever sees an old price.";
    } else {
      verdict.className = "verdict bad";
      verdict.textContent = "Available, but not linearizable: both cities keep answering, and the two copies drift apart. Reads can return an old price, and concurrent writes will conflict when the link heals.";
    }
  }

  function line(text) { s.lines.push(text); if (s.lines.length > 5) s.lines.shift(); }

  function flash(i, cls) {
    s.flash = [null, null];
    s.flash[i] = cls;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { s.flash = [null, null]; draw(); }, 900);
  }

  // A dot crossing the link. A new action finishes the previous one at once.
  function travel(from, to) {
    if (anim) cancelAnimationFrame(anim);
    if (prefersReducedMotion()) { dot.setAttribute("opacity", 0); return; }
    const xa = from === 0 ? BX[0] + BW : BX[1], xb = to === 0 ? BX[0] + BW : BX[1];
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const t0 = performance.now();
    dot.setAttribute("opacity", 1);
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / 450);
      dot.setAttribute("cx", xa + (xb - xa) * ease(t));
      if (t < 1) anim = requestAnimationFrame(frame); else { dot.setAttribute("opacity", 0); anim = null; }
    };
    anim = requestAnimationFrame(frame);
  }

  function write(i) {
    const other = 1 - i;
    if (s.policy === "lin") {
      if (i === 1 && s.cut) {
        s.errors++; flash(1, "err");
        line("Lisbon cannot reach the leader, so the write fails with an error.");
      } else {
        const v = ++s.counter;
        s.val[0] = v; s.latest = v; s.served++;
        if (!s.cut) { s.val[1] = v; travel(i === 1 ? 1 : 0, i === 1 ? 0 : 1); }
        flash(i, "ok");
        line(i === 0
          ? `Tokyo, the leader, sets price = ${v}.` + (s.cut ? " Lisbon's copy falls behind, but Lisbon is not answering anyone." : " It copies the change to Lisbon.")
          : `Lisbon forwards the write to Tokyo, which sets price = ${v} and copies it back.`);
      }
    } else {
      const v = ++s.counter;
      s.val[i] = v; s.latest = v; s.served++;
      flash(i, "ok");
      if (!s.cut) { s.val[other] = v; travel(i, other); line(`${DC[i]} sets price = ${v} locally and copies it to ${DC[other]}.`); }
      else { s.pend[i].push(v); line(`${DC[i]} sets price = ${v} locally. The copy to ${DC[other]} has to wait for the link.`); }
    }
    draw();
  }

  function read(i) {
    if (s.policy === "lin") {
      if (i === 1 && s.cut) {
        s.errors++; flash(1, "err");
        line("Lisbon cannot ask the leader, so it refuses to answer rather than risk a stale value.");
      } else {
        s.served++; flash(i, "ok");
        if (i === 1) travel(1, 0);
        line(i === 0 ? `Tokyo answers price = ${s.val[0]}.` : `Lisbon asks Tokyo and answers price = ${s.val[0]}.`);
      }
    } else {
      s.served++;
      const stale = s.val[i] !== s.latest;
      if (stale) { s.stale++; flash(i, "stale"); line(`${DC[i]} answers price = ${s.val[i]}, but price = ${s.latest} was already written elsewhere. A stale read.`); }
      else { flash(i, "ok"); line(`${DC[i]} answers price = ${s.val[i]}.`); }
    }
    draw();
  }

  function toggleCut() {
    s.cut = !s.cut;
    if (s.cut) line("The link between the data centres fails. Both sides are still running.");
    else if (s.policy === "lin") {
      if (s.val[1] !== s.val[0]) { s.val[1] = s.val[0]; travel(0, 1); }
      line("The link heals. Lisbon catches up from the leader and starts answering again.");
    } else {
      const [a, b] = s.pend;
      if (a.length && b.length) {
        const winner = Math.max(a[a.length - 1], b[b.length - 1]);
        const loser = winner === a[a.length - 1] ? b[b.length - 1] : a[a.length - 1];
        line(`The link heals. Both sides changed the price while apart (${a[a.length - 1]} in Tokyo, ${b[b.length - 1]} in Lisbon). Last write wins keeps ${winner} and silently drops ${loser}.`);
        s.val = [winner, winner];
        s.latest = winner;
      } else if (a.length || b.length) {
        const i = a.length ? 0 : 1;
        s.val[1 - i] = s.val[i];
        travel(i, 1 - i);
        line(`The link heals. ${DC[1 - i]} receives the writes it missed.`);
      } else line("The link heals. Nothing was written while it was down.");
      s.pend = [[], []];
    }
    draw();
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.policy) { reset({ policy: b.dataset.policy, cut: s.cut }); line(b.dataset.policy === "lin" ? "Policy: every request goes through the leader in Tokyo." : "Policy: each data centre answers on its own and syncs in the background."); draw(); }
    else if (b.dataset.act === "cut") toggleCut();
    else if (b.dataset.act === "reset") reset({ policy: s.policy });
    else if (b.dataset.write) write(+b.dataset.write);
    else if (b.dataset.read) read(+b.dataset.read);
  });

  reset();
}
