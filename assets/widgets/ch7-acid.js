// Chapter 7, lesson 1: atomicity with a write-ahead log, and what "committed" waited for.
import { el } from "../charts.js";
import { TxnDB } from "../engines/ch7-txn.js";

const h = (tag, attrs = {}, html) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  if (html !== undefined) n.innerHTML = html;
  return n;
};

// ---------------------------------------------------------------------------
// Atomicity: move 40 pallets from the north warehouse to the south one.
// ---------------------------------------------------------------------------
{
  const root = document.getElementById("atomic");
  const INITIAL = { "stock:north": 180, "stock:south": 120 };
  const TOTAL = 300;
  const STATEMENTS = [
    { sql: "UPDATE stock SET pallets = pallets − 40 WHERE site = 'north'", op: { op: "inc", key: "stock:north", by: -40, label: "north −40" } },
    { sql: "UPDATE stock SET pallets = pallets + 40 WHERE site = 'south'", op: { op: "inc", key: "stock:south", by: 40, label: "south +40" } },
    { sql: "INSERT INTO shipments VALUES ('SH-311', 40, 'north to south')", op: { op: "write", key: "ship:SH-311", value: "40 north→south", label: "record shipment" } },
  ];
  const modeBtns = [...root.querySelectorAll("[data-mode]")];
  const bNext = root.querySelector("[data-act=next]");
  const bCrash = root.querySelector("[data-act=crash]");
  const bReset = root.querySelector("[data-act=reset]");
  const prog = root.querySelector(".atomic-prog");
  const rows = root.querySelector(".atomic-rows");
  const wal = root.querySelector(".wal");
  const verdict = root.querySelector(".verdict");
  const statTotal = root.querySelector("[data-stat=total]");
  const statState = root.querySelector("[data-stat=state]");

  let mode = "txn", db, done, crashed, seenWal;

  function reset() {
    db = new TxnDB({ initial: INITIAL, level: "rc" });
    if (mode === "txn") db.addTxn("T", [...STATEMENTS.map((s) => s.op), { op: "commit" }]);
    else STATEMENTS.forEach((s, k) => db.addTxn("S" + (k + 1), [s.op, { op: "commit" }]));
    done = 0; crashed = false; seenWal = 0;
    wal.innerHTML = "";
    modeBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    render();
  }
  const steps = () => STATEMENTS.length + (mode === "txn" ? 1 : 0);

  function next() {
    if (crashed || done >= steps()) return;
    if (mode === "txn") db.step(0);
    else { db.step(done); db.step(done); }
    done++;
    render();
  }
  function crash() {
    if (crashed) return;
    db.crash();
    crashed = true;
    render();
  }

  function render() {
    // program
    prog.innerHTML = "";
    const lines = STATEMENTS.map((s) => s.sql);
    if (mode === "txn") { lines.unshift("BEGIN"); lines.push("COMMIT"); }
    lines.forEach((text, k) => {
      const idx = mode === "txn" ? k - 1 : k; // BEGIN is implicit in the first statement
      const ran = mode === "txn" ? (k === 0 ? done > 0 : idx < done) : idx < done;
      const isNext = !crashed && (mode === "txn" ? k > 0 && idx === done : idx === done);
      const li = h("li", { class: ran ? "done" : isNext ? "next" : crashed ? "dead" : "pending" });
      li.textContent = text + (mode === "auto" && ran ? "  (committed)" : "");
      prog.appendChild(li);
    });
    // rows
    rows.innerHTML = "";
    const keys = ["stock:north", "stock:south", "ship:SH-311"];
    for (const k of keys) {
      rows.appendChild(h("span", { class: "kv-key" }, k));
      const box = h("div", { class: "kv-vers" });
      const vs = db.versions.get(k) || [];
      const committed = db.value(null, k, "committed");
      const pending = [...vs].reverse().find((v) => !v.aborted && db.committedSeq(v.by) === null);
      const rolled = [...vs].reverse().find((v) => v.aborted);
      const chip = (val, meta, cls) => { const c = h("span", { class: "ver " + cls }); c.appendChild(h("span", { class: "val" }, val)); c.appendChild(h("span", { class: "meta" }, meta)); box.appendChild(c); };
      chip(committed === null ? "no row" : committed, committed === null ? "" : "committed", committed === null ? "old" : "");
      if (pending) chip(pending.value, "uncommitted", "uncommitted");
      else if (rolled && crashed) chip(rolled.value, "undone by recovery", "aborted");
      rows.appendChild(box);
    }
    // log
    for (let k = seenWal; k < db.wal.length; k++) {
      const e = db.wal[k];
      const name = (txid) => `T${txid}`;
      let text, cls = "enter";
      if (e.type === "begin") text = `${name(e.txid)} begin`;
      else if (e.type === "update") text = `${name(e.txid)} ${e.key}: ${e.before ?? "none"} → ${e.after}`;
      else if (e.type === "commit") { text = `${name(e.txid)} commit`; cls += " commit"; }
      else if (e.type === "crash") { text = "CRASH. Restart and replay the log."; cls += " crash"; }
      else if (e.type === "undo") { text = `undo ${name(e.txid)} ${e.key}: ${e.before} → ${e.after ?? "none"}`; cls += " undo"; }
      else if (e.type === "abort") { text = `${name(e.txid)} no commit record: rolled back`; cls += " undo"; }
      wal.appendChild(h("li", { class: cls }, text));
    }
    seenWal = db.wal.length;
    if (!wal.children.length) wal.appendChild(h("li", { class: "empty" }, "The log is empty."));
    else wal.querySelector(".empty")?.remove();

    const s = db.state();
    const total = (s["stock:north"] ?? 0) + (s["stock:south"] ?? 0);
    statTotal.textContent = `${total} of ${TOTAL}`;
    statTotal.style.color = total === TOTAL ? "" : "var(--red)";
    const finished = done >= steps();
    statState.textContent = crashed ? "after recovery" : finished ? "finished" : done ? "in progress" : "not started";

    bNext.disabled = crashed || finished;
    bCrash.disabled = crashed;
    verdict.className = "verdict";
    if (!crashed) {
      verdict.innerHTML = finished ? "The transfer completed. Now press Reset and crash it partway through." : done ? "Press Crash now to pull the plug before the remaining statements run." : "";
      return;
    }
    const shipped = s["ship:SH-311"] !== undefined;
    if (done === 0) {
      verdict.innerHTML = "Nothing had been written yet, so there was nothing to lose and nothing to undo.";
    } else if (total !== TOTAL) {
      verdict.classList.add("bad");
      verdict.innerHTML = `<strong>Half applied.</strong> The committed rows count ${total} pallets instead of ${TOTAL}${shipped ? "" : ", and no shipment explains the difference"}. Each statement committed on its own, so the database has no idea they belonged together; someone has to find and repair this by hand.`;
    } else if (mode === "auto" && done > 0 && done < STATEMENTS.length) {
      verdict.classList.add("bad");
      verdict.innerHTML = `<strong>Half applied.</strong> The pallet totals still add up, but the shipment record is missing for a transfer that happened.`;
    } else if (mode === "txn" && done < steps()) {
      verdict.classList.add("good");
      verdict.innerHTML = `<strong>Rolled back.</strong> On restart the database found writes in its log with no commit record, and used the old values stored next to them to undo every one. The stock is back to 180 and 120, as if the transfer never started, so the application can simply run it again.`;
    } else {
      verdict.classList.add("good");
      verdict.innerHTML = "<strong>Kept.</strong> Every write was committed before the crash, so recovery has nothing to undo.";
    }
  }

  modeBtns.forEach((b) => b.addEventListener("click", () => { mode = b.dataset.mode; reset(); }));
  bNext.addEventListener("click", next);
  bCrash.addEventListener("click", crash);
  bReset.addEventListener("click", reset);
  reset();
}

