// Chapter 5, lesson 4: quorum playground with n, w, r, failures, read repair, and sloppy quorums.
import { quorumCluster, SPARES } from "../engines/ch5-quorum.js";
import { makeClock, spaceTime, esc } from "./ch5-util.js";

const root = document.getElementById("quorum");
const nIn = root.querySelector("#q-n"), wIn = root.querySelector("#q-w"), rIn = root.querySelector("#q-r");
const ruleEl = root.querySelector(".ch5-rule");
const repEl = root.querySelector(".ch5-replicas");
const tableEl = root.querySelector('[data-out="table"]');
const verdict = root.querySelector(".verdict");
const sloppyBox = root.querySelector("#q-sloppy");
const out = (input) => input.closest(".control").querySelector("output");
const list = (arr) => (arr.length < 2 ? arr.join("") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1]);

const st = spaceTime(root.querySelector(".st"), { window: 3200, rowH: 32, labelW: 70, aria: "Space-time diagram of the client and the replicas" });
const clock = makeClock(render, { onIdle: render });
let seed = 11;

const cfg = () => ({ n: +nIn.value, w: +wIn.value, r: +rIn.value, sloppy: sloppyBox.checked });

function reset() {
  const sim = quorumCluster({ ...cfg(), seed: seed++ });
  // Rebuild the replica buttons before the first draw: with a smaller n, the old
  // buttons name replicas that no longer exist.
  repEl.innerHTML = sim.home.map((id) => `<button class="btn sm" data-rep="${id}" aria-pressed="false">${id}</button>`).join("");
  clock.set(sim);
}

function syncSliders() {
  const n = +nIn.value;
  for (const input of [wIn, rIn]) { input.max = n; if (+input.value > n) input.value = n; }
  out(nIn).textContent = n; out(wIn).textContent = wIn.value; out(rIn).textContent = rIn.value;
  const { w, r } = cfg();
  const ok = w + r > n;
  ruleEl.className = `ch5-rule ${ok ? "good" : "bad"}`;
  const k = w + r - n;
  const writers = w === 1 ? "the replica that acknowledges a write" : `any ${w} replicas that acknowledge a write`;
  const readers = r === 1 ? "the replica that answers a read" : `any ${r} that answer a read`;
  ruleEl.innerHTML = ok
    ? `<b>w + r = ${w + r} &gt; n = ${n}.</b> ${writers[0].toUpperCase() + writers.slice(1)} and ${readers} share at least ${k} replica${k > 1 ? "s" : ""}. Every read reaches at least one replica with the latest successful write.`
    : `<b>w + r = ${w + r} ≤ n = ${n}.</b> ${r === 1 ? "The single replica that answers a read can be one" : `The ${r} replicas that answer a read can all be ones`} that missed the latest write. Stale reads are possible even with no failures.`;
}

function render(sim = clock.sim) {
  const showSpares = sim.cfg.sloppy || SPARES.some((s) => sim.node(s).hints.length || sim.msgs.some((m) => m.from === s || m.to === s));
  const cols = [...sim.home, ...(showSpares ? SPARES : [])];
  st.lanes = [{ id: "C", label: "Client" }, ...cols.map((id) => {
    const n = sim.node(id);
    if (SPARES.includes(id)) return { id, label: id, sub: n.hints.length ? "hint for " + [...new Set(n.hints.map((h) => h.for))].join(",") : "stand-in", subCls: n.hints.length ? "bad" : "" };
    return { id, label: id, sub: n.up ? "v" + n.ver : "down", subCls: !n.up ? "bad" : n.ver < sim.latest ? "bad" : "good" };
  })];
  st.draw(sim);

  repEl.querySelectorAll("[data-rep]").forEach((b) => {
    const n = sim.node(b.dataset.rep);
    b.setAttribute("aria-pressed", String(!n.up));
    b.textContent = `${b.dataset.rep} v${n.ver}`;
    b.title = n.up ? "Click to fail" : "Click to recover";
  });

  const lw = sim.lastWrite(), lr = sim.lastRead();
  const acked = new Set(lw ? lw.acks : []), counted = new Set(lr && lr.decided ? lr.counted : []);
  const cell = (id, inSet, other) => {
    if (!inSet.has(id)) return `<td></td>`;
    return `<td class="${other.has(id) ? "both" : "yes"}">✓</td>`;
  };
  tableEl.innerHTML = `<tr><th>Replica</th>${cols.map((id) => `<th>${id}</th>`).join("")}</tr>
    <tr><td>Holds</td>${cols.map((id) => {
      const n = sim.node(id);
      if (SPARES.includes(id)) return `<td class="${n.hints.length ? "yes" : "down"}">${n.hints.length ? "v" + Math.max(...n.hints.map((h) => h.ver)) + "*" : "–"}</td>`;
      return `<td class="${!n.up ? "down" : n.ver < sim.latest ? "old" : ""}">${n.up ? "v" + n.ver : "down"}</td>`;
    }).join("")}</tr>
    <tr><td>Acknowledged last write</td>${cols.map((id) => cell(id, acked, counted)).join("")}</tr>
    <tr><td>Counted in last read</td>${cols.map((id) => cell(id, counted, acked)).join("")}</tr>`;
  say(sim);
}

