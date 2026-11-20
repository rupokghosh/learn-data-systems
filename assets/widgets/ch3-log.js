// Chapter 3, lesson 1: an append-only log with a hash index, segments, and compaction.
import { rng } from "../charts.js";
import { LogKV } from "../engines/logkv.js";
import { makePlayer, esc, pick } from "./ch3-util.js";

const root = document.getElementById("logkv");
const keyIn = root.querySelector("#lk-key");
const valIn = root.querySelector("#lk-val");
const segOut = root.querySelector('[data-out="segments"]');
const idxOut = root.querySelector('[data-out="index"]');
const verdict = root.querySelector(".verdict");
const out = (k) => root.querySelector(`[data-out="${k}"]`);
const indexBtn = root.querySelector('[data-act="index"]');

const SEG = 6;
const CITIES = ["ams", "ber", "cai", "del", "lim", "osl", "sfo", "tok"];
const rand = rng(17);
const player = makePlayer();
let db, useIndex = true, lastRead = null;

function reset() {
  db = new LogKV({ segmentRecords: SEG });
  [["osl", 4], ["lim", 19], ["tok", 22], ["osl", 6], ["ber", 11], ["lim", 18], ["cai", 31], ["osl", 5], ["del", 29]]
    .forEach(([k, v]) => db.set(k, v));
  lastRead = null;
  render();
  say("Nine readings are already in the log. The first segment filled up at six records, so it is frozen and a new one is taking appends.");
}

function say(html, cls = "") { verdict.className = `verdict ${cls}`; verdict.innerHTML = html; }

/**
 * Draw segments and index. opts.segments: a snapshot to draw instead of the live state.
 * opts.marks: Map "seg:pos" -> class. opts.enter: Set of "seg:pos" that just arrived.
 * opts.idxKey / opts.idxClass: highlight one index row.
 */
function render(opts = {}) {
  const segs = opts.segments || db.segments;
  const marks = opts.marks || new Map();
  const enter = opts.enter || new Set();
  segOut.innerHTML = [...segs].reverse().map((s) => {
    const active = !s.frozen;
    const state = active ? "active, takes appends" : s.merged ? "merged, read-only" : "frozen, read-only";
    const recs = s.records.map((r, pos) => {
      const id = `${s.id}:${pos}`;
      const cls = ["rec", r.tombstone ? "tomb" : "", marks.get(id) || "", enter.has(id) ? "enter" : ""].join(" ");
      const delay = enter.has(id) && opts.stagger ? ` style="transition-delay:${opts.stagger.get(id)}ms"` : "";
      return `<span class="${cls}" data-id="${id}"${delay}><span class="off">@${r.offset}</span><span class="k">${esc(r.key)}</span><span class="v">${r.tombstone ? "tombstone" : esc(r.value)}</span></span>`;
    }).join("");
    return `<p class="lane-label"><span>Segment ${s.id} · ${state}</span><span class="count">${s.records.length}/${SEG} records · ${s.bytes} B</span></p>
      <div class="lane ${active ? "is-active" : "is-frozen"}${s.records.length ? "" : " empty"}">${recs}</div>`;
  }).join("");

  const index = opts.index || db.index;
  const rows = [...index.entries()].map(([k, loc]) => {
    const cls = opts.idxKey === k ? opts.idxClass || "hl" : "";
    return `<tr class="${cls}"><td>${esc(k)}</td><td>seg ${loc.seg} @ ${loc.offset}</td></tr>`;
  });
  if (opts.idxKey && !index.has(opts.idxKey) && opts.idxClass === "miss") rows.push(`<tr class="miss"><td>${esc(opts.idxKey)}</td><td>not in index</td></tr>`);
  idxOut.innerHTML = rows.length ? rows.join("") : `<tr class="none"><td colspan="2">no live keys</td></tr>`;

  // Disk stats follow whatever is drawn, so a snapshot shows its own totals.
  out("recs").textContent = String(segs.reduce((a, s) => a + s.records.length, 0));
  out("bytes").textContent = `${segs.reduce((a, s) => a + s.bytes, 0)} B`;
  out("live").textContent = `${db.liveBytes} B`;
  out("read").textContent = lastRead === null ? "none yet" : `${lastRead} record${lastRead === 1 ? "" : "s"}`;
}

