// Chapter 2, lesson 4: a property graph and a Cypher-style pattern query, traversed hop by hop.
import { el, prefersReducedMotion } from "../charts.js";
import { evaluatePerson, setEdge } from "./ch2-logic.js";

/* ---------- The graph ---------- */
const NODES = {
  ines: { label: "Person", name: "Inês" }, tomas: { label: "Person", name: "Tomás" }, lena: { label: "Person", name: "Lena" },
  yuki: { label: "Person", name: "Yuki" }, rafael: { label: "Person", name: "Rafael" },
  porto: { label: "City", name: "Porto" }, lisbon: { label: "City", name: "Lisbon" }, munich: { label: "City", name: "Munich" },
  osaka: { label: "City", name: "Osaka" }, kyoto: { label: "City", name: "Kyoto" }, campinas: { label: "City", name: "Campinas" },
  lisbonD: { label: "Region", name: "Lisbon District" }, bavaria: { label: "Region", name: "Bavaria" },
  kansai: { label: "Region", name: "Kansai" }, saoPaulo: { label: "Region", name: "São Paulo State" },
  minas: { label: "Region", name: "Minas Gerais" },
  pt: { label: "Country", name: "Portugal" }, de: { label: "Country", name: "Germany" },
  jp: { label: "Country", name: "Japan" }, br: { label: "Country", name: "Brazil" },
  eu: { label: "Continent", name: "Europe" }, as: { label: "Continent", name: "Asia" }, sa: { label: "Continent", name: "South America" },
};
const W = (from, to) => ({ id: `w-${from}`, from, to, type: "WITHIN" });
const PE = (from, type, to) => ({ id: `${from}-${type}-${to}`, from, to, type });
const INITIAL = {
  nodes: NODES,
  edges: [
    W("porto", "pt"), W("lisbon", "lisbonD"), W("lisbonD", "pt"), W("munich", "bavaria"), W("bavaria", "de"),
    W("osaka", "kansai"), W("kyoto", "kansai"), W("kansai", "jp"), W("campinas", "saoPaulo"), W("saoPaulo", "br"),
    W("minas", "br"), W("pt", "eu"), W("de", "eu"), W("jp", "as"), W("br", "sa"),
    PE("ines", "BORN_IN", "porto"), PE("ines", "LIVES_IN", "munich"),
    PE("tomas", "BORN_IN", "campinas"), PE("tomas", "LIVES_IN", "lisbon"),
    PE("lena", "BORN_IN", "munich"), PE("lena", "LIVES_IN", "osaka"),
    PE("yuki", "BORN_IN", "osaka"), PE("yuki", "LIVES_IN", "kyoto"),
    PE("rafael", "BORN_IN", "minas"), PE("rafael", "LIVES_IN", "porto"),
  ],
};

/* ---------- Layout: one column per kind of vertex ---------- */
const COLS = { Person: [8, 78], City: [150, 86], Region: [296, 120], Country: [476, 92], Continent: [628, 124] };
const COL_TITLES = { Person: "people", City: "cities", Region: "regions", Country: "countries", Continent: "continents" };
const H = 28;
const TOP = {
  ines: 34, tomas: 112, lena: 190, yuki: 268, rafael: 392,
  porto: 34, lisbon: 90, munich: 150, osaka: 210, kyoto: 262, campinas: 330,
  lisbonD: 90, bavaria: 150, kansai: 236, saoPaulo: 330, minas: 392,
  pt: 62, de: 150, jp: 236, br: 361,
  eu: 106, as: 236, sa: 361,
};
const box = (id) => { const [x, w] = COLS[NODES[id].label]; return { x, y: TOP[id], w }; };
function edgePath(e) {
  const a = box(e.from), b = box(e.to);
  const off = e.type === "BORN_IN" ? -5 : e.type === "LIVES_IN" ? 5 : 0;
  const x1 = a.x + a.w, y1 = a.y + H / 2 + off, x2 = b.x - 3, y2 = b.y + H / 2 + off;
  const c = Math.max(20, (x2 - x1) * 0.5);
  return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
}

