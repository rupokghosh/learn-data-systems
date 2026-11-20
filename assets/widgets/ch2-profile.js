// Chapter 2, lesson 1: one profile as a JSON document and as relational tables.
import { prefersReducedMotion } from "../charts.js";

const P = {
  id: 4127, name: "Mira Okafor", headline: "Payments infrastructure", location: "Lisbon, Portugal",
  positions: [
    { id: 901, title: "Staff Engineer", org: "Tidewater Pay", from: 2021, to: null },
    { id: 902, title: "Senior Engineer", org: "Kestrel Freight", from: 2017, to: 2021 },
    { id: 903, title: "Software Engineer", org: "Brightfold", from: 2014, to: 2017 },
  ],
  education: [
    { id: 311, school: "University of Porto", degree: "MSc Computer Science", from: 2012, to: 2014 },
    { id: 312, school: "University of Lagos", degree: "BSc Mathematics", from: 2008, to: 2012 },
  ],
};

const root = document.getElementById("profile");
const pre = root.querySelector("pre.json");
const tablesEl = root.querySelector(".rel-tables");
const readout = root.querySelector("[data-readout]");
const verdict = root.querySelector(".verdict");
const logs = { doc: root.querySelector('[data-log="doc"]'), rel: root.querySelector('[data-log="rel"]') };
const out = (k) => root.querySelector(`[data-out="${k}"]`);
const loadBtn = root.querySelector("[data-load]");

/* ---------- What each key means in each model ---------- */
const DESC = {
  uid: ["user_id", "users.id, and copied into user_id on every positions and education row"],
  name: ["name", "users.name"],
  headline: ["headline", "users.headline"],
  location: ["location", "users.location"],
};
P.positions.forEach((p, i) => {
  for (const c of ["title", "org", "from", "to"]) DESC[`pos.${i}.${c}`] = [`positions[${i}].${c}`, `positions.${c}, row id ${p.id}`];
});
P.education.forEach((e, i) => {
  for (const c of ["school", "degree", "from", "to"]) DESC[`edu.${i}.${c}`] = [`education[${i}].${c}`, `education.${c}, row id ${e.id}`];
});

/* ---------- Build the JSON document ---------- */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const lit = (v) => (v === null ? "null" : typeof v === "number" ? String(v) : `"${esc(v)}"`);
const f = (key, v) => `<span data-f="${key}" tabindex="0">${lit(v)}</span>`;
const k = (name) => `<span class="jk">"${name}"</span>: `;

const lines = ["{",
  `  ${k("user_id")}${f("uid", P.id)},`,
  `  ${k("name")}${f("name", P.name)},`,
  `  ${k("headline")}${f("headline", P.headline)},`,
  `  ${k("location")}${f("location", P.location)},`,
  `  ${k("positions")}[`];
P.positions.forEach((p, i) => {
  const last = i === P.positions.length - 1;
  lines.push(`    { ${k("title")}${f(`pos.${i}.title`, p.title)},`);
  lines.push(`      ${k("org")}${f(`pos.${i}.org`, p.org)},`);
  lines.push(`      ${k("from")}${f(`pos.${i}.from`, p.from)}, ${k("to")}${f(`pos.${i}.to`, p.to)} }${last ? "" : ","}`);
});
lines.push("  ],", `  ${k("education")}[`);
P.education.forEach((e, i) => {
  const last = i === P.education.length - 1;
  lines.push(`    { ${k("school")}${f(`edu.${i}.school`, e.school)},`);
  lines.push(`      ${k("degree")}${f(`edu.${i}.degree`, e.degree)},`);
  lines.push(`      ${k("from")}${f(`edu.${i}.from`, e.from)}, ${k("to")}${f(`edu.${i}.to`, e.to)} }${last ? "" : ","}`);
});
lines.push("  ]", "}");
pre.innerHTML = lines.join("\n");

/* ---------- Build the three tables ---------- */
const cell = (key, v, cls = "") => `<td${key ? ` data-f="${key}"` : ""}${cls ? ` class="${cls}"` : ""}>${v === null ? "NULL" : esc(v)}</td>`;
function table(name, cols, rows) {
  return `<div class="rel-table"><p class="rel-name">${name}</p><div class="table-wrap" style="margin:0"><table class="rel">
    <tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>${rows.join("")}</table></div></div>`;
}
tablesEl.innerHTML =
  table("users", ["id", "name", "headline", "location"], [
    `<tr data-row="users">${cell("uid", P.id)}${cell("name", P.name)}${cell("headline", P.headline)}${cell("location", P.location)}</tr>`,
  ]) +
  table("positions", ["id", "user_id", "title", "org", "from", "to"], P.positions.map((p, i) =>
    `<tr data-row="positions">${cell(null, p.id, "key")}${cell("uid", P.id)}${cell(`pos.${i}.title`, p.title)}${cell(`pos.${i}.org`, p.org)}${cell(`pos.${i}.from`, p.from)}${cell(`pos.${i}.to`, p.to)}</tr>`)) +
  table("education", ["id", "user_id", "school", "degree", "from", "to"], P.education.map((e, i) =>
    `<tr data-row="education">${cell(null, e.id, "key")}${cell("uid", P.id)}${cell(`edu.${i}.school`, e.school)}${cell(`edu.${i}.degree`, e.degree)}${cell(`edu.${i}.from`, e.from)}${cell(`edu.${i}.to`, e.to)}</tr>`));

