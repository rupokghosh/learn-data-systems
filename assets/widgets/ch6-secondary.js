// Chapter 6, lesson 2: local (document-partitioned) versus global (term-partitioned) secondary indexes.
import { el, prefersReducedMotion, rng, slider } from "../charts.js";
import { NP, CITIES, ID_RANGES, TERM_RANGES, docPartition, createStore } from "../engines/ch6-index.js";

const root = document.getElementById("sec-index");
const stage = root.querySelector(".ch6-stage");
const partsEl = root.querySelector(".ch6-parts");
const clientEl = root.querySelector(".ch6-client");
const overlay = root.querySelector(".ch6-overlay");
const verdict = root.querySelector(".verdict");
const out = (n) => root.querySelector(`[data-out="${n}"]`);
const lagInput = root.querySelector("#sec-lag");

let store, rand, mode = "local", lag = 2000, epoch = 0, readGen = 0;
let inFlight = 0;
let marks = { probe: new Set(), rows: new Set(), docs: new Set(), pending: new Map(), lat: new Map() };
const timers = new Set();
const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };

function reset() {
  epoch++;
  timers.forEach(clearTimeout); timers.clear();
  overlay.innerHTML = "";
  store = createStore(11);
  rand = rng(5);
  inFlight = 0;
  clearMarks();
  out("result").textContent = "Pick a city to query, or write a listing.";
  out("read").textContent = "none yet";
  out("write").textContent = "none yet";
  out("lat").textContent = "none yet";
  verdict.textContent = "";
  verdict.className = "verdict";
  render();
}
function clearMarks() { marks = { probe: new Set(), rows: new Set(), docs: new Set(), pending: marks.pending ?? new Map(), lat: new Map() }; }

// ---------- rendering ----------
function render() {
  partsEl.innerHTML = "";
  for (let p = 0; p < NP; p++) {
    const part = document.createElement("div");
    part.className = "ch6-part" + (marks.probe.has(p) ? " probe" : "");
    part.dataset.p = p;
    const lat = marks.lat.get(p);
    part.innerHTML = `<div class="ch6-part-head"><span>Partition ${p}</span><span class="lat${lat?.slow ? " slow" : ""}">${lat ? lat.ms + " ms" : ""}</span></div>
      <div class="ch6-part-sub">listings ${ID_RANGES[p]}</div>`;
    const docs = document.createElement("div");
    docs.className = "ch6-docs";
    for (const [id, city] of store.docsIn(p)) {
      const r = document.createElement("span");
      r.className = "rec" + (marks.docs.has(id) ? " hl" : "");
      r.innerHTML = `<span class="k">#${id}</span><span class="v">${city}</span>`;
      docs.appendChild(r);
    }
    part.appendChild(docs);
    const idx = document.createElement("div");
    idx.className = "ch6-idx";
    const entries = mode === "local" ? store.localIndex(p) : store.globalPart(p);
    const title = mode === "local" ? "Local index on city" : `Global index, cities ${TERM_RANGES[p]}`;
    let rows = `<div class="ch6-idx-title">${title}</div>`;
    const cities = mode === "local" ? CITIES.filter((c) => entries.has(c)) : [...entries.keys()];
    for (const c of cities) {
      const ids = entries.get(c);
      const key = `${p}:${c}`;
      const pend = marks.pending.get(key) || [];
      const pendTxt = pend.map((o) => `<span class="pend">${o.op === "add" ? "+" : "−"}#${o.id}</span>`).join(" ");
      rows += `<div class="ch6-idx-row${marks.rows.has(key) ? " hl" : ""}${pend.length ? " pending" : ""}"><span class="t">${c}</span><span class="ids">${ids.length ? ids.map((i) => "#" + i).join(" ") : "none"} ${pendTxt}</span></div>`;
    }
    idx.innerHTML = rows;
    part.appendChild(idx);
    partsEl.appendChild(part);
  }
  out("flight").textContent = String(inFlight);
}

