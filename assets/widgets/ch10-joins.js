// Chapter 10, lesson 3: how records move in three join strategies, with a skew toggle.
import { plan, HOT_USER } from "../engines/ch10-joins.js";
import { makeMover, sleep } from "./ch10-util.js";
import { prefersReducedMotion } from "../charts.js";

const root = document.getElementById("joins");
const board = root.querySelector(".jn-board");
const verdict = root.querySelector(".verdict");
const skewIn = root.querySelector("#jn-skew");
const splitIn = root.querySelector("#jn-split");
const runBtn = root.querySelector('[data-act="run"]');
const o = (k) => root.querySelector(`[data-out="${k}"]`);
const mover = makeMover(board);

const st = { strategy: "sortmerge", view: "before", running: false, gen: 0 };
let P = plan(st.strategy);

function sq(r, showNet) {
  const cls = ["sq", r.kind === "user" ? "user" : "", r.hot ? (r.kind === "user" ? "hotu" : "hot") : "", showNet && r.net ? "net" : ""].join(" ");
  const title = r.kind === "user" ? `user ${r.n}, plan ${r.plan}` : `event by user ${r.n}`;
  return `<span class="${cls}" data-fid="${r.id}"${r.from ? ` data-from="${r.from}"` : ""} title="${title}">${r.n}</span>`;
}
const lane = (recs, net) => `<div class="lane">${recs.map((r) => sq(r, net)).join("")}</div>`;

function render() {
  const before = st.view === "before";
  const moved = new Set(before ? [] : P.tasks.flatMap((t) => [...t.mem, ...t.stream].map((r) => r.id)));
  const src = P.sources.map((s) => {
    const lanes = s.lanes.map((l, i) => `${s.lanes.length > 1 ? `<p class="sub-l">part ${i + 1}</p>` : ""}${lane(l.filter((r) => !moved.has(r.id)), false)}`).join("");
    return `<div class="box"><div class="box-h"><span>${s.label}</span></div><div class="box-s">${s.sub}</div>${lanes}</div>`;
  }).join("");

  const maxWork = Math.max(...P.stats.work);
  const tasks = P.tasks.map((t, i) => {
    const done = st.view === "done";
    const straggler = done && P.stats.work[i] > 1.5 * P.stats.median;
    const stream = before ? [] : st.view === "moved" ? t.arrived : t.stream;
    const memPart = P.strategy === "sortmerge"
      ? `<p class="sub-l">${t.memNote}</p>`
      : `<p class="sub-l">${t.memNote}</p>${lane(before ? [] : t.mem, true)}`;
    const streamLabel = P.strategy === "sortmerge" ? (st.view === "done" ? "sorted by user, user record first" : "arriving from the shuffle") : "events streamed from the local block";
    return `<div class="box ${straggler ? "slow" : done ? "ok" : ""}"><div class="box-h"><span>${t.label}</span></div><div class="box-s">${t.sub}</div>
      ${memPart}<p class="sub-l" style="margin-top:6px">${streamLabel}</p>${lane(stream, true)}
      <div class="jn-bar${straggler ? " straggler" : ""}"><i style="width:${done ? (100 * P.stats.work[i]) / maxWork : 0}%"></i></div>
      <div class="jn-meta${straggler ? " bad" : ""}">${done ? `${P.stats.work[i]} records processed${straggler ? ", straggler" : ""}` : "&nbsp;"}</div></div>`;
  }).join("");

  board.innerHTML = `<p class="b10-head"><b>Inputs</b><span>${P.strategy === "partitioned" ? "both inputs already partitioned by user" : "events stored in log order"}</span></p>
    <div class="b10-row n4" style="--n:4">${src}</div>
    <p class="b10-head"><b>Join tasks</b><span>${P.strategy === "sortmerge" ? "reduce side" : "map side, no reducers"}</span></p>
    <div class="b10-row" style="--n:3">${tasks}</div>`;

  const shown = st.view !== "before";
  o("net").textContent = shown ? String(P.stats.network) : "–";
  o("mem").textContent = shown ? `${P.stats.maxMem} record${P.stats.maxMem === 1 ? "" : "s"}` : "–";
  o("ratio").textContent = st.view === "done" ? `${P.stats.ratio.toFixed(1)}×` : "–";
  o("joined").textContent = st.view === "done" ? `${P.stats.joined} of ${P.stats.events}` : "–";
  runBtn.disabled = st.view === "done";
  splitIn.disabled = !(st.strategy === "sortmerge" && skewIn.checked);
  splitIn.closest("label").style.opacity = splitIn.disabled ? 0.45 : 1;
}

