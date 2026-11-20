// Chapter 9, lesson 4: a five-node Raft-style cluster you can crash and partition.
import { el, slider, prefersReducedMotion } from "../charts.js";
import { Raft } from "../engines/ch9-raft.js";

const root = document.getElementById("raft");
const svg = root.querySelector("svg");
const logOut = root.querySelector(".rf-log");
const stepsEl = root.querySelector(".steps");
const clientRow = root.querySelector('[data-out="clients"]');
const out = (k) => root.querySelector(`[data-out="${k}"]`);
const MS_PER_UNIT = 20;
const CX = 320, CY = 162, RAD = 118, NR = 28;

let r, speed = 1, paused = false, visible = true, raf = null, last = 0, seed = 1;
const pos = Array.from({ length: 5 }, (_, i) => {
  const a = (-90 + i * 72) * (Math.PI / 180);
  return [CX + RAD * Math.cos(a), CY + RAD * Math.sin(a)];
});

// ---------- static drawing ----------
svg.textContent = "";
const wall = el("line", { class: "rf-wall", opacity: 0 }, svg);
const msgLayer = el("g", {}, svg);
const nodes = pos.map(([x, y], i) => {
  const g = el("g", { class: "rf-node", tabindex: 0, role: "button", "aria-label": `Node N${i + 1}: click to crash or restart` }, svg);
  const timer = el("circle", { class: "rf-timer", cx: x, cy: y, r: NR + 6, transform: `rotate(-90 ${x} ${y})` }, g);
  el("circle", { class: "body", cx: x, cy: y, r: NR }, g);
  el("text", { class: "nm", x, y: y - 1, "text-anchor": "middle" }, g).textContent = "N" + (i + 1);
  const tm = el("text", { class: "tm", x, y: y + 13, "text-anchor": "middle" }, g);
  const below = y > CY + 10;
  const role = el("text", { class: "role", x, y: below ? y + NR + 22 : y - NR - 14, "text-anchor": "middle" }, g);
  if (i === 0) role.setAttribute("y", y + NR + 22);
  g.addEventListener("click", () => toggleNode(i));
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleNode(i); } });
  return { g, timer, tm, role };
});
const CIRC = 2 * Math.PI * (NR + 6);

function reset() {
  r = new Raft({ seed: seed });
  seed = seed % 7 + 1;
  logOut.dataset.sig = "";
  clientRow.dataset.sig = "";
  render();
}

// ---------- render ----------
const COLORS = { RequestVote: "var(--orange)", Vote: "var(--green)", AppendEntries: "var(--accent)", AppendReply: "var(--ink-3)" };

function edgePoint(a, b, k) {
  const [x1, y1] = pos[a], [x2, y2] = pos[b];
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const sx = x1 + ux * (NR + 4), sy = y1 + uy * (NR + 4), ex = x2 - ux * (NR + 4), ey = y2 - uy * (NR + 4);
  return [sx + (ex - sx) * k, sy + (ey - sy) * k, sx, sy, ex, ey];
}

function render() {
  const reduced = prefersReducedMotion();
  r.nodes.forEach((n, i) => {
    const v = nodes[i];
    v.g.setAttribute("class", "rf-node " + (n.up ? n.role : "down"));
    v.tm.textContent = "term " + n.term;
    v.role.textContent = n.up ? n.role : "down";
    if (n.up && n.role !== "leader") {
      const f = Math.max(0, Math.min(1, (n.deadline - r.now) / (n.deadline - n.timerStart || 1)));
      v.timer.setAttribute("stroke-dasharray", `${CIRC * f} ${CIRC}`);
      v.timer.setAttribute("opacity", 1);
    } else v.timer.setAttribute("opacity", 0);
  });

  // messages
  msgLayer.textContent = "";
  for (const m of r.msgs) {
    const p = Math.max(0, Math.min(1, (r.now - m.sentAt) / (m.arriveAt - m.sentAt)));
    const big = m.type === "AppendEntries" && m.entries.length;
    const color = m.type === "Vote" && !m.granted ? "var(--ink-4)" : COLORS[m.type];
    if (reduced) {
      const [, , sx, sy, ex, ey] = edgePoint(m.from, m.to, 0);
      el("line", { x1: sx, y1: sy, x2: ex, y2: ey, style: `stroke:${m.dropped ? "var(--red)" : color};stroke-width:1.2;opacity:.35` }, msgLayer);
      continue;
    }
    if (m.dropped && p > 0.5) continue;
    const [x, y] = edgePoint(m.from, m.to, p);
    el("circle", { cx: x, cy: y, r: big ? 6 : 4, style: `fill:${m.dropped ? "var(--red)" : color}`, opacity: m.dropped ? 1 - p : 1 }, msgLayer);
  }

  // partition wall
  if (r.partition) {
    const pair = r.partition.map((g, i) => (g === r.partition[0] ? i : null)).filter((i) => i !== null);
    const small = pair.length <= 2 ? pair : r.partition.map((g, i) => (g !== r.partition[0] ? i : null)).filter((i) => i !== null);
    const mx = small.reduce((s, i) => s + pos[i][0], 0) / small.length - CX;
    const my = small.reduce((s, i) => s + pos[i][1], 0) / small.length - CY;
    const len = Math.hypot(mx, my) || 1;
    const ux = mx / len, uy = my / len;
    const d = RAD * 0.3, L = RAD * 1.25;
    wall.setAttribute("x1", CX + ux * d - uy * L); wall.setAttribute("y1", CY + uy * d + ux * L);
    wall.setAttribute("x2", CX + ux * d + uy * L); wall.setAttribute("y2", CY + uy * d - ux * L);
    wall.setAttribute("opacity", 1);
  } else wall.setAttribute("opacity", 0);

  renderLog();
  renderControls();
}

