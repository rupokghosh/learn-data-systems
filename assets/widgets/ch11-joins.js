// Chapter 11, lesson 4: a stream-table join, a windowed stream-stream join, and crash recovery.
import { el, linear, responsive } from "../charts.js";
import { enrichment, MEMBERS0, windowJoin, SENT, OPENS, OffsetConsumer } from "../engines/ch11-joins.js";
import { say, radio, makeLoop, esc } from "./ch11-util.js";

/* ------------------------------------------------------------------
   1. Stream-table join: purchases enriched with the member's tier
   ------------------------------------------------------------------ */
{
  const root = document.getElementById("enrich");
  const inOut = root.querySelector('[data-out="inputs"]');
  const tblOut = root.querySelector('[data-out="table"]');
  const resOut = root.querySelector('[data-out="results"]');
  const verdict = root.querySelector(".verdict");
  const delayIn = root.querySelector("#en-delay");
  const playBtn = root.querySelector('[data-act="play"]');
  let mode = "latest", steps = [], k = 0, fresh = -1;

  const name = (id) => id;
  const money = (v) => v.toFixed(2);

  function recompute(toEnd) {
    steps = enrichment({ cdcDelay: +delayIn.value, mode });
    k = toEnd ? steps.length : Math.min(k, steps.length);
    fresh = -1;
    render();
  }

  function render() {
    inOut.innerHTML = steps.map((s, i) => {
      const cls = ["c11-ev", i >= k ? "future" : "", i === k - 1 ? "cur" : ""].join(" ");
      if (!s.input) return `<div class="${cls}"><span class="n">${s.at.toFixed(1)}</span><span>change stream heartbeat passes ${(s.at - +delayIn.value).toFixed(1)} s</span></div>`;
      const e = s.input;
      const what = e.kind === "buy"
        ? `<span class="t">purchase</span> ${name(e.member)} ${money(e.amount)} <span style="color:var(--ink-4)">at ${e.t} s</span>`
        : `<span class="t" style="color:var(--purple)">change</span> ${name(e.member)} ${Object.entries(e.set).map(([f, v]) => `${f}=${esc(v)}`).join(", ")} <span style="color:var(--ink-4)">at ${e.t} s</span>`;
      return `<div class="${cls}"><span class="n">${s.at.toFixed(1)}</span><span>${what}</span></div>`;
    }).join("");

    const snap = k > 0 ? steps[k - 1].table : MEMBERS0;
    const changed = k > 0 && steps[k - 1].input?.kind === "chg" ? steps[k - 1].input.member : null;
    tblOut.innerHTML = `<tr><th>Member</th><th>Name</th><th>Tier</th></tr>` + snap.map((r) =>
      `<tr class="${r.id === changed ? "changed" : ""}"><td>${r.id}</td><td>${esc(r.name)}</td><td>${esc(r.tier)}</td></tr>`).join("");

    const outs = steps.slice(0, k).flatMap((s, i) => s.outputs.map((o) => ({ ...o, step: i })));
    resOut.innerHTML = outs.length ? outs.map((o) => {
      const body = o.tier
        ? `${o.member} ${esc(o.name)}, ${money(o.amount)}, ${o.tier}, ${o.discount}% off`
        : `${o.member}, ${money(o.amount)}, no member row`;
      const note = o.ok ? "" : o.tier ? ` <span style="color:var(--red)">should be ${o.correctTier}</span>` : ` <span style="color:var(--red)">member exists as ${o.correctTier}</span>`;
      const wait = mode === "versioned" && o.waited > 0.05 ? ` <span style="color:var(--ink-4)">waited ${o.waited.toFixed(1)} s</span>` : "";
      return `<div class="c11-jrow${o.step === fresh ? " enter" : ""}"><span class="rec ${o.ok ? "good" : "bad"}"><span class="k">${o.t} s</span><span class="v">${body}</span></span>${note}${wait}</div>`;
    }).join("") : `<span class="note" style="margin:0">No output yet.</span>`;

    if (k >= steps.length) {
      const all = steps.flatMap((s) => s.outputs);
      const bad = all.filter((o) => !o.ok);
      if (mode === "latest") {
        say(verdict, bad.length
          ? `${bad.length} of ${all.length} purchases were joined with the wrong tier, or with no row at all, because the change reached the processor after the purchase did. Run it again with a different delay and you get different answers: the join is not deterministic.`
          : `With the change stream this fast, every purchase met the right version of its member row. Increase the delay to see what happens when the two streams drift apart.`, bad.length ? "bad" : "good");
      } else {
        const maxWait = Math.max(...all.map((o) => o.waited));
        say(verdict, `Every purchase is joined with the tier that was valid at its event time, regardless of delay. The cost: the processor keeps table history and holds each purchase until the change stream has caught up${maxWait > 0.05 ? `, up to ${maxWait.toFixed(1)} s here` : ". With no change stream delay, nothing had to wait here"}.`, "good");
      }
    } else if (k === 0) {
      say(verdict, "Press Step or Play to feed the processor one arrival at a time.");
    } else {
      const s = steps[k - 1];
      say(verdict, !s.input
        ? "No new events, but the change stream signals it is complete up to this time, so held purchases can be joined."
        : s.input.kind === "chg"
          ? `The change for ${s.input.member} is applied to the processor's local copy of the table. No output; table changes only affect future joins.`
          : mode === "latest"
            ? `The purchase is joined with whatever the local table says right now.`
            : `The purchase is held until the change stream has passed ${s.input.t} s. ${s.waiting} waiting.`);
    }
  }

  function step() {
    if (k >= steps.length) return false;
    k++;
    fresh = k - 1;
    render();
    if (k >= steps.length) return false;
  }

  const loop = makeLoop(step, 900, (on) => { playBtn.textContent = on ? "Pause" : "Play"; });
  playBtn.addEventListener("click", () => { if (k >= steps.length) { k = 0; render(); } loop.toggle(); });
  root.querySelector('[data-act="step"]').addEventListener("click", () => { loop.stop(); if (k >= steps.length) k = 0; step(); });
  root.querySelector('[data-act="reset"]').addEventListener("click", () => { loop.stop(); k = 0; render(); });
  const delayOut = delayIn.closest(".control").querySelector("output");
  delayIn.addEventListener("input", () => { loop.stop(); delayOut.textContent = `${(+delayIn.value).toFixed(1)} s`; recompute(true); });
  delayOut.textContent = `${(+delayIn.value).toFixed(1)} s`;
  radio([...root.querySelectorAll("[data-mode]")], "mode", (v) => { loop.stop(); mode = v; recompute(true); });
  recompute(true);
}