/* ---------- DOM ---------- */
const root = document.getElementById("graph");
const svg = root.querySelector("svg");
const logEl = root.querySelector("[data-log]");
const resultsEl = root.querySelector("[data-results]");
const verdict = root.querySelector(".verdict");
const out = (k) => root.querySelector(`[data-out="${k}"]`);
const btn = { run: root.querySelector("[data-run]"), skip: root.querySelector("[data-skip]"), reset: root.querySelector("[data-reset]"), apply: root.querySelector("[data-apply]") };
const sel = { person: root.querySelector("[data-person]"), type: root.querySelector("[data-type]"), place: root.querySelector("[data-place]") };

const defs = el("defs", {}, svg);
const marker = el("marker", { id: "g-arr", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto" }, defs);
el("path", { d: "M0,0 L10,5 L0,10 z", style: "fill:var(--ink-4)" }, marker);
for (const [label, [x]] of Object.entries(COLS)) {
  const t = el("text", { x, y: 18, class: "col-label" }, svg);
  t.textContent = COL_TITLES[label];
}
const gEdges = el("g", {}, svg);
const gNodes = el("g", {}, svg);
const nodeEls = {};
for (const [id, n] of Object.entries(NODES)) {
  const b = box(id);
  const g = el("g", { class: `gn${n.label === "Person" ? " person" : ""}` }, gNodes);
  el("rect", { x: b.x, y: b.y, width: b.w, height: H, rx: n.label === "Person" ? 14 : 6 }, g);
  const t = el("text", { x: b.x + 10, y: b.y + 18 }, g);
  t.textContent = n.name;
  nodeEls[id] = g;
}

let graph = INITIAL;
let edgeEls = {};
let fresh = null;

function drawEdges() {
  gEdges.innerHTML = "";
  edgeEls = {};
  for (const e of graph.edges) {
    const kind = e.type === "BORN_IN" ? "k-born" : e.type === "LIVES_IN" ? "k-lives" : "k-within";
    edgeEls[e.id] = el("path", { d: edgePath(e), class: `ge ${kind}${e.id === fresh ? " fresh" : ""}`, "marker-end": "url(#g-arr)" }, gEdges);
  }
}

/* ---------- Controls for moving an edge ---------- */
const people = Object.keys(NODES).filter((id) => NODES[id].label === "Person");
sel.person.innerHTML = people.map((id) => `<option value="${id}">${NODES[id].name}</option>`).join("");
sel.place.innerHTML = ["City", "Region", "Country", "Continent"].map((label) =>
  `<optgroup label="${COL_TITLES[label]}">${Object.keys(NODES).filter((id) => NODES[id].label === label)
    .map((id) => `<option value="${id}">${NODES[id].name}</option>`).join("")}</optgroup>`).join("");
function syncPlace() {
  const e = graph.edges.find((x) => x.from === sel.person.value && x.type === sel.type.value);
  if (e) sel.place.value = e.to;
}
sel.person.addEventListener("change", syncPlace);
sel.type.addEventListener("change", syncPlace);

/* ---------- Running the query ---------- */
let runId = 0;
let skipping = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (ms) => (skipping ? Promise.resolve() : sleep(ms));

function clearPaths() {
  Object.values(edgeEls).forEach((p) => p.classList.remove("born-path", "lives-path"));
  Object.entries(nodeEls).forEach(([id, g]) => { if (NODES[id].label !== "Person") g.classList.remove("born", "lives"); });
}
function clearAll() {
  clearPaths();
  Object.values(nodeEls).forEach((g) => g.classList.remove("on", "match", "nomatch"));
  logEl.innerHTML = "";
  resultsEl.hidden = true;
  verdict.hidden = true;
  for (const k of ["edges", "people", "matches"]) out(k).textContent = 0;
}

function setBusy(busy) {
  btn.run.disabled = busy;
  btn.skip.disabled = !busy;
  btn.apply.disabled = busy;
}

async function run() {
  const id = ++runId;
  const live = () => id === runId;
  skipping = false;
  fresh = null;
  drawEdges();
  clearAll();
  setBusy(true);
  const hop = prefersReducedMotion() ? 380 : 300;
  let edgesFollowed = 0, matches = 0;
  const rows = [];
  const hops = [];

  for (let i = 0; i < people.length; i++) {
    const pid = people[i];
    const r = evaluatePerson(graph, pid);
    const li = document.createElement("li");
    li.className = "current";
    logEl.appendChild(li);
    [...logEl.children].forEach((x) => x.classList.toggle("current", x === li));
    nodeEls[pid].classList.add("on");
    const parts = [];
    const render = (tail = "") => { li.textContent = `${NODES[pid].name}: ${parts.join("; ")}${tail}`; };

    for (const [type, edge, walk, cls] of [["born in", r.bornEdge, r.born, "born"], ["lives in", r.livesEdge, r.lives, "lives"]]) {
      if (!edge) { parts.push(`no ${type} edge`); render(); continue; }
      const names = [NODES[edge.to].name];
      parts.push(`${type} ${names.join(" → ")}`);
      const idx = parts.length - 1;
      edgeEls[edge.id].classList.add(`${cls}-path`);
      nodeEls[edge.to].classList.add(cls);
      out("edges").textContent = ++edgesFollowed;
      render();
      await wait(hop);
      if (!live()) return;
      for (const e of walk.path) {
        edgeEls[e.id].classList.add(`${cls}-path`);
        nodeEls[e.to].classList.add(cls);
        names.push(NODES[e.to].name);
        parts[idx] = `${type} ${names.join(" → ")}`;
        out("edges").textContent = ++edgesFollowed;
        render();
        await wait(hop);
        if (!live()) return;
      }
      if (!walk.country) { parts[idx] += " (no Country on this path)"; render(); }
      else hops.push(walk.path.length - (walk.continent ? 1 : 0));
    }

    const verdictText = r.match ? ": different continents, match" : (r.born?.continent && r.lives?.continent ? ": same continent" : ": pattern incomplete");
    render(verdictText);
    nodeEls[pid].classList.remove("on");
    nodeEls[pid].classList.add(r.match ? "match" : "nomatch");
    out("people").textContent = i + 1;
    if (r.match) {
      out("matches").textContent = ++matches;
      rows.push([NODES[pid].name, NODES[r.born.country].name, NODES[r.lives.country].name]);
    }
    await wait(hop * 1.6);
    if (!live()) return;
    clearPaths();
  }
  [...logEl.children].forEach((x) => x.classList.remove("current"));

  resultsEl.innerHTML = `<table class="tradeoffs"><tr><th>p.name</th><th>home.name</th><th>now.name</th></tr>${
    rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") : '<tr><td colspan="3">(no rows)</td></tr>'}</table>`;
  resultsEl.hidden = false;
  verdict.className = "verdict good";
  const span = hops.length ? `between ${Math.min(...hops)} and ${Math.max(...hops)}` : "no";
  verdict.textContent = `${matches} of ${people.length} people match. The query followed ${edgesFollowed} edges. Paths took ${span} WITHIN hops to reach a country, and the one pattern WITHIN*0.. covered every length.`;
  verdict.hidden = false;
  setBusy(false);
}

btn.run.addEventListener("click", run);
btn.skip.addEventListener("click", () => { skipping = true; });
btn.reset.addEventListener("click", () => {
  runId++;
  graph = INITIAL;
  fresh = null;
  drawEdges();
  clearAll();
  setBusy(false);
  syncPlace();
});
btn.apply.addEventListener("click", () => {
  const pid = sel.person.value, type = sel.type.value, to = sel.place.value;
  graph = setEdge(graph, pid, type, to);
  fresh = `${pid}-${type}-${to}`;
  drawEdges();
  clearAll();
  const li = document.createElement("li");
  li.textContent = `Moved: ${NODES[pid].name} ${type} → ${NODES[to].name}. Run the query again.`;
  logEl.appendChild(li);
});

drawEdges();
syncPlace();
