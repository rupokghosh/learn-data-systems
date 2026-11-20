// Chapter 10 helpers shared by the widgets: FLIP movement of records between containers.
import { prefersReducedMotion } from "../charts.js";

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";

/**
 * Moves records between containers with the FLIP technique.
 * Every movable element carries data-fid. Elements that are new but carry data-from="<fid>"
 * start where that element was before the change (a copy leaving its source).
 * Returns a promise that resolves when movement is over. Under reduced motion it resolves at once.
 */
export function makeMover(root) {
  const running = new Set();
  function finish() { for (const a of [...running]) a.finish(); running.clear(); }
  async function flip(mutate, duration = 520) {
    finish();
    const before = new Map();
    root.querySelectorAll("[data-fid]").forEach((n) => before.set(n.dataset.fid, n.getBoundingClientRect()));
    mutate();
    if (prefersReducedMotion()) return;
    const anims = [];
    root.querySelectorAll("[data-fid]").forEach((n) => {
      const b = before.get(n.dataset.fid) || (n.dataset.from && before.get(n.dataset.from));
      if (!b) return;
      const a = n.getBoundingClientRect();
      const dx = b.left - a.left, dy = b.top - a.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      const anim = n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration, easing: EASE_IN_OUT });
      running.add(anim);
      anim.finished.then(() => running.delete(anim), () => running.delete(anim));
      anims.push(anim.finished.catch(() => {}));
    });
    await Promise.all(anims);
  }
  return { flip, finish };
}

/** A small Play loop: calls stepFn until it returns false. Clicking Play again pauses. */
export function makeLoop(button, stepFn, gap = 380) {
  let playing = false, active = false;
  const label = button.textContent;
  async function run() {
    playing = true; button.textContent = "Pause"; button.setAttribute("aria-pressed", "true");
    if (active) return;
    active = true;
    while (playing) {
      const more = await stepFn();
      if (!more) break;
      await sleep(prefersReducedMotion() ? Math.max(gap, 500) : gap);
    }
    active = false;
    stop();
  }
  function stop() { playing = false; button.textContent = label; button.setAttribute("aria-pressed", "false"); }
  button.addEventListener("click", () => (playing ? stop() : run()));
  return { stop, get playing() { return playing; } };
}