/* ------------------------------------------------------------------
   2. Stream-stream window join: notifications and app opens
   ------------------------------------------------------------------ */
{
  const root = document.getElementById("wjoin");
  const chart = root.querySelector(".chart");
  const winIn = root.querySelector("#wj-win");
  const verdict = root.querySelector(".verdict");
  const out = (k) => root.querySelector(`[data-stat="${k}"]`);
  let width = 0;

  function draw(w) {
    width = w;
    const win = +winIn.value;
    const r = windowJoin(win);
    const H = 176, L = 70, R = w - 10;
    const narrow = w < 560;
    const x = linear([0, 62], [L, R]);
    const svg = el("svg", { viewBox: `0 0 ${w} ${H}`, class: "c11-ff", role: "img", "aria-label": "Notifications on the top lane, app opens on the bottom lane, with lines joining opens to the notification they came from." });
    const yS = 52, yO = 120;
    for (const [y, label] of [[yS, "Sent"], [yO, "Opened"]]) {
      el("line", { x1: L, x2: R, y1: y, y2: y, class: "axis" }, svg);
      const t = el("text", { x: 0, y: y + 4, class: "title" }, svg); t.textContent = label;
    }
    for (let m = 0; m <= 60; m += w < 480 ? 20 : 10) {
      const t = el("text", { x: x(m), y: H - 4, "text-anchor": "middle" }, svg); t.textContent = `${m} min`;
    }
    const matched = new Set(r.pairs.map((p) => p.sent.id));
    for (const s of SENT) {
      el("rect", { x: x(s.t), y: yS - 5, width: Math.max(1, x(Math.min(62, s.t + win)) - x(s.t)), height: 10, rx: 2, class: `span${matched.has(s.id) ? "" : " miss"}` }, svg);
    }
    for (const p of r.pairs) el("line", { x1: x(p.sent.t), y1: yS, x2: x(p.open.t), y2: yO, class: "pair" }, svg);
    SENT.forEach((s, i) => {
      el("circle", { cx: x(s.t), cy: yS, r: 4.5, class: `ev${matched.has(s.id) ? "" : " miss"}` }, svg);
      const t = el("text", { x: x(s.t), y: yS - 11 - (narrow && i % 2 ? 12 : 0), "text-anchor": "middle" }, svg); t.textContent = s.id;
    });
    const paired = new Set(r.pairs.map((p) => p.open));
    [...OPENS].sort((a, b) => a.t - b.t).forEach((o, i) => {
      el("circle", { cx: x(o.t), cy: yO, r: 4.5, class: `ev ${paired.has(o) ? "open" : "miss"}` }, svg);
      const t = el("text", { x: x(o.t), y: yO + 17 + (narrow && i % 2 ? 12 : 0), "text-anchor": "middle" }, svg); t.textContent = o.ref;
    });
    chart.replaceChildren(svg);
    out("pairs").textContent = r.pairs.length;
    out("orphans").textContent = r.orphans.length;
    out("ignored").textContent = r.ignored.length;
    out("peak").textContent = r.peak;
    say(verdict, `With a ${win}-minute window, ${r.pairs.length} of ${OPENS.length} opens are credited to a notification. ${r.orphans.length
      ? `${r.orphans.length} open${r.orphans.length === 1 ? " falls" : "s fall"} outside the window and count${r.orphans.length === 1 ? "s" : ""} as organic. `
      : ""}A wider window credits more, but the processor must keep up to ${r.peak} notification${r.peak === 1 ? "" : "s"} in state at once, and cannot report "no open" for a notification until its window closes.`);
  }

  const winOut = winIn.closest(".control").querySelector("output");
  winIn.addEventListener("input", () => { winOut.textContent = `${winIn.value} min`; if (width) draw(width); });
  winOut.textContent = `${winIn.value} min`;
  responsive(chart, draw);
}