function renderLog() {
  const sig = JSON.stringify(r.nodes.map((n) => [n.up, n.role, n.commit, n.log.length, n.log.at(-1)?.term]));
  if (sig === logOut.dataset.sig) return;
  logOut.dataset.sig = sig;
  const max = Math.max(4, ...r.nodes.map((n) => n.log.length));
  let html = "<table><tr><th></th>";
  for (let i = 1; i <= max; i++) html += `<th class="idx">${i}</th>`;
  html += "</tr>";
  for (const n of r.nodes) {
    html += `<tr class="${n.up ? "" : "down"} ${n.up && n.role === "leader" ? "lead" : ""}"><th>N${n.id + 1}${n.up && n.role === "leader" ? " (leader)" : ""}</th>`;
    for (let i = 0; i < max; i++) {
      const e = n.log[i];
      if (!e) { html += '<td class="e none"></td>'; continue; }
      html += `<td class="e ${i < n.commit ? "c" : ""}" title="term ${e.term}${i < n.commit ? ", committed" : ", not committed yet"}"><b>t${e.term}</b><span>${e.cmd === "no-op" ? "·" : e.cmd}</span></td>`;
    }
    html += "</tr>";
  }
  logOut.innerHTML = html + "</table>";
}

function renderControls() {
  const leaders = r.leadersNow();
  const csig = leaders.map((n) => n.id + ":" + n.term).join(",") + "|" + r.cmdCount;
  if (csig !== clientRow.dataset.sig) {
    clientRow.dataset.sig = csig;
    clientRow.innerHTML = leaders.length
      ? leaders.map((n) => `<button class="btn" data-cmd="${n.id}">Send x=${r.cmdCount + 1} to N${n.id + 1} (leader, term ${n.term})</button>`).join("")
      : '<span class="note" style="margin:0">No node thinks it is leader right now.</span>';
  }
  root.querySelectorAll("[data-crash]").forEach((b) => {
    const n = r.nodes[+b.dataset.crash];
    b.setAttribute("aria-pressed", !n.up);
    b.textContent = (n.up ? "Crash N" : "Restart N") + (n.id + 1);
  });
  const pb = root.querySelector('[data-act="partition"]');
  pb.setAttribute("aria-pressed", !!r.partition);
  pb.textContent = r.partition ? "Heal the partition" : "Isolate the leader with one follower";
  root.querySelector('[data-act="pause"]').textContent = paused ? "Play" : "Pause";
  root.querySelector('[data-act="step"]').disabled = !paused;

  const terms = [...r.leaders.entries()].slice(-4).map(([t, s]) => `t${t}: ${[...s].map((i) => "N" + (i + 1)).join(" and ")}`);
  out("leaders").textContent = terms.length ? terms.join(", ") : "none yet";
  out("commit").textContent = r.commitIndex();
  out("safety").textContent = r.safe() ? "holds" : "violated";
  const ev = r.events.slice(-5);
  const esig = r.events.length + ":" + (r.events.at(-1)?.t ?? "");
  if (stepsEl.dataset.sig !== esig) {
    stepsEl.dataset.sig = esig;
    stepsEl.innerHTML = ev.map((e, k) => `<li class="${k === ev.length - 1 ? "current" : ""}">${e.text}</li>`).join("") || "<li>Every node starts as a follower with a random election timeout (the grey ring).</li>";
  }
}

// ---------- loop ----------
function loop(now) {
  const dt = Math.min(100, now - last);
  last = now;
  if (!paused) r.advanceTo(r.now + (dt / MS_PER_UNIT) * speed);
  render();
  raf = !paused && visible ? requestAnimationFrame(loop) : null;
}
function kick() { if (!raf && !paused && visible) { last = performance.now(); raf = requestAnimationFrame(loop); } }

new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) kick(); }).observe(root);

function toggleNode(i) {
  if (r.nodes[i].up) r.crash(i); else r.restart(i);
  render();
}

root.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.cmd) r.clientCommand(+b.dataset.cmd);
  else if (b.dataset.crash) toggleNode(+b.dataset.crash);
  else if (b.dataset.act === "partition") {
    if (r.partition) r.setPartition(null);
    else {
      const lead = r.leadersNow().sort((a, c) => c.term - a.term)[0];
      const i = lead ? lead.id : 0, j = (i + 1) % 5;
      r.setPartition(r.nodes.map((n) => (n.id === i || n.id === j ? 0 : 1)));
    }
  } else if (b.dataset.act === "pause") { paused = !paused; }
  else if (b.dataset.act === "step") { r.stepOne(); }
  else if (b.dataset.act === "reset") reset();
  render();
  kick();
});

slider(root.querySelector("#rf-speed"), (v) => v + "×", (v) => { speed = v; });
reset();
kick();