function say(sim) {
  const set = (cls, t) => { verdict.className = `verdict ${cls}`; verdict.textContent = t; };
  const op = sim.ops[sim.ops.length - 1];
  if (!op) return set("", "Start with a write, then a read. Then fail a replica or lower w and r.");
  if (!op.decided) return set("", op.type === "write" ? `Writing v${op.ver}: waiting for ${op.need} acknowledgement${op.need > 1 ? "s" : ""}...` : `Reading: waiting for the first ${op.need} answer${op.need > 1 ? "s" : ""}...`);
  const { n, w, r } = sim.cfg;
  if (op.type === "write") {
    if (op.ok) {
      const hinted = op.targets.filter((t) => t.hintFor && op.acks.includes(t.to));
      let t = `v${op.ver} written: ${list(op.acks)} acknowledged, and w = ${op.need} was enough.`;
      if (hinted.length) t += ` ${list(hinted.map((h) => `${h.to} holds it for ${h.hintFor}`))}. ${hinted.length > 1 ? "They" : "It"} will hand it over when ${hinted.length > 1 ? "those replicas recover" : "that replica recovers"}. Reads only ask home replicas, so until then they cannot see these copies.`;
      return set(hinted.length ? "" : "good", t);
    }
    const holders = sim.home.filter((id) => sim.node(id).ver >= op.ver);
    let t = `Write v${op.ver} failed: only ${op.acks.length} of the required ${op.need} replicas acknowledged.`;
    if (holders.length) t += ` Yet ${list(holders)} stored v${op.ver}, and nothing rolls it back. A later read may return a value whose write was reported as failed.`;
    return set("bad", t);
  }
  if (op.result == null) return set("bad", `Read failed: fewer than r = ${op.need} replicas answered.`);
  const repaired = op.repaired.length ? ` Read repair sent v${op.result} to ${list([...new Set(op.repaired)])}.` : "";
  const both = op.counted.filter((id) => (sim.lastWrite()?.acks || []).includes(id));
  if (op.stale) {
    const hints = SPARES.some((s) => sim.node(s).hints.length) || sim.msgs.some((m) => m.label === "handoff" && m.sent <= op.t && m.arrive > op.t);
    const why = hints ? "The newest copies sat on stand-in nodes, or were still being handed back, and reads do not consult stand-ins: a sloppy quorum is not a quorum."
      : w + r <= n ? `With w + r ≤ n, the ${r} replica${r > 1 ? "s" : ""} that answered first did not have to include any that acknowledged the write.`
      : "The replicas that answered had missed the write.";
    return set("bad", `Stale read: the client got v${op.result} from ${list(op.counted)}, but v${op.latestAtStart} had been written successfully. ${why}${repaired}`);
  }
  if (!op.latestAtStart) return set("", `Read v${op.result}: nothing has been written successfully yet.${repaired}`);
  const t = both.length && w + r > n
    ? `Up to date: v${op.result}. ${list(both)} answered the read and had also acknowledged the write, exactly the overlap that w + r > n guarantees.`
    : w + r > n ? `Up to date: v${op.result}.` : `Up to date: v${op.result}, but only by luck. With w + r ≤ n nothing guaranteed it.`;
  return set("good", t + repaired);
}

// ---- controls ----
nIn.addEventListener("input", () => { syncSliders(); reset(); });
for (const input of [wIn, rIn]) input.addEventListener("input", () => {
  syncSliders();
  Object.assign(clock.sim.cfg, { w: +wIn.value, r: +rIn.value });
  render();
});
sloppyBox.addEventListener("change", () => { clock.sim.cfg.sloppy = sloppyBox.checked; render(); });

root.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.rep) { const id = b.dataset.rep; clock.act((s) => (s.node(id).up ? s.crash(id) : s.recover(id))); return; }
  const act = b.dataset.act;
  if (act === "write") clock.act((s) => s.write());
  else if (act === "read") clock.act((s) => s.read());
  else if (act === "ae") clock.act((s) => s.antiEntropy());
  else if (act === "reset") reset();
});

syncSliders();
reset();
