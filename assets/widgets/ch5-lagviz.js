// Chapter 5, lesson 2: three replication-lag anomalies on a space-time diagram, each with a fix.
import { lagScenario, SCENARIOS } from "../engines/ch5-lag.js";
import { makeClock, spaceTime, esc } from "./ch5-util.js";

const root = document.getElementById("lag");
const tabsEl = root.querySelector(".ch5-tabs");
const fixesEl = root.querySelector('[data-out="fixes"]');
const storyEl = root.querySelector('[data-out="story"]');
const sawEl = root.querySelector(".ch5-saw");
const verdict = root.querySelector(".verdict");

const STORY = {
  own: "Ines changes her delivery address. The app then reloads her profile from whichever follower the load balancer picks. Both followers are behind the leader.",
  monotonic: "The score desk records a goal. Tomas refreshes the match page three times, and each refresh may land on a different follower. Follower B is far behind.",
  prefix: "Products live in partition 1, orders in partition 2, and each partition has its own leader and follower. A merchant adds a product, a customer orders it, and a dashboard reads both followers.",
};

const VERDICT = {
  own: {
    none: ["bad", "Ines read from a follower that had not yet received her write, so her own change looked lost. Nothing is broken: the follower is simply behind."],
    leader: ["good", "Anything Ines can edit, her own profile, is read from the leader, which always has her latest write. Profiles of other people can still come from followers."],
    position: ["good", "The app remembered the log position of her write and sent it with the read. The follower held the read until it had applied that position, then answered. Slower, but correct."],
  },
  monotonic: {
    none: ["bad", "Tomas saw 2–1 and then 1–1: one refresh hit an up-to-date follower and a later one hit a lagging follower. To him, time ran backwards."],
    sticky: ["good", "Every refresh from Tomas goes to follower B, chosen by hashing his user ID. B is behind, so he sees the goal late, but he never sees an older score after a newer one."],
  },
  prefix: {
    none: ["bad", "The partitions replicate independently, and partition 2's follower was faster. The dashboard saw the effect, an order, before its cause, the product."],
    same: ["good", "Both writes went to partition 1, keyed by the product, so its follower applies them in the order they happened. A reader may see nothing, or the product alone, or both, but never the order without its product."],
  },
};

let tab = "own", fix = "none", seed = SCENARIOS.own.seed;
const st = spaceTime(root.querySelector(".st"), { rowH: 36, labelW: 84, aria: "Space-time diagram of the scenario" });
const clock = makeClock(render, { speed: 0.4, onIdle: done });

function render(sim) {
  st.draw(sim);
  sawEl.innerHTML = sim.saw.map((x) => `<li><span class="t">${(x.t / 1000).toFixed(2)} s</span><span class="${x.cls}">${esc(x.text)}</span></li>`).join("");
}

function done(sim) {
  let [cls, text] = VERDICT[tab][fix];
  if (fix === "none" && !sim.anomaly) { cls = ""; text = "This run happened to dodge the anomaly, because the random routing picked a lucky order. Press Another run: it will come back."; }
  verdict.className = `verdict ${cls}`;
  verdict.textContent = text;
}

function start() {
  // Run once off-screen to size the time axis, then play a fresh copy.
  const probe = lagScenario(tab, { fix, seed });
  probe.runAll();
  st.lanes = probe.lanes;
  st.fit = [0, probe.t + 120];
  verdict.className = "verdict";
  verdict.textContent = "";
  const sim = lagScenario(tab, { fix, seed });
  clock.set(sim);
  if (seen) clock.kick();
}

// Start the first story only once the figure scrolls into view.
let seen = false;
new IntersectionObserver((entries, obs) => {
  if (entries.some((e) => e.isIntersecting)) { seen = true; obs.disconnect(); clock.kick(); }
}, { threshold: 0.35 }).observe(root);

function drawControls() {
  tabsEl.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === tab)));
  fixesEl.innerHTML = SCENARIOS[tab].fixes.map(([id, label]) => `<button class="btn" data-fix="${id}" aria-pressed="${id === fix}">${esc(label)}</button>`).join("");
  storyEl.textContent = STORY[tab];
}

root.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.tab) { tab = b.dataset.tab; fix = "none"; seed = SCENARIOS[tab].seed; drawControls(); start(); }
  else if (b.dataset.fix) { fix = b.dataset.fix; drawControls(); start(); }
  else if (b.dataset.act === "replay") start();
  else if (b.dataset.act === "another") { seed += 1; start(); }
});

drawControls();
start();
