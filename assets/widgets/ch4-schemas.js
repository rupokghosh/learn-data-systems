// Lesson: Thrift, Protocol Buffers, and Avro. One record, four binary encodings, plus a varint lab.
import {
  encodeThriftBinary, encodeThriftCompact, encodeProtobuf, encodeAvro, encodeJSON,
  size, varint, varintGroups, zigzag, hex,
} from "../engines/ch4-codec.js";
import { renderBytes, infoBox } from "./ch4-byteview.js";

/* ---------------- Four encodings ---------------- */
{
  const root = document.getElementById("three-ways");
  const $ = (s) => root.querySelector(s);
  const SCHEMA = [
    { name: "observer", tag: 1, type: "string" },
    { name: "count", tag: 2, type: "long" },
    { name: "species", tag: 3, type: "list" },
    { name: "verified", tag: 4, type: "bool" },
  ];
  const COLOR = { observer: "fc-0", count: "fc-1", species: "fc-2", verified: "fc-4" };
  const colorOf = (f) => COLOR[f] || "";
  const info = infoBox($(".byte-info"), '<span class="muted">Hover or tap a byte. Dashed cells are framing: types, tags, lengths. Solid cells are the values themselves.</span>');
  const FORMATS = [
    { id: "tb", name: "Thrift BinaryProtocol", enc: encodeThriftBinary },
    { id: "tc", name: "Thrift CompactProtocol", enc: encodeThriftCompact },
    { id: "pb", name: "Protocol Buffers", enc: encodeProtobuf },
    { id: "av", name: "Avro", enc: encodeAvro },
  ];
  const list = $(".enc-list");
  for (const f of FORMATS) {
    const d = document.createElement("div");
    d.className = "enc";
    d.innerHTML = `<div class="enc-head"><b>${f.name}</b><span class="enc-size" id="sz-${f.id}"></span></div><div class="enc-bar" id="bar-${f.id}"></div><div class="bytes" id="b-${f.id}"></div>`;
    list.appendChild(d);
  }
  const inp = { observer: $("#s-observer"), count: $("#s-count"), hasCount: $("#s-has-count"), species: $("#s-species"), verified: $("#s-verified") };
  let lastCount = 37n;

  function draw() {
    const cText = inp.count.value.trim();
    const ok = /^-?\d{1,18}$/.test(cText);
    inp.count.classList.toggle("bad-input", !ok);
    if (ok) lastCount = BigInt(cText);
    inp.count.disabled = !inp.hasCount.checked;
    const rec = {
      observer: inp.observer.value,
      count: inp.hasCount.checked ? lastCount : null,
      species: inp.species.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20),
      verified: inp.verified.checked,
    };
    const jsonRec = { observer: rec.observer, ...(rec.count !== null ? { count: rec.count } : {}), species: rec.species, verified: rec.verified };
    const nJson = size(encodeJSON(jsonRec));
    $("#sz-json").textContent = `${nJson} bytes`;
    for (const f of FORMATS) {
      const n = renderBytes($(`#b-${f.id}`), f.enc(SCHEMA, rec), { colorOf, info, label: f.name });
      $(`#sz-${f.id}`).textContent = `${n} bytes · ${Math.round((100 * n) / nJson)}% of JSON`;
      $(`#bar-${f.id}`).style.width = `${Math.min(100, (100 * n) / nJson)}%`;
    }
  }
  Object.values(inp).forEach((i) => i.addEventListener("input", draw));
  inp.hasCount.addEventListener("change", draw);
  draw();
}

/* ---------------- Varint lab ---------------- */
{
  const root = document.getElementById("varint");
  const $ = (s) => root.querySelector(s);
  const input = $("#v-num");
  const zz = $("#v-zigzag");
  let last = 9000n;

  function draw() {
    const t = input.value.trim();
    const ok = /^-?\d{1,19}$/.test(t) && BigInt(t) < (1n << 63n) && BigInt(t) >= -(1n << 63n);
    input.classList.toggle("bad-input", !ok);
    if (ok) last = BigInt(t);
    const n = last;
    const useZz = zz.checked;
    const encoded = useZz ? zigzag(n) : n;
    const bytes = varint(encoded);
    const groups = varintGroups(encoded);

    $("#v-step").innerHTML = useZz
      ? `zigzag(${n}) = <b>${encoded}</b> ${n >= 0n ? `(2 × ${n})` : `(2 × ${-n} − 1)`}`
      : n < 0n
        ? `${n} as an unsigned 64-bit pattern = <b>${BigInt.asUintN(64, n)}</b>, because a plain varint has no sign`
        : `no zigzag: the varint encodes <b>${n}</b> directly`;

    const g = $(".vgroups");
    g.textContent = "";
    groups.forEach((gr, i) => {
      const d = document.createElement("div");
      d.className = "vgroup";
      const bits = [`<span class="vbit cont" title="continuation bit">${gr.more ? 1 : 0}</span>`, ...gr.bits.split("").map((b) => `<span class="vbit">${b}</span>`)].join("");
      d.innerHTML = `<div class="vbits">${bits}</div><span class="hexb">0x${hex(gr.byte)}</span><small>byte ${i + 1}: ${gr.more ? "more follows" : "last byte"}</small>`;
      g.appendChild(d);
    });
    $("#v-bytes").textContent = bytes.length;
    $("#v-fixed").textContent = "8";
    $("#v-hex").textContent = bytes.map(hex).join(" ");

    const tbl = $(".zz");
    tbl.innerHTML = [0n, -1n, 1n, -2n, 2n, -3n, 3n, -64n, 63n, 64n]
      .map((v) => `<span class="${v === n ? "hl" : ""}">${v} → ${zigzag(v)}</span>`).join("");

    const v = $("#varint-verdict");
    if (!useZz && n < 0n) {
      v.className = "verdict bad";
      v.textContent = `A negative number without zigzag looks like a huge unsigned number, so it always takes ${bytes.length} bytes. This is why Protocol Buffers has sint64 alongside int64, and why Thrift CompactProtocol and Avro always zigzag.`;
    } else if (bytes.length > 8) {
      v.className = "verdict";
      v.textContent = `${bytes.length} bytes, more than a fixed 8: each byte carries only 7 bits of the number, so the very largest values cost extra. Varints pay off because most numbers in real data are small.`;
    } else {
      v.className = "verdict good";
      v.textContent = `${bytes.length} ${bytes.length === 1 ? "byte" : "bytes"} instead of a fixed 8. Each byte carries 7 bits of the number, least significant group first, and its top bit says whether another byte follows.`;
    }
  }
  input.addEventListener("input", draw);
  zz.addEventListener("change", draw);
  root.querySelectorAll("[data-n]").forEach((b) => b.addEventListener("click", () => { input.value = b.dataset.n; draw(); }));
  draw();
}
