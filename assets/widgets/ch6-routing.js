// Chapter 6, lesson 4: request routing in three styles, with a partition move and a stale-routing window.
import { el, prefersReducedMotion, slider } from "../charts.js";
import { createRouting, KEYS, NODES, NPARTS, partOf } from "../engines/ch6-routing.js";

const root = document.getElementById("routing");
const svg = root.querySelector("svg");
const verdict = root.querySelector(".verdict");
const stepsEl = root.querySelector(".steps");
const mapTable = root.querySelector("[data-out=maps]");
const out = (n) => root.querySelector(`[data-out="${n}"]`);
const probeBox = root.querySelector("#rt-probe");
const partSel = root.querySelector("#rt-part");
const toSel = root.querySelector("#rt-to");

const BOX = {
  client: { x: 10, y: 160, w: 116, h: 64 },
  router: { x: 196, y: 160, w: 124, h: 64 },
  zk: { x: 180, y: 14, w: 156, h: 62 },
  A: { x: 440, y: 14, w: 190, h: 92 },
  B: { x: 440, y: 146, w: 190, h: 92 },
  C: { x: 440, y: 278, w: 190, h: 92 },
};
const EDGES = {
  any: [["client", "A"], ["client", "B"], ["client", "C"], ["A", "B"], ["B", "C"], ["A", "C"]],
  tier: [["client", "router"], ["router", "A"], ["router", "B"], ["router", "C"], ["zk", "router"], ["zk", "A"], ["zk", "B"], ["zk", "C"]],
  client: [["client", "A"], ["client", "B"], ["client", "C"], ["zk", "client"], ["zk", "A"], ["zk", "B"], ["zk", "C"]],
};
const COLOR = { req: "var(--accent)", res: "var(--green)", moved: "var(--orange)", copy: "var(--purple)", register: "var(--ink-3)", notify: "var(--ink-3)", gossip: "var(--ink-3)" };

let mode = "tier", notifyDelay = 1800, sim;

// ---------- geometry ----------
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
function clip(from, to) {
  const a = center(from), b = center(to);
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.min((from.w / 2 + 3) / Math.abs(dx || 1e-9), (from.h / 2 + 3) / Math.abs(dy || 1e-9));
  return { x: a.x + dx * t, y: a.y + dy * t };
}
/** A quadratic path between two boxes; A and C bend around B on the left. */
function route(a, b) {
  const pair = [a, b].sort().join("");
  if (pair === "AC") {
    const top = a === "A" ? BOX.A : BOX.C, bot = a === "A" ? BOX.C : BOX.A;
    const p0 = { x: top.x + 4, y: top.y + (a === "A" ? top.h - 4 : 4) };
    const p1 = { x: bot.x + 4, y: bot.y + (a === "A" ? 4 : bot.h - 4) };
    return { p0, c: { x: 392, y: 192 }, p1 };
  }
  const p0 = clip(BOX[a], BOX[b]), p1 = clip(BOX[b], BOX[a]);
  return { p0, c: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, p1 };
}
const at = ({ p0, c, p1 }, e) => ({
  x: (1 - e) ** 2 * p0.x + 2 * (1 - e) * e * c.x + e * e * p1.x,
  y: (1 - e) ** 2 * p0.y + 2 * (1 - e) * e * c.y + e * e * p1.y,
});
const d = ({ p0, c, p1 }) => `M ${p0.x} ${p0.y} Q ${c.x} ${c.y} ${p1.x} ${p1.y}`;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// ---------- static frame ----------
let H = {};
function drawFrame() {
  svg.innerHTML = "";
  const gE = el("g", {}, svg);
  for (const [a, b] of EDGES[mode]) el("path", { d: d(route(a, b)), class: "dg-edge ch6-edge" }, gE);
  H = { boxes: {}, flight: el("g", {}, svg) };
  for (const [id, b] of Object.entries(BOX)) {
    const g = el("g", { class: "dg-node ch6-rt" }, svg);
    el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 9 }, g);
    const name = el("text", { x: b.x + 12, y: b.y + 22 }, g);
    name.textContent = id === "client" ? "Client" : id === "router" ? "Routing tier" : id === "zk" ? "ZooKeeper" : "Node " + id;
    const sub = el("text", { x: b.x + 12, y: b.y + (NODES.includes(id) ? 22 : 42), class: "sub" }, g);
    if (NODES.includes(id)) { sub.setAttribute("x", b.x + b.w - 12); sub.setAttribute("text-anchor", "end"); }
    const chips = el("g", {}, g);
    H.boxes[id] = { g, sub, chips };
  }
  H.dots = el("g", {}, svg);
  drawDynamic(true);
}

