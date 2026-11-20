// Small helpers shared by the Chapter 3 widgets.
import { prefersReducedMotion } from "../charts.js";

/** Bytes as B, KB, MB, GB, TB, PB (powers of 1024). */
export function fmtBytes(n, digits = 1) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  let i = 0, v = n;
  while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(Math.round(v)) : v >= 100 ? v.toFixed(0) : v.toFixed(digits).replace(/\.0$/, "");
  return `${s} ${units[i]}`;
}

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Plays explanatory frames one after another, then a final state.
 * Starting a new animation (or calling settle) finishes the current one
 * instantly, so repeated clicks never feel blocked. With reduced motion the
 * frames are skipped and only the final state is applied.
 */
export function makePlayer() {
  let timers = [];
  let pending = null;
  const settle = () => {
    timers.forEach(clearTimeout);
    timers = [];
    const f = pending;
    pending = null;
    if (f) f();
  };
  const play = (frames, stepMs, final, { instant = false } = {}) => {
    settle();
    if (instant || prefersReducedMotion() || !frames.length) { final(); return; }
    pending = final;
    let t = 0;
    frames.forEach((fn, i) => {
      timers.push(setTimeout(fn, t));
      t += typeof stepMs === "function" ? stepMs(i) : stepMs;
    });
    timers.push(setTimeout(() => { timers = []; const f = pending; pending = null; if (f) f(); }, t));
  };
  return { play, settle, get busy() { return pending !== null; } };
}

/** Seeded random integer helper. */
export const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