// ---------- motion ----------
const partEl = (p) => partsEl.children[p];
function anchor(node, side) {
  const s = stage.getBoundingClientRect(), r = node.getBoundingClientRect();
  return { x: r.left - s.left + r.width / 2, y: side === "top" ? r.top - s.top + 2 : r.bottom - s.top - 2 };
}
/** Moves a dot between two elements. Resolves on arrival (immediately with reduced motion). */
function fly(fromNode, toNode, cls, dur) {
  if (prefersReducedMotion()) return new Promise((r) => later(r, Math.min(dur, 250)));
  const fromTop = fromNode.getBoundingClientRect().top > toNode.getBoundingClientRect().top;
  const a = anchor(fromNode, fromTop ? "top" : "bottom");
  const b = anchor(toNode, fromTop ? "bottom" : "top");
  if (fromNode === toNode) { a.y = b.y = anchor(fromNode, "top").y + 10; }
  const g = el("circle", { r: 5, class: "ch6-flydot " + cls }, overlay);
  g.style.transform = `translate(${a.x}px, ${a.y}px)`;
  g.getBoundingClientRect();
  g.style.transition = `transform ${dur}ms var(--ease-in-out)`;
  g.style.transform = `translate(${b.x}px, ${b.y}px)`;
  return new Promise((r) => later(() => { g.remove(); r(); }, dur));
}

function sampleLatency() {
  const slow = rand() < 0.12;
  return { ms: slow ? 60 + Math.floor(rand() * 140) : 4 + Math.floor(rand() * 9), slow };
}

// ---------- actions ----------
async function read(city) {
  const my = ++readGen, ep = epoch;
  const stale = () => my !== readGen || ep !== epoch;
  clearMarks(); render();
  const q = store.query(city, mode);
  const lats = q.parts.map(() => sampleLatency());
  out("read").textContent = `${q.parts.length} of ${NP}`;
  out("result").textContent = `Querying city = ${city}...`;
  await Promise.all(q.parts.map(async (p, i) => {
    await fly(clientEl, partEl(p), "req", 480);
    if (stale()) return;
    marks.probe.add(p);
    marks.rows.add(`${p}:${city}`);
    marks.lat.set(p, lats[i]);
    render();
    await new Promise((r) => later(r, Math.min(1400, lats[i].ms * 7)));
    if (stale()) return;
    await fly(partEl(p), clientEl, "res", 480);
  }));
  if (stale()) return;
  const worst = Math.max(...lats.map((l) => l.ms));
  const slowP = q.parts[lats.findIndex((l) => l.ms === worst)];
  const ids = q.ids;
  out("lat").textContent = `${worst} ms`;
  out("result").innerHTML = `${city}: ${ids.length} ${ids.length === 1 ? "listing" : "listings"}${ids.length ? " (" + ids.map((i) => "#" + i).join(", ") + ")" : ""}`;
  if (mode === "local") {
    verdict.className = "verdict" + (worst > 40 ? " bad" : "");
    verdict.textContent = worst > 40
      ? `All four partitions had to answer, and the read could not finish until the slowest did: partition ${slowP} took ${worst} ms while the others took a few. With more partitions, a slow one in the set becomes the norm.`
      : `All four partitions had to answer, even those with no listings in ${city}. The read took as long as the slowest reply, ${worst} ms. Query a few more times and watch for a slow partition.`;
  } else if (q.missing.length || q.extra.length) {
    verdict.className = "verdict bad";
    const bits = [];
    if (q.missing.length) bits.push(`${q.missing.map((i) => "#" + i).join(", ")} ${q.missing.length === 1 ? "is" : "are"} in ${city} but not yet in the index`);
    if (q.extra.length) bits.push(`${q.extra.map((i) => "#" + i).join(", ")} moved away but ${q.extra.length === 1 ? "is" : "are"} still listed`);
    verdict.textContent = `One partition answered, but the answer is stale: ${bits.join("; ")}. The index update is still in flight.`;
  } else {
    verdict.className = "verdict good";
    verdict.textContent = `Only partition ${q.parts[0]}, which holds the index entries for ${city}, was asked. The entry carries a copy of each listing's summary, so no other partition is involved.`;
  }
}

