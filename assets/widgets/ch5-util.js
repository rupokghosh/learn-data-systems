// Shared drawing and playback helpers for the Chapter 5 replication widgets.
import { prefersReducedMotion } from "../charts.js";

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Message and mark colours, by class name. Always CSS variables so both themes work. */
export const COLOR = {
  write: "--accent", ok: "--green", repl: "--ink-3", read: "--purple", reply: "--purple",
  stale: "--red", bad: "--red", repair: "--orange", hint: "--orange", ctl: "--ink-2", sync: "--accent",
};
const colorOf = (cls) => `var(${COLOR[cls] || "--ink-3"})`;

export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Plays a simulation forward in real time. Simulated milliseconds advance at
 * `speed` per real millisecond. Stops by itself when nothing is left to happen.
 * With reduced motion, simulated time still passes (so you can still crash a
 * node while messages are in flight), but the picture updates in discrete
 * steps a few times per second instead of sliding.
 * User actions go through act(), so clicks during playback are simply queued
 * into the simulation at the current instant: nothing is ever blocked.
 */
export function makeClock(render, { speed = 0.35, gap = 60, onIdle } = {}) {
  let sim = null, raf = 0, last = 0, lastDraw = 0;
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  function frame(now) {
    const dt = Math.min(64, now - last);
    last = now;
    // Fast-forward through quiet stretches (for example a failover timeout) so nobody waits.
    const quiet = !sim.msgs.some((m) => m.status === "flight");
    const target = sim.t + dt * clock.speed * (quiet ? 5 : 1);
    sim.runUntil(target);
    const idle = sim.idle();
    if (idle || !prefersReducedMotion() || now - lastDraw > 280) { render(sim); lastDraw = now; }
    if (idle) { raf = 0; onIdle?.(sim); return; }
    raf = requestAnimationFrame(frame);
  }
  const clock = {
    speed,
    get sim() { return sim; },
    get running() { return raf !== 0; },
    set(s) { stop(); sim = s; render(sim); },
    /** Run an action against the simulation now, then keep playing. */
    act(fn) {
      if (sim.idle()) sim.t += gap;
      fn(sim);
      clock.kick();
    },
    kick() {
      if (sim.idle()) { render(sim); onIdle?.(sim); return; }
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    },
    /** Finish everything instantly. */
    finish() { stop(); sim.runAll(); render(sim); onIdle?.(sim); },
    stop,
  };
  return clock;
}

let uid = 0;

/**
 * A space-time diagram: one horizontal line per node, time running left to right,
 * each message an arrow from (send time, sender) to (arrival time, receiver).
 * Messages still in flight are drawn up to "now" with a dot at the head.
 * Lost messages end in a cross.
 *
 * opts.lanes: [{ id, label, sub }]  (can be replaced later through st.lanes)
 * opts.window: simulated milliseconds visible at once (the view slides with time)
 * opts.fit: [t0, t1] to show a fixed range instead of sliding
 */