function readKey() { return keyIn.value.trim().toLowerCase().replace(/[^a-z0-9_:-]/g, "").slice(0, 8); }
function readVal() { return valIn.value.trim().replace(/[,\n]/g, "").slice(0, 8); }

function doSet(key, value, animate = true) {
  if (!key) { say("Type a key first."); return; }
  if (value === "") { say("Type a value first."); return; }
  player.settle();
  const r = db.set(key, value);
  const id = `${r.seg}:${r.pos}`;
  render({ enter: animate ? new Set([id]) : new Set(), idxKey: key });
  let msg = `Appended <span class="mono">${esc(key)},${esc(value)}</span> at byte ${r.rec.offset} of segment ${r.seg}, and pointed the index at it.`;
  if (r.froze) msg += ` Segment ${r.froze.id} is now full, so it is frozen and segment ${db.active.id} takes the next append.`;
  say(msg);
}

function doDelete(key) {
  if (!key) { say("Type a key to delete."); return; }
  player.settle();
  const r = db.delete(key);
  render({ enter: new Set([`${r.seg}:${r.pos}`]) });
  say(r.existed
    ? `Nothing was erased. A tombstone for <span class="mono">${esc(key)}</span> was appended and the key left the index. Older records for it stay on disk until compaction.`
    : `<span class="mono">${esc(key)}</span> was not in the index, but a tombstone was appended anyway. Deletes are just more appends.`);
}

function doGet(key) {
  if (!key) { say("Type a key to look up."); return; }
  player.settle();
  const res = db.get(key, { useIndex });
  lastRead = res.recordsRead;
  if (useIndex) {
    if (!res.found) {
      render({ idxKey: key, idxClass: "miss" });
      say(`<span class="mono">${esc(key)}</span> is not in the hash index, so it does not exist. No disk read at all.`, "good");
      return;
    }
    const id = `${res.hit.seg}:${res.hit.pos}`;
    render({ idxKey: key, marks: new Map([[id, "hl"]]) });
    const loc = db.index.get(key);
    say(`Hash lookup: <span class="mono">${esc(key)}</span> lives in segment ${loc.seg} at byte ${loc.offset}. One seek, one record read: <strong>${esc(res.value)}</strong>.`, "good");
    return;
  }
  // Without the index: read every record from the oldest, keep the last match.
  const ids = res.read.map((r) => `${r.seg}:${r.pos}`);
  const hitId = res.hit ? `${res.hit.seg}:${res.hit.pos}` : null;
  const finalMarks = new Map(ids.map((id) => [id, "seen"]));
  if (hitId) finalMarks.set(hitId, res.found ? "hl" : "warn");
  const finish = () => {
    render({ marks: finalMarks });
    const what = res.found ? `The newest match says <strong>${esc(res.value)}</strong>.` : res.deleted ? "The newest match is a tombstone, so the key is deleted." : "No record has that key.";
    say(`Scanned all ${res.recordsRead} records (${res.bytesRead} bytes) to be sure no later record overrides an earlier one. ${what}`, "bad");
  };
  render();
  const stepMs = Math.max(45, Math.min(130, 1400 / ids.length));
  const frames = ids.map((id, i) => () => {
    const el = segOut.querySelector(`[data-id="${id}"]`);
    if (i > 0) segOut.querySelector(`[data-id="${ids[i - 1]}"]`)?.classList.replace("scan", "seen");
    el?.classList.add("scan");
    out("read").textContent = `${i + 1} records`;
  });
  say("Scanning the log from the start…");
  player.play(frames, stepMs, finish);
}