async function write(kind) {
  const my = epoch;
  let id, city;
  if (kind === "add") {
    id = store.freshId(rand);
    city = CITIES[Math.floor(rand() * CITIES.length)];
  } else {
    const all = [...store.docs.keys()];
    id = all[Math.floor(rand() * all.length)];
    const others = CITIES.filter((c) => c !== store.docs.get(id));
    city = others[Math.floor(rand() * others.length)];
  }
  const p = docPartition(id);
  const before = store.docs.get(id);
  out("result").textContent = before ? `Moving listing #${id} from ${before} to ${city}...` : `Adding listing #${id} in ${city}...`;
  await fly(clientEl, partEl(p), "req", 480);
  if (my !== epoch) return;
  const w = store.write(id, city, mode);
  clearMarks();
  marks.docs.add(id);
  if (mode === "local") marks.rows.add(`${p}:${city}`);
  for (const o of w.ops) {
    const key = `${o.part}:${o.city}`;
    if (!marks.pending.has(key)) marks.pending.set(key, []);
    marks.pending.get(key).push(o);
    inFlight++;
  }
  marks.probe.add(p);
  out("write").textContent = String(w.touched.length);
  render();
  fly(partEl(p), clientEl, "res", 480).then(() => {
    if (my !== epoch) return;
    out("result").textContent = before ? `Listing #${id} now in ${city}. Write acknowledged.` : `Listing #${id} in ${city} stored. Write acknowledged.`;
  });
  if (mode === "local") {
    verdict.className = "verdict good";
    verdict.textContent = `One partition did all the work: it stored listing #${id} and updated its own index in the same local write. Nothing else had to change.`;
    return;
  }
  const parts = [...new Set(w.ops.map((o) => o.part))].filter((x) => x !== p);
  verdict.className = "verdict";
  verdict.textContent = `The write was acknowledged as soon as partition ${p} stored the listing. The index ${w.ops.length === 1 ? "entry lives" : "entries live"} on partition ${[...new Set(w.ops.map((o) => o.part))].join(" and ")}${parts.length ? ", so the update has to travel there" : ""}, and it is applied asynchronously. Query ${city} before it lands to see a stale answer.`;
  // asynchronous index maintenance
  for (const o of w.ops) {
    later(async () => {
      if (my !== epoch) return;
      await fly(partEl(p), partEl(o.part), "idx", 520);
      if (my !== epoch) return;
      store.applyOp(o);
      const key = `${o.part}:${o.city}`;
      const list = marks.pending.get(key) || [];
      list.splice(list.indexOf(o), 1);
      if (!list.length) marks.pending.delete(key);
      inFlight--;
      marks.rows.add(key);
      render();
    }, lag);
  }
}

// ---------- controls ----------
function setMode(m) {
  mode = m;
  root.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  epoch++;
  timers.forEach(clearTimeout); timers.clear();
  overlay.innerHTML = "";
  store.syncGlobal();
  inFlight = 0;
  marks.pending = new Map();
  clearMarks();
  verdict.textContent = ""; verdict.className = "verdict";
  out("result").textContent = m === "local"
    ? "Each partition indexes only its own listings."
    : "The index is partitioned by city name, separately from the listings.";
  render();
}

root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
const cityRow = root.querySelector("[data-cities]");
for (const c of CITIES) {
  const b = document.createElement("button");
  b.className = "btn"; b.textContent = c;
  b.addEventListener("click", () => read(c));
  cityRow.appendChild(b);
}
root.querySelector("[data-act=add]").addEventListener("click", () => write("add"));
root.querySelector("[data-act=move]").addEventListener("click", () => write("move"));
root.querySelector("[data-act=reset]").addEventListener("click", () => { reset(); setMode(mode); });
slider(lagInput, (v) => (v === 0 ? "none" : (v / 1000).toFixed(v % 1000 ? 2 : 0).replace(/0$/, "") + " s"), (v) => { lag = v; });

reset();
setMode("local");
