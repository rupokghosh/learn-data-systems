// Lesson: Forward and backward compatibility. A schema evolution lab and a rolling upgrade.
import { V1, CHANGES, evolve, resolve, schemaText, initialUpgrade, edit, upgrade, KNOWS, FIELD_NAMES } from "../engines/ch4-evolve.js";
import { esc } from "./ch4-byteview.js";
import { prefersReducedMotion } from "../charts.js";

/* ---------------- Schema evolution lab ---------------- */
{
  const root = document.getElementById("evo-lab");
  const $ = (s) => root.querySelector(s);
  let format = "protobuf";
  const on = {};

  const grid = $(".change-grid");
  for (const c of CHANGES) {
    const l = document.createElement("label");
    l.className = "btn check";
    l.innerHTML = `<input type="checkbox" data-change="${c.id}"> ${esc(c.label)}`;
    grid.appendChild(l);
  }
  const boxes = [...grid.querySelectorAll("input")];

  const FORMAT_NAME = { protobuf: "Protocol Buffers", thrift: "Thrift", avro: "Avro" };
  const CELLS = [
    { w: "v1", r: "v1", who: "Old code reads old data", tag: "" },
    { w: "v1", r: "v2", who: "New code reads old data", tag: "backward compatibility" },
    { w: "v2", r: "v1", who: "Old code reads new data", tag: "forward compatibility" },
    { w: "v2", r: "v2", who: "New code reads new data", tag: "" },
  ];

  const statusText = (res) => {
    if (res.status === "fail") return "Fails to decode";
    if (res.status === "lossy") return "Decodes, but a value is lost or changed";
    if (res.status === "exact") return "Decodes exactly";
    if (res.defaults && res.skipped) return "Decodes, with defaults and skipped fields";
    if (res.defaults) return "Decodes, with defaults filled in";
    return "Decodes, skipping unknown fields";
  };

  const pre = (lines) => lines.map((l) => `<span class="ln${l.change ? " " + l.change : ""}">${esc(l.text) || " "}</span>`).join("");

  function draw() {
    boxes.forEach((b) => { on[b.dataset.change] = b.checked; });
    // Dependencies between toggles.
    for (const c of CHANGES) {
      const box = boxes.find((b) => b.dataset.change === c.id);
      const blocked = (c.needs && !on[c.needs]) || (c.conflicts && on[c.conflicts]);
      box.disabled = !!blocked;
      if (blocked && box.checked) { box.checked = false; on[c.id] = false; }
    }
    const v2 = evolve(on);
    const schemas = { v1: V1, v2 };
    $("#schema-v1").innerHTML = pre(schemaText(format, V1));
    $("#schema-v2").innerHTML = pre(schemaText(format, v2, V1));

    const mx = $(".matrix");
    mx.textContent = "";
    const results = {};
    for (const c of CELLS) {
      const res = resolve(format, schemas[c.w], schemas[c.r]);
      results[c.w + c.r] = res;
      const d = document.createElement("div");
      d.className = `mx-cell ${res.status}`;
      const chips = res.decoded.map((x) =>
        `<span class="rec${x.how === "default" ? " dflt" : x.how === "changed" ? " chg" : ""}"><span class="k">${esc(x.name)}</span><span class="v">${esc(x.value)}</span></span>`).join("");
      const notes = res.notes.length
        ? `<ul>${res.notes.map((n) => `<li class="${n.cls}">${esc(n.text)}</li>`).join("")}</ul>`
        : `<ul><li>Same schema on both sides.</li></ul>`;
      d.innerHTML = `<div class="mx-who"><span>${c.who}</span><span>${c.tag}</span></div>
        <div class="mx-status">${statusText(res)}</div>
        ${chips ? `<div class="mx-recs">${chips}</div>` : ""}${notes}`;
      mx.appendChild(d);
    }
    const ok = (r) => r.status === "exact" || r.status === "compatible";
    const back = results.v1v2, fwd = results.v2v1;
    $("#st-back").textContent = ok(back) ? "Yes" : back.status === "lossy" ? "Lossy" : "No";
    $("#st-fwd").textContent = ok(fwd) ? "Yes" : fwd.status === "lossy" ? "Lossy" : "No";
    const v = $("#evo-verdict");
    const changed = Object.values(on).some(Boolean);
    if (!changed) { v.className = "verdict"; v.textContent = "Toggle a change to create v2 of the schema."; }
    else if (ok(back) && ok(fwd)) { v.className = "verdict good"; v.textContent = `Safe for a rolling upgrade in ${FORMAT_NAME[format]}: old and new code can read each other's data in both directions.`; }
    else { v.className = "verdict bad"; v.textContent = `Not safe while old and new code run side by side. ${!ok(back) ? "New code cannot reliably read data written before the change. " : ""}${!ok(fwd) ? "Old code cannot reliably read data written after it." : ""}`; }
  }

  root.querySelectorAll("[data-format]").forEach((b) => b.addEventListener("click", () => {
    format = b.dataset.format;
    root.querySelectorAll("[data-format]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  }));
  boxes.forEach((b) => b.addEventListener("change", draw));
  draw();
}

/* ---------------- Rolling upgrade ---------------- */
{
  const root = document.getElementById("rolling");
  const $ = (s) => root.querySelector(s);
  const preserve = $("#preserve");
  const grid = $(".srv-grid");
  const log = $(".steps");
  let state = initialUpgrade();
  let queue = [];
  let running = false;
  let gen = 0;
  let busy = { srv: -1, db: false, flow: "" };
  let mem = {}; // server index -> { fields, unknown, changedTag }

  const wait = (ms) => (prefersReducedMotion() ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
  const fmtVal = (v) => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v));
  const chip = (f, cls = "") => `<span class="rec ${cls}"><span class="k">${FIELD_NAMES[f.tag]}</span><span class="v">${esc(fmtVal(f.value))}</span></span>`;

  // Build server cards once.
  state.servers.forEach((s, i) => {
    const d = document.createElement("div");
    d.className = "srv";
    d.innerHTML = `<div class="srv-name"><span>${s.id}</span><span class="vtag"></span></div>
      <div class="srv-knows"></div>
      <div class="srv-mem"></div>
      <button class="btn" type="button" data-act="edit" data-i="${i}">Edit row</button>
      <button class="btn" type="button" data-act="upgrade" data-i="${i}">Deploy v2</button>`;
    grid.appendChild(d);
  });
  const cards = [...grid.children];

  function render() {
    state.servers.forEach((s, i) => {
      const c = cards[i];
      c.classList.toggle("busy", busy.srv === i);
      const tag = c.querySelector(".vtag");
      tag.textContent = `v${s.v}`;
      tag.className = `vtag v${s.v}`;
      c.querySelector(".srv-knows").textContent = s.v === 1 ? "knows owner, sizeBytes, labels" : "also knows checksum (tag 4)";
      c.querySelector("[data-act=upgrade]").disabled = s.v === 2;
      const m = mem[i];
      c.querySelector(".srv-mem").innerHTML = m
        ? m.fields.map((f) => chip(f, f.tag === 4 ? "newf" : f.tag === m.changedTag ? "hl" : "")).join("") +
          m.unknown.map((f) => `<span class="rec unk"><span class="k">tag ${f.tag}</span><span class="v">kept as bytes</span></span>`).join("")
        : "";
    });
    $(".dbbox").classList.toggle("busy", busy.db);
    const fl = $(".flowline span");
    fl.textContent = busy.flow;
    fl.classList.toggle("on", !!busy.flow);
    const row = state.row.map((f) => chip(f, f.tag === 4 ? "newf" : "")).join("");
    $(".dbrow").innerHTML = row + (state.ghost ? `<span class="rec ghost"><span class="k">checksum</span><span class="v">lost</span></span>` : "");
    $("#st-lost").textContent = state.lost;
    $("#st-v2").textContent = state.servers.filter((s) => s.v === 2).length + " of 3";
  }

  function say(text, cls = "") {
    log.querySelectorAll("li.current").forEach((li) => li.classList.remove("current"));
    const li = document.createElement("li");
    li.textContent = text;
    li.className = "current " + cls;
    log.appendChild(li);
    while (log.children.length > 7) log.firstChild.remove();
  }

  async function perform(a, g) {
    if (a.type === "upgrade") {
      if (state.servers[a.i].v === 2) return;
      state = upgrade(state, a.i);
      busy = { srv: a.i, db: false, flow: "" };
      say(`${state.servers[a.i].id} is redeployed with v2 code. The other servers still run v1.`);
      render();
      await wait(700);
      if (g !== gen) return;
      busy = { srv: -1, db: false, flow: "" };
      render();
      return;
    }
    const keep = preserve.checked;
    $("#rolling-verdict").className = "verdict";
    $("#rolling-verdict").textContent = "";
    const { state: next, steps, lostNow } = edit(state, a.i, keep);
    const srv = state.servers[a.i];
    for (const st of steps) {
      if (st.phase === "read") {
        busy = { srv: a.i, db: true, flow: `${srv.id} reads the row` };
        mem = { [a.i]: { fields: st.mem, unknown: st.unknown } };
      } else if (st.phase === "change") {
        busy = { srv: a.i, db: false, flow: "" };
        mem = { [a.i]: { fields: st.mem.filter((f) => KNOWS[srv.v].includes(f.tag)), unknown: st.unknown, changedTag: 3 } };
      } else {
        busy = { srv: a.i, db: true, flow: `${srv.id} writes the whole row back` };
        state = next;
      }
      say(st.text, st.phase === "write" && lostNow ? "bad" : "");
      render();
      await wait(st.phase === "write" ? 900 : 800);
      if (g !== gen) return;
    }
    busy = { srv: -1, db: false, flow: "" };
    render();
    const v = $("#rolling-verdict");
    if (lostNow) { v.className = "verdict bad"; v.textContent = "Data loss with no error anywhere: v1 code decoded the row into an object that had no place for the checksum, then wrote that object back. Turn on \"Preserve unknown fields\" and try again."; }
    else if (keep && state.row.some((f) => f.tag === 4) && KNOWS[srv.v].length === 3) { v.className = "verdict good"; v.textContent = "The v1 server carried the checksum through untouched. It could not interpret it, but it did not destroy it."; }
  }

  async function run() {
    if (running) return;
    running = true;
    while (queue.length) {
      const a = queue.shift();
      await perform(a, gen);
    }
    running = false;
  }
  const enqueue = (...acts) => { queue.push(...acts); run(); };

  function reset() {
    gen++;
    queue = [];
    state = initialUpgrade();
    busy = { srv: -1, db: false, flow: "" };
    mem = {};
    log.textContent = "";
    $("#rolling-verdict").className = "verdict";
    $("#rolling-verdict").textContent = "";
    render();
  }

  grid.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) enqueue({ type: b.dataset.act, i: +b.dataset.i });
  });
  $("#play-failure").addEventListener("click", () => {
    reset();
    say(preserve.checked ? "Scenario, with unknown fields preserved." : "Scenario: the rollout is one third done.");
    enqueue({ type: "upgrade", i: 0 }, { type: "edit", i: 0 }, { type: "edit", i: 1 });
  });
  $("#reset-rolling").addEventListener("click", reset);
  render();
}
