// Chapter 12, lesson 4: how few attributes it takes to single someone out of an "anonymous" dataset.
import { fmt } from "../charts.js";
import { population, anonymity, ATTRS } from "../engines/ch12-ethics.js";

const root = document.getElementById("reident");
const bar = root.querySelector(".anon-bar");
const stepsEl = root.querySelector(".anon-steps");
const verdict = root.querySelector(".verdict");
const boxes = [...root.querySelectorAll("[data-attr]")];
const out = (k) => root.querySelector(`[data-out="${k}"]`);
const btnNext = root.querySelector('[data-act="next"]');

const people = population(20000, 2026);
const N = people.length;
const BUCKETS = [
  { key: "unique", label: "unique (1)", color: "var(--red)" },
  { key: "small", label: "2 to 4", color: "var(--orange)" },
  { key: "medium", label: "5 to 19", color: "var(--purple)" },
  { key: "large", label: "20 or more", color: "var(--ink-4)" },
];
root.querySelector(".legend").innerHTML = BUCKETS.map((b) => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join("");

// Pick people whose story is interesting: hidden by one attribute, exposed by all five.
const all = anonymity(people, ATTRS.map((a) => a.key)).size;
const two = anonymity(people, ["postcode", "year"]).size;
const candidates = [];
for (let i = 0; i < N && candidates.length < 40; i++) if (all[i] === 1 && two[i] > 3) candidates.push(i);
let who = 0;

const fmtVal = (k, v) => (k === "year" ? `born ${v}` : k === "gender" ? { F: "female", M: "male", X: "another gender" }[v] : v);

function update() {
  const keys = ATTRS.filter((a) => boxes.find((b) => b.dataset.attr === a.key).checked).map((a) => a.key);
  const res = keys.length ? anonymity(people, keys) : { buckets: { unique: 0, small: 0, medium: 0, large: N }, groups: 1, size: people.map(() => N) };
  bar.innerHTML = BUCKETS.map((b) => `<span style="width:${(res.buckets[b.key] / N) * 100}%;background:${b.color}" title="${b.label}: ${res.buckets[b.key]}"></span>`).join("");
  out("unique").textContent = ((res.buckets.unique / N) * 100).toFixed(1) + "%";
  out("small").textContent = (((res.buckets.unique + res.buckets.small) / N) * 100).toFixed(1) + "%";
  out("groups").textContent = fmt(res.groups);

  // Follow one person as attributes are released, in the order listed.
  const p = people[candidates[who % candidates.length]];
  const idx = candidates[who % candidates.length];
  let used = [], lastSize = N;
  stepsEl.innerHTML = `<li><span>Everyone in the dataset</span><span class="n">${fmt(N, 0)}</span></li>` + ATTRS.map((a) => {
    const on = keys.includes(a.key);
    if (!on) return `<li class="off"><span>${a.label} <span class="val">not released</span></span><span class="n">—</span></li>`;
    used.push(a.key);
    lastSize = anonymity(people, used).size[idx];
    return `<li class="${lastSize === 1 ? "unique" : ""}"><span>${a.label} <span class="val">${fmtVal(a.key, p[a.key])}</span></span><span class="n">${lastSize === 1 ? "1: found" : fmt(lastSize, 0)}</span></li>`;
  }).join("");

  const u = res.buckets.unique / N;
  verdict.className = "verdict " + (u > 0.5 ? "bad" : "");
  verdict.textContent = keys.length === 0
    ? "With no attributes released, everyone hides among all 20,000 rows."
    : u === 0
      ? "Nobody is unique yet. Add a second attribute."
      : `${(u * 100).toFixed(u < 0.01 ? 1 : 0)}% of people are the only row with their combination. Anyone who knows those few facts about them, from a social profile or a shared receipt, can find their row and read everything else in it.`;
}

boxes.forEach((b) => b.addEventListener("change", update));
btnNext.addEventListener("click", () => { who++; update(); });
update();