// ---------- per-frame state ----------
let lastLogLen = -1, lastLogRef = null, lastSig = "";
function drawDynamic(force = false) {
  const staleSet = new Set(sim.stale());
  // boxes
  const used = { client: true, router: mode === "tier", zk: mode !== "any", A: true, B: true, C: true };
  for (const [id, h] of Object.entries(H.boxes)) {
    h.g.classList.toggle("off", !used[id]);
    h.g.classList.toggle("miss", staleSet.has(id));
    let sub = "";
    if (id === "client") sub = mode === "client" ? `map v${sim.maps.client.v}` : "application";
    else if (id === "router") sub = mode === "tier" ? `map v${sim.maps.router.v}` : "not used";
    else if (id === "zk") sub = mode === "any" ? "not used" : `partition map v${sim.zk.v}`;
    else sub = mode === "any" ? `map v${sim.maps[id].v}` : "";
    if (staleSet.has(id)) sub += " (stale)";
    h.sub.textContent = sub;
  }
  // partition chips on nodes
  const sig = NODES.map((n) => [...sim.owns[n]].join(",")).join("|") + [...sim.moving].map(([p, m]) => `${p}${m.to}`).join("");
  if (force || sig !== lastSig) {
    lastSig = sig;
    for (const n of NODES) {
      const { chips } = H.boxes[n];
      chips.innerHTML = "";
      const b = BOX[n];
      const list = [...sim.owns[n]].map((p) => ({ p, cls: sim.moving.has(p) ? "out" : "" }));
      for (const [p, m] of sim.moving) if (m.to === n) list.push({ p, cls: "in" });
      list.sort((x, y) => x.p - y.p);
      const step = Math.min(42, (b.w - 24) / Math.max(1, list.length));
      list.forEach((c, i) => {
        const x = b.x + 12 + i * step, y = b.y + 40, w = step - 5;
        el("rect", { x, y, width: w, height: 30, rx: 5, class: "ch6-pchip " + c.cls }, chips);
        const t = el("text", { x: x + w / 2, y: y + 20, "text-anchor": "middle", class: "ch6-pchip-t" }, chips);
        t.textContent = "P" + c.p;
      });
    }
  }
  // messages in flight
  H.dots.innerHTML = "";
  H.flight.innerHTML = "";
  const motion = !prefersReducedMotion();
  for (const m of sim.msgs) {
    const r = route(m.from, m.to);
    const prog = Math.max(0, Math.min(1, (sim.t - m.sendT) / (m.arriveT - m.sendT)));
    el("path", { d: d(r), class: "ch6-inflight", style: `stroke:${COLOR[m.kind]}` }, H.flight);
    if (!motion) continue;
    const pos = at(r, ease(prog));
    if (m.kind === "copy") {
      el("rect", { x: pos.x - 15, y: pos.y - 10, width: 30, height: 20, rx: 4, class: "ch6-copy" }, H.dots);
      const t = el("text", { x: pos.x, y: pos.y + 4, "text-anchor": "middle", class: "ch6-copy-t" }, H.dots);
      t.textContent = "P" + m.data.p;
    } else {
      el("circle", { cx: pos.x, cy: pos.y, r: m.kind === "req" || m.kind === "res" || m.kind === "moved" ? 6 : 4.5, style: `fill:${COLOR[m.kind]}` }, H.dots);
      if (m.data.map) {
        const t = el("text", { x: pos.x + 8, y: pos.y - 7, class: "ch6-msg-t" }, H.dots);
        t.textContent = "v" + m.data.map.v;
      } else if (m.kind === "moved") {
        const t = el("text", { x: pos.x + 8, y: pos.y - 7, class: "ch6-msg-t" }, H.dots);
        t.textContent = "moved";
      }
    }
  }
  // log
  const log = sim.log;
  const lastRef = log[log.length - 1] || null;
  if (force || lastRef !== lastLogRef || log.length !== lastLogLen) {
    lastLogRef = lastRef; lastLogLen = log.length;
    const recent = log.slice(-6);
    stepsEl.innerHTML = recent.map((l, i) => `<li class="${l.kind}${i === recent.length - 1 ? " current" : ""}">${l.text}</li>`).join("") || "<li>Send a request, or move a partition.</li>";
    updateNumbers(staleSet);
  }
}