function explain() {
  const s = P.stats, skew = P.skew;
  if (P.strategy === "sortmerge") {
    if (skew && P.split) {
      const unsplit = plan("sortmerge", { skew: true }).stats;
      return ["good", `User ${HOT_USER}'s events are dealt out to all three reducers, and user ${HOT_USER}'s record is copied to each of them. That costs ${s.network - unsplit.network} extra records on the network, and the slowest reducer now handles ${s.slowest} records instead of ${unsplit.slowest}.`];
    }
    if (skew) return ["bad", `Reducer 1 owns user ${HOT_USER}, so it received all ${P.tasks[0].stream.filter((r) => r.n === HOT_USER && r.kind === "event").length} of that user's events and processes ${s.slowest} records while the median reducer handles ${s.median}. The job is done only when the slowest reducer is done.`];
    return ["", `All ${s.network} records crossed the network. In exchange, no reducer needs more than one user record in memory: the secondary sort puts each user's record directly in front of that user's events.`];
  }
  if (P.strategy === "broadcast") {
    const base = `Events never left their machines. Only the users table moved: ${s.network / 3} records to each of three tasks, ${s.network} in all. Every task holds the whole users table in memory, which is trivial for eight users and impossible for eight hundred million.`;
    return [skew ? "good" : "", skew ? `${base} The popular user does not matter here: blocks were cut by position in the log, not by user, so every task gets an even share.` : base];
  }
  if (skew) return ["bad", `Partitioning by user puts every event of user ${HOT_USER} into partition 1, so map task 1 processes ${s.slowest} records against a median of ${s.median}. Splitting the key is not an option here: the partitioning was fixed by whatever job wrote these files.`];
  return ["good", `Each task loads only its third of the users table: at most ${s.maxMem} records in memory and ${s.network} records over the network. This works only because an earlier job wrote both inputs with the same partitioning, user number mod 3.`];
}

function say(cls, text) { verdict.className = `verdict ${cls}`; verdict.textContent = text; }

function reset(msg = true) {
  st.gen++; mover.finish(); st.running = false;
  P = plan(st.strategy, { skew: skewIn.checked, split: splitIn.checked });
  st.view = "before";
  render();
  if (msg) say("", "Records are sitting in their input files. Press Run the join to see where each one has to go.");
}

async function run() {
  if (st.running) { mover.finish(); return; }
  if (st.view === "done") return;
  st.running = true;
  const g = st.gen;
  await mover.flip(() => { st.view = "moved"; render(); }, 700);
  if (g !== st.gen) return;
  if (P.strategy === "sortmerge") {
    await sleep(prefersReducedMotion() ? 300 : 250);
    if (g !== st.gen) return;
    await mover.flip(() => { st.view = "done"; render(); }, 600);
    if (g !== st.gen) return;
  } else { st.view = "done"; render(); }
  st.running = false;
  const [cls, text] = explain();
  say(cls, text);
}

root.querySelectorAll("[data-strat]").forEach((b) => b.addEventListener("click", () => {
  st.strategy = b.dataset.strat;
  root.querySelectorAll("[data-strat]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  reset();
}));
skewIn.addEventListener("change", () => { if (!skewIn.checked) splitIn.checked = false; reset(); });
splitIn.addEventListener("change", () => reset());
runBtn.addEventListener("click", run);
root.querySelector('[data-act="reset"]').addEventListener("click", () => reset());
reset();
