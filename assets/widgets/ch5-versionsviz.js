// Chapter 5, lesson 5: sibling values on one server, then version vectors across three replicas.
import { siblingStore, SIBLING_SCRIPT, POOLS, vvStore, VV_EXAMPLE, VV_NODES, fmtVV } from "../engines/ch5-versions.js";
import { makeClock, spaceTime, esc } from "./ch5-util.js";

const list = (arr) => (arr.length < 2 ? arr.join("") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1]);

// =============================================================== figure 1: siblings
{
  const root = document.getElementById("siblings");
  const tombBox = root.querySelector("#sb-tomb");
  const nextBtn = root.querySelector('[data-act="next"]');
  const stepsEl = root.querySelector(".steps");
  const verdict = root.querySelector(".verdict");
  const st = spaceTime(root.querySelector(".st"), {
    lanes: [{ id: "noor", label: "Noor" }, { id: "server", label: "Server" }, { id: "felix", label: "Felix" }],
    window: 2600, rowH: 44, labelW: 64, aria: "Space-time diagram of Noor, the server, and Felix",
  });
  const clock = makeClock(render, { onIdle: render });
  let step = 0, removedStove = false;

  stepsEl.innerHTML = SIBLING_SCRIPT.map(([, , , text]) => `<li>${esc(text)}</li>`).join("");

  function reset() {
    step = 0; removedStove = false;
    clock.set(siblingStore({ tombstones: tombBox.checked }));
  }

  const chips = (items, tombs, removable, who) =>
    items.map((x) => removable
      ? `<button class="rec" data-remove="${esc(x)}" data-who="${who}" title="Remove ${esc(x)}"><span class="k">${esc(x)}</span><span class="v">×</span></button>`
      : `<span class="rec"><span class="k">${esc(x)}</span></span>`).join("") +
    tombs.map((x) => `<span class="rec tomb" title="tombstone"><span class="k">${esc(x)}</span></span>`).join("");

  function render(sim = clock.sim) {
    st.draw(sim);
    for (const id of ["noor", "felix"]) {
      const c = sim.node(id);
      const p = root.querySelector(`[data-client="${id}"]`);
      p.querySelector('[data-out="known"]').textContent = `knows v${c.known}`;
      const html = chips(c.items, sim.cfg.tombstones ? c.tombs : [], true, id) || `<span class="ch5-empty">empty list</span>`;
      const box = p.querySelector(".ch5-items");
      if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
      const i = c.next, pool = POOLS[id];
      p.querySelector('[data-add]').textContent = `Add ${pool[i % pool.length]}${i >= pool.length ? " " + (Math.floor(i / pool.length) + 1) : ""}`;
    }
    const srv = sim.node("server");
    root.querySelector('[data-out="counter"]').textContent = `latest v${srv.counter}`;
    root.querySelector('[data-out="sibs"]').innerHTML = srv.siblings.length
      ? srv.siblings.map((s) => `<div class="ch5-sib"><span class="ver">v${s.ver}</span>${chips(s.items, s.tombs, false) || `<span class="ch5-empty">empty</span>`}</div>`).join("")
      : `<span class="ch5-empty">no value yet</span>`;
    [...stepsEl.children].forEach((li, j) => { li.classList.toggle("current", j === step - 1); li.style.opacity = j < step ? 1 : 0.45; });
    nextBtn.disabled = step >= SIBLING_SCRIPT.length;
    nextBtn.textContent = step === 0 ? "Play example, step 1" : step >= SIBLING_SCRIPT.length ? "Example finished" : `Step ${step + 1} of ${SIBLING_SCRIPT.length}`;
    say(sim, srv);
  }

  function say(sim, srv) {
    const set = (cls, t) => { verdict.className = `verdict ${cls}`; verdict.textContent = t; };
    const back = removedStove && ["noor", "felix"].some((id) => sim.node(id).items.includes("stove"));
    if (back && !sim.cfg.tombstones) return set("bad", "Stove is back. Felix removed it, but Noor's concurrent sibling still contained it, and a union cannot tell a removed item from one that was never added. Turn on tombstones and play the example again.");
    if (removedStove && sim.cfg.tombstones && !back && srv.siblings.some((s) => s.items.includes("stove"))) return set("good", "Stove stays removed: Felix's sibling carries a tombstone for it, and the merge subtracts every tombstone from the union. The tombstones themselves must be kept until no older sibling can bring the item back.");
    if (srv.siblings.length > 1) return set("", `The server holds ${srv.siblings.length} siblings: writes it could not order, because neither writer had seen the other's value. It keeps them all and lets the client merge them.`);
    if (srv.counter) return set("", "One value: the last write was based on everything the server had, so it safely overwrote it.");
    return set("", "");
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.dataset.remove) {
      const who = b.dataset.who, item = b.dataset.remove;
      if (item === "stove") removedStove = true;
      clock.act((s) => s.remove(who, item));
    } else if (b.dataset.add) clock.act((s) => s.add(b.dataset.add));
    else if (b.dataset.read) clock.act((s) => s.read(b.dataset.read));
    else if (b.dataset.act === "next") {
      // Each step of the story starts from a settled state, so finish anything still in flight.
      if (clock.running) clock.finish();
      const [who, act, item] = SIBLING_SCRIPT[step++];
      if (act === "remove" && item === "stove") removedStove = true;
      clock.act((s) => (act === "add" ? s.add(who) : act === "remove" ? s.remove(who, item) : s.read(who)));
      render();
    } else if (b.dataset.act === "reset") reset();
  });
  tombBox.addEventListener("change", reset);
  reset();
}

