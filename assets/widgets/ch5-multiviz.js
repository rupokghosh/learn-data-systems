// Chapter 5, lesson 3: conflicting edits in three data centres, and replication topologies.
import { slider, ms } from "../charts.js";
import { teamRecord, DCS, STRATEGIES, topology, TOPO_NODES, TOPOLOGIES } from "../engines/ch5-multi.js";
import { makeClock, spaceTime, flightDots, esc } from "./ch5-util.js";

const secs = (t) => (t / 1000).toFixed(2) + " s";
const list = (arr) => (arr.length < 2 ? arr.join("") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1]);

// =============================================================== figure 1
{
  const root = document.getElementById("conflict");
  const cardsEl = root.querySelector(".ch5-cards");
  const stratEl = root.querySelector('[data-out="strategies"]');
  const lostEl = root.querySelector('[data-out="lost"]');
  const verdict = root.querySelector(".verdict");
  let strategy = "lww", delay = 900;

  const st = spaceTime(root.querySelector(".st"), {
    lanes: DCS.map((d) => ({ id: d.id, label: d.name, sub: d.skew ? `clock ${d.skew} ms` : "clock exact" })),
    window: 3200, labelW: 96, aria: "Space-time diagram of the three data centres",
  });
  const clock = makeClock(render, { onIdle: render });

  stratEl.innerHTML = STRATEGIES.map(([id, label]) => `<button class="btn" data-strat="${id}" aria-pressed="${id === strategy}">${esc(label)}</button>`).join("");
  cardsEl.innerHTML = DCS.map((d) => `<div class="ch5-card" data-dc="${d.id}">
      <div class="ch5-card-head"><span>${d.name}</span><span>${d.who}</span></div>
      <div class="ch5-card-val"></div>
      <div class="pick-row" hidden></div>
      <button class="btn" data-edit="${d.id}"></button>
    </div>`).join("");

  function reset() { clock.set(teamRecord({ delay, strategy })); }

  function render(sim = clock.sim) {
    st.draw(sim);
    for (const d of DCS) {
      const card = cardsEl.querySelector(`[data-dc="${d.id}"]`);
      const v = sim.view(d.id);
      const showConflict = v.conflict && (strategy === "merge" || strategy === "custom");
      card.classList.toggle("conflict", showConflict);
      const valEl = card.querySelector(".ch5-card-val");
      const pick = card.querySelector(".pick-row");
      if (strategy === "custom" && v.conflict) {
        valEl.textContent = "Conflict: pick one";
        const vals = [...new Set(v.heads.map((w) => w.val))].sort();
        const key = vals.join("|");
        if (pick.dataset.key !== key) {
          pick.dataset.key = key;
          pick.innerHTML = vals.map((x) => `<button class="btn sm" data-resolve="${d.id}" data-val="${esc(x)}">${esc(x)}</button>`).join("");
        }
        pick.hidden = false;
      } else {
        valEl.textContent = v.val;
        pick.hidden = true;
        pick.dataset.key = "";
      }
      const via = strategy === "home" && d.id !== "fra" ? " (via Frankfurt)" : "";
      card.querySelector("[data-edit]").textContent = `${d.who} sets ${sim.nextVal(d.id)}${via}`;
    }
    const lost = sim.lost();
    lostEl.innerHTML = lost.length
      ? lost.map((w) => `<span class="rec warn"><span class="k">${esc(w.val)}</span><span class="v">${esc(w.who)}, stamped ${secs(w.ts)}, written ${secs(w.real)}</span></span>`).join("")
      : `<span class="ch5-empty">none</span>`;
    say(sim, lost);
  }

  function say(sim, lost) {
    const set = (cls, t) => { verdict.className = `verdict ${cls}`; verdict.textContent = t; };
    if (sim.msgs.some((m) => m.status === "flight")) return set("", "Replicating between data centres...");
    const edits = [...sim.node("fra").writes.values()].filter((w) => w.id !== "w0");
    if (!edits.length) return set("", "Every data centre shows Oslo. Press Edit all three at once, or make edits one by one, faster than the delay.");
    const v = sim.view("fra");
    if (strategy === "home") return set("good", "Every edit was ordered by the Frankfurt leader, so no conflict can arise. The price: edits from Singapore and São Paulo make a round trip to Frankfurt first, and stop working if Frankfurt is unreachable.");
    if (strategy === "lww" && lost.length) {
      const win = v.winner;
      const later = lost.filter((w) => w.real > win.real);
      let t = `Every data centre converged on ${win.val}, the edit with the highest timestamp. ${list(lost.map((w) => w.val))} ${lost.length > 1 ? "were" : "was"} silently discarded: no error, no trace that ${lost.length > 1 ? "they" : "it"} ever existed.`;
      if (later.length) t += ` ${list(later.map((w) => w.val))} ${later.length > 1 ? "were" : "was"} in fact written later than ${win.val}, but Singapore's clock runs 400 ms slow, so ${later.length > 1 ? "their timestamps were" : "its timestamp was"} lower.`;
      return set("bad", t);
    }
    if (strategy === "merge" && v.conflict) return set("", `Every data centre converged on "${v.val}". Nothing was lost, but nobody chose this value either. Merging suits sets and counters better than a single destination.`);
    if (strategy === "custom" && v.conflict) return set("", "All three data centres hold the same set of conflicting versions, and none is dropped. Pick one in any data centre: the choice is a new write that replicates and settles the conflict everywhere.");
    if (edits.some((w) => w.who === "resolved")) return set("good", `Resolved to ${v.val} by a person. That decision replicated like any other write, and it supersedes every version it was chosen from.`);
    return set("good", `No conflict: each edit arrived before the next one was made, so it simply replaced the previous value. Edit faster than the ${ms(delay)} delay, or use Edit all three at once, to get a conflict.`);
  }

  slider(root.querySelector("#mc-delay"), ms, (v) => { delay = v; if (clock.sim) clock.sim.cfg.delay = v; });

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.strat) {
      const was = strategy;
      strategy = b.dataset.strat;
      stratEl.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      // The same history can be re-read under another rule, except when routing changes.
      if (was === "home" || strategy === "home") reset();
      else { clock.sim.cfg.strategy = strategy; render(); }
    } else if (b.dataset.edit) clock.act((s) => s.edit(b.dataset.edit));
    else if (b.dataset.resolve) clock.act((s) => s.resolve(b.dataset.resolve, b.dataset.val));
    else if (b.dataset.act === "all") clock.act((s) => DCS.forEach((d) => s.edit(d.id)));
    else if (b.dataset.act === "reset") reset();
  });
  reset();
}

