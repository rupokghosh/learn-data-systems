// Chapter 8: shared space-time diagram renderer and a small time-sweep player.
// One horizontal line per node, true time running left to right, messages as arrows.
import { el, linear, niceTicks, prefersReducedMotion } from "../charts.js";

let uid = 0;
const MSG_COLOR = { "": "var(--ink-3)", bad: "var(--red)", alt: "var(--accent)", good: "var(--green)", muted: "var(--ink-4)" };
const DOT_COLOR = {
  ok: "var(--green)", drop: "var(--red)", timeout: "var(--red)", late: "var(--orange)",
  work: "var(--accent)", check: "var(--purple)", write: "var(--accent)", send: "var(--ink-3)",
};
const textW = (s, size = 11) => String(s).length * size * 0.55;

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function label(parent, x, y, text, { anchor = "middle", cls = "", style = "", size = 11 } = {}) {
  const t = el("text", { x, y, "text-anchor": anchor, class: cls,
    style: `font-size:${size}px;paint-order:stroke;stroke:var(--bg);stroke-width:4px;stroke-linejoin:round;${style}` }, parent);
  t.textContent = text;
  return t;
}

function cross(parent, x, y, color, r = 5) {
  const g = el("g", { style: `stroke:${color};stroke-width:2;stroke-linecap:round` }, parent);
  el("line", { x1: x - r, y1: y - r, x2: x + r, y2: y + r }, g);
  el("line", { x1: x - r, y1: y + r, x2: x + r, y2: y - r }, g);
}

/**
 * Draw a trace from the ch8 simulator.
 * opts.upto: draw only what has happened by this true time (for animation).
 * opts.hide: Set of node ids to leave out (their messages become short stubs).
 * opts.markers: [{ t, label, color, always }] vertical lines across all rows.
 * opts.rowSub: { nodeId: "second line under the node name" }.
 * opts.tick: format a time value for the axis.
 */
