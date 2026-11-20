// Lesson 1: follow a request through a composite data system.
import { el, prefersReducedMotion } from "../charts.js";

const root = document.getElementById("arch");
const svg = root.querySelector("svg");
const stepsEl = root.querySelector(".steps");
const verdict = root.querySelector(".verdict");
const bugToggle = root.querySelector("#skip-invalidate");

const NODES = {
  user:   { x: 20,  y: 140, w: 110, h: 58, label: "You", sub: "browser or phone" },
  app:    { x: 200, y: 140, w: 130, h: 58, label: "Application", sub: "your code (the glue)" },
  cache:  { x: 430, y: 20,  w: 180, h: 54, label: "Cache", sub: "fast, temporary copy" },
  db:     { x: 430, y: 112, w: 180, h: 54, label: "Database", sub: "source of truth" },
  search: { x: 430, y: 204, w: 180, h: 54, label: "Search index", sub: "find by keyword" },
  queue:  { x: 200, y: 280, w: 130, h: 54, label: "Message queue", sub: "work for later" },
  worker: { x: 430, y: 290, w: 180, h: 44, label: "Background worker", sub: "" },
};
const EDGES = [["user", "app"], ["app", "cache"], ["app", "db"], ["app", "search"], ["app", "queue"], ["queue", "worker"], ["worker", "search"]];

