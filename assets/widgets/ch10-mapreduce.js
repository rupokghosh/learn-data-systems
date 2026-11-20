// Chapter 10, lesson 2: an animated MapReduce job with a killable map task.
import { createJob } from "../engines/ch10-mapreduce.js";
import { esc, makeMover, makeLoop } from "./ch10-util.js";

const root = document.getElementById("mr");
const board = root.querySelector(".mr-board");
const verdict = root.querySelector(".verdict");
const o = (k) => root.querySelector(`[data-out="${k}"]`);
const mover = makeMover(board);
let job = createJob();

const PHASE = { ready: "not started", map: "map", shuffle: "shuffle", merge: "merge", reduce: "reduce", done: "done" };

function rec(r, cls = "") {
  return `<span class="rec ${cls}" data-fid="${r.id}"${r.from ? ` data-from="${r.from}"` : ""}><span class="k">${esc(r.k)}</span><span class="v">${esc(r.v)}</span></span>`;
}
const lane = (inner) => `<div class="lane">${inner}</div>`;

function render() {
  const s = job.state;
  const splits = s.splits.map((sp, i) => {
    const m = s.mappers[i];
    const reading = m.status === "running" ? m.pos - 1 : -1;
    const recs = sp.records.map((r, j) => {
      const cls = j === reading ? "hl" : (j < m.pos || m.status === "done") && m.status !== "failed" ? "seen" : "";
      return `<span class="rec ${cls}" data-fid="${r.id}"><span class="v">${r.user}</span><span class="k">${r.product}</span></span>`;
    }).join("");
    return `<div class="box"><div class="box-h"><span>Block ${i + 1}</span></div><div class="box-s">replicas on nodes ${sp.nodes.join(", ")}</div>${lane(recs)}</div>`;
  }).join("");

  const mappers = s.mappers.map((m) => {
    const cls = m.status === "failed" ? "failed" : m.status === "done" ? "ok" : m.status === "running" ? "on" : "";
    const status = m.status === "failed" ? `node ${m.node} is down` : m.status === "done" ? "finished, output sorted" : m.status === "running" ? (m.pos >= s.splits[m.split].records.length ? "sorting partitions" : `reading record ${m.pos} of ${s.splits[m.split].records.length}`) : "waiting";
    const parts = m.out.map((p, r) => `<p class="sub-l">for reducer ${r + 1}</p>${lane(p.map((x) => rec(x)).join(""))}`).join("");
    return `<div class="box ${cls}"><div class="box-h"><span>Map task ${m.id + 1}</span><span class="v" style="font-weight:400;color:var(--ink-3)">node ${m.node}${m.attempt > 1 ? ` · attempt ${m.attempt}` : ""}</span></div><div class="box-s">${status}</div>${parts}</div>`;
  }).join("");

  const reducers = s.reducers.map((r) => {
    const cls = r.status === "done" ? "ok" : r.status === "waiting" ? "" : "on";
    let inner;
    if (r.input.length) inner = lane(r.input.map((x, i) => rec(x, i < r.consumed ? "seen" : "")).join(""));
    else inner = r.runs.map((run, i) => `<p class="sub-l">run copied from map task ${i + 1}</p>${lane(run.map((x) => rec(x)).join(""))}`).join("") || lane("");
    const status = { waiting: "waiting for map output", fetching: `copied ${r.runs.length} of ${s.mappers.length} sorted runs`, reducing: `reducing key by key`, done: "finished" }[r.status];
    return `<div class="box ${cls}"><div class="box-h"><span>Reducer ${r.id + 1}</span><span class="v" style="font-weight:400;color:var(--ink-3)">partition ${r.id + 1}</span></div><div class="box-s">${status}</div>${inner}</div>`;
  }).join("");

  const outputs = s.reducers.map((r) => `<div class="box"><div class="box-h"><span class="mono" style="font-size:11px">part-r-0000${r.id}</span></div><div class="box-s">written to HDFS, replicated</div>${lane(r.out.map((x) => rec(x, "out")).join(""))}</div>`).join("");

  board.innerHTML = `
    <p class="b10-head"><b>Input splits</b><span>one block of the input file each</span></p><div class="b10-row" style="--n:3">${splits}</div>
    <p class="b10-head"><b>Map tasks</b><span>emit (product, 1), partitioned by hash(product) mod 2</span></p><div class="b10-row" style="--n:3">${mappers}</div>
    <p class="b10-head"><b>Reduce tasks</b><span>fetch, merge, sum</span></p><div class="b10-row" style="--n:2">${reducers}</div>
    <p class="b10-head"><b>Output files</b><span>one per reducer</span></p><div class="b10-row" style="--n:2">${outputs}</div>`;

  o("phase").textContent = PHASE[s.phase];
  o("attempts").textContent = String(s.attempts);
  o("emitted").textContent = String(s.emitted);
  o("shuffled").textContent = String(s.shuffled);
  root.querySelectorAll("[data-kill]").forEach((b) => (b.disabled = !job.canKill(+b.dataset.kill)));
  root.querySelector('[data-act="step"]').disabled = job.done;
}

function say(text, cls = "") { verdict.className = `verdict ${cls}`; verdict.textContent = text; }

async function doStep() {
  if (job.done) return false;
  let res;
  await mover.flip(() => { res = job.step(); render(); });
  say(res.text, job.done ? "good" : "");
  if (job.done) say(`Done. Five output records across two files, in sorted order within each file.${job.state.attempts > 3 ? ` The failed map task cost ${job.state.attempts - 3} extra attempt${job.state.attempts > 4 ? "s" : ""}, but the result is identical, because a map task is a deterministic function of its input block.` : ""}`, "good");
  return !job.done;
}

const loop = makeLoop(root.querySelector('[data-act="play"]'), doStep, 420);
root.querySelector('[data-act="step"]').addEventListener("click", () => { loop.stop(); doStep(); });
root.querySelector('[data-act="reset"]').addEventListener("click", () => {
  loop.stop(); mover.finish(); job = createJob(); render();
  say("Fifteen product view events sit in three blocks. Press Step or Play.");
});
root.querySelectorAll("[data-kill]").forEach((b) => b.addEventListener("click", () => {
  mover.finish();
  const res = job.kill(+b.dataset.kill);
  if (res) { render(); say(res.text, "bad"); }
}));

render();
say("Fifteen product view events sit in three blocks. Press Step or Play.");
