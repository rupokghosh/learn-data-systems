// Lesson: Formats for encoding data. A byte inspector (JSON vs MessagePack) and a 64-bit ID in a double.
import { encodeJSON, encodeMsgPack, encodeXML, flatten, asDouble, bitLength } from "../engines/ch4-codec.js";
import { renderBytes, infoBox, esc } from "./ch4-byteview.js";
import { slider } from "../charts.js";

/* ---------------- Byte inspector ---------------- */
{
  const root = document.getElementById("inspector");
  const $ = (s) => root.querySelector(s);
  const ORDER = ["id", "observer", "count", "verified", "species"];
  const COLOR = { observer: "fc-0", count: "fc-1", species: "fc-2", id: "fc-3", verified: "fc-4" };
  const colorOf = (f) => COLOR[f] || "";
  const info = infoBox($(".byte-info"), '<span class="muted">Hover or tap any byte to see what it means. Dashed cells are framing (types, lengths, markers); solid cells are content.</span>');
  const inputs = { id: $("#f-id"), observer: $("#f-observer"), count: $("#f-count"), verified: $("#f-verified"), species: $("#f-species") };
  const MAX64 = (1n << 64n) - 1n;
  const MIN64 = -(1n << 63n);
  let last = null;

  function readRecord() {
    const rec = {};
    let ok = true;
    const idText = inputs.id.value.trim();
    const idOk = /^\d{1,20}$/.test(idText) && BigInt(idText) <= MAX64;
    inputs.id.classList.toggle("bad-input", !idOk);
    rec.id = idOk ? BigInt(idText) : last?.id ?? 0n;
    ok &&= idOk;
    rec.observer = inputs.observer.value;
    const cText = inputs.count.value.trim();
    const cOk = /^-?\d{1,19}$/.test(cText) && BigInt(cText) <= MAX64 && BigInt(cText) >= MIN64;
    inputs.count.classList.toggle("bad-input", !cOk);
    rec.count = cOk ? BigInt(cText) : last?.count ?? 0n;
    rec.verified = inputs.verified.checked;
    rec.species = inputs.species.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 15);
    return rec;
  }

  function draw() {
    const rec = readRecord();
    last = rec;
    const json = encodeJSON(rec, ORDER);
    const mp = encodeMsgPack(rec, ORDER);
    const nJ = renderBytes($("#bytes-json"), json, { colorOf, info, chars: true, label: "JSON" });
    const nM = renderBytes($("#bytes-mp"), mp, { colorOf, info, label: "MessagePack" });
    const nX = encodeXML(rec, "sighting", ORDER).length;
    $("#size-json").textContent = `${nJ} bytes`;
    $("#size-mp").textContent = `${nM} bytes`;
    $("#bar-json").style.width = "100%";
    $("#bar-mp").style.width = `${(100 * nM) / nJ}%`;
    $("#st-json").textContent = nJ;
    $("#st-mp").textContent = nM;
    $("#st-xml").textContent = nX;
    $("#st-save").textContent = `${Math.round(100 * (1 - nM / nJ))}%`;

    // Read the JSON back the way a JavaScript client would.
    const text = new TextDecoder().decode(new Uint8Array(flatten(json)));
    const parsed = JSON.parse(text);
    const d = asDouble(rec.id);
    const shownId = String(parsed.id);
    const idCls = d.error === 0n ? "good" : "bad";
    $(".readback").innerHTML =
      `JSON.parse(bytes) → { id: <span class="${idCls}">${esc(shownId)}</span>, observer: ${esc(JSON.stringify(parsed.observer))}, count: ${esc(String(parsed.count))}, verified: ${parsed.verified}, species: ${esc(JSON.stringify(parsed.species))} }`;
    const v = $("#inspector-verdict");
    if (d.error === 0n) {
      v.className = "verdict good";
      v.textContent = bitLength(rec.id) <= 53
        ? `The id survives: ${rec.id} is small enough (${bitLength(rec.id)} significant bits) to be held exactly by a double.`
        : `The id survives, but only by luck: ${rec.id} needs ${bitLength(rec.id)} bits and happens to end in enough zero bits to land exactly on a double. Most of its neighbours would not.`;
    } else {
      v.className = "verdict bad";
      v.textContent = `The writer sent ${rec.id}, but a reader that parses every JSON number into a double holds ${d.digits} and prints ${shownId}: off by ${(d.error < 0n ? -d.error : d.error).toString()}. Look the record up by that id and you get nothing, or someone else's sighting. MessagePack has a 64-bit integer type (marker 0xcf), so its bytes keep the exact value.`;
    }
  }

  Object.values(inputs).forEach((i) => i.addEventListener("input", draw));
  draw();
}

/* ---------------- Where doubles stop counting ---------------- */
{
  const root = document.getElementById("doubles");
  const $ = (s) => root.querySelector(s);
  const BASE = 0xb7c359e2d41f8a6dn; // an arbitrary 64-bit pattern with its top bit set
  const strip = $(".bits");
  const cells = [];
  for (let i = 0; i < 64; i++) { const c = document.createElement("span"); c.className = "bit"; strip.appendChild(c); cells.push(c); }

  slider($("#bits"), (b) => `${b} bits`, (b) => {
    const value = BASE >> BigInt(64 - b);
    const d = asDouble(value);
    const lostBits = Math.max(0, b - 53);
    const bin = value.toString(2).padStart(64, "0");
    cells.forEach((c, i) => {
      const pos = 63 - i; // bit position, 63 = most significant
      const used = pos < b;
      c.className = "bit" + (bin[i] === "1" ? " one" : "") + (used ? (pos >= lostBits ? " kept" : " lost") : "");
    });
    $("#d-exact").textContent = value.toString();
    $("#d-double").textContent = d.digits;
    $("#d-err").textContent = (d.error < 0n ? "" : "+") + d.error.toString();
    const v = $("#doubles-verdict");
    if (lostBits === 0) {
      v.className = "verdict good";
      v.textContent = `A ${b}-bit integer fits in the 53 significant bits of a double, so it survives a round trip through JavaScript, or through any JSON parser that uses doubles.`;
    } else if (d.error === 0n) {
      v.className = "verdict";
      v.textContent = `Only the top 53 bits fit. This particular value happens to end in enough zero bits to land exactly on a double, but most of its neighbours do not: they round to the nearest multiple of ${2 ** lostBits}.`;
    } else {
      v.className = "verdict bad";
      v.textContent = `Only the top 53 bits fit. The lowest ${lostBits} ${lostBits === 1 ? "bit is" : "bits are"} rounded away, so the parser lands on the nearest multiple of ${2 ** lostBits}. Integers above 2^53 = 9007199254740992 are not all representable.`;
    }
  });
}
