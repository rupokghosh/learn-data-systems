// Small helpers shared by the Chapter 11 widgets.
import { prefersReducedMotion } from "../charts.js";

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Set the verdict line. cls: "", "good" or "bad". */
export function say(node, html, cls = "") {
  node.className = `verdict ${cls}`.trim();
  node.innerHTML = html;
}

/** A play / pause loop that calls fn every `ms` milliseconds. */
export function makeLoop(fn, ms, onChange) {
  let id = null;
  const api = {
    get running() { return id !== null; },
    start() { if (id !== null) return; id = setInterval(() => { if (fn() === false) api.stop(); }, ms); onChange?.(true); },
    stop() { if (id === null) return; clearInterval(id); id = null; onChange?.(false); },
    toggle() { id === null ? api.start() : api.stop(); },
  };
  return api;
}

/** Make a set of buttons behave as a radio group via aria-pressed. */
export function radio(buttons, attr, onPick) {
  const set = (v) => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === v)));
  buttons.forEach((b) => b.addEventListener("click", () => { set(b.dataset[attr]); onPick(b.dataset[attr]); }));
  return set;
}

/** Ease-in-out cubic, for things that travel across the screen. */
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Animate a number from a to b over dur ms, calling draw(value) each frame.
 * Returns a handle whose finish() jumps to the end at once.
 * With reduced motion it jumps straight to b.
 */
export function tween(a, b, dur, draw, done) {
  let raf = 0, over = false;
  const finish = () => { if (over) return; over = true; cancelAnimationFrame(raf); draw(b); done?.(); };
  if (prefersReducedMotion() || dur <= 0) { finish(); return { finish, get over() { return true; } }; }
  const t0 = performance.now();
  const frame = (now) => {
    if (over) return;
    const t = Math.min(1, (now - t0) / dur);
    draw(a + (b - a) * t);
    if (t < 1) raf = requestAnimationFrame(frame); else finish();
  };
  raf = requestAnimationFrame(frame);
  return { finish, get over() { return over; } };
}