/* ---------- Linked highlighting ---------- */
const fields = [...root.querySelectorAll("[data-f]")];
const DEFAULT_READOUT = "Hover or tap a value.";
let pinned = null;

function show(key) {
  fields.forEach((n) => n.classList.toggle("is-hl", key !== null && n.dataset.f === key));
  if (!key) { readout.textContent = DEFAULT_READOUT; return; }
  const [doc, rel] = DESC[key];
  readout.innerHTML = `Document: <span class="mono">${doc}</span> &nbsp;·&nbsp; Tables: <span class="mono">${rel}</span>${pinned === key ? " &nbsp;(pinned)" : ""}`;
}
const keyOf = (e) => e.target.closest?.("[data-f]")?.dataset.f ?? null;
const split = root.querySelector(".split");
split.addEventListener("pointerover", (e) => { const key = keyOf(e); if (key) show(key); });
split.addEventListener("pointerleave", () => show(pinned));
split.addEventListener("focusin", (e) => { const key = keyOf(e); if (key) show(key); });
split.addEventListener("focusout", () => show(pinned));
function togglePin(key) { pinned = pinned === key ? null : key; show(pinned ?? key); }
split.addEventListener("click", (e) => { const key = keyOf(e); if (key) togglePin(key); });
split.addEventListener("keydown", (e) => {
  const key = keyOf(e);
  if (key && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); togglePin(key); }
});

/* ---------- Load the whole profile ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;
let runId = 0;
const counts = { dq: 0, dr: 0, rq: 0, rr: 0 };
const setCount = (k, v) => { counts[k] = v; out(k).textContent = v; };

function logLine(which, html) {
  const li = document.createElement("li");
  li.innerHTML = html;
  logs[which].appendChild(li);
  return li;
}

function reset() {
  runId++;
  running = false;
  loadBtn.disabled = false;
  pre.classList.remove("is-read");
  root.querySelectorAll("tr.is-read").forEach((tr) => tr.classList.remove("is-read"));
  logs.doc.innerHTML = "";
  logs.rel.innerHTML = "";
  for (const key of Object.keys(counts)) setCount(key, 0);
  verdict.hidden = true;
}

const QUERIES = [
  { table: "users", sql: `SELECT * FROM users WHERE id = ${P.id};` },
  { table: "positions", sql: `SELECT * FROM positions WHERE user_id = ${P.id};` },
  { table: "education", sql: `SELECT * FROM education WHERE user_id = ${P.id};` },
];

async function load() {
  if (running) return;
  reset();
  running = true;
  loadBtn.disabled = true;
  const id = runId;
  const live = () => id === runId;
  const rowPause = prefersReducedMotion() ? 260 : 180;

  // Both models start at the same moment. The document needs one step.
  const docLi = logLine("doc", `db.profiles.findOne({ user_id: ${P.id} })`);
  for (let q = 0; q < QUERIES.length; q++) {
    const { table: t, sql } = QUERIES[q];
    const li = logLine("rel", sql);
    setCount("rq", q + 1);
    if (q === 0) { pre.classList.add("is-read"); setCount("dq", 1); setCount("dr", 1); }
    const rows = [...tablesEl.querySelectorAll(`tr[data-row="${t}"]`)];
    for (const tr of rows) {
      await sleep(rowPause);
      if (!live()) return;
      tr.classList.add("is-read");
      setCount("rr", counts.rr + 1);
    }
    li.classList.add("done");
    li.insertAdjacentHTML("beforeend", ` <span class="cnt">→ ${rows.length} ${rows.length === 1 ? "row" : "rows"}</span>`);
    if (q === 0) {
      docLi.classList.add("done");
      docLi.insertAdjacentHTML("beforeend", ` <span class="cnt">→ 1 document, done</span>`);
    }
    await sleep(520);
    if (!live()) return;
  }
  verdict.className = "verdict good";
  verdict.innerHTML = `The document store found one key and read one contiguous value. The relational design sent ${QUERIES.length} queries and read ${counts.rr} rows from ${QUERIES.length} tables, finding the child rows through an index on <span class="mono">user_id</span>. A single query with joins would save round trips, but the database would still visit all three tables.`;
  verdict.hidden = false;
  loadBtn.disabled = false;
  running = false;
}

loadBtn.addEventListener("click", load);
root.querySelector("[data-reset]").addEventListener("click", reset);
