// Chapter 5, lesson 1: one leader, three followers, sync or async, and failover.
import { slider, ms } from "../charts.js";
import { leaderCluster, DB_NODES } from "../engines/ch5-leader.js";
import { makeClock, spaceTime, esc } from "./ch5-util.js";

const root = document.getElementById("failover");
const nodesEl = root.querySelector(".ch5-nodes");
const verdict = root.querySelector(".verdict");
const out = (k) => root.querySelector(`[data-out="${k}"]`);
const fenceBox = root.querySelector("#fo-fence");
const failBtn = root.querySelector('[data-act="failover"]');

const sync = new Set();
let base = 160, timeout = 800;

const st = spaceTime(root.querySelector(".st"), { window: 3000, aria: "Space-time diagram of the app, the cron job, and nodes n1 to n4" });
const clock = makeClock(render, { onIdle: render });

// ---- node panels (built once, updated in place) ----
const panels = {};
for (const id of DB_NODES) {
  const d = document.createElement("div");
  d.className = "ch5-node";
  d.innerHTML = `<div class="ch5-node-head"><span class="ch5-node-name">${id}</span><span class="ch5-role"></span>
    <span class="ch5-node-btns"><button class="btn sm" data-sync="${id}" aria-pressed="false">async</button><button class="btn sm" data-crash="${id}">Crash</button></span></div>
    <div class="lane ch5-log"></div>`;
  nodesEl.appendChild(d);
  panels[id] = { box: d, role: d.querySelector(".ch5-role"), sync: d.querySelector("[data-sync]"), crash: d.querySelector("[data-crash]"), log: d.querySelector(".ch5-log"), key: "" };
}

function reset() {
  clock.set(leaderCluster({ base, sync, fence: fenceBox.checked }));
}

function render(sim = clock.sim) {
  const lost = new Set(sim.lostWrites());
  const leaders = sim.activeLeaders();
  const curLog = new Set(sim.node(sim.leader).log.map((e) => e.w));
  st.lanes = [
    { id: "app", label: "App", sub: "→ " + sim.node("app").target },
    { id: "cron", label: "Cron job", sub: "→ " + sim.node("cron").target },
    ...DB_NODES.map((id) => {
      const n = sim.node(id);
      const role = !n.up ? "down" : n.role === "leader" ? (id === sim.leader ? "leader" : "old leader") : sim.cfg.sync.has(id) ? "sync follower" : "follower";
      return { id, label: id, sub: role, subCls: !n.up || role === "old leader" ? "bad" : role === "leader" ? "lead" : "" };
    }),
  ];
  st.draw(sim);

  for (const id of DB_NODES) {
    const n = sim.node(id), p = panels[id];
    const isLeader = n.role === "leader";
    p.box.classList.toggle("is-leader", isLeader && n.up);
    p.box.classList.toggle("is-down", !n.up);
    p.role.textContent = !n.up ? "down" : isLeader ? (id === sim.leader ? `leader, epoch ${n.epoch}` : `thinks it leads, epoch ${n.epoch}`) : `follows ${n.leader}`;
    p.sync.hidden = isLeader;
    p.sync.setAttribute("aria-pressed", String(sim.cfg.sync.has(id) && !isLeader));
    p.sync.textContent = sim.cfg.sync.has(id) && !isLeader ? "sync" : "async";
    p.crash.textContent = n.up ? "Crash" : "Restart";
    const key = n.log.map((e) => e.w + (lost.has(e.w) ? "l" : "") + (curLog.has(e.w) ? "c" : "")).join(",") + "|" + [...sim.writes.values()].map((r) => r.status[0]).join("");
    if (key !== p.key) {
      p.key = key;
      p.log.innerHTML = n.log.length
        ? n.log.map((e, i) => {
            const r = sim.writes.get(e.w);
            const cls = lost.has(e.w) ? "warn" : r.status === "acked" ? "hl" : "";
            return `<span class="rec ${cls}" title="position ${i + 1}"><span class="v">${i + 1}</span><span class="k">w${e.w}</span></span>`;
          }).join("")
        : `<span class="ch5-empty">empty log</span>`;
    }
  }

  const all = [...sim.writes.values()];
  out("acked").textContent = all.filter((r) => r.status === "acked").length;
  out("waiting").textContent = all.filter((r) => r.status === "sent").length;
  out("lost").textContent = lost.size;
  out("leaders").textContent = leaders.length;
  out("lost").closest(".stat").classList.toggle("bad", lost.size > 0);
  out("leaders").closest(".stat").classList.toggle("bad", leaders.length > 1);
  failBtn.disabled = !sim.canFailover();
  say(sim, lost, leaders);
}

