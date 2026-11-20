// Tiny, dependency-free SVG chart helpers.

const NS = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

export function linear([d0, d1], [r0, r1]) {
  const f = (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
  f.domain = [d0, d1];
  return f;
}

export function logScale([d0, d1], [r0, r1]) {
  const l0 = Math.log10(d0), l1 = Math.log10(d1);
  const f = (v) => r0 + ((Math.log10(Math.max(v, d0)) - l0) / (l1 - l0)) * (r1 - r0);
  f.domain = [d0, d1];
  f.invert = (r) => 10 ** (l0 + ((r - r0) / (r1 - r0)) * (l1 - l0));
  return f;
}

export function niceTicks(min, max, count = 5) {
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

export function logTicks(min, max) {
  const t = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    const v = 10 ** e;
    if (v >= min && v <= max) t.push(v);
  }
  return t;
}

/** Compact number: 1.2k, 3.4M, 2B */
export function fmt(n, digits = 1) {
  const a = Math.abs(n);
  if (a >= 1e15) {
    // Beyond trillions, suffixes stop being readable: use powers of ten.
    const e = Math.floor(Math.log10(a));
    const sup = String(e).replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[d]);
    return `${trim((n / 10 ** e).toFixed(digits))} × 10${sup}`;
  }
  if (a >= 1e12) return trim((n / 1e12).toFixed(digits)) + "T";
  if (a >= 1e9) return trim((n / 1e9).toFixed(digits)) + "B";
  if (a >= 1e6) return trim((n / 1e6).toFixed(digits)) + "M";
  if (a >= 1e3) return trim((n / 1e3).toFixed(digits)) + "k";
  if (a >= 100 || Number.isInteger(n)) return String(Math.round(n));
  return trim(n.toFixed(digits));
}
const trim = (s) => s.replace(/\.0+$/, "");

export function ms(v) {
  if (v >= 1000) return trim((v / 1000).toFixed(v >= 10000 ? 0 : 1)) + " s";
  return Math.round(v) + " ms";
}

/** Calls draw(width) now and whenever the container resizes or the theme changes. */
export function responsive(container, draw) {
  let w = 0;
  const run = () => { w = container.clientWidth; if (w > 0) draw(w); };
  new ResizeObserver(() => { if (container.clientWidth !== w) run(); }).observe(container);
  window.addEventListener("themechange", run);
  run();
  return run;
}

/** Wires a range input to an <output> and a callback. Returns a getter. */
export function slider(input, format, onChange) {
  const out = input.closest(".control")?.querySelector("output");
  const update = () => { if (out) out.textContent = format(+input.value); onChange?.(+input.value); };
  input.addEventListener("input", update);
  update();
  return () => +input.value;
}

export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Seeded random for reproducible demos. */
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function normal(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