export function spaceTime(svg, trace, opts = {}) {
  const {
    width = 640, rowGap = 78, top = 46, left = 100, right = 20, upto = Infinity,
    hide = new Set(), markers = [], rowSub = {}, tick = (t) => `${+t.toFixed(2)} s`, axisLabel = "true time",
  } = opts;
  const rows = trace.nodes.filter((n) => !hide.has(n.id));
  const rowY = {};
  rows.forEach((n, i) => { rowY[n.id] = top + i * rowGap; });
  const lastY = top + (rows.length - 1) * rowGap;
  const h = lastY + 84;
  svg.setAttribute("viewBox", `0 0 ${width} ${h}`);
  clear(svg);
  if (!svg.dataset.stid) svg.dataset.stid = `ch8st${++uid}`;
  const sid = svg.dataset.stid;
  const x = linear([trace.t0, trace.t1], [left, width - right]);
  const cap = Math.min(upto, trace.t1);
  const xmin = left, xmax = width - right;

  // Arrowhead markers, one per colour.
  const defs = el("defs", {}, svg);
  for (const [k, c] of Object.entries(MSG_COLOR)) {
    const m = el("marker", { id: `${sid}-${k || "base"}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0,0 L10,5 L0,10 z", style: `fill:${c}` }, m);
  }

  // Vertical markers (timeouts, lease expiry).
  const gMark = el("g", {}, svg);
  for (const mk of markers) {
    if (mk.t < trace.t0 || mk.t > trace.t1) continue;
    if (!mk.always && mk.t > cap) continue;
    const mx = x(mk.t);
    const color = mk.color || "var(--ink-3)";
    el("line", { x1: mx, x2: mx, y1: top - 26, y2: lastY + 14, style: `stroke:${color};stroke-width:1;stroke-dasharray:4 4` }, gMark);
    const anchor = mx > xmax - 60 ? "end" : mx < xmin + 60 ? "start" : "middle";
    label(gMark, mx + (anchor === "end" ? 4 : anchor === "start" ? -4 : 0), top - 32, mk.label, { anchor, style: `fill:${color};font-weight:500` });
  }

  // Node lines.
  const gRows = el("g", {}, svg);
  for (const n of rows) {
    const y = rowY[n.id];
    const crash = trace.spans.find((s) => s.node === n.id && s.kind === "crash");
    const name = el("text", { x: 0, y: y + 4, class: "diagram-label" }, gRows);
    name.textContent = n.label;
    if (rowSub[n.id]) { const s = el("text", { x: 0, y: y + 20, class: "diagram-sub", style: "font-size:11px" }, gRows); s.textContent = rowSub[n.id]; }
    el("line", { x1: xmin, x2: xmax, y1: y, y2: y, style: "stroke:var(--line-2);stroke-width:1" }, gRows);
    const aliveEnd = crash ? Math.min(cap, crash.t0) : cap;
    if (aliveEnd > trace.t0) el("line", { x1: xmin, x2: x(aliveEnd), y1: y, y2: y, style: "stroke:var(--ink-3);stroke-width:1.5" }, gRows);
    if (crash && cap >= crash.t0) {
      el("line", { x1: x(crash.t0), x2: x(cap), y1: y, y2: y, style: "stroke:var(--red);stroke-width:1.5;stroke-dasharray:2 5;opacity:0.6" }, gRows);
    }
  }

  // Labels are placed after all marks, trying a few candidate spots to avoid overlaps.
  const boxes = [];
  const boxOf = (lx, ly, w, anchor) => {
    const x0 = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
    return { x0, x1: x0 + w, y0: ly - 10, y1: ly + 3 };
  };
  const hits = (b) => boxes.some((o) => !(b.x1 < o.x0 - 6 || b.x0 > o.x1 + 6 || b.y1 <= o.y0 || b.y0 >= o.y1));
    /** cands: [{x, y, anchor}] for the first line; extra lines go below it. */
  function placeLabel(parent, lines, cands, styles) {
    const w = Math.max(...lines.map((l) => textW(l)));
    const n = lines.length;
    // Slide each candidate sideways until it fits inside the drawing, then test for overlaps.
    const fitted = cands.map((c) => {
      const b = boxOf(c.x, c.y, w, c.anchor);
      const dx = b.x0 < 2 ? 2 - b.x0 : b.x1 > width - 2 ? width - 2 - b.x1 : 0;
      return { ...c, x: c.x + dx };
    });
    const boxFor = (c) => { const b = boxOf(c.x, c.y, w, c.anchor); b.y1 += (n - 1) * 13; return b; };
    let pick = fitted.find((c) => !hits(boxFor(c)));
    if (!pick) {
      // Everything collides: take the spot with the least overlap.
      const overlap = (b) => boxes.reduce((sum, o) => sum
        + Math.max(0, Math.min(b.x1, o.x1) - Math.max(b.x0, o.x0)) * Math.max(0, Math.min(b.y1, o.y1) - Math.max(b.y0, o.y0)), 0);
      pick = fitted.reduce((best, c) => (overlap(boxFor(c)) < overlap(boxFor(best)) ? c : best), fitted[0]);
    }
    boxes.push(boxFor(pick));
    lines.forEach((l, i) => label(parent, pick.x, pick.y + i * 13, l, { anchor: pick.anchor, ...styles[i] }));
  }

  // Pauses and crashes.
  const gSpan = el("g", {}, svg);
  const spanLabels = [];
  for (const s of trace.spans) {
    if (!(s.node in rowY) || s.t0 > cap) continue;
    const y = rowY[s.node];
    if (s.kind === "pause") {
      const x0 = x(Math.max(trace.t0, s.t0)), x1 = x(Math.min(s.t1, cap, trace.t1));
      el("rect", { x: x0, y: y - 8, width: Math.max(1, x1 - x0), height: 16, rx: 3, style: "fill:var(--orange-soft);stroke:var(--orange);stroke-width:1" }, gSpan);
      const full = x(Math.min(s.t1, trace.t1)) - x0;
      const mid = x0 + full / 2;
      if (full > textW(s.label) + 16 && x1 >= mid + textW(s.label) / 2) spanLabels.push({ x: mid, y: y + 4, text: s.label });
    } else if (s.kind === "crash") {
      cross(gSpan, x(s.t0), y, "var(--red)", 6);
      spanLabels.push({ x: x(s.t0) + 10, y: y + 20, text: s.label, anchor: "start", red: true });
    }
  }

  // Messages (lines now, labels later).
  const gMsg = el("g", {}, svg);
  const msgLabels = [];
  for (const m of trace.msgs) {
    if (m.send > cap || m.send < trace.t0 - 1e-9) continue;
    const fromVis = m.from in rowY, toVis = m.to in rowY;
    if (!fromVis && !toVis) continue;
    const color = MSG_COLOR[m.cls || ""] ?? MSG_COLOR[""];
    const style = `stroke:${color};stroke-width:1.6;fill:none`;
    if (!fromVis || !toVis) {
      // The other end is hidden: show only what the visible node itself can observe.
      if (fromVis) {
        const x0 = x(m.send), y0 = rowY[m.from];
        el("line", { x1: x0, y1: y0, x2: x0 + 16, y2: y0 + 22, style: `${style};stroke-dasharray:3 3` }, gMsg);
        msgLabels.push({ lines: [`${m.label} (out of sight)`], color: "var(--ink-3)", cands: [{ x: x0 + 20, y: y0 + 34, anchor: "start" }] });
      } else if (m.recv != null && m.recv <= cap) {
        const x1 = x(m.recv), y1 = rowY[m.to];
        el("line", { x1: x1 - 16, y1: y1 + 22, x2: x1, y2: y1 + 2, style, "marker-end": `url(#${sid}-${m.cls || "base"})` }, gMsg);
      }
      continue;
    }
    const y0 = rowY[m.from], y1 = rowY[m.to];
    const lost = m.status === "lost";
    const tEnd = lost ? m.lostAt : (m.recv ?? trace.t1);
    const frac = lost ? 0.45 : 1;
    const sx = x(m.send);
    const ex = sx + (x(m.send + m.delay) - sx) * frac;
    const ey = y0 + (y1 - y0) * frac;
    const done = cap >= tEnd;
    const p = done ? 1 : Math.max(0, (cap - m.send) / (tEnd - m.send || 1));
    const px = sx + (ex - sx) * p, py = y0 + (ey - y0) * p;
    const dy = Math.sign(y1 - y0);
    el("line", {
      x1: sx, y1: y0 + dy * 2, x2: px, y2: py - (done && !lost ? dy * 2 : 0), style,
      "marker-end": done && !lost ? `url(#${sid}-${m.cls || "base"})` : null,
    }, gMsg);
    if (done && (lost || m.status === "dropped")) cross(gMsg, ex, ey, "var(--red)");
    if (m.label && p >= 0.5) {
      const mx = (sx + ex) / 2, my = (y0 + ey) / 2;
      const steep = Math.abs(ex - sx) < 40;
      const cands = steep
        ? [4, -10, 18, -24, 32].flatMap((dy) => [{ x: mx + 7, y: my + dy, anchor: "start" }, { x: mx - 7, y: my + dy, anchor: "end" }])
        : [{ x: mx, y: my - 5, anchor: "middle" }, { x: mx, y: my + 13, anchor: "middle" }, { x: mx + 8, y: my + 4, anchor: "start" }, { x: mx - 8, y: my + 4, anchor: "end" }];
      msgLabels.push({ lines: [m.label], color, cands });
    }
  }

  // Event dots.
  const gEv = el("g", {}, svg);
  const evLabels = [];
  for (const e of trace.events) {
    if (!(e.node in rowY) || e.t > cap || e.t < trace.t0) continue;
    const ex = x(e.t), y = rowY[e.node];
    el("circle", { cx: ex, cy: y, r: 4, style: `fill:${DOT_COLOR[e.kind] || "var(--ink-3)"};stroke:var(--bg);stroke-width:1.5` }, gEv);
    boxes.push({ x0: ex - 5, x1: ex + 5, y0: y - 5, y1: y + 5 });
    const lines = [e.label];
    if (e.stamp != null) lines.push(`ts ${e.stamp.toFixed(3)}`);
    const n = lines.length;
    const anchor = e.align === "left" ? "end" : e.align === "right" ? "start" : "middle";
    const ax = anchor === "end" ? ex + 2 : anchor === "start" ? ex - 2 : ex;
    const up = (lvl) => ({ x: ax, y: y - 10 - (n - 1) * 13 - lvl * 13 * n, anchor });
    const down = (lvl) => ({ x: ax, y: y + 19 + lvl * 13 * n, anchor });
    const above = e.pos !== "below";
    const cands = above ? [up(0), up(1), up(2), down(0), down(1)] : [down(0), down(1), down(2), up(0), up(1)];
    evLabels.push({ lines, kind: e.kind, cands });
  }

  // Place labels: events first, then spans, then messages.
  for (const L of evLabels) {
    placeLabel(gEv, L.lines, L.cands, [
      { style: `fill:var(--ink-2);font-weight:${L.kind === "write" ? 600 : 400}` },
      { style: "fill:var(--ink-3);font-family:var(--mono)", size: 10 },
    ]);
  }
  for (const S of spanLabels) {
    const anchor = S.anchor || "middle";
    boxes.push(boxOf(S.x, S.y, textW(S.text, 10.5), anchor));
    label(gSpan, S.x, S.y, S.text, { anchor, size: 10.5, style: `fill:var(${S.red ? "--red" : "--orange"});font-weight:500` });
  }
  for (const M of msgLabels) placeLabel(gMsg, M.lines, M.cands, [{ style: `fill:${M.color}` }]);

  // Axis.
  const ay = lastY + 70;
  const ticks = opts.ticks || niceTicks(trace.t0, trace.t1, Math.max(3, Math.floor((width - left) / 90)));
  for (const t of ticks) {
    if (t < trace.t0 || t > trace.t1) continue;
    el("line", { x1: x(t), x2: x(t), y1: ay - 12, y2: ay - 8, style: "stroke:var(--line-2)" }, svg);
    const tx = el("text", { x: x(t), y: ay + 2, "text-anchor": "middle", class: "diagram-sub", style: "font-size:11px" }, svg);
    tx.textContent = tick(t);
  }
  el("line", { x1: xmin, x2: xmax, y1: ay - 12, y2: ay - 12, style: "stroke:var(--line-2)" }, svg);
  const al = el("text", { x: 0, y: ay + 2, class: "diagram-sub", style: "font-size:11px" }, svg);
  al.textContent = axisLabel;

  if (upto < trace.t1) {
    el("line", { x1: x(cap), x2: x(cap), y1: top - 20, y2: lastY + 20, style: "stroke:var(--accent);stroke-width:1;opacity:0.5" }, svg);
  }
  return { x, rowY, height: h };
}

/**
 * Sweep a playhead across a trace. draw(upto) is called each frame.
 * Calling play again restarts cleanly; finish() jumps to the end at once.
 */
export function makeSweep(draw, { duration = 2600 } = {}) {
  let raf = 0, target = null;
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  return {
    play(t0, t1, onDone) {
      stop();
      target = { t1, onDone };
      if (prefersReducedMotion()) { draw(Infinity); target = null; onDone?.(); return; }
      const start = performance.now();
      const frame = (now) => {
        // Time itself advances at a constant rate, so the sweep is linear.
        const k = Math.min(1, (now - start) / duration);
        draw(k >= 1 ? Infinity : t0 + (t1 - t0) * k);
        if (k < 1) raf = requestAnimationFrame(frame);
        else { raf = 0; const d = target?.onDone; target = null; d?.(); }
      };
      raf = requestAnimationFrame(frame);
    },
    finish() {
      if (!raf) return;
      stop();
      draw(Infinity);
      const d = target?.onDone; target = null; d?.();
    },
    get running() { return raf !== 0; },
  };
}