export function spaceTime(container, opts = {}) {
  const id = "st" + ++uid;
  const st = {
    lanes: opts.lanes || [],
    window: opts.window || 2400,
    fit: opts.fit || null,
    rowH: opts.rowH || 40,
    labelW: opts.labelW || 92,
    selected: new Set(),
    draw,
  };
  let lastSim = null;
  new ResizeObserver(() => lastSim && draw(lastSim)).observe(container);
  window.addEventListener("themechange", () => lastSim && draw(lastSim));

  function draw(sim, { msgFilter } = {}) {
    lastSim = sim;
    const W = Math.max(container.clientWidth || 0, 300);
    const top = 16;
    const H = top + st.lanes.length * st.rowH + 22;
    const now = sim.t;
    let t0, t1;
    if (st.fit) [t0, t1] = st.fit;
    else { t1 = Math.max(st.window, now + st.window * 0.08); t0 = t1 - st.window; }
    const x0 = st.labelW, x1 = W - 8;
    const X = (t) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
    const Y = {};
    st.lanes.forEach((l, i) => (Y[l.id] = top + i * st.rowH + st.rowH / 2));

    const used = new Set(Object.values(COLOR));
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="st-svg" role="img" aria-label="${esc(opts.aria || "Space-time diagram: each line is a node, arrows are messages")}"><defs>`;
    for (const v of used) s += `<marker id="${id}${v}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(${v})"/></marker>`;
    s += `<clipPath id="${id}clip"><rect x="${x0 - 2}" y="0" width="${x1 - x0 + 10}" height="${H}"/></clipPath></defs>`;

    // lanes
    for (const l of st.lanes) {
      const y = Y[l.id];
      const n = sim.node(l.id);
      s += `<text x="0" y="${y - (l.sub ? 2 : -4)}" class="st-label">${esc(l.label)}</text>`;
      if (l.sub) s += `<text x="0" y="${y + 12}" class="st-sub${l.subCls ? " " + l.subCls : ""}">${esc(l.sub)}</text>`;
      s += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" class="st-lane"/>`;
      if (n) for (const [a, b] of n.downs) {
        const xa = Math.max(x0, X(a)), xb = Math.min(x1, X(Math.min(b, now)));
        if (xb > xa) s += `<line x1="${xa}" y1="${y}" x2="${xb}" y2="${y}" class="st-down"/>`;
      }
    }
    s += `<g clip-path="url(#${id}clip)">`;
    // "now" line
    if (!st.fit || now < t1) s += `<line x1="${X(now)}" y1="${top - 6}" x2="${X(now)}" y2="${H - 18}" class="st-now"/>`;
    // messages
    for (const m of sim.msgs) {
      if (!(m.from in Y) || !(m.to in Y)) continue;
      if (msgFilter && !msgFilter(m)) continue;
      if (m.sent > now) continue;
      if (Math.max(m.arrive, m.sent) < t0) continue;
      const c = COLOR[m.cls] || "--ink-3";
      const xa = X(m.sent), ya = Y[m.from], xb = X(m.arrive), yb = Y[m.to];
      const f = m.arrive <= m.sent ? 1 : Math.min(1, (now - m.sent) / (m.arrive - m.sent));
      const px = xa + (xb - xa) * f, py = ya + (yb - ya) * f;
      const style = `stroke:var(${c})`;
      const fLost = m.lostAt != null ? Math.max(0, (m.lostAt - m.sent) / Math.max(1, m.arrive - m.sent)) : 1;
      if (m.status === "done" || (m.status === "flight" && f >= 1)) {
        s += `<line x1="${xa}" y1="${ya}" x2="${xb}" y2="${yb}" class="st-msg" style="${style}" marker-end="url(#${id}${c})"/>`;
      } else if (m.status === "lost" && f >= fLost) {
        const lx = xa + (xb - xa) * fLost, ly = ya + (yb - ya) * fLost;
        s += `<line x1="${xa}" y1="${ya}" x2="${lx}" y2="${ly}" class="st-msg lost" style="${style}"/>`;
        s += `<text x="${lx}" y="${ly + 4}" text-anchor="middle" class="st-x">×</text>`;
      } else {
        s += `<line x1="${xa}" y1="${ya}" x2="${px}" y2="${py}" class="st-msg" style="${style}"/><circle cx="${px}" cy="${py}" r="3.5" style="fill:var(${c})"/>`;
      }
      if (m.label && f >= 1 && m.status !== "lost" && Math.hypot(xb - xa, yb - ya) > 46) {
        const mx = (xa + xb) / 2, my = (ya + yb) / 2;
        s += `<text x="${mx + 4}" y="${my - 3}" class="st-mlabel" style="fill:var(${c})">${esc(m.label)}</text>`;
      }
    }
    // marks
    for (const k of sim.marks) {
      if (!(k.node in Y) || k.t < t0 - 50 || k.t > now) continue;
      const x = X(k.t), y = Y[k.node];
      const c = colorOf(k.cls);
      const sel = k.ev && st.selected.has(k.ev);
      const attrs = k.ev ? ` data-ev="${k.ev}" class="st-mark pick${sel ? " sel" : ""}" tabindex="-1"` : ` class="st-mark"`;
      s += `<g${attrs}><circle cx="${x}" cy="${y}" r="${sel ? 6 : 4.5}" style="fill:var(--bg);stroke:${c}"/>`;
      if (k.label) s += `<text x="${x}" y="${y - 9}" text-anchor="middle" class="st-klabel" style="fill:${c}">${esc(k.label)}</text>`;
      s += `</g>`;
    }
    s += `</g>`;
    // time axis
    s += `<text x="${x1}" y="${H - 4}" text-anchor="end" class="st-sub">time →</text>`;
    s += `</svg>`;
    container.innerHTML = s;
  }
  return st;
}

/**
 * SVG for messages in flight on a topology view: a dot moving from sender to
 * receiver (eased, because it travels across the screen), and a short-lived
 * cross where a message was lost.
 */
export function flightDots(sim, pos) {
  let s = "";
  for (const m of sim.msgs) {
    const a = pos[m.from], b = pos[m.to];
    if (!a || !b) continue;
    const c = colorOf(m.cls);
    if (m.status === "flight" && m.sent <= sim.t) {
      const f = easeInOut(Math.min(1, (sim.t - m.sent) / Math.max(1, m.arrive - m.sent)));
      s += `<circle cx="${a.x + (b.x - a.x) * f}" cy="${a.y + (b.y - a.y) * f}" r="5" style="fill:${c}"/>`;
    } else if (m.status === "lost" && sim.t - (m.lostAt ?? m.arrive) < 300) {
      const f = m.lostAt != null ? easeInOut(Math.min(1, (m.lostAt - m.sent) / Math.max(1, m.arrive - m.sent))) : 0.82;
      s += `<text x="${a.x + (b.x - a.x) * f}" y="${a.y + (b.y - a.y) * f + 5}" text-anchor="middle" class="st-x">×</text>`;
    }
  }
  return s;
}
