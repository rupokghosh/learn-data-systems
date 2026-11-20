// Chapter 6, lesson 3: add or remove a node and count the keys that move.
import { el, responsive } from "../charts.js";
import { createCluster, NKEYS, KEYS, KEY_HASH, NUM_PARTITIONS, MIN_NODES, MAX_NODES } from "../engines/ch6-rebalance.js";

const root = document.getElementById("rebalance");
const keysEl = root.querySelector(".ch6-keys");
const mechEl = root.querySelector(".ch6-mech");
const legendEl = root.querySelector("[data-out=legend]");
const verdict = root.querySelector(".verdict");
const out = (n) => root.querySelector(`[data-out="${n}"]`);
const tokenRow = root.querySelector("[data-tokenrow]");

const NODE_COLOR = {
  A: "var(--accent)", B: "var(--orange)", C: "var(--green)", D: "var(--purple)", E: "var(--red)", F: "var(--ink-3)",
  G: "color-mix(in srgb, var(--accent) 45%, var(--green))", H: "color-mix(in srgb, var(--orange) 45%, var(--purple))",
};
const NAMES = { modn: "hash mod N", fixed: "Fixed partitions", ring: "Hash ring" };

let strat = "modn", tokens = 8, cluster = createCluster({ nodes: 4, tokens });
let cells = [];

// ---------- key grid ----------
const COLS = 50;
function layoutKeys(width) {
  keysEl.innerHTML = "";
  const gap = width < 480 ? 1 : 2;
  const size = (width - gap * (COLS - 1)) / COLS;
  const rows = Math.ceil(NKEYS / COLS);
  const h = rows * size + (rows - 1) * gap;
  const svg = el("svg", { viewBox: `0 0 ${width} ${h}`, height: h, role: "img", "aria-label": "1,000 keys coloured by the node that stores them" }, keysEl);
  cells = KEYS.map((_, i) => el("rect", {
    x: (i % COLS) * (size + gap), y: Math.floor(i / COLS) * (size + gap), width: size, height: size, rx: Math.min(2, size / 4), class: "ch6-cell",
  }, svg));
  paint();
}

function paint() {
  const st = cluster.state[strat];
  const last = cluster.last;
  const moved = last ? new Set(last.moved[strat]) : null;
  cells.forEach((c, i) => {
    c.style.fill = NODE_COLOR[st.owners[i]];
    c.classList.toggle("moved", !!moved && moved.has(i));
    c.classList.toggle("still", !!moved && !moved.has(i));
  });
}

// ---------- mechanism views ----------
function drawMech() {
  mechEl.innerHTML = "";
  tokenRow.hidden = strat !== "ring";
  if (strat === "modn") return drawModN();
  if (strat === "fixed") return drawFixed();
  drawRing();
}

const SAMPLE = [3, 41, 158, 260, 377, 502, 689, 914];
function drawModN() {
  const nodes = cluster.nodes, last = cluster.last;
  const prev = last ? last.before.modn.nodes : null;
  let html = `<table class="ch6-mini"><tr><th>Key</th><th>hash</th>${prev ? `<th>mod ${prev.length}</th>` : ""}<th>mod ${nodes.length}</th><th></th></tr>`;
  for (const i of SAMPLE) {
    const h = KEY_HASH[i];
    const now = nodes[h % nodes.length];
    const was = prev ? prev[h % prev.length] : null;
    const mv = prev && was !== now;
    html += `<tr class="${mv ? "mv" : ""}"><td>${KEYS[i]}</td><td>${h}</td>${prev ? `<td>${h % prev.length} → ${sw(was)}${was}</td>` : ""}<td>${h % nodes.length} → ${sw(now)}${now}</td><td>${prev ? (mv ? "moves" : "stays") : ""}</td></tr>`;
  }
  mechEl.innerHTML = html + "</table>";
}
const sw = (n) => `<i class="ch6-sw" style="background:${NODE_COLOR[n]}"></i>`;