// ---------------------------------------------------------------------------
// Durability: what did "committed" wait for, and which failures does that survive?
// ---------------------------------------------------------------------------
{
  const root = document.getElementById("durability");
  const svgBox = root.querySelector(".dur");
  const verdict = root.querySelector(".verdict");
  const lieBox = root.querySelector("#disk-lies");
  const matrixBox = root.querySelector(".matrix-box");
  const waitBtns = [...root.querySelectorAll("[data-wait]")];
  const failBtns = [...root.querySelectorAll("[data-fail]")];
  const statLat = root.querySelector("[data-stat=lat]");
  const statCopies = root.querySelector("[data-stat=copies]");
  const statOut = root.querySelector("[data-stat=out]");

  const WAITS = {
    mem: { label: "Memory only", lat: "0.01 ms" },
    fsync: { label: "Local fsync", lat: "2 ms" },
    rep1: { label: "Fsync + 1 replica", lat: "2.5 ms" },
    rep2: { label: "Fsync + 2 replicas", lat: "70 ms" },
  };
  const FAILS = {
    crash: "Process crash",
    power: "Power cut in A",
    disk: "Leader disk dies",
    dc: "Datacentre A lost",
  };
  let wait = "fsync", fail = null;

  // Where the committed order lives at the moment the client hears "committed".
  function placement(w, lies) {
    const p = { "L.mem": true };
    if (w !== "mem") p["L.disk"] = lies ? "lie" : true;
    if (w === "rep1" || w === "rep2") p["R1.mem"] = true;
    if (w === "rep2") p["R2.mem"] = true;
    return p;
  }
  function destroyed(f, lies) {
    if (f === "crash") return ["L.mem"];
    if (f === "power") return ["L.mem", "R1.mem", ...(lies ? ["L.disk"] : [])];
    if (f === "disk") return ["L.mem", "L.disk"];
    if (f === "dc") return ["L.mem", "L.disk", "R1.mem", "R1.disk"];
    return [];
  }
  function survives(w, f, lies) {
    const p = placement(w, lies), gone = destroyed(f, lies);
    return Object.keys(p).some((k) => !gone.includes(k));
  }

  const NODES = [
    { id: "L", name: "Leader", x: 30 },
    { id: "R1", name: "Replica 1", x: 230 },
    { id: "R2", name: "Replica 2", x: 470 },
  ];
  function draw() {
    const lies = lieBox.checked;
    const p = placement(wait, lies), gone = destroyed(fail, lies);
    svgBox.innerHTML = "";
    const svg = el("svg", { viewBox: "0 0 650 220", role: "img", "aria-label": "Three database nodes in two datacentres, showing where the committed order is stored" }, svgBox);
    el("rect", { x: 14, y: 22, width: 404, height: 188, rx: 10, class: "dc" }, svg);
    el("rect", { x: 454, y: 22, width: 186, height: 188, rx: 10, class: "dc" }, svg);
    const t1 = el("text", { x: 26, y: 15, class: "dc-label" }, svg); t1.textContent = "Datacentre A";
    const t2 = el("text", { x: 466, y: 15, class: "dc-label" }, svg); t2.textContent = "Datacentre B";
    el("path", { d: "M200,62 L230,62", class: "link" + (p["R1.mem"] ? " on" : "") }, svg);
    el("path", { d: "M200,52 C300,30 380,30 470,52", class: "link" + (p["R2.mem"] ? " on" : "") }, svg);
    for (const n of NODES) {
      const down = gone.some((k) => k.startsWith(n.id + "."));
      const g = el("g", { class: "node" + (down ? " down" : "") }, svg);
      el("rect", { x: n.x, y: 40, width: 170, height: 156, rx: 8, class: "box" }, g);
      const tt = el("text", { x: n.x + 12, y: 62, class: "t" }, g); tt.textContent = n.name;
      for (const [slot, y, label] of [["mem", 78, "memory"], ["disk", 132, "disk"]]) {
        const k = `${n.id}.${slot}`;
        const has = p[k], lost = has && gone.includes(k);
        const sg = el("g", { class: "slot" + (has ? (lost ? " lost" : " has") : "") + (has === "lie" ? " lie" : "") }, g);
        el("rect", { x: n.x + 10, y, width: 150, height: 46, rx: 6 }, sg);
        const a = el("text", { x: n.x + 20, y: y + 18 }, sg); a.textContent = label + (slot === "disk" && has === "lie" ? " (drive cache)" : "");
        const b = el("text", { x: n.x + 20, y: y + 35, style: "font-family:var(--mono)" }, sg);
        b.textContent = has ? "order #4471" : "–";
      }
    }
  }
  function matrix() {
    const lies = lieBox.checked;
    let html = '<table class="tradeoffs matrix" style="margin:0"><tr><th>Commit waits for</th>' + Object.values(FAILS).map((f) => `<th>${f}</th>`).join("") + "</tr>";
    for (const [w, W] of Object.entries(WAITS)) {
      html += `<tr><td${w === wait ? ' class="cur"' : ""}>${W.label}</td>`;
      for (const f of Object.keys(FAILS)) {
        const ok = survives(w, f, lies);
        html += `<td class="${ok ? "ok" : "lost"}${w === wait && f === fail ? " cur" : ""}">${ok ? "survives" : "lost"}</td>`;
      }
      html += "</tr>";
    }
    matrixBox.innerHTML = html + "</table>";
  }
  function render() {
    const lies = lieBox.checked;
    waitBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.wait === wait)));
    failBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.fail === fail)));
    draw();
    matrix();
    const p = placement(wait, lies);
    statLat.textContent = wait === "fsync" && lies ? "0.05 ms" : WAITS[wait].lat;
    statCopies.textContent = String(Object.keys(p).length);
    verdict.className = "verdict";
    if (!fail) { statOut.textContent = "acknowledged"; verdict.innerHTML = "The client has been told the order is committed. Now pick a failure."; return; }
    const ok = survives(wait, fail, lies);
    statOut.textContent = ok ? "survived" : "lost";
    verdict.classList.add(ok ? "good" : "bad");
    const left = Object.keys(p).filter((k) => !destroyed(fail, lies).includes(k)).map((k) => ({ "L.mem": "the leader's memory", "L.disk": "the leader's disk", "R1.mem": "replica 1", "R2.mem": "replica 2 in datacentre B" }[k]));
    verdict.innerHTML = ok
      ? `<strong>The order survived</strong>: a copy is still in ${left.length > 1 ? left.slice(0, -1).join(", ") + (left.length > 2 ? ", and " : " and ") + left.at(-1) : left[0]}.`
      : `<strong>The order is gone</strong>, although the client was told it was committed.${wait === "fsync" && lies && fail === "power" ? " The drive reported the fsync as done while the data sat in its volatile cache." : ""}`;
  }
  waitBtns.forEach((b) => b.addEventListener("click", () => { wait = b.dataset.wait; fail = null; render(); }));
  failBtns.forEach((b) => b.addEventListener("click", () => { fail = fail === b.dataset.fail ? null : b.dataset.fail; render(); }));
  lieBox.addEventListener("change", () => { fail = null; render(); });
  render();
}
