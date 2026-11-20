// Chapter 11, lesson 1: a log-based broker with a consumer group, and a traditional queue.
import { rng, responsive } from "../charts.js";
import { LogBroker, QueueBroker } from "../engines/ch11-broker.js";
import { say, makeLoop, radio } from "./ch11-util.js";

/* ------------------------------------------------------------------
   1. Log-based broker
   ------------------------------------------------------------------ */
{
  const root = document.getElementById("logbroker");
  const logOut = root.querySelector('[data-out="log"]');
  const groupOut = root.querySelector('[data-out="group"]');
  const verdict = root.querySelector(".verdict");
  const playBtn = root.querySelector('[data-act="play"]');
  const rateIn = root.querySelector("#lb-rate");
  const commitIn = root.querySelector("#lb-commit");
  const seekIn = root.querySelector("#lb-seek");
  const out = (k) => root.querySelector(`[data-stat="${k}"]`);

  // Keys chosen so that two keys land on each of the three partitions.
  const KEYS = [
    { key: "pia", color: "var(--accent)" }, { key: "lena", color: "var(--purple)" },
    { key: "mara", color: "var(--orange)" }, { key: "tess", color: "var(--green)" },
    { key: "ivo", color: "var(--red)" }, { key: "kit", color: "var(--ink-3)" },
  ];
  const COLOR = Object.fromEntries(KEYS.map((k) => [k.key, k.color]));
  const ACTIONS = ["move", "chat", "score", "trade"];
  const CW = 28; // cell pitch in px
  const MAXC = 4;

  let b, rand, credit, width = 0, groupSig = "", lastExpired = 0;
  const rows = []; // per partition: { track, label, cells: Map, cursor, commit, behind }

  function build() {
    logOut.innerHTML = "";
    rows.length = 0;
    for (let p = 0; p < 3; p++) {
      const row = document.createElement("div");
      row.className = "c11-prow";
      row.innerHTML = `<div class="c11-plabel"><strong>P${p}</strong><span data-r="owner"></span><span data-r="lag"></span></div>
        <div class="c11-track"><div class="c11-commit" title="committed offset"></div><div class="c11-cursor"><span></span></div><div class="c11-behind"></div></div>`;
      logOut.appendChild(row);
      rows.push({
        track: row.querySelector(".c11-track"),
        owner: row.querySelector('[data-r="owner"]'),
        lag: row.querySelector('[data-r="lag"]'),
        cursor: row.querySelector(".c11-cursor"),
        commit: row.querySelector(".c11-commit"),
        behind: row.querySelector(".c11-behind"),
        cells: new Map(),
      });
    }
  }

  function produceOne() {
    const k = KEYS[Math.floor(rand() * KEYS.length)].key;
    b.produce(k, ACTIONS[Math.floor(rand() * ACTIONS.length)]);
  }

  function reset() {
    loop.stop();
    b = new LogBroker({ partitions: 3, retention: 30, commitEvery: +commitIn.value, rate: 1, slowRate: 0.2 });
    rand = rng(11);
    credit = 0;
    lastExpired = 0;
    groupSig = "";
    b.addConsumer("C1");
    b.addConsumer("C2");
    for (let i = 0; i < 12; i++) produceOne();
    for (let i = 0; i < 3; i++) b.tick();
    build();
    render();
    say(verdict, "Twelve events are in the log. C1 reads P0 and P2, C2 reads P1. Press Play to keep events flowing.");
  }

  function tick() {
    credit += +rateIn.value;
    while (credit >= 1) { produceOne(); credit -= 1; }
    b.tick();
    render();
    if (b.stats.expired > lastExpired) {
      say(verdict, `Retention deleted ${b.stats.expired - lastExpired} message${b.stats.expired - lastExpired === 1 ? "" : "s"} before the group read ${b.stats.expired - lastExpired === 1 ? "it" : "them"}. The log is a bounded buffer: a consumer that falls further behind than the retention period silently skips data.`, "bad");
      lastExpired = b.stats.expired;
    }
  }

  function cellClass(p, m) {
    const owner = b.owner[p] && b.consumer(b.owner[p]);
    const pos = owner ? owner.pos[p] : b.committed[p];
    const n = b.times.get(`${p}:${m.offset}`) || 0;
    let cls = "c11-cell";
    if (m.offset < b.committed[p]) cls += " done";
    else if (m.offset < pos) cls += " inflight";
    if (n > 1) cls += " again";
    return cls;
  }

  function render() {
    const trackW = rows[0]?.track.clientWidth || width || 300;
    const visible = Math.max(5, Math.floor((trackW - 22) / CW));
    for (let p = 0; p < 3; p++) {
      const r = rows[p];
      const P = b.parts[p];
      const end = b.end(p);
      const win = Math.max(P.start, end - visible);
      // remove cells that left the window
      for (const [off, node] of r.cells) if (off < win || off < P.start) { node.remove(); r.cells.delete(off); }
      for (const m of P.msgs) {
        if (m.offset < win) continue;
        let node = r.cells.get(m.offset);
        if (!node) {
          node = document.createElement("div");
          node.innerHTML = `<span class="o">${m.offset}</span><span class="k">${m.key[0].toUpperCase()}</span>`;
          node.style.setProperty("--kc", COLOR[m.key]);
          node.title = `offset ${m.offset}: ${m.key} ${m.value}`;
          node.style.transform = `translateX(${(m.offset - win) * CW}px)`;
          r.track.appendChild(node);
          r.cells.set(m.offset, node);
        }
        node.className = cellClass(p, m);
        node.style.transform = `translateX(${(m.offset - win) * CW}px)`;
      }
      const owner = b.owner[p] && b.consumer(b.owner[p]);
      const pos = owner ? Math.max(owner.pos[p], P.start) : Math.max(b.committed[p], P.start);
      const cx = (pos - win) * CW;
      r.cursor.style.transform = `translateX(${Math.max(0, cx) - 1}px)`;
      r.cursor.classList.toggle("off", !owner);
      r.cursor.querySelector("span").textContent = owner && pos >= win ? owner.name : "";
      const kx = (Math.max(b.committed[p], P.start) - win) * CW;
      r.commit.style.transform = `translateX(${Math.max(0, kx) - 1}px)`;
      r.behind.textContent = pos < win ? `← ${owner ? owner.name : "group"} at ${pos}` : "";
      r.behind.hidden = pos >= win;
      r.owner.textContent = owner ? `${owner.name}${owner.slow ? " (slow)" : ""}` : "no consumer";
      const lag = b.lag(p);
      r.lag.textContent = `lag ${lag}`;
      r.lag.className = lag > 10 ? "warn" : "";
    }
    renderGroup();
    const maxEnd = Math.max(...b.parts.map((_, p) => b.end(p)));
    const minStart = Math.min(...b.parts.map((P) => P.start));
    seekIn.min = minStart;
    seekIn.max = Math.max(minStart, maxEnd);
    if (+seekIn.value > maxEnd) seekIn.value = maxEnd;
    seekIn.dispatchEvent(new Event("sync"));
    out("produced").textContent = b.stats.produced;
    out("processed").textContent = b.stats.processed;
    out("again").textContent = b.stats.again;
    out("lag").textContent = [0, 1, 2].reduce((s, p) => s + b.lag(p), 0);
  }

  function renderGroup() {
    const sig = b.consumers.map((c) => `${c.name}:${c.slow}:${Object.keys(c.pos).join(",")}`).join("|");
    if (sig === groupSig) return;
    groupSig = sig;
    const chips = b.consumers.map((c) => {
      const parts = Object.keys(c.pos).map((p) => `P${p}`).join(", ") || "idle, no partition";
      return `<div class="c11-chip${c.slow ? " slow" : ""}"><span class="c11-chip-name">${c.name}</span><span class="c11-chip-sub">${parts}</span>
        <button class="btn" data-slow="${c.name}" aria-pressed="${c.slow}">Slow</button><button class="btn" data-crash="${c.name}">Crash</button></div>`;
    }).join("");
    const add = b.consumers.length < MAXC ? `<button class="btn" data-add>Add consumer</button>` : "";
    groupOut.innerHTML = chips + add + (b.consumers.length ? "" : `<span class="note">The group has no members. Messages wait in the log.</span>`);
  }

  function describeMoves(notes) {
    return notes.map((n) => `P${n.p} ${n.from ? `moved from ${n.from}` : "was unassigned"}${n.to ? ` to ${n.to}` : " and now has no reader"}`).join("; ");
  }

  groupOut.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.slow) {
      const c = b.consumer(t.dataset.slow);
      c.slow = !c.slow;
      render();
      say(verdict, c.slow
        ? `${c.name} now handles one message every five ticks. Its lag climbs, but nothing is lost: the messages stay in the log until ${c.name} gets to them, as long as retention does not delete them first.`
        : `${c.name} is back to full speed and starts to catch up.`);
    } else if (t.dataset.crash) {
      const name = t.dataset.crash;
      const redo = b.crash(name);
      const moves = describeMoves(b.notes);
      render();
      const again = redo.map((r) => `P${r.p} offset${r.to > r.from ? `s ${r.from} to ${r.to}` : ` ${r.from}`}`).join(" and ");
      const resume = b.consumers.length ? "The new owner starts from the last committed offset." : "Whichever consumer joins next will start from the last committed offset.";
      say(verdict, `${name} crashed. ${moves ? moves + "." : ""} ${resume} ${again
        ? `${name} had processed ${again} without committing, so those messages will be processed a second time.`
        : `${name} had committed everything it processed, so nothing is repeated.`}`, redo.length ? "bad" : "good");
    } else if (t.hasAttribute("data-add")) {
      const names = new Set(b.consumers.map((c) => c.name));
      let i = 1;
      while (names.has(`C${i}`)) i++;
      b.addConsumer(`C${i}`);
      const moves = describeMoves(b.notes);
      render();
      say(verdict, b.consumers.length > 3
        ? `C${i} joined, but there are only three partitions. It sits idle: within one group, a partition is never split between consumers.`
        : `C${i} joined and the group rebalanced${moves ? `: ${moves}` : ""}. Each partition still has exactly one reader in the group, so messages within a partition stay in order.`);
    }
  });

  const loop = makeLoop(tick, 650, (on) => { playBtn.textContent = on ? "Pause" : "Play"; });
  playBtn.addEventListener("click", () => loop.toggle());
  root.querySelector('[data-act="step"]').addEventListener("click", () => { loop.stop(); tick(); });
  root.querySelector('[data-act="burst"]').addEventListener("click", () => {
    for (const k of KEYS) b.produce(k.key, ACTIONS[Math.floor(rand() * ACTIONS.length)]);
    render();
    say(verdict, "One event per player. Each key always hashes to the same partition, so all of one player's events stay in order relative to each other.");
  });
  root.querySelector('[data-act="reset"]').addEventListener("click", reset);
  root.querySelector('[data-act="seek"]').addEventListener("click", () => {
    const o = +seekIn.value;
    b.seek(o);
    render();
    say(verdict, `The group's committed offsets were moved back to ${o} (or to the oldest retained message). The log itself did not change; the consumers simply read those messages again. This is how you reprocess history after fixing a bug in a consumer.`);
  });

  const commitOut = commitIn.closest(".control").querySelector("output");
  const syncCommit = () => { commitOut.textContent = `${commitIn.value} message${commitIn.value === "1" ? "" : "s"}`; if (b) b.commitEvery = +commitIn.value; };
  commitIn.addEventListener("input", syncCommit);
  const rateOut = rateIn.closest(".control").querySelector("output");
  const syncRate = () => { rateOut.textContent = `${rateIn.value} per tick`; };
  rateIn.addEventListener("input", syncRate);
  const seekOut = seekIn.closest(".control").querySelector("output");
  const syncSeek = () => { seekOut.textContent = `offset ${seekIn.value}`; };
  seekIn.addEventListener("input", syncSeek);
  seekIn.addEventListener("sync", syncSeek);
  syncCommit(); syncRate();

  reset();
  responsive(logOut, (w) => { width = w; render(); });
}