function randomWrites() {
  player.settle();
  const enter = new Set(), stagger = new Map();
  const froze = [];
  for (let i = 0; i < 5; i++) {
    const k = pick(rand, CITIES);
    const r = rand() < 0.12 ? db.delete(k) : db.set(k, Math.round(-5 + rand() * 40));
    const id = `${r.seg}:${r.pos}`;
    enter.add(id); stagger.set(id, i * 60);
    if (r.froze) froze.push(r.froze.id);
  }
  render({ enter, stagger });
  say(`Five more appends.${froze.length ? ` Segment${froze.length > 1 ? "s" : ""} ${froze.join(" and ")} filled up and froze.` : ""} Overwrites do not touch the old records; they only move the index pointer.`);
}

function compact() {
  player.settle();
  const frozen = db.segments.filter((s) => s.frozen);
  if (!frozen.length) { say("No frozen segments yet. Compaction only touches segments that no longer take writes."); return; }
  const frozenRecs = frozen.reduce((a, s) => a + s.records.length, 0);
  const allLive = frozen.every((s) => s.records.every((_, pos) => db.isLive(s.id, pos)));
  if (allLive && Math.ceil(frozenRecs / SEG) === frozen.length) {
    render();
    say("Nothing to compact: every record in the frozen segments is already the latest value of a live key, and they are as tightly packed as they can be. Write or delete some keys first.");
    return;
  }
  const snap = db.segments.map((s) => ({ ...s, records: [...s.records] }));
  const idxSnap = new Map(db.index);
  const marks = new Map();
  for (const s of frozen) s.records.forEach((_, pos) => marks.set(`${s.id}:${pos}`, db.isLive(s.id, pos) ? "keep" : "dead"));
  const res = db.compact();
  const reasons = { overwritten: 0, tombstone: 0, deleted: 0 };
  res.dropped.forEach((d) => reasons[d.reason]++);
  const enter = new Set();
  res.outputs.forEach((id) => db.segment(id).records.forEach((_, pos) => enter.add(`${id}:${pos}`)));
  const summary = `Compacted ${res.before.segments} frozen segment${res.before.segments > 1 ? "s" : ""}: <strong>${res.before.records} records, ${res.before.bytes} B → ${res.after.records} records, ${res.after.bytes} B</strong>. Dropped ${reasons.overwritten} overwritten value${reasons.overwritten === 1 ? "" : "s"}, ${reasons.tombstone} tombstone${reasons.tombstone === 1 ? "" : "s"}, and ${reasons.deleted} deleted value${reasons.deleted === 1 ? "" : "s"}. The active segment was not touched.`;
  render({ segments: snap, marks, index: idxSnap });
  say(`Crossed out: records that a newer write or a tombstone has replaced. Green: the latest value of each key, which will be copied.`);
  player.play([() => {}], 1100, () => { render({ enter }); say(summary, "good"); });
}

function crash() {
  player.settle();
  const r = db.crashAndRecover();
  lastRead = r.recordsRead;
  render();
  say(`The process restarted and the in-memory index was gone. Rebuilding it meant reading all ${r.recordsRead} records on disk. Bitcask avoids most of this work by also writing a small hint file per segment.`);
}

root.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "set") doSet(readKey(), readVal());
  else if (act === "get") doGet(readKey());
  else if (act === "del") doDelete(readKey());
  else if (act === "random") randomWrites();
  else if (act === "compact") compact();
  else if (act === "crash") crash();
  else if (act === "reset") { player.settle(); reset(); }
  else if (act === "index") {
    useIndex = !useIndex;
    indexBtn.setAttribute("aria-pressed", String(useIndex));
    player.settle();
    say(useIndex ? "Reads now go through the hash index." : "Index off: every read scans the whole log. Try a get.");
  }
});
[keyIn, valIn].forEach((inp) => inp.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); doSet(readKey(), readVal(), false); }
}));

reset();