function drawFixed() {
  const st = cluster.state.fixed, last = cluster.last;
  const moved = new Set(last ? st.movedParts : []);
  const wrap = document.createElement("div");
  wrap.className = "ch6-pstrip";
  for (let p = 0; p < NUM_PARTITIONS; p++) {
    const d = document.createElement("span");
    d.className = "ch6-pcell" + (moved.has(p) ? " moved" : "") + (last && !moved.has(p) ? " still" : "");
    d.style.background = NODE_COLOR[st.assign[p]];
    d.title = `Partition ${p} on node ${st.assign[p]}`;
    d.textContent = p;
    wrap.appendChild(d);
  }
  const cap = document.createElement("p");
  cap.className = "note";
  cap.textContent = `${NUM_PARTITIONS} partitions, fixed when the cluster was created. A key always stays in its partition (partition = hash mod ${NUM_PARTITIONS}); only whole partitions move between nodes.` + (last ? ` This change moved ${moved.size} partitions.` : "");
  mechEl.append(wrap, cap);
}

function drawRing() {
  const st = cluster.state.ring, last = cluster.last;
  const moved = last ? new Set(last.moved.ring) : null;
  const W = Math.min(300, mechEl.clientWidth || 300), R = W / 2 - 18, cx = W / 2, cy = W / 2;
  const svg = el("svg", { viewBox: `0 0 ${W} ${W}`, width: W, height: W, class: "ch6-ring", role: "img", "aria-label": "Hash ring with node tokens and keys" }, mechEl);
  const ang = (pos) => (pos / 4294967296) * 2 * Math.PI - Math.PI / 2;
  const pt = (pos, r) => [cx + r * Math.cos(ang(pos)), cy + r * Math.sin(ang(pos))];
  // arcs: each token owns the arc from the previous token up to itself
  const toks = st.toks;
  toks.forEach((t, i) => {
    const prev = toks[(i - 1 + toks.length) % toks.length];
    let a0 = prev.pos, a1 = t.pos;
    if (toks.length === 1) { a0 = t.pos + 1; }
    const span = ((a1 - a0) >>> 0) / 4294967296;
    const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R);
    const large = span > 0.5 ? 1 : 0;
    const d = toks.length === 1
      ? `M ${cx} ${cy - R} A ${R} ${R} 0 1 1 ${cx - 0.01} ${cy - R}`
      : `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1}`;
    el("path", { d, class: "ch6-arc", style: `stroke:${NODE_COLOR[t.node]}` }, svg);
  });
  // keys
  KEY_HASH.forEach((h, i) => {
    const [x, y] = pt(h, R - 12);
    const c = el("circle", { cx: x, cy: y, r: moved && moved.has(i) ? 2.6 : 1.6, class: "ch6-rkey" + (moved ? (moved.has(i) ? " moved" : " still") : "") }, svg);
    c.style.fill = NODE_COLOR[st.owners[i]];
  });
  // tokens
  for (const t of toks) {
    const [x0, y0] = pt(t.pos, R - 5), [x1, y1] = pt(t.pos, R + 7);
    el("line", { x1: x0, y1: y0, x2: x1, y2: y1, class: "ch6-tok", style: `stroke:${NODE_COLOR[t.node]}` }, svg);
  }
  const tx = el("text", { x: cx, y: cy - 4, "text-anchor": "middle", class: "ch6-ring-t" }, svg);
  tx.textContent = `${toks.length} tokens`;
  const tx2 = el("text", { x: cx, y: cy + 13, "text-anchor": "middle", class: "ch6-ring-s" }, svg);
  tx2.textContent = "key → next token clockwise";
}