/* ------------------------------------------------------------------
   2. Traditional queue: delete on acknowledgement
   ------------------------------------------------------------------ */
{
  const root = document.getElementById("queue");
  const view = root.querySelector('[data-out="queue"]');
  const verdict = root.querySelector(".verdict");
  const playBtn = root.querySelector('[data-act="play"]');
  const crashBtn = root.querySelector('[data-act="crash"]');
  const MSGS = ["inv-1", "inv-2", "inv-3", "inv-4", "inv-5", "inv-6", "inv-7", "inv-8"];
  let mode = "balance", q, crashedAt = null;

  const CONSUMERS = {
    balance: [{ name: "A", work: 2, label: "PDF worker A" }, { name: "B", work: 3, label: "PDF worker B" }],
    fanout: [{ name: "A", work: 2, label: "PDF renderer" }, { name: "B", work: 3, label: "Email sender" }],
  };

  function reset() {
    loop.stop();
    q = new QueueBroker({ mode, messages: MSGS, consumers: CONSUMERS[mode] });
    crashedAt = null;
    render();
    say(verdict, mode === "balance"
      ? "Eight invoices to render, two interchangeable workers. Each message goes to exactly one of them."
      : "Each consumer has its own queue and receives every message: one renders the PDF, the other emails it.");
  }

  const rec = (m, cls = "") => `<span class="rec ${cls}"><span class="k">${m.id}</span></span>`;

  function render() {
    const bad = q.outOfOrder();
    const queues = mode === "fanout"
      ? q.consumers.map((c) => `<p class="lane-label"><span>Queue for ${c.name}</span><span>${q.queues[c.name].length} waiting</span></p>
          <div class="lane${q.queues[c.name].length ? "" : " c11-empty"}">${q.queues[c.name].map((m) => rec(m, m.deliveries ? "warn" : "")).join("")}</div>`).join("")
      : `<p class="lane-label"><span>Queue</span><span>${q.queues.shared.length} waiting</span></p>
          <div class="lane${q.queues.shared.length ? "" : " c11-empty"}">${q.queues.shared.map((m) => rec(m, m.deliveries ? "warn" : "")).join("")}</div>`;
    const limbo = q.limbo.length ? `<p class="note" style="margin:0 0 4px">Unacknowledged, waiting for the broker's timeout: ${q.limbo.map((l) => l.m.id).join(", ")}</p>` : "";
    const workers = q.consumers.map((c, i) => {
      const meta = CONSUMERS[mode][i];
      const state = !c.alive ? "crashed" : c.busy ? `working, ${c.left} tick${c.left === 1 ? "" : "s"} left` : "idle";
      return `<div class="c11-worker${c.alive ? "" : " dead"}"><p class="lane-label"><span>${meta.label}</span><span>${state}</span></p>
        <div class="lane">${c.busy ? rec(c.busy, "hl") : ""}</div></div>`;
    }).join("");
    const done = q.log.map((e) => `<span class="rec ${bad.has(e) ? "warn" : "dead-soft"}" title="${e.redelivered ? "redelivered" : ""}"><span class="k">${e.id}</span><span class="v">${e.by}${e.redelivered ? " again" : ""}</span></span>`).join("");
    view.innerHTML = `${queues}${limbo}<div class="c11-workers">${workers}</div>
      <p class="lane-label"><span>Acknowledged, then deleted from the broker (completion order)</span><span>${q.acked}</span></p>
      <div class="lane${q.log.length ? "" : " c11-empty"}">${done}</div>`;
    const b = q.consumers.find((c) => c.name === "B");
    crashBtn.textContent = b.alive ? "Crash B" : "Restart B";
  }

  function tick() {
    if (q.finished) { loop.stop(); return false; }
    q.tick();
    render();
    const stalled = !q.finished && q.inFlight === 0 && q.limbo.length === 0
      && q.consumers.every((c) => !c.alive || q.queueFor(c).length === 0);
    if (stalled) {
      say(verdict, "Nothing more can happen until B restarts. Its messages wait in the queue, which is exactly what a durable queue is for.");
      loop.stop();
      return false;
    }
    if (q.finished) {
      const bad = q.outOfOrder();
      if (mode === "balance") {
        const redo = [...bad].filter((e) => e.redelivered);
        const why = redo.length
          ? `${redo.map((e) => e.id).join(", ")} finished after invoices that were sent later, because ${redo.length === 1 ? "it was" : "they were"} redelivered after the crash.`
          : bad.size
            ? `${[...bad].map((e) => e.id).join(", ")} finished after later invoices simply because two workers run in parallel at different speeds.`
            : "Order happened to survive, but nothing guarantees it with two workers.";
        say(verdict, `All acknowledged and deleted. ${why} The queue is now empty, so a consumer that subscribes now can never see these invoices.`, bad.size ? "bad" : "");
      } else {
        say(verdict, "Both consumers saw every invoice. Once acknowledged, each copy is gone; there is nothing left to replay.");
      }
      loop.stop();
      return false;
    }
  }

  const loop = makeLoop(tick, 600, (on) => { playBtn.textContent = on ? "Pause" : "Play"; });
  playBtn.addEventListener("click", () => { if (q.finished) reset(); loop.toggle(); });
  root.querySelector('[data-act="step"]').addEventListener("click", () => { loop.stop(); tick(); });
  root.querySelector('[data-act="reset"]').addEventListener("click", reset);
  crashBtn.addEventListener("click", () => {
    const b = q.consumers.find((c) => c.name === "B");
    if (b.alive) {
      const m = q.crash("B");
      crashedAt = m;
      render();
      say(verdict, m
        ? mode === "balance"
          ? `B crashed while holding ${m.id}. It was never acknowledged. Once the broker notices that B is gone, after a timeout of a few ticks, it puts ${m.id} back at the front of the queue. Meanwhile A keeps taking later invoices.`
          : `B crashed while holding ${m.id}. It was never acknowledged. Once the broker notices that B is gone, after a timeout of a few ticks, it puts ${m.id} back at the front of B's own queue, where it waits for B to restart. A reads from its own queue and is not affected.`
        : "B crashed while idle. Nothing was in flight, so nothing needs redelivery.", m ? "bad" : "");
    } else {
      q.restart("B");
      render();
      say(verdict, "B is back and takes new messages from the queue.");
    }
  });
  radio([...root.querySelectorAll("[data-mode]")], "mode", (v) => { mode = v; reset(); });
  reset();
}