function say(sim, lost, leaders) {
  const list = (arr) => arr.map((w) => "w" + w).join(", ");
  const cur = sim.node(sim.leader);
  if (leaders.length > 1) {
    const other = leaders.find((x) => x !== sim.leader);
    const a = sim.node(other).log, b = cur.log;
    let p = 0;
    while (p < a.length && p < b.length && a[p].w === b[p].w) p++;
    const where = p < a.length && p < b.length ? ` Position ${p + 1} holds w${a[p].w} on ${other} but w${b[p].w} on ${cur.id}.` : "";
    return set("bad", `Split brain: ${other} and ${cur.id} both accept writes, and their logs have diverged.${where} No automatic rule can merge them safely. Reset, turn on fencing, and bring the old leader back again.`);
  }
  if (sim.failoverRunning) return set("", `Nobody has heard from ${sim.leader} yet. The followers wait for the ${ms(timeout)} timeout before they act, and writes to ${sim.leader} go unanswered until then.`);
  if (lost.size) {
    const f = sim.failovers[sim.failovers.length - 1];
    const many = lost.size > 1;
    const why = f ? ` The client was told ${many ? "they were" : "it was"} saved, but ${f.to} never received ${many ? "them" : "it"} before ${f.from} crashed, and ${f.to} is now the leader.` : "";
    const back = f && sim.node(f.from).up && sim.node(f.from).role === "follower" ? ` When ${f.from} came back it rejoined as a follower and threw away its own copy.` : "";
    return set("bad", `Acknowledged but lost: ${list([...lost])}.${why}${back} Reset, make one follower synchronous, and repeat.`);
  }
  if (!cur.up) return set("", `${cur.id} is down. Writes sent to it get no reply. Press Run failover to promote a follower.`);
  const blocked = cur.pending.length && cur.followers.some((f) => sim.cfg.sync.has(f) && !sim.node(f).up);
  if (blocked) return set("bad", `${list(cur.pending.map((p) => p.w))} cannot be acknowledged: a synchronous follower is down, so the leader waits for it. Make it asynchronous or restart it.`);
  const f = sim.failovers[sim.failovers.length - 1];
  if (f && sim.node(f.from).up && sim.node(f.from).role === "follower") {
    const gone = sim.discarded.filter((d) => d.node === f.from).map((d) => d.w);
    return set("good", `${f.from} came back, saw the newer epoch, and rejoined as a follower of ${sim.leader}${gone.length ? `, throwing away ${list(gone)}, which no other node had` : ""}. Writes the cron job still sends to ${f.from} are now refused instead of silently forking the data.`);
  }
  if (sim.failovers.length) return set("good", `Failover done: ${sim.leader} leads and the app was reconfigured. The cron job still sends to ${sim.node("cron").target}. Restart the old leader to see what happens next.`);
  if (sim.writes.size) return set("", `Asynchronous followers let the leader acknowledge as soon as its own log has the write. Now crash ${sim.leader} while writes are still on their way to the followers.`);
  return set("", "");
}
function set(cls, text) { verdict.className = `verdict ${cls}`; verdict.textContent = text; }

// ---- controls ----
slider(root.querySelector("#fo-delay"), (v) => ms(v), (v) => { base = v; if (clock.sim) clock.sim.cfg.base = v; });
slider(root.querySelector("#fo-timeout"), (v) => ms(v), (v) => { timeout = v; });

root.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.sync) {
    const id = b.dataset.sync;
    if (sync.has(id)) sync.delete(id); else sync.add(id);
    clock.act((s) => s.checkPending());
    render();
    return;
  }
  if (b.dataset.crash) {
    const id = b.dataset.crash;
    clock.act((s) => (s.node(id).up ? s.crash(id) : s.recover(id)));
    return;
  }
  const act = b.dataset.act;
  if (act === "write-app") clock.act((s) => s.write("app"));
  else if (act === "write-cron") clock.act((s) => s.write("cron"));
  else if (act === "failover") clock.act((s) => s.failover(timeout));
  else if (act === "reset") reset();
});
fenceBox.addEventListener("change", () => {
  const s = clock.sim;
  s.cfg.fence = fenceBox.checked;
  if (fenceBox.checked) clock.act((x) => x.fenceNow());
});

reset();
