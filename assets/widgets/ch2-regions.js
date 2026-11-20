// Chapter 2, lesson 2: renaming a city stored as duplicated text versus as an ID.
import { prefersReducedMotion } from "../charts.js";
import { planRename } from "./ch2-logic.js";

/* ---------- Rename widget ---------- */
{
  const OLD = "Bangalore", NEW = "Bengaluru";
  const CITIES = [{ id: 1, name: OLD }, { id: 2, name: "Pune" }, { id: 3, name: "Chennai" }];
  const PEOPLE = [
    { id: 101, name: "Asha Rao", cityId: 1 }, { id: 102, name: "Daniel Kim", cityId: 1 },
    { id: 103, name: "Priya Nair", cityId: 2 }, { id: 104, name: "Omar Haddad", cityId: 1 },
    { id: 105, name: "Wen Li", cityId: 3 }, { id: 106, name: "Sofia Marin", cityId: 1 },
    { id: 107, name: "Kofi Mensah", cityId: 2 }, { id: 108, name: "Nadia Petrova", cityId: 1 },
  ];

  const root = document.getElementById("rename");
  const panes = { dup: root.querySelector('[data-pane="dup"]'), norm: root.querySelector('[data-pane="norm"]') };
  const logs = { dup: root.querySelector('[data-log="dup"]'), norm: root.querySelector('[data-log="norm"]') };
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const verdict = root.querySelector(".verdict");
  const renameBtn = root.querySelector("[data-rename]");
  const crashBox = root.querySelector("[data-crash]");

  let dup, cities, runId = 0;

  const tbl = (name, cols, rows) => `<div class="rel-table"><p class="rel-name">${name}</p><div class="table-wrap" style="margin:0"><table class="rel">
    <tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>${rows.join("")}</table></div></div>`;

  function render() {
    const cityName = (id) => cities.find((c) => c.id === id).name;
    panes.dup.innerHTML = tbl("profiles", ["id", "name", "city"], dup.map((p) =>
      `<tr><td class="key">${p.id}</td><td>${p.name}</td><td data-c="${p.id}">${p.city}</td></tr>`));
    panes.norm.innerHTML =
      tbl("profiles", ["id", "name", "city_id", "shown as"], PEOPLE.map((p) =>
        `<tr><td class="key">${p.id}</td><td>${p.name}</td><td>${p.cityId}</td><td class="joined" data-s="${p.id}">${cityName(p.cityId)}</td></tr>`)) +
      tbl("cities", ["id", "name"], cities.map((c) => `<tr><td class="key">${c.id}</td><td data-cn="${c.id}">${c.name}</td></tr>`));
  }

  const spellings = () => new Set(dup.filter((p) => p.cityId === 1).map((p) => p.city)).size;

  function reset() {
    runId++;
    dup = PEOPLE.map((p) => ({ ...p, city: CITIES.find((c) => c.id === p.cityId).name }));
    cities = CITIES.map((c) => ({ ...c }));
    render();
    logs.dup.innerHTML = "";
    logs.norm.innerHTML = "";
    out("wa").textContent = 0; out("wb").textContent = 0;
    out("sa").textContent = 1; out("sb").textContent = 1;
    verdict.hidden = true;
    renameBtn.disabled = false;
    crashBox.disabled = false;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (which, text, cls = "") => {
    const li = document.createElement("li");
    li.textContent = text;
    if (cls) li.className = cls;
    logs[which].appendChild(li);
  };

  async function writeCell(td, text) {
    td.classList.add("writing");
    await sleep(160);
    td.textContent = text;
    td.classList.remove("writing");
    td.classList.add("written");
  }

  async function rename() {
    const id = ++runId;
    const live = () => id === runId;
    renameBtn.disabled = true;
    crashBox.disabled = true;
    verdict.hidden = true;
    const crash = crashBox.checked;
    const plan = planRename(dup, OLD, crash);
    const pause = prefersReducedMotion() ? 420 : 340;
    let wa = 0;

    for (let i = 0; i < plan.targets.length; i++) {
      if (i === 0) {
        // The normalized design: one write, then every profile reads the new name through the join.
        cities.find((c) => c.id === 1).name = NEW;
        writeCell(panes.norm.querySelector('[data-cn="1"]'), NEW).then(() => {
          if (!live()) return;
          out("wb").textContent = 1;
          log("norm", `cities row 1 → ${NEW}`, "done");
          PEOPLE.filter((p) => p.cityId === 1).forEach((p) => {
            const td = panes.norm.querySelector(`[data-s="${p.id}"]`);
            td.textContent = NEW;
            td.classList.replace("joined", "via");
          });
          log("norm", `${PEOPLE.filter((p) => p.cityId === 1).length} profiles show ${NEW} through the join, with no writes`);
        });
      }
      const pid = plan.targets[i];
      if (i >= plan.applied) {
        log("dup", `crash before profile ${pid}`, "fail");
        for (const m of plan.missed) panes.dup.querySelector(`[data-c="${m}"]`).classList.add("stale");
        break;
      }
      dup.find((p) => p.id === pid).city = NEW;
      await writeCell(panes.dup.querySelector(`[data-c="${pid}"]`), NEW);
      if (!live()) return;
      out("wa").textContent = ++wa;
      out("sa").textContent = spellings();
      log("dup", `profile ${pid} → ${NEW}`, "done");
      await sleep(pause);
      if (!live()) return;
    }
    out("sa").textContent = spellings();

    if (crash) {
      verdict.className = "verdict bad";
      verdict.innerHTML = `The crash left ${plan.applied} profiles saying ${NEW} and ${plan.missed.length} still saying ${OLD}. A search for people in ${NEW} now finds ${plan.applied} of ${plan.targets.length}, and nothing records which rows were missed. The normalized design has no halfway state: its single write either happened or it did not.`;
    } else {
      verdict.className = "verdict good";
      verdict.innerHTML = `Duplicated text needed ${wa} writes, one per profile in that city. The normalized design needed 1, and every profile picked up the new name through the join. With a million people in ${NEW}, the left design needs a million writes; the right still needs one.`;
    }
    verdict.hidden = false;
  }

  renameBtn.addEventListener("click", rename);
  root.querySelector("[data-reset]").addEventListener("click", reset);
  reset();
}

/* ---------- Many-to-many diagram ---------- */
{
  const root = document.getElementById("m2m");
  const outEl = root.querySelector("[data-m2m-out]");
  const DEFAULT = outEl.textContent;
  const PEOPLE = { 1: "Asha", 2: "Daniel", 3: "Priya", 4: "Omar" };
  const ORGS = { 10: "Lumen Analytics", 11: "Harbor Bank", 12: "OpenRail Guild" };
  const ROWS = [...root.querySelectorAll("[data-r]")].map((g) => g.dataset.r.split(" "));

  function clear() {
    root.querySelectorAll(".active").forEach((n) => n.classList.remove("active"));
  }
  function show(k) {
    clear();
    if (!k) { outEl.textContent = DEFAULT; return; }
    const isPerson = k[0] === "p";
    const id = k.slice(1);
    const pairs = ROWS.filter(([p, o]) => (isPerson ? p : o) === id);
    root.querySelector(`[data-k="${k}"]`).classList.add("active");
    for (const [p, o] of pairs) {
      root.querySelector(`[data-r="${p} ${o}"]`).classList.add("active");
      root.querySelectorAll(`[data-e="${p} ${o}"]`).forEach((e) => e.classList.add("active"));
      root.querySelector(`[data-k="${isPerson ? "o" + o : "p" + p}"]`).classList.add("active");
    }
    const others = pairs.map(([p, o]) => (isPerson ? ORGS[o] : PEOPLE[p])).join(", ");
    outEl.innerHTML = isPerson
      ? `${PEOPLE[id]} has ${pairs.length} ${pairs.length === 1 ? "row" : "rows"} in memberships: ${others}. <span class="mono">WHERE person_id = ${id}</span>`
      : `${ORGS[id]} has ${pairs.length} ${pairs.length === 1 ? "member" : "members"}: ${others}. <span class="mono">WHERE org_id = ${id}</span>`;
  }
  const keyOf = (e) => e.target.closest?.("[data-k]")?.dataset.k ?? null;
  const svg = root.querySelector("svg");
  svg.addEventListener("pointerover", (e) => { const k = keyOf(e); if (k) show(k); });
  svg.addEventListener("pointerleave", () => show(null));
  svg.addEventListener("focusin", (e) => show(keyOf(e)));
  svg.addEventListener("focusout", () => show(null));
  svg.addEventListener("click", (e) => { const k = keyOf(e); if (k) show(k); });
}
