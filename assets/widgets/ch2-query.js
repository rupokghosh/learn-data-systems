// Chapter 2, lesson 3: an imperative loop versus a declarative query the planner may parallelize.
import { slider, prefersReducedMotion } from "../charts.js";
import { matches, choosePlan, simulate } from "./ch2-logic.js";

const ITEMS = [
  ["Knife", 48, 1], ["Mug", 12, 1], ["Pan", 39, 1], ["Towel", 8, 0], ["Pepper mill", 22, 1], ["Kettle", 35, 1],
  ["Whisk", 9, 1], ["Teapot", 29, 1], ["Spice rack", 27, 0], ["Jar", 6, 1], ["Dutch oven", 85, 1], ["Bread knife", 31, 1],
  ["Oven mitt", 11, 1], ["Stock pot", 44, 0], ["Pour-over", 16, 1], ["Ladle", 7, 0], ["Bowl", 24, 1], ["Grater", 14, 1],
  ["Rolling pin", 18, 1], ["Apron", 21, 1], ["Sieve", 13, 1], ["Board", 26, 1], ["Tongs", 10, 0], ["Scale", 32, 1],
].map(([name, price, inStock]) => ({ name, price, inStock: !!inStock }));
const Q = { maxPrice: 15 };
const WORKERS = [1, 2, 4, 8];

const root = document.getElementById("plan");
const imp = root.querySelector('[data-panel="imp"]');
const dec = root.querySelector('[data-panel="dec"]');
const verdict = root.querySelector(".verdict");
const runBtn = root.querySelector("[data-run]");
const indexBox = root.querySelector("#has-index");

let workers = 4;
let plan = null;
let runId = 0;

const card = (i) => {
  const it = ITEMS[i];
  return `<span class="item" data-i="${i}">${it.name} <span class="p">$${it.price}</span>${it.inStock ? "" : ' <span class="out">sold out</span>'}</span>`;
};

function planText(p) {
  const filter = "Filter: ((price < 15) AND in_stock)";
  if (p.kind === "index") return "Index Scan using products_price_idx on products\n  Index Cond: (price < 15)\n  Filter: in_stock";
  if (p.kind === "parallel") return `Gather\n  Workers Planned: ${p.lanes.length}\n  ->  Parallel Seq Scan on products\n        ${filter}`;
  return `Seq Scan on products\n  ${filter}`;
}

const kindName = { index: "index scan", parallel: "parallel scan", seq: "sequential scan" };

function setup() {
  runId++;
  runBtn.disabled = false;
  verdict.hidden = true;
  const { chosen, other } = choosePlan(ITEMS, Q, { workers, hasIndex: indexBox.checked });
  plan = chosen;

  imp.querySelector("[data-lane]").innerHTML = ITEMS.map((_, i) => card(i)).join("");
  dec.querySelector("[data-plan]").textContent = planText(plan);
  const why = dec.querySelector("[data-why]");
  if (other) {
    why.textContent = `Planner estimate: ${kindName[plan.kind]} ${plan.steps} steps, ${kindName[other.kind]} ${other.steps} steps. It picks the cheaper one.`;
  } else {
    why.textContent = plan.kind === "parallel"
      ? `No index on price, so every row must be checked. With ${plan.lanes.length} workers, each scans a share of the table.`
      : "No index and one worker: the database has no better option than checking every row.";
  }
  dec.querySelector("[data-lanes]").innerHTML = plan.lanes.map((lane, li) => {
    const label = plan.kind === "index" ? "Price index" : plan.lanes.length > 1 ? `Worker ${li + 1}` : "Scan";
    // An index lists every entry in price order; the scan stops early.
    const shown = plan.kind === "index" ? ITEMS.map((_, i) => i).sort((a, b) => ITEMS[a].price - ITEMS[b].price || a - b) : lane;
    return `<div class="worker" data-w="${li}"><span class="worker-label">${label}</span><div class="items">${shown.map(card).join("")}</div></div>`;
  }).join("");

  setCount(imp, 0, ITEMS.length);
  setCount(dec, 0, plan.steps);
  imp.querySelector("[data-results]").textContent = "";
  dec.querySelector("[data-results]").textContent = "";
}

