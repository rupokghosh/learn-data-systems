// Chapter 3, lesson 2: an LSM-tree simulator and a Bloom filter.
import { rng } from "../charts.js";
import { LSM, BloomFilter } from "../engines/lsm.js";
import { makePlayer, esc, pick } from "./ch3-util.js";

/* ---------- LSM simulator ---------- */
{
  const root = document.getElementById("lsm");
  const keyIn = root.querySelector("#lsm-key");
  const valIn = root.querySelector("#lsm-val");
  const memOut = root.querySelector('[data-out="mem"]');
  const walOut = root.querySelector('[data-out="wal"]');
  const lvlOut = root.querySelector('[data-out="levels"]');
  const mergeOut = root.querySelector(".merge");
  const verdict = root.querySelector(".verdict");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);

  const KEYS = ["ams", "ath", "ber", "bog", "cai", "del", "dub", "hel", "ist", "jnb", "lim", "lis", "mex", "nbo", "osl", "rio", "sel", "sfo", "syd", "tok"];
  const OPTS = { memtableLimit: 4, l0Limit: 3, baseLevelEntries: 8, levelRatio: 4, tableEntries: 4, tierSize: 3, bitsPerKey: 4, hashes: 2 };
  const player = makePlayer();
  let rand, db, strategy = "leveled", bloomOn = true;

  const say = (html, cls = "") => { verdict.className = `verdict ${cls}`; verdict.innerHTML = html; };
  const temp = () => String(Math.round(-5 + rand() * 40));
  const liveState = () => ({ mem: db.memtableSorted(), wal: [...db.wal], levels: db.levels.map((l) => [...l]) });

  function reset() {
    player.settle();
    rand = rng(29);
    db = new LSM({ ...OPTS, strategy, bloom: bloomOn });
    for (let i = 0; i < 22; i++) db.put(pick(rand, KEYS), temp());
    mergeOut.hidden = true;
    render(liveState());
    say(`Twenty-two writes are already in. Each time the memtable held four keys, it was flushed to a new SSTable in L0; ${strategy === "leveled" ? "when L0 reached three tables, they were merged into L1" : "when a level reached three tables, they were merged into one table on the next level"}.`);
  }

  function levelLabel(i, tables) {
    const n = tables.reduce((a, t) => a + t.entries.length, 0);
    if (i === 0) return [`L0 · flushed memtables, newest first, ranges may overlap`, `${tables.length}/${strategy === "leveled" ? OPTS.l0Limit : OPTS.tierSize} tables`];
    if (strategy === "leveled") return [`L${i} · one sorted run, split into tables`, `${n}/${OPTS.baseLevelEntries * OPTS.levelRatio ** (i - 1)} entries`];
    return [`L${i} · merged runs, newest first`, `${tables.length}/${OPTS.tierSize} tables`];
  }

  function recHtml(e, cls = "") {
    return `<span class="rec${e.tomb ? " tomb" : ""}${cls ? " " + cls : ""}"><span class="k">${esc(e.key)}</span><span class="v">${e.tomb ? "del" : esc(e.value)}</span></span>`;
  }

  /** opts: cls Map(tableId -> class), tags Map(tableId -> text), enter Set(tableId), memProbe, memHit key, hitKey {table, key}, memEnter key */
  function render(state, opts = {}) {
    const { cls = new Map(), tags = new Map(), enter = new Set() } = opts;
    memOut.className = `lane${state.mem.length ? "" : " empty"}${opts.memProbe ? " probe" : ""}`;
    memOut.innerHTML = state.mem.map((e) => recHtml(e, [opts.memHit === e.key ? "hl" : "", opts.memEnter === e.key ? "enter" : ""].join(" ").trim())).join("");
    out("memcount").textContent = `${state.mem.length}/${OPTS.memtableLimit} entries`;
    walOut.className = `lane${state.wal.length ? "" : " empty"}`;
    walOut.innerHTML = state.wal.map((e, i) => recHtml(e, opts.memEnter && i === state.wal.length - 1 ? "enter" : "")).join("");
    out("walcount").textContent = `${state.wal.length} record${state.wal.length === 1 ? "" : "s"}, arrival order`;
    const levels = state.levels.length > 1 ? state.levels : [state.levels[0] || [], []];
    lvlOut.innerHTML = levels.map((tables, i) => {
      const [label, count] = levelLabel(i, tables);
      const body = tables.map((t) => {
        const rows = Math.max(1, Math.min(t.entries.length, 6));
        const recs = t.entries.map((e) => recHtml(e, opts.hitKey && opts.hitKey.table === t.id && opts.hitKey.key === e.key ? "hl" : "")).join("");
        return `<div class="sst ${cls.get(t.id) || ""}${enter.has(t.id) ? " enter" : ""}"><div class="sst-head"><span>SST ${t.id}</span><span>${esc(t.minKey)}–${esc(t.maxKey)}</span></div><div class="sst-recs" style="grid-template-rows:repeat(${rows},auto)">${recs}</div><div class="sst-tag">${tags.get(t.id) || ""}</div></div>`;
      }).join("");
      return `<p class="lane-label"><span>${label}</span><span class="count">${count}</span></p><div class="lane${tables.length ? "" : " empty"}" style="gap:6px">${body}</div>`;
    }).join("");
    const r = db.reads;
    out("gets").textContent = String(r.gets);
    out("consulted").textContent = String(r.considered);
    out("bloomno").textContent = String(r.bloomNo);
    out("tread").textContent = String(r.tablesRead);
    out("fp").textContent = String(r.falsePositives);
  }

  function runLabels(c) {
    if (strategy === "tiered") return c.inputs.map((t, i) => `SST ${t.id}${i === 0 ? " newest" : ""}`);
    if (c.from === 0) {
      const l0 = c.inputs.filter((t) => t.level === 0);
      const labels = l0.map((t, i) => `SST ${t.id}${i === 0 ? " newest" : ""}`);
      if (c.runs.length > l0.length) labels.push(`L1 oldest`);
      return labels;
    }
    return [`L${c.from} newer`, `L${c.to} older`].slice(0, c.runs.length);
  }

  /** Draw the merge panel with the first `upto` trace steps applied. */
  function renderMerge(c, upto) {
    const state = c.runs.map((run) => run.map(() => ""));
    const outRecs = [];
    c.steps.slice(0, upto).forEach((s, j) => {
      const current = j === upto - 1 && upto < c.steps.length;
      state[s.run][s.idx] = s.kept ? (current ? "hl" : "taken") : "dead";
      if (s.kept) outRecs.push(recHtml(c.runs[s.run][s.idx], current ? "enter keep" : ""));
    });
    const labels = runLabels(c);
    const title = strategy === "leveled" ? `Compaction: merging ${c.from === 0 ? "L0" : `L${c.from}`} into L${c.to}` : `Compaction: merging the tables of L${c.from} into one table on L${c.to}`;
    mergeOut.hidden = false;
    mergeOut.innerHTML = `<p class="merge-title">${title}</p>` +
      c.runs.map((run, r) => `<div class="merge-run"><span class="who">${labels[r] || ""}</span>${run.map((e, i) => recHtml(e, state[r][i])).join("")}</div>`).join("") +
      `<div class="merge-run out"><span class="who">Output run</span>${outRecs.join("")}</div>` +
      (upto >= c.steps.length ? `<p class="note">Kept ${c.output.reduce((a, t) => a + t.entries.length, 0)} entries; dropped ${c.stale} older version${c.stale === 1 ? "" : "s"}${c.tombsDropped ? ` and ${c.tombsDropped} tombstone${c.tombsDropped === 1 ? "" : "s"} (nothing older remains below, so they are no longer needed)` : ""}. ${c.inputs.length} input table${c.inputs.length === 1 ? "" : "s"} became ${c.output.length}.</p>` : "");
  }

  function applyCompaction(state, c) {
    const levels = state.levels.map((l) => [...l]);
    while (levels.length <= c.to) levels.push([]);
    levels[c.from] = [];
    levels[c.to] = strategy === "leveled" ? [...c.output] : [...c.output, ...levels[c.to]];
    return { mem: state.mem, wal: state.wal, levels };
  }

  function handleWrite(pre, events, info) {
    const flush = events.find((e) => e.type === "flush");
    const comps = events.filter((e) => e.type === "compact");
    const writeMsg = info.key ? `${info.tomb ? "Delete" : "Write"} of <span class="mono">${esc(info.key)}</span> appended to the log, then placed in sorted order in the memtable. ` : "";
    if (!flush) {
      mergeOut.hidden = true;
      render(liveState(), { memEnter: info.animate ? info.key : null });
      say(`${writeMsg}${info.tomb ? "A delete is a tombstone entry, written like any other value." : ""}`);
      return;
    }
    const flushMsg = `${writeMsg}The memtable ${info.forced ? "was" : "was full, so it was"} written out as <strong>SST ${flush.table.id}</strong>, already sorted, in one sequential write. The log it protected was then discarded.`;
    const afterFlush = { mem: [], wal: [], levels: pre.levels.map((l) => [...l]) };
    afterFlush.levels[0] = [flush.table, ...(afterFlush.levels[0] || [])];
    if (!comps.length) {
      mergeOut.hidden = true;
      render(liveState(), { enter: new Set(info.animate ? [flush.table.id] : []) });
      say(flushMsg);
      return;
    }
    const frames = [], durations = [];
    let state = afterFlush;
    comps.forEach((c, ci) => {
      const before = state;
      const after = applyCompaction(state, c);
      const inputIds = new Set(c.inputs.map((t) => t.id));
      frames.push(() => {
        render(before, { cls: new Map([...inputIds].map((id) => [id, "s-merge"])), enter: new Set(ci === 0 ? [flush.table.id] : []) });
        renderMerge(c, 0);
        say(ci === 0 ? `${flushMsg} That pushed L${c.from} over its limit, so compaction starts: the dashed tables are merged like the merge step of mergesort.` : `Now L${c.from} is over its limit too, so it merges into L${c.to}.`);
      });
      durations.push(900);
      const stepMs = Math.max(60, Math.min(170, 2600 / Math.max(1, c.steps.length)));
      c.steps.forEach((_, j) => { frames.push(() => renderMerge(c, j + 1)); durations.push(stepMs); });
      frames.push(() => render(after, { enter: new Set(c.output.map((t) => t.id)) }));
      durations.push(600);
      state = after;
    });
    const last = comps[comps.length - 1];
    const final = () => {
      render(liveState());
      renderMerge(last, last.steps.length);
      const dropped = comps.reduce((a, c) => a + c.stale + c.tombsDropped, 0);
      const written = comps.reduce((a, c) => a + c.bytes, 0);
      say(`${flushMsg} Compaction ${comps.length > 1 ? `ran ${comps.length} times in a row` : "merged the sorted runs"}, dropping ${dropped} obsolete entr${dropped === 1 ? "y" : "ies"} and rewriting ${written} bytes that the application had already written once.`, "good");
    };
    player.play(frames, (i) => durations[i], final, { instant: !info.animate });
  }

  function doWrite(key, value, tomb, animate = true) {
    if (!key) { say("Type a key first."); return; }
    if (!tomb && value === "") { say("Type a value first."); return; }
    player.settle();
    const pre = liveState();
    const r = tomb ? db.delete(key) : db.put(key, value);
    handleWrite(pre, r.events, { key, tomb, animate });
  }

  function randomUntilFlush() {
    player.settle();
    // Overwrites of a key already in the memtable do not grow it, so keep writing until it flushes.
    for (let i = 0; i < 200; i++) {
      const k = pick(rand, KEYS);
      const tomb = rand() < 0.1;
      const pre = liveState();
      const r = tomb ? db.delete(k) : db.put(k, temp());
      if (r.events.length) { handleWrite(pre, r.events, { key: k, tomb, animate: true }); return; }
    }
    render(liveState());
  }

  function flushNow() {
    player.settle();
    if (!db.mem.size) { say("The memtable is empty, so there is nothing to flush."); return; }
    const pre = liveState();
    handleWrite(pre, db.flush(), { forced: true, animate: true });
  }

  function doGet(key) {
    if (!key) { say("Type a key to look up."); return; }
    player.settle();
    mergeOut.hidden = true;
    const res = db.get(key);
    const live = liveState();
    const states = [];
    const cls = new Map(), tags = new Map();
    let hitKey = null;
    states.push({ memProbe: true, memHit: res.where === "memtable" ? key : null, ms: 420 });
    for (const s of res.steps) {
      if (s.where === "memtable") continue;
      if (s.check === "range") { cls.set(s.table, "s-range"); tags.set(s.table, "key outside range"); }
      else if (s.check === "bloom-no") { cls.set(s.table, "s-no"); tags.set(s.table, "Bloom: definitely not"); }
      else if (s.check === "false-positive") { cls.set(s.table, "s-fp"); tags.set(s.table, "Bloom: maybe. Read: no"); }
      else if (s.check === "read-miss") { cls.set(s.table, "s-read"); tags.set(s.table, "read: not here"); }
      else if (s.check === "hit") { cls.set(s.table, "s-hit"); tags.set(s.table, bloomOn ? "Bloom: maybe. Read: found" : "read: found"); hitKey = { table: s.table, key }; }
      states.push({ cls: new Map(cls), tags: new Map(tags), hitKey, ms: s.check === "range" ? 140 : 420 });
    }
    const frames = states.map((st) => () => render(live, st));
    const final = () => {
      render(live, states[states.length - 1]);
      const answer = res.found ? `Found <span class="mono">${esc(key)}</span> = <strong>${esc(res.value)}</strong>` : res.deleted ? `Found a tombstone for <span class="mono">${esc(key)}</span>, so it is deleted` : `<span class="mono">${esc(key)}</span> does not exist`;
      const where = res.where === "memtable" ? " in the memtable, without touching disk." : ".";
      const detail = res.where === "memtable" ? "" : ` Tables in key range: ${res.tablesConsidered}. ${bloomOn ? `Bloom filters ruled out ${res.bloomNo}. ` : ""}Block reads from disk: ${res.pagesRead}${res.falsePositives ? `, of which ${res.falsePositives} ${res.falsePositives === 1 ? "was a false positive" : "were false positives"}` : ""}.`;
      say(`${answer}${where}${detail}`, res.pagesRead > 1 ? "bad" : "good");
    };
    player.play(frames, (i) => states[i].ms, final);
  }

  function missingBatch() {
    player.settle();
    mergeOut.hidden = true;
    let considered = 0, no = 0, reads = 0, fps = 0;
    const N = 20;
    const written = db.snapshot();
    for (let i = 0; i < N; i++) {
      let k;
      do { k = String.fromCharCode(97 + Math.floor(rand() * 26), 97 + Math.floor(rand() * 26), 97 + Math.floor(rand() * 26)); } while (KEYS.includes(k) || written.has(k));
      const r = db.get(k);
      considered += r.tablesConsidered; no += r.bloomNo; reads += r.pagesRead; fps += r.falsePositives;
    }
    render(liveState());
    say(bloomOn
      ? `${N} lookups for keys that were never written. ${considered} table checks fell inside a key range; the Bloom filters ruled out ${no} of them, and ${fps} false positive${fps === 1 ? "" : "s"} cost a wasted disk read. Turn Bloom filters off and run this again.`
      : `${N} lookups for keys that were never written, without Bloom filters: every one of the ${considered} tables whose key range covered the key had to be read from disk, for nothing.`, bloomOn ? "good" : "bad");
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    const key = keyIn.value.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
    const val = valIn.value.trim().slice(0, 6);
    if (act === "put") doWrite(key, val, false);
    else if (act === "del") doWrite(key, null, true);
    else if (act === "get") doGet(key);
    else if (act === "random") randomUntilFlush();
    else if (act === "flush") flushNow();
    else if (act === "missing") missingBatch();
    else if (act === "reset") reset();
    else if (act === "bloom") {
      player.settle();
      bloomOn = !bloomOn; db.bloom = bloomOn;
      b.setAttribute("aria-pressed", String(bloomOn));
      say(bloomOn ? "Bloom filters on: each table's filter is checked before reading it." : "Bloom filters off: any table whose key range covers the key must be read.");
    } else if (act === "leveled" || act === "tiered") {
      strategy = act;
      root.querySelectorAll('[data-act="leveled"],[data-act="tiered"]').forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.act === act)));
      reset();
    }
  });
  [keyIn, valIn].forEach((inp) => inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const key = keyIn.value.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
    doWrite(key, valIn.value.trim().slice(0, 6), false, false);
  }));

  reset();
}