// =============================================================== figure 2: version vectors
{
  const root = document.getElementById("vv");
  const selA = root.querySelector("#vv-a"), selB = root.querySelector("#vv-b");
  const cardsEl = root.querySelector(".ch5-cards");
  const verdict = root.querySelector(".verdict");
  const stEl = root.querySelector(".st");
  const st = spaceTime(stEl, {
    lanes: VV_NODES.map((id) => ({ id, label: "Replica " + id })), window: 3400, rowH: 46, labelW: 80,
    aria: "Space-time diagram of three replicas. Each dot is an event with a version vector.",
  });
  const clock = makeClock(render, { gap: 220, onIdle: render });
  let lastPicked = "b";
  const pick = { a: "", b: "" };

  cardsEl.innerHTML = VV_NODES.map((id) => `<div class="ch5-card" data-rep="${id}">
      <div class="ch5-card-head"><span>Replica ${id}</span><span class="vv"></span></div>
      <div class="ch5-card-val"></div></div>`).join("");

  function reset(example) {
    const sim = vvStore();
    if (example) {
      for (const [k, a, b] of VV_EXAMPLE) { sim.t += 250; if (k === "write") sim.write(a); else sim.sync(a, b); sim.runAll(); }
      pick.a = "e3"; pick.b = "e4";
      clock.set(sim);
    } else { pick.a = ""; pick.b = ""; clock.set(sim); }
  }

  function render(sim = clock.sim) {
    const evs = sim.events.map((e) => e.ev);
    if (!evs.includes(pick.a)) pick.a = evs[0] || "";
    if (!evs.includes(pick.b)) pick.b = evs.length > 1 ? evs[evs.length - 1] : "";
    st.selected = new Set([pick.a, pick.b]);
    st.draw(sim);
    for (const id of VV_NODES) {
      const n = sim.node(id);
      const card = cardsEl.querySelector(`[data-rep="${id}"]`);
      card.querySelector(".vv").textContent = fmtVV(n.vv);
      card.querySelector(".ch5-card-val").textContent = n.vals.map((x) => x.val).join(" and ");
      card.classList.toggle("conflict", n.vals.length > 1);
    }
    const opts = sim.events.map((e) => `<option value="${e.ev}">${e.ev} · ${e.node} · ${fmtVV(e.vv)} · ${e.vals.join(" and ")}</option>`).join("");
    for (const sel of [selA, selB]) if (sel.dataset.opts !== opts) { sel.dataset.opts = opts; sel.innerHTML = opts || `<option value="">no events yet</option>`; }
    selA.value = pick.a; selB.value = pick.b;
    compare(sim);
  }

  function compare(sim) {
    if (sim.events.length < 2 || !pick.a || !pick.b) {
      verdict.className = "verdict";
      verdict.textContent = sim.events.length ? "Make at least two events to compare them." : "Write at a replica to create the first event.";
      return;
    }
    const { A, B, rel } = sim.compare(pick.a, pick.b);
    const a = A.ev, b = B.ev;
    const ahead = (x, y) => VV_NODES.filter((k) => (x.vv[k] || 0) > (y.vv[k] || 0)).map((k) => `${k} (${x.vv[k]} against ${y.vv[k] || 0})`);
    let head, body, cls = "good";
    if (rel === "equal") { head = `${a} and ${b} are the same version.`; body = `Both carry ${fmtVV(A.vv)}.`; cls = ""; }
    else if (rel === "before" || rel === "after") {
      const [x, y] = rel === "before" ? [A, B] : [B, A];
      head = `${x.ev} happened before ${y.ev}.`;
      body = `Every counter in ${x.ev} (${fmtVV(x.vv)}) is at most the matching counter in ${y.ev} (${fmtVV(y.vv)}), so ${y.ev} already reflects everything ${x.ev} knew. A replica holding ${y.ev}'s value can safely drop ${x.ev}'s.`;
    } else {
      cls = "bad";
      head = `${a} and ${b} are concurrent.`;
      body = `${a} is ahead on ${list(ahead(A, B))}; ${b} is ahead on ${list(ahead(B, A))}. Neither has seen everything the other has, so a replica that receives both must keep both values as siblings until someone merges them.`;
    }
    verdict.className = `verdict ${cls}`;
    verdict.innerHTML = `<strong>${esc(head)}</strong> ${esc(body)}`;
  }

  root.addEventListener("click", (e) => {
    const mark = e.target.closest("[data-ev]");
    if (mark) {
      lastPicked = lastPicked === "b" ? "a" : "b";
      pick[lastPicked] = mark.dataset.ev;
      render();
      return;
    }
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.write) clock.act((s) => s.write(b.dataset.write));
    else if (b.dataset.from) clock.act((s) => s.sync(b.dataset.from, b.dataset.to));
    else if (b.dataset.act === "example") reset(true);
    else if (b.dataset.act === "clear") reset(false);
  });
  selA.addEventListener("change", () => { pick.a = selA.value; render(); });
  selB.addEventListener("change", () => { pick.b = selB.value; render(); });
  reset(true);
}