function setCount(panel, n, total) {
  panel.querySelector("[data-count]").innerHTML = `step <b>${n}</b> of ${total}`;
}

function showResults(panel, list) {
  panel.querySelector("[data-results]").innerHTML = list.length
    ? `Found: <b>${list.map((i) => ITEMS[i].name).join(", ")}</b>`
    : "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  setup();
  const id = runId;
  const live = () => id === runId;
  runBtn.disabled = true;
  const tick = prefersReducedMotion() ? 360 : 280;

  const impSim = simulate(ITEMS, Q, [ITEMS.map((_, i) => i)]);
  const decSim = simulate(ITEMS, Q, plan.lanes);
  const impEl = (i) => imp.querySelector(`[data-i="${i}"]`);
  const decEl = (lane, i) => dec.querySelector(`[data-w="${lane}"] [data-i="${i}"]`);
  const found = { imp: [], dec: [] };
  let pending = [];
  const settle = () => {
    for (const { el, hit } of pending) { el.classList.remove("cur"); el.classList.add(hit ? "yes" : "no"); }
    pending = [];
  };
  const examine = (el, hit) => { el.classList.add("cur"); pending.push({ el, hit }); };

  const total = Math.max(ITEMS.length, plan.steps);
  for (let t = 0; t < total; t++) {
    settle();
    if (t < impSim.ticks.length) {
      for (const s of impSim.ticks[t]) { examine(impEl(s.item), s.hit); if (s.hit) found.imp.push(s.item); }
      setCount(imp, t + 1, ITEMS.length);
      showResults(imp, found.imp);
    }
    if (t < decSim.ticks.length) {
      for (const s of decSim.ticks[t]) { examine(decEl(s.lane, s.item), s.hit); if (s.hit) found.dec.push(s.item); }
      setCount(dec, t + 1, plan.steps);
      showResults(dec, found.dec);
    } else if (t === decSim.ticks.length && plan.kind === "parallel") {
      setCount(dec, t + 1, plan.steps);
      dec.querySelector("[data-results]").innerHTML += ` <span>(gathered from ${plan.lanes.length} workers)</span>`;
    }
    await sleep(tick);
    if (!live()) return;
  }
  settle();

  const impSteps = ITEMS.length;
  let how;
  if (plan.kind === "index") {
    const read = plan.lanes[0].length;
    how = `The planner used the price index: it read ${read - 1} entries under $15 in price order, stopped at the first entry that cost more, and never looked at the other ${ITEMS.length - read} products.`;
  } else if (plan.kind === "parallel") {
    how = `The planner split the table across ${plan.lanes.length} workers: ${plan.scanSteps} scan steps, then 1 step to gather their results.`;
  } else {
    how = "With one worker and no index, the database has to do what the loop does: check every row.";
  }
  verdict.className = `verdict ${plan.steps < impSteps ? "good" : ""}`;
  verdict.innerHTML = `The loop took ${impSteps} steps. The query took ${plan.steps}, and its SQL never changed. ${how} Both found the same ${found.imp.length} products, but ${sameOrder(found) ? "in the same order this time" : "in a different order"}: without <span class="mono">ORDER BY</span>, SQL promises no order.`;
  verdict.hidden = false;
  runBtn.disabled = false;
}

const sameOrder = ({ imp: a, dec: b }) => a.length === b.length && a.every((v, i) => v === b[i]);

slider(root.querySelector("#workers"), (v) => `${WORKERS[v]} ${WORKERS[v] === 1 ? "worker" : "workers"}`, (v) => { workers = WORKERS[v]; setup(); });
indexBox.addEventListener("change", setup);
runBtn.addEventListener("click", run);
root.querySelector("[data-reset]").addEventListener("click", setup);

// Sanity check that the data matches the prose: six products match.
if (ITEMS.filter((it) => matches(it, Q)).length !== 6) console.warn("query widget: expected six matching products");