function updateNumbers(staleSet) {
  const st = sim.stats;
  out("done").textContent = `${st.done} of ${st.sent}`;
  out("hops").textContent = st.lastHops === null ? "none yet" : `${st.lastHops}`;
  out("detours").textContent = String(st.redirected);
  const names = { router: "routing tier", client: "client", A: "node A", B: "node B", C: "node C" };
  out("stale").textContent = staleSet.size ? [...staleSet].map((s) => names[s]).join(", ") : "none";
  // who thinks what
  const rows = [["Actual location", Array.from({ length: NPARTS }, (_, p) => sim.ownerOf(p)), false]];
  if (mode !== "any") rows.push([`ZooKeeper (v${sim.zk.v})`, sim.zk.owner, true]);
  for (const h of sim.holders()) rows.push([`${names[h][0].toUpperCase() + names[h].slice(1)} (v${sim.maps[h].v})`, sim.maps[h].owner, true]);
  let html = `<tr><th>Who thinks what</th>${Array.from({ length: NPARTS }, (_, p) => `<th>P${p}</th>`).join("")}</tr>`;
  for (const [label, owner, check] of rows) {
    html += `<tr><td>${label}</td>${owner.map((o, p) => `<td class="${check && o !== sim.ownerOf(p) ? "stale" : ""}">${o}</td>`).join("")}</tr>`;
  }
  mapTable.innerHTML = html;
  // verdict
  let cls = "", msg;
  if (staleSet.size) {
    cls = "bad";
    msg = mode === "any"
      ? `Node ${[...staleSet].join(", ")} has not heard the gossip yet. A request that enters there is forwarded to the old owner, which passes it on: correct, but slower.`
      : `The partition has moved, but the ${mode === "tier" ? "routing tier" : "client"} is still routing by its old map until ZooKeeper's notification arrives. Requests sent now reach the old owner and are redirected.`;
  } else if (st.lastRedirected) {
    cls = "";
    msg = `The last request took ${st.lastHops} hops because it was routed by a stale map, then corrected. Maps agree again; send the same key to compare.`;
  } else if (mode === "any") msg = "The client talks to any node. If that node does not own the key, it forwards the request to the owner and relays the answer back.";
  else if (mode === "tier") msg = "Every request goes through the routing tier, which knows the partition map because it watches ZooKeeper. Two extra hops, but clients stay simple.";
  else msg = "The client holds the partition map itself and goes straight to the owner: the fewest hops, at the price of a smarter client library.";
  verdict.className = "verdict " + cls;
  verdict.textContent = msg;
}

// ---------- loop ----------
let raf = 0, lastNow = 0;
function frame(now) {
  const dt = lastNow ? Math.min(50, now - lastNow) : 16;
  lastNow = now;
  sim.advance(dt);
  drawDynamic();
  if (sim.busy) raf = requestAnimationFrame(frame);
  else { raf = 0; lastNow = 0; drawDynamic(true); }
}
const kick = () => { if (!raf) { lastNow = 0; raf = requestAnimationFrame(frame); } };

function reset() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  sim = createRouting({ mode, notifyDelay, probe: probeBox.checked });
  root.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  lastLogRef = null; lastSig = "";
  drawFrame();
}

// ---------- controls ----------
root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { mode = b.dataset.mode; reset(); }));
const keyRow = root.querySelector("[data-keys]");
KEYS.forEach((k) => {
  const b = document.createElement("button");
  b.className = "btn";
  b.innerHTML = `get ${k} <span class="ch6-dim">P${partOf(k)}</span>`;
  b.addEventListener("click", () => { sim.request(k); kick(); });
  keyRow.appendChild(b);
});
for (let p = 0; p < NPARTS; p++) partSel.insertAdjacentHTML("beforeend", `<option value="${p}">P${p}</option>`);
for (const n of NODES) toSel.insertAdjacentHTML("beforeend", `<option value="${n}">node ${n}</option>`);
partSel.value = "3"; toSel.value = "C";
root.querySelector("[data-act=move]").addEventListener("click", () => {
  const ok = sim.move(+partSel.value, toSel.value);
  if (!ok) {
    verdict.className = "verdict";
    verdict.textContent = sim.moving.has(+partSel.value)
      ? `P${partSel.value} is already being moved.`
      : `P${partSel.value} already lives on node ${toSel.value}. Pick another node.`;
    return;
  }
  kick();
});
root.querySelector("[data-act=reset]").addEventListener("click", reset);
probeBox.addEventListener("change", () => { sim.cfg.probe = probeBox.checked; });
slider(root.querySelector("#rt-delay"), (v) => `${(v / 1000).toFixed(1)} s`, (v) => { notifyDelay = v; if (sim) sim.cfg.notifyDelay = v; });

reset();
