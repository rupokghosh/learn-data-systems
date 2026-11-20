// Chapter 4: shared byte-cell renderer. Each byte is a small button coloured by the field
// it belongs to; hovering, focusing, or tapping one explains it in a shared info box.
import { hex } from "../engines/ch4-codec.js";

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const ROLE = { type: "type", tag: "tag", header: "tag+type", len: "len", value: "val", key: "key", punct: "", union: "union", end: "end", map: "map" };
const printable = (b) => b >= 0x21 && b <= 0x7e;
let clearOther = null; // the view that currently shows a highlight, so only one is lit at a time

/**
 * Info box shared by several byte views. Returns { show(html), reset() }.
 */
export function infoBox(node, idleHtml) {
  const reset = () => { node.innerHTML = idleHtml; };
  reset();
  return { show: (html) => { node.innerHTML = html; }, reset };
}

/**
 * Draw segments into `wrap` (a .bytes element).
 * opts: { colorOf(field) -> "fc-0".."fc-4" | "", info, chars: show characters for every byte, label }
 */
export function renderBytes(wrap, segs, opts) {
  const { colorOf, info, chars = false, label = "" } = opts;
  wrap.textContent = "";
  const cellsBySeg = [];
  let offset = 0;
  segs.forEach((s, si) => {
    const cells = [];
    const color = s.field ? colorOf(s.field) : "";
    s.bytes.forEach((b) => {
      const c = document.createElement("button");
      c.type = "button";
      const textual = s.role === "value" || s.role === "key" || chars;
      const showChar = textual && printable(b);
      c.className = `bcell ${color}${showChar ? " ch" : ""}${s.role === "value" || s.role === "key" || (chars && s.role === "punct") ? "" : " frame"}`;
      const sub = showChar ? String.fromCharCode(b) : (b === 0x20 && textual ? "␣" : ROLE[s.role] ?? "");
      c.innerHTML = `${hex(b)}<small>${esc(sub)}</small>`;
      c.dataset.seg = si;
      c.dataset.b = b;
      c.dataset.off = offset;
      c.setAttribute("aria-label", `${label} byte ${offset}, 0x${hex(b)}${s.field ? ", field " + s.field : ""}: ${s.note}`);
      cells.push(c);
      wrap.appendChild(c);
      offset++;
    });
    cellsBySeg.push(cells);
  });

  let hot = null;
  const clear = () => {
    wrap.classList.remove("dim");
    wrap.querySelectorAll(".in-seg, .is-hot").forEach((c) => c.classList.remove("in-seg", "is-hot"));
    hot = null;
  };
  const activate = (c) => {
    if (hot === c) return;
    if (clearOther && clearOther !== clear) clearOther();
    clearOther = clear;
    clear();
    hot = c;
    const s = segs[+c.dataset.seg];
    cellsBySeg[+c.dataset.seg].forEach((x) => x.classList.add("in-seg"));
    c.classList.add("is-hot");
    wrap.classList.add("dim");
    const b = +c.dataset.b;
    const where = `${label ? esc(label) + ", " : ""}byte ${c.dataset.off}`;
    const field = s.field ? ` <b>${esc(s.field)}</b>` : " <span class=\"muted\">framing</span>";
    info.show(`<span class="mono">${where} · 0x${hex(b)}</span> ·${field} · <span class="muted">${esc(ROLE[s.role] || s.role)}</span><br>${esc(s.note)}.`);
  };
  wrap.onmouseover = (e) => { const c = e.target.closest(".bcell"); if (c) activate(c); };
  wrap.onfocusin = (e) => { const c = e.target.closest(".bcell"); if (c) activate(c); };
  wrap.onclick = (e) => { const c = e.target.closest(".bcell"); if (c) activate(c); };
  wrap.onmouseleave = () => { if (!wrap.contains(document.activeElement)) { clear(); info.reset(); } };
  wrap.onfocusout = (e) => { if (!wrap.contains(e.relatedTarget)) { clear(); info.reset(); } };
  return offset;
}