const center = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
function anchor(from, to) {
  const a = center(from), b = center(to);
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.min((from.w / 2 + 4) / Math.abs(dx || 1e-9), (from.h / 2 + 4) / Math.abs(dy || 1e-9));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

// ---- draw static diagram ----
const edgeEls = {};
const gEdges = el("g", {}, svg);
for (const [a, b] of EDGES) {
  const p = anchor(NODES[a], NODES[b]), q = anchor(NODES[b], NODES[a]);
  edgeEls[a + b] = edgeEls[b + a] = el("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: "dg-edge" }, gEdges);
}
const nodeEls = {};
for (const [id, n] of Object.entries(NODES)) {
  const g = el("g", { class: "dg-node" }, svg);
  el("rect", { x: n.x, y: n.y, width: n.w, height: n.h, rx: 10 }, g);
  const t = el("text", { x: n.x + 14, y: n.y + (n.sub ? 24 : 27) }, g); t.textContent = n.label;
  if (n.sub) { const s = el("text", { x: n.x + 14, y: n.y + 42, class: "sub" }, g); s.textContent = n.sub; }
  nodeEls[id] = g;
}
const dot = el("circle", { r: 7, class: "dg-dot", opacity: 0 }, svg);

// ---- state ----
let cacheWarm = false;
let cachedName = "Ada";
let dbName = "Ada";
let running = false;

const step = (from, to, text, mark) => ({ from, to, text, mark });

function scenario(kind) {
  if (kind === "read") {
    if (!cacheWarm) {
      cacheWarm = true; cachedName = dbName;
      return { steps: [
        step("user", "app", "You open a profile page."),
        step("app", "cache", "The app asks the cache first. Miss: the profile is not cached yet.", { cache: "miss" }),
        step("app", "db", "The app reads the profile from the database."),
        step("db", "app", `The database returns the row: name = "${dbName}".`),
        step("app", "cache", "The app saves a copy in the cache so the next read is faster."),
        step("app", "user", `The page shows "${dbName}". Six hops, three systems.`),
      ], done: { cls: "", text: "Cache miss: slower, but the cache is now warm. Try reading again." } };
    }
    const stale = cachedName !== dbName;
    return { steps: [
      step("user", "app", "You open the profile page again."),
      step("app", "cache", "The app asks the cache. Hit: the profile is there."),
      step("cache", "app", `The cache returns name = "${cachedName}". The database is never touched.`),
      step("app", "user", stale ? `The page shows "${cachedName}". But the database says "${dbName}"!` : `The page shows "${cachedName}". Four hops, fast.`),
    ], done: stale
      ? { cls: "bad", text: `Stale read. The cache still holds "${cachedName}" because the update never invalidated it. Your app is responsible for keeping derived copies in sync.` }
      : { cls: "good", text: "Cache hit: fast, and the database did no work." } };
  }
  if (kind === "search") {
    return { steps: [
      step("user", "app", `You search for "${dbName.toLowerCase()}".`),
      step("app", "search", "The database is bad at keyword search, so the app asks the search index."),
      step("search", "app", "The index returns the matching profile IDs."),
      step("app", "user", "Results appear."),
    ], done: { cls: "", text: "The search index is a second copy of the data, shaped for a different kind of question." } };
  }
  // update
  const newName = dbName === "Ada" ? "Ada Lovelace" : "Ada";
  const skip = bugToggle.checked;
  dbName = newName;
  const steps = [
    step("user", "app", `You change your name to "${newName}".`),
    step("app", "db", "The app writes the new name to the database, the source of truth."),
  ];
  if (!skip) {
    steps.push(step("app", "cache", "The app deletes the old cached profile (cache invalidation)."));
    cacheWarm = false;
  }
  steps.push(
    step("app", "queue", "The app publishes a \"name changed\" event."),
    step("app", "user", "You see \"Saved\". The rest happens in the background."),
    step("queue", "worker", "A background worker picks up the event."),
    step("worker", "search", "The worker updates the search index."),
  );
  return { steps, done: skip
    ? { cls: "bad", text: "The cache was not invalidated. Read the profile again to see what users will see." }
    : { cls: "good", text: "Database, cache, and search index all agree again. Notice the app replied before the index was updated." } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function moveDot(from, to, dur) {
  const p = anchor(NODES[from], NODES[to]), q = anchor(NODES[to], NODES[from]);
  if (prefersReducedMotion()) { dot.setAttribute("opacity", 0); return sleep(dur); }
  dot.setAttribute("opacity", 1);
  // Explanation motion: ease-in-out, as the dot travels across the screen.
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  return new Promise((res) => {
    const t0 = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / dur), e = ease(t);
      dot.setAttribute("cx", p.x + (q.x - p.x) * e);
      dot.setAttribute("cy", p.y + (q.y - p.y) * e);
      if (t < 1) requestAnimationFrame(frame); else res();
    };
    requestAnimationFrame(frame);
  });
}

async function play(kind) {
  if (running) return;
  running = true;
  root.querySelectorAll("[data-run]").forEach((b) => (b.disabled = true));
  verdict.hidden = true;
  const { steps, done } = scenario(kind);
  stepsEl.innerHTML = steps.map((s) => `<li>${s.text}</li>`).join("");
  const lis = [...stepsEl.children];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    lis.forEach((li, j) => { li.classList.toggle("current", j === i); li.style.opacity = j <= i ? 1 : 0.35; });
    Object.values(nodeEls).forEach((g) => g.classList.remove("active", "miss"));
    Object.values(edgeEls).forEach((e) => e.classList.remove("active"));
    nodeEls[s.from].classList.add("active");
    nodeEls[s.to].classList.add(s.mark?.[s.to] === "miss" ? "miss" : "active");
    edgeEls[s.from + s.to].classList.add("active");
    await moveDot(s.from, s.to, 650);
    await sleep(prefersReducedMotion() ? 500 : 450);
  }
  dot.setAttribute("opacity", 0);
  lis.forEach((li) => { li.classList.remove("current"); li.style.opacity = 1; });
  Object.values(nodeEls).forEach((g) => g.classList.remove("active", "miss"));
  Object.values(edgeEls).forEach((e) => e.classList.remove("active"));
  verdict.className = `verdict ${done.cls}`;
  verdict.textContent = done.text;
  verdict.hidden = false;
  root.querySelectorAll("[data-run]").forEach((b) => (b.disabled = false));
  running = false;
}

root.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => play(b.dataset.run)));
