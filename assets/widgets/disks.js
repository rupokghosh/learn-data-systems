// Lesson 2: disk failures at scale, and independent vs correlated faults.
import { slider, fmt, rng, normal, prefersReducedMotion } from "../charts.js";

/* ---------- Disk failure simulator ---------- */
{
  const root = document.getElementById("disks");
  const grid = root.querySelector(".disk-grid");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const runBtn = root.querySelector("[data-run]");
  const rand = rng(7);

  const toDisks = (v) => { const n = 10 ** v; const m = 10 ** Math.floor(Math.log10(n)); return Math.round(n / m) * m; };
  let disks = 10000, mttf = 30, timer = null;

  function every(perDay) {
    if (perDay <= 0) return "never";
    const hours = 24 / perDay;
    if (hours < 1) return `${Math.round(hours * 60)} minutes`;
    if (hours < 48) return `${fmt(hours)} hours`;
    const days = hours / 24;
    if (days < 730) return `${Math.round(days)} days`;
    return `${fmt(days / 365)} years`;
  }

  function cellsCount() { return Math.min(disks, 240); }
  function buildGrid() {
    grid.innerHTML = "";
    for (let i = 0; i < cellsCount(); i++) { const d = document.createElement("div"); d.className = "disk"; grid.appendChild(d); }
    out("cell").textContent = disks <= 240 ? "Each square is one disk." : `Each square is about ${fmt(disks / 240)} disks.`;
  }

  function update() {
    stop();
    const perDay = disks / (mttf * 365);
    out("day").textContent = perDay < 0.1 ? String(+perDay.toPrecision(2)) : fmt(perDay, perDay < 1 ? 2 : 1);
    out("year").textContent = fmt(perDay * 365);
    out("every").textContent = every(perDay);
    out("sim").textContent = "–";
    buildGrid();
  }

  function poisson(lambda) {
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(rand)));
    let L = Math.exp(-lambda), k = 0, p = 1;
    do { k++; p *= rand(); } while (p > L);
    return k - 1;
  }

  function stop() { if (timer) cancelAnimationFrame(timer); timer = null; runBtn.textContent = "Simulate one year"; }

  function run() {
    if (timer) { stop(); return; }
    buildGrid();
    const cells = [...grid.children];
    const perDay = disks / (mttf * 365);
    let day = 0, total = 0;
    const t0 = performance.now();
    const DURATION = prefersReducedMotion() ? 1 : 6000;
    runBtn.textContent = "Stop";
    const frame = (now) => {
      const target = Math.min(365, Math.floor(((now - t0) / DURATION) * 365));
      while (day < target) {
        day++;
        const k = poisson(perDay);
        total += k;
        const shown = Math.min(k, 6);
        for (let i = 0; i < shown; i++) {
          const c = cells[Math.floor(rand() * cells.length)];
          c.classList.remove("replaced"); c.classList.add("dead");
          setTimeout(() => { c.classList.remove("dead"); c.classList.add("replaced"); }, 260);
        }
      }
      out("sim").textContent = `Day ${day}: ${fmt(total)} disks replaced`;
      if (day < 365) timer = requestAnimationFrame(frame); else stop();
    };
    timer = requestAnimationFrame(frame);
  }

  slider(root.querySelector("#n-disks"), (v) => fmt(toDisks(v)), (v) => { disks = toDisks(v); update(); });
  slider(root.querySelector("#mttf"), (v) => `${v} years`, (v) => { mttf = v; update(); });
  runBtn.addEventListener("click", run);
}

/* ---------- Independent vs correlated ---------- */
{
  const root = document.getElementById("corr");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  let p = 0.001, n = 3;

  function every(prob) {
    const days = 1 / prob;
    if (days < 730) return `${fmt(days)} days`;
    const years = days / 365;
    if (years > 1.4e10) return `${sci(years)} years (longer than the age of the universe)`;
    return `${fmt(years)} years`;
  }

  // 2.7e17 as "2.7 × 10¹⁷", so huge numbers stay short.
  function sci(v) {
    const e = Math.floor(Math.log10(v));
    const sup = String(e).replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[d]);
    return `${+(v / 10 ** e).toFixed(1)} × 10${sup}`;
  }

  function update() {
    out("indep").textContent = every(p ** n);
    out("corr").textContent = every(p);
    const v = root.querySelector(".verdict");
    v.textContent = n === 1
      ? "With one copy there is no difference: any fault loses the data."
      : `Adding replicas multiplies protection against independent faults, but a bug that hits every replica at once makes extra copies worthless. ${n} replicas protect you exactly as well as 1.`;
  }

  slider(root.querySelector("#p-fail"), (v) => `${+(10 ** v * 100).toPrecision(2)}% per day`, (v) => { p = 10 ** v; update(); });
  slider(root.querySelector("#replicas"), (v) => String(v), (v) => { n = v; update(); });
}