// =============================================================== figure 2
{
  const root = document.getElementById("topo");
  const svg = root.querySelector(".topo svg");
  const verdict = root.querySelector(".verdict");
  let kind = "circular", mode = "write", demo = false, lastOp = null;

  const POS = {
    ring: { A: { x: 210, y: 40 }, B: { x: 360, y: 140 }, C: { x: 210, y: 240 }, D: { x: 60, y: 140 } },
    star: { A: { x: 210, y: 140 }, B: { x: 210, y: 36 }, C: { x: 350, y: 236 }, D: { x: 70, y: 236 } },
  };
  const pos = () => (kind === "star" ? POS.star : POS.ring);
  const EDGES = {
    circular: [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"]],
    star: [["A", "B"], ["A", "C"], ["A", "D"]],
    all: [["A", "B"], ["A", "C"], ["A", "D"], ["B", "C"], ["B", "D"], ["C", "D"]],
  };

  const st = spaceTime(root.querySelector(".st"), {
    lanes: TOPO_NODES.map((id) => ({ id, label: "Leader " + id })), window: 2600, rowH: 34, labelW: 74,
    aria: "Space-time diagram of four leaders",
  });
  const clock = makeClock(render, { onIdle: render });

  let built = null, dotsEl = null;
  const nodeEls = {};
  // Edges and nodes are built once per topology; each frame only updates them and redraws the dots.
  function build() {
    const P = pos();
    let s = `<defs><marker id="tp-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--line-2)"/></marker></defs>`;
    for (const [a, b] of EDGES[kind]) {
      const p = P[a], q = P[b];
      const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy);
      const k = 46 / L;
      const arrow = kind === "circular" ? ` marker-end="url(#tp-arr)"` : "";
      s += `<line x1="${p.x + dx * k}" y1="${p.y + dy * k}" x2="${q.x - dx * k}" y2="${q.y - dy * k}" class="dg-edge"${arrow}/>`;
    }
    for (const id of TOPO_NODES) {
      const p = P[id];
      const hub = kind === "star" && id === "A";
      s += `<g class="dg-node${hub ? " hub" : ""}" data-node="${id}" role="button" tabindex="0">
        <rect x="${p.x - 44}" y="${p.y - 24}" width="88" height="48" rx="8"/>
        <text x="${p.x}" y="${p.y - 4}" text-anchor="middle">${id}${hub ? " (hub)" : ""}</text>
        <text x="${p.x}" y="${p.y + 13}" text-anchor="middle" class="sub"></text></g>`;
    }
    s += `<g class="dots"></g>`;
    svg.innerHTML = s;
    dotsEl = svg.querySelector(".dots");
    for (const id of TOPO_NODES) nodeEls[id] = svg.querySelector(`[data-node="${id}"]`);
    built = kind;
  }

  function reset() { demo = false; lastOp = null; build(); clock.set(topology({ kind })); }

  function render(sim = clock.sim) {
    if (built !== kind) build();
    for (const id of TOPO_NODES) {
      const n = sim.node(id), g = nodeEls[id];
      g.classList.toggle("down", !n.up);
      g.classList.toggle("err", n.errors.length > 0);
      const row = n.rows.get("order-88");
      const sub = !n.up ? "down" : row ? `order 88: ${row}` : n.seen.filter((x) => x.startsWith("x")).slice(-4).join(" ") || "no writes";
      g.querySelector(".sub").textContent = sub;
      g.setAttribute("aria-label", `Leader ${id}, ${sub}`);
    }
    dotsEl.innerHTML = flightDots(sim, pos());
    st.draw(sim);
    say(sim);
  }

  function say(sim) {
    const set = (cls, t) => { verdict.className = `verdict ${cls}`; verdict.textContent = t; };
    if (sim.msgs.some((m) => m.status === "flight")) return set("", "Propagating...");
    if (demo) {
      const c = sim.node("C");
      if (c.errors.length) return set("bad", `C received B's "paid" update before A's insert, because the link from A to C is slow. The update found no row and failed; then the insert arrived. C now says "${c.rows.get("order-88")}" while the others say "paid", and this protocol has no way to repair it. Attaching timestamps does not help: C needs to know that the update depends on the insert.`);
      return set("", "");
    }
    if (!lastOp) return set("", mode === "write" ? "Click a leader to make a write there." : "Click a leader to fail it, then switch to Write and click another.");
    const up = TOPO_NODES.filter((id) => sim.node(id).up);
    const missing = up.filter((id) => !sim.node(id).seen.includes(lastOp.id));
    const down = TOPO_NODES.filter((id) => !sim.node(id).up);
    if (!missing.length) {
      if (down.length && kind === "all") return set("good", `${lastOp.id} reached every running leader. In all-to-all, each leader sends straight to every other, so a failure only affects the failed node.`);
      if (down.length && kind === "star") return set("good", `${lastOp.id} reached every running leader. Only the failed leaf misses out, because nothing has to pass through it.`);
      if (down.length) return set("good", `${lastOp.id} reached every running leader: on its way round the ring it did not have to pass through ${list(down)}.`);
      return set("good", `${lastOp.id} reached every leader. Now fail one and write again.`);
    }
    if (kind === "circular") return set("bad", `${list(missing)} never received ${lastOp.id}, although ${missing.length > 1 ? "they are" : "it is"} running. In a ring every write passes through each node in turn, and ${list(down)} is down, so the chain is broken until someone reconfigures the ring.`);
    if (kind === "star") return set("bad", `${list(missing)} never received ${lastOp.id}. Every write between leaves passes through the hub, A, and A is down.`);
    return set("bad", `${list(missing)} did not receive ${lastOp.id}.`);
  }

  function nodeAction(id) {
    if (demo) reset();
    if (mode === "fail") clock.act((s) => (s.node(id).up ? s.crash(id) : s.recover(id)));
    else clock.act((s) => { const o = s.write(id); if (o) lastOp = o; });
  }

  root.addEventListener("click", (e) => {
    const g = e.target.closest("[data-node]");
    if (g) return nodeAction(g.dataset.node);
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.kind) {
      kind = b.dataset.kind;
      root.querySelectorAll("[data-kind]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      reset();
    } else if (b.dataset.mode) {
      mode = b.dataset.mode;
      root.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      render();
    } else if (b.dataset.act === "overtake") {
      kind = "all";
      root.querySelectorAll("[data-kind]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.kind === "all")));
      reset();
      demo = true;
      clock.act((s) => s.overtake());
    } else if (b.dataset.act === "reset") reset();
  });
  root.addEventListener("keydown", (e) => {
    const g = e.target.closest("[data-node]");
    if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); nodeAction(g.dataset.node); }
  });
  reset();
}