// ---------- numbers ----------
function update() {
  const nodes = cluster.nodes, last = cluster.last;
  root.querySelectorAll("[data-strat]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.strat === strat)));
  root.querySelectorAll("[data-tokens]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.tokens === tokens)));
  root.querySelector("[data-act=add]").disabled = nodes.length >= MAX_NODES;
  root.querySelector("[data-act=remove]").disabled = nodes.length <= MIN_NODES;

  const loads = cluster.loads(strat);
  legendEl.innerHTML = loads.map((l) => `<span><i style="background:${NODE_COLOR[l.node]}"></i>Node ${l.node}: ${l.keys}</span>`).join("");
  out("nodes").textContent = String(nodes.length);
  const avg = NKEYS / nodes.length;
  const busiest = Math.max(...loads.map((l) => l.keys));
  out("busy").textContent = `${(busiest / avg).toFixed(2)}× average`;
  if (last) {
    const m = last.moved[strat].length;
    out("moved").textContent = `${m}`;
    out("share").textContent = `${Math.round((m / NKEYS) * 100)}%`;
    out("ideal").textContent = `${last.ideal[strat]}`;
  } else {
    out("moved").textContent = out("share").textContent = out("ideal").textContent = "none yet";
  }
  // comparison table
  for (const k of ["modn", "fixed", "ring"]) {
    const row = root.querySelector(`[data-row="${k}"]`);
    row.classList.toggle("sel", k === strat);
    const L = cluster.loads(k).map((l) => l.keys);
    row.querySelector("[data-col=moved]").textContent = last ? `${last.moved[k].length} (${Math.round((last.moved[k].length / NKEYS) * 100)}%)` : "none yet";
    row.querySelector("[data-col=busy]").textContent = `${(Math.max(...L) / avg).toFixed(2)}×`;
  }
  verdictFor();
}

function verdictFor() {
  const last = cluster.last;
  let cls = "", msg;
  if (!last) {
    msg = "Add or remove a node. Keys that change owner stay bright; keys that stay put fade.";
  } else {
    const m = last.moved[strat].length, ideal = last.ideal[strat];
    const verb = last.kind === "add" ? `Adding node ${last.node}` : `Removing node ${last.node}`;
    if (strat === "modn") {
      cls = "bad";
      msg = `${verb} changed the divisor from ${last.nodesBefore} to ${last.nodesAfter}, so ${m} of ${NKEYS} keys changed owner, although ${ideal} would have been enough. Most of those moves shuffle data between nodes that were not involved at all.`;
    } else if (strat === "fixed") {
      cls = "good";
      msg = last.kind === "add"
        ? `Node ${last.node} took ${cluster.state.fixed.movedParts.length} whole partitions from the busiest nodes: ${m} keys, close to the fair share of ${ideal}. Every moved key went to the new node.`
        : `Node ${last.node} handed its ${cluster.state.fixed.movedParts.length} partitions to the least loaded nodes: ${m} keys, exactly what it held. Nothing else moved.`;
    } else {
      cls = tokens === 1 ? "" : "good";
      msg = last.kind === "add"
        ? `Node ${last.node} took over the arcs just before its ${tokens === 1 ? "token" : tokens + " tokens"}: ${m} keys moved, all to the new node (a fair share would be ${ideal}).`
        : `The keys of node ${last.node} passed to the next token clockwise: ${m} keys moved, exactly what it held.`;
      if (tokens === 1) msg += " With one token per node, arcs are uneven and so are the loads; check the busiest node, then try more tokens.";
    }
  }
  verdict.className = "verdict " + cls;
  verdict.textContent = msg;
}

function render() { paint(); drawMech(); update(); }

// ---------- controls ----------
root.querySelectorAll("[data-strat]").forEach((b) => b.addEventListener("click", () => { strat = b.dataset.strat; render(); }));
root.querySelectorAll("[data-tokens]").forEach((b) => b.addEventListener("click", () => {
  tokens = +b.dataset.tokens;
  cluster.setTokens(tokens);
  render();
}));
root.querySelector("[data-act=add]").addEventListener("click", () => { cluster.change("add"); render(); });
root.querySelector("[data-act=remove]").addEventListener("click", () => { cluster.change("remove"); render(); });
root.querySelector("[data-act=reset]").addEventListener("click", () => { cluster = createCluster({ nodes: 4, tokens }); render(); });

responsive(keysEl, layoutKeys);
let mechW = 0;
new ResizeObserver(() => { if (strat === "ring" && Math.abs(mechEl.clientWidth - mechW) > 4) { mechW = mechEl.clientWidth; drawMech(); } }).observe(mechEl);
render();