/* ------------------------------------------------------------------
   3. Crash and restart: offsets, outputs, and the order between them
   ------------------------------------------------------------------ */
{
  const root = document.getElementById("crash");
  const inputOut = root.querySelector('[data-out="input"]');
  const opsOut = root.querySelector('[data-out="ops"]');
  const sinkOut = root.querySelector('[data-out="sink"]');
  const posOut = root.querySelector('[data-out="pos"]');
  const verdict = root.querySelector(".verdict");
  const batchIn = root.querySelector("#cr-batch");
  const playBtn = root.querySelector('[data-act="play"]');
  const crashBtn = root.querySelector('[data-act="crash"]');
  const out = (k) => root.querySelector(`[data-stat="${k}"]`);
  const N = 10, POINTS = 10;
  let strategy = "after", c, freshSink = 0;

  const DESC = {
    before: "Commit the offset for the whole batch first, then write each output.",
    after: "Write each output first, then commit the offset for the batch.",
    idempotent: "Write first, then commit, but each write is an upsert keyed by the message offset.",
    atomic: "Write the outputs and the new offset in one transaction, so both become visible together.",
  };

  function opText(op) {
    switch (op.type) {
      case "write":
        if (strategy === "idempotent") return `upsert ledger row for msg ${op.offset}${op.overwrote ? " (already there: overwritten)" : ""}`;
        if (strategy === "atomic") return `write +${POINTS} for msg ${op.offset}, inside the transaction`;
        return `write +${POINTS} points for msg ${op.offset}`;
      case "commit": return `commit offset ${op.offset}`;
      case "begin": return "begin transaction";
      case "txcommit": return `commit transaction: outputs and offset ${op.offset} together`;
      case "crash": return `crash: in-memory position ${op.pos} is lost`;
      case "restart": return `restart from committed offset ${op.offset}`;
      default: return op.type;
    }
  }

  function reset() {
    loop.stop();
    c = new OffsetConsumer({ messages: N, batch: +batchIn.value, strategy });
    freshSink = 0;
    render();
    say(verdict, `${DESC[strategy]} Press Play, then Crash at any moment.`);
  }

  function render() {
    inputOut.innerHTML = Array.from({ length: N }, (_, i) => {
      const cls = i < c.committed ? "dead-soft" : i < c.pos && !c.down ? "hl" : "";
      return `<span class="rec ${cls}"><span class="k">msg ${i}</span></span>`;
    }).join("");
    posOut.textContent = `committed offset ${c.committed} · ${c.down ? "consumer down" : `in-memory position ${c.pos}`}`;
    const hist = c.history.slice(-9);
    const next = c.down ? [{ type: "restart", offset: c.committed, planned: true }] : c.ops.slice(0, Math.max(0, 11 - hist.length)).map((o) => ({ ...o, planned: true }));
    opsOut.innerHTML = [...hist.map((o, i) => ({ ...o, last: i === hist.length - 1 })), ...next].map((o) => {
      const cls = o.planned ? "" : o.type === "crash" ? "crash" : o.type === "restart" ? "restart" : o.last ? "cur" : "done";
      return `<li class="${cls}"><span class="w">${o.planned ? "next" : "done"}</span><span>${esc(opText(o))}</span></li>`;
    }).join("");
    const t = c.tally();
    const seen = new Map();
    sinkOut.innerHTML = c.sink.length ? c.sink.map((r, i) => {
      let cls = "";
      if (r.state === "pending") cls = "pending";
      else if (r.state === "aborted") cls = "dead";
      else { const n = (seen.get(r.offset) || 0) + 1; seen.set(r.offset, n); if (n > 1) cls = "bad"; }
      return `<span class="rec ${cls}${i >= freshSink ? " enter" : ""}"><span class="k">msg ${r.offset}</span><span class="v">+${POINTS}${r.state === "pending" ? " pending" : r.state === "aborted" ? " rolled back" : ""}</span></span>`;
    }).join("") : `<span class="note" style="margin:0">empty</span>`;
    freshSink = c.sink.length;
    out("rows").textContent = t.visible;
    out("dup").textContent = t.dup;
    out("lost").textContent = c.done ? t.lost : "–";
    out("balance").textContent = `${t.visible * POINTS} / ${N * POINTS}`;
    crashBtn.disabled = c.down || c.done;
  }

  function tick() {
    if (c.done) { finish(); return false; }
    const op = c.step();
    render();
    if (op?.type === "restart") say(verdict, `Restarted. The consumer asks the broker for its committed offset, ${op.offset}, and continues from there.`);
    if (c.done) { finish(); return false; }
  }

  function finish() {
    loop.stop();
    const t = c.tally();
    const crashed = c.history.some((o) => o.type === "crash");
    if (!crashed) { say(verdict, "All ten messages processed without a crash. Every strategy looks correct on a good day; reset and crash it partway through."); return; }
    if (t.lost) say(verdict, `${t.lost} message${t.lost === 1 ? " was" : "s were"} never written: the offset said they were done before their outputs existed. This is at-most-once processing.`, "bad");
    else if (t.dup) say(verdict, `${t.dup} duplicate ledger row${t.dup === 1 ? "" : "s"}: those messages were written, the crash came before the commit, and they were processed again. This is at-least-once processing. The member now has ${t.visible * POINTS} points instead of ${N * POINTS}.`, "bad");
    else if (strategy === "idempotent" && c.overwrites) say(verdict, `Messages were processed more than once (${c.overwrites} repeat write${c.overwrites === 1 ? "" : "s"}), but each repeat overwrote the same keyed row, so the ledger is exactly right. At-least-once delivery plus idempotent writes gives exactly-once effects.`, "good");
    else if (strategy === "atomic" && c.sink.some((r) => r.state === "aborted")) say(verdict, "No loss and no duplicates. The crash rolled back the open transaction together with its uncommitted offset, so the restarted consumer redid exactly the work that had been discarded.", "good");
    else say(verdict, "No loss and no duplicates, but only because the crash landed right after a commit, so there was no unfinished work to lose or repeat. Reset and crash in the middle of a batch.");
  }

  crashBtn.addEventListener("click", () => {
    const before = { committed: c.committed, pos: c.pos };
    const op = c.crash();
    if (!op) return;
    render();
    const { committed, pos } = before;
    if (strategy === "before") {
      say(verdict, committed > pos
        ? `Crashed after committing offset ${committed} but ${pos > 0 ? `with outputs only up to msg ${pos - 1}` : "before writing a single output"}. On restart the consumer starts at ${committed}, so ${committed - pos === 1 ? `msg ${pos}` : `msg ${pos} to ${committed - 1}`} will never be written.`
        : `Crashed between batches, with nothing uncommitted. You were lucky; crash in the middle of a batch.`, committed > pos ? "bad" : "");
    } else if (strategy === "atomic") {
      say(verdict, `Crashed. The open transaction is rolled back: its pending outputs disappear together with the uncommitted offset. The consumer will restart from ${committed}.`, "good");
    } else {
      const redo = pos - committed;
      say(verdict, redo > 0
        ? `Crashed with ${redo} output${redo === 1 ? "" : "s"} written but not committed (${redo === 1 ? `msg ${committed}` : `msg ${committed} to ${pos - 1}`}). The consumer will restart at ${committed} and write ${redo === 1 ? "it" : "them"} again${strategy === "idempotent" ? ", but as upserts keyed by offset, so the repeats replace the same rows" : ""}.`
        : "Crashed right after a commit, so nothing will be repeated. Try crashing in the middle of a batch.", redo > 0 && strategy === "after" ? "bad" : "");
    }
  });

  const loop = makeLoop(tick, 650, (on) => { playBtn.textContent = on ? "Pause" : "Play"; });
  playBtn.addEventListener("click", () => { if (c.done) reset(); loop.toggle(); });
  root.querySelector('[data-act="step"]').addEventListener("click", () => { loop.stop(); tick(); });
  root.querySelector('[data-act="reset"]').addEventListener("click", reset);
  const batchOut = batchIn.closest(".control").querySelector("output");
  batchIn.addEventListener("input", () => { batchOut.textContent = `${batchIn.value} message${batchIn.value === "1" ? "" : "s"}`; reset(); });
  batchOut.textContent = `${batchIn.value} messages`;
  radio([...root.querySelectorAll("[data-strategy]")], "strategy", (v) => { strategy = v; reset(); });
  reset();
}