/* ---------- Bloom filter ---------- */
{
  const root = document.getElementById("bloom");
  const keyIn = root.querySelector("#bf-key");
  const bitsOut = root.querySelector(".bits");
  const addedOut = root.querySelector('[data-out="added"]');
  const verdict = root.querySelector(".verdict");
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const M = 32, K = 3;
  const WORDS = ["amber", "birch", "cedar", "delta", "ember", "fjord", "grove", "heron", "iris", "jade", "kelp", "lotus", "maple", "nectar", "onyx", "pearl", "quartz", "raven", "sage", "tundra", "umber", "violet", "willow", "yarrow"];
  let bf, added, rand, measured = null;

  const say = (html, cls = "") => { verdict.className = `verdict ${cls}`; verdict.innerHTML = html; };

  for (let i = 0; i < M; i++) {
    const d = document.createElement("div");
    d.className = "bit";
    d.textContent = i;
    bitsOut.appendChild(d);
  }
  const cells = [...bitsOut.children];

  function render(probe = [], mode = "") {
    cells.forEach((c, i) => {
      const on = bf.bits[i] === 1;
      c.className = "bit" + (on ? " on" : "") + (probe.includes(i) ? ` probe${mode === "add" ? " add" : on ? "" : " zero"}` : "");
    });
    addedOut.innerHTML = added.length ? added.map((k) => `<span class="rec"><span class="k">${esc(k)}</span></span>`).join("") : `<span class="note" style="margin:0">No keys yet.</span>`;
    out("n").textContent = String(added.length);
    out("set").textContent = `${bf.setBits} of ${M}`;
    out("exp").textContent = added.length ? `${(bf.expectedFalsePositiveRate() * 100).toFixed(1)}%` : "0%";
    out("meas").textContent = measured === null ? "not run" : `${measured.fp} of ${measured.n}`;
  }

  function reset() { bf = new BloomFilter(M, K); added = []; rand = rng(5); measured = null; render(); say("An empty filter: 32 bits, all zero, and 3 hash functions."); }

  const norm = (s) => s.trim().toLowerCase().slice(0, 12);
  const posText = (p) => `bits ${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;

  function add(key) {
    if (!key) { say("Type a key first."); return; }
    const p = bf.positions(key);
    if (!added.includes(key)) { bf.add(key); added.push(key); }
    measured = null;
    render(p, "add");
    say(`<span class="mono">${esc(key)}</span> hashes to ${posText(p)}. Those bits are now 1. The key itself is not stored anywhere.`);
  }

  function test(key) {
    if (!key) { say("Type a key to test."); return; }
    const p = bf.positions(key);
    render(p, "test");
    const zeros = p.filter((i) => !bf.bits[i]);
    if (zeros.length) {
      say(`<span class="mono">${esc(key)}</span> hashes to ${posText(p)}. Bit ${zeros[0]} is 0, so the key is <strong>definitely not</strong> in the set. Skip this table.`, "good");
    } else if (added.includes(key)) {
      say(`<span class="mono">${esc(key)}</span> hashes to ${posText(p)}, and all are 1. <strong>Maybe present</strong>, and it was added, so the read will find it.`);
    } else {
      const owners = p.map((i) => `${i} (set by ${added.filter((k) => bf.positions(k).includes(i)).map((k) => `<span class="mono">${esc(k)}</span>`).join(", ")})`);
      say(`<span class="mono">${esc(key)}</span> was never added, yet all its bits are 1: ${owners.join("; ")}. That is a <strong>false positive</strong>, and it would cost one wasted disk read.`, "bad");
    }
  }

  function addRandom() {
    const pool = WORDS.filter((w) => !added.includes(w));
    let last = [];
    for (let i = 0; i < 4 && pool.length; i++) {
      const w = pool.splice(Math.floor(rand() * pool.length), 1)[0];
      last = bf.positions(w); bf.add(w); added.push(w);
    }
    measured = null;
    render(last, "add");
    say(`Added four more keys. ${bf.setBits} of ${M} bits are now 1, so a random key has all ${K} of its bits set more often.`);
  }

  function testMany() {
    const N = 100;
    let fp = 0;
    for (let i = 0; i < N; i++) if (bf.mightContain(`probe-${i}-${Math.floor(rand() * 1e9)}`)) fp++;
    measured = { fp, n: N };
    render();
    say(`Tested ${N} keys that were never added: ${fp} false positive${fp === 1 ? "" : "s"} (${fp}%). The formula expects about ${(bf.expectedFalsePositiveRate() * 100).toFixed(1)}%. Add more keys and the rate climbs; real filters size the bit array to the number of keys.`, fp / N > 0.2 ? "bad" : "good");
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const a = b.dataset.act;
    if (a === "add") add(norm(keyIn.value));
    else if (a === "test") test(norm(keyIn.value));
    else if (a === "random") addRandom();
    else if (a === "many") testMany();
    else if (a === "reset") reset();
  });
  keyIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(norm(keyIn.value)); } });
  reset();
}
