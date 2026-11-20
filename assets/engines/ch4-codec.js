// Chapter 4: real byte-level encoders, DOM-free so they can be tested in Node.
// Every encoder returns a list of segments: { bytes, field, role, note }.
//   field: which record field the bytes belong to (null for framing bytes)
//   role:  "type" | "tag" | "header" | "len" | "value" | "key" | "punct" | "union" | "end" | "map"
//   note:  a plain-language explanation shown when the reader hovers a byte
// Integers in records are BigInt so 64-bit values stay exact.

const textEncoder = new TextEncoder();
export const utf8 = (s) => Array.from(textEncoder.encode(s));
export const hex = (b) => b.toString(16).padStart(2, "0");
export const flatten = (segs) => segs.flatMap((s) => s.bytes);
export const size = (segs) => segs.reduce((n, s) => n + s.bytes.length, 0);

const seg = (bytes, field, role, note) => ({ bytes, field, role, note });

/* ---------------- varint and zigzag ---------------- */

/** Zigzag maps signed to unsigned so small negatives stay small: 0,-1,1,-2,2 become 0,1,2,3,4. */
export function zigzag(n) {
  const v = BigInt(n);
  return v >= 0n ? v << 1n : ((-v) << 1n) - 1n;
}
export function unzigzag(z) {
  const v = BigInt(z);
  return v & 1n ? -((v + 1n) >> 1n) : v >> 1n;
}

/** Unsigned LEB128 varint: 7 bits per byte, least significant group first, top bit means "more follows". */
export function varint(n) {
  let v = BigInt(n);
  if (v < 0n) v = BigInt.asUintN(64, v); // how Protocol Buffers writes a negative int64: ten bytes
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}

export function readVarint(bytes, pos = 0) {
  let v = 0n, shift = 0n, i = pos;
  for (;;) {
    const b = bytes[i++];
    if (b === undefined) throw new Error("truncated varint");
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return { value: v, length: i - pos };
}

/** The 7-bit groups of a varint, for drawing. Least significant group first, like the bytes. */
export function varintGroups(n) {
  return varint(n).map((b) => ({ byte: b, more: (b & 0x80) !== 0, bits: (b & 0x7f).toString(2).padStart(7, "0") }));
}

/** Fixed-width big-endian integer (two's complement for negatives). */
export function bigEndian(n, bytes) {
  let v = BigInt.asUintN(bytes * 8, BigInt(n));
  const out = [];
  for (let i = 0; i < bytes; i++) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  return out;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const quote = (s) => `"${s.length > 24 ? s.slice(0, 22) + "..." : s}"`;

/* ---------------- textual formats ---------------- */

/** Compact JSON, segment per key and per value so bytes can be coloured by field. */
export function encodeJSON(rec, order = Object.keys(rec)) {
  const segs = [seg(utf8("{"), null, "punct", "Opening brace: start of the object")];
  order.forEach((name, i) => {
    if (i > 0) segs.push(seg(utf8(","), null, "punct", "Comma between fields"));
    segs.push(seg(utf8(JSON.stringify(name) + ":"), name, "key", `The key ${quote(name)} spelled out in full, with quotes and a colon, in every record`));
    const v = rec[name];
    let text, note;
    if (typeof v === "bigint") { text = v.toString(); note = `The number ${text} written as ${plural(text.length, "decimal digit")}. JSON does not say whether it is an integer or how many bits it needs`; }
    else if (typeof v === "string") { text = JSON.stringify(v); note = `The text ${quote(v)} in quotes, as UTF-8`; }
    else if (typeof v === "boolean") { text = String(v); note = `The literal ${text}, ${plural(text.length, "byte")}`; }
    else if (v === null) { text = "null"; note = "The literal null"; }
    else { text = JSON.stringify(v); note = `An array of ${plural(v.length, "string")}, brackets, quotes, and commas included`; }
    segs.push(seg(utf8(text), name, "value", note));
  });
  segs.push(seg(utf8("}"), null, "punct", "Closing brace: end of the object"));
  return segs;
}

const xmlEsc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
/** Plain XML, only its size is used. */
export function encodeXML(rec, root = "record", order = Object.keys(rec)) {
  let s = `<${root}>`;
  for (const k of order) {
    const v = rec[k];
    if (Array.isArray(v)) s += `<${k}>${v.map((x) => `<item>${xmlEsc(x)}</item>`).join("")}</${k}>`;
    else if (v === null) s += `<${k}/>`;
    else s += `<${k}>${xmlEsc(v)}</${k}>`;
  }
  return utf8(s + `</${root}>`);
}

/* ---------------- MessagePack ---------------- */

function mpString(s, field, role, what) {
  const b = utf8(s);
  const n = b.length;
  let head, hnote;
  if (n < 32) { head = [0xa0 | n]; hnote = `fixstr: 0xa0 plus the length ${n}, in one byte`; }
  else if (n < 256) { head = [0xd9, n]; hnote = `str8: marker 0xd9, then the length ${n} in one byte`; }
  else { head = [0xda, ...bigEndian(n, 2)]; hnote = `str16: marker 0xda, then the length ${n} in two bytes`; }
  return [seg(head, field, "type", hnote), seg(b, field, role, `${what} ${quote(s)} as UTF-8`)];
}

function mpInt(v, field) {
  const n = BigInt(v);
  const str = n.toString();
  if (n >= 0n && n < 128n) return [seg([Number(n)], field, "value", `positive fixint: ${str} fits in the marker byte itself`)];
  if (n < 0n && n >= -32n) return [seg([Number(BigInt.asUintN(8, n))], field, "value", `negative fixint: ${str} fits in the marker byte itself`)];
  const unsigned = n >= 0n;
  const kinds = unsigned
    ? [[0xcc, 1, 256n, "uint8"], [0xcd, 2, 65536n, "uint16"], [0xce, 4, 1n << 32n, "uint32"], [0xcf, 8, 1n << 64n, "uint64"]]
    : [[0xd0, 1, 128n, "int8"], [0xd1, 2, 32768n, "int16"], [0xd2, 4, 1n << 31n, "int32"], [0xd3, 8, 1n << 63n, "int64"]];
  for (const [mark, bytes, lim, name] of kinds) {
    if (unsigned ? n < lim : n >= -lim) {
      return [seg([mark], field, "type", `${name} marker 0x${hex(mark)}: an integer follows in ${plural(bytes, "byte")}`),
        seg(bigEndian(n, bytes), field, "value", `${str} as a ${bytes * 8}-bit big-endian integer`)];
    }
  }
  throw new Error("integer out of range");
}

function mpValue(v, field) {
  if (typeof v === "bigint") return mpInt(v, field);
  if (typeof v === "string") return mpString(v, field, "value", "The text");
  if (typeof v === "boolean") return [seg([v ? 0xc3 : 0xc2], field, "value", `${v} is a single marker byte, 0x${v ? "c3" : "c2"}`)];
  if (v === null) return [seg([0xc0], field, "value", "nil is a single marker byte, 0xc0")];
  if (Array.isArray(v)) {
    const head = v.length < 16 ? [0x90 | v.length] : [0xdc, ...bigEndian(v.length, 2)];
    const out = [seg(head, field, "len", v.length < 16 ? `fixarray: 0x90 plus the count ${v.length}` : `array16: marker 0xdc, then the count ${v.length}`)];
    v.forEach((x) => out.push(...mpString(x, field, "value", "Element")));
    return out;
  }
  throw new Error("unsupported value");
}

/** MessagePack: binary JSON. Same structure, keys still included, smaller numbers and lengths. */
export function encodeMsgPack(rec, order = Object.keys(rec)) {
  const n = order.length;
  const segs = [seg(n < 16 ? [0x80 | n] : [0xde, ...bigEndian(n, 2)], null, "map", `fixmap: 0x80 plus the number of entries, ${n}`)];
  for (const name of order) {
    segs.push(...mpString(name, name, "key", "The key"));
    segs.push(...mpValue(rec[name], name));
  }
  return segs;
}

/* ---------------- Schema-driven binary formats ---------------- */
// Schema: [{ name, tag, type: "string" | "long" | "bool" | "list" }]
// Record: { [name]: string | BigInt | boolean | string[] | null }  (null means not set)

const TB = { bool: 2, long: 10, string: 11, list: 15 };
const TB_NAME = { 2: "bool", 10: "i64", 11: "string", 15: "list" };

/** Thrift BinaryProtocol: type byte, 2-byte tag, then fixed-width values. */
export function encodeThriftBinary(schema, rec) {
  const segs = [];
  for (const f of schema) {
    const v = rec[f.name];
    if (v === null || v === undefined) continue;
    const t = TB[f.type];
    segs.push(seg([t], f.name, "type", `Field type ${t} (${TB_NAME[t]})`));
    segs.push(seg(bigEndian(f.tag, 2), f.name, "tag", `Field tag ${f.tag} (${f.name}) as a 2-byte integer. The name itself is never written`));
    if (f.type === "string") {
      const b = utf8(v);
      segs.push(seg(bigEndian(b.length, 4), f.name, "len", `Length ${b.length}, always a 4-byte integer`));
      segs.push(seg(b, f.name, "value", `The text ${quote(v)} as UTF-8`));
    } else if (f.type === "long") {
      segs.push(seg(bigEndian(v, 8), f.name, "value", `${v} as an 8-byte big-endian integer, however small the number is`));
    } else if (f.type === "bool") {
      segs.push(seg([v ? 1 : 0], f.name, "value", `${v} as one byte`));
    } else if (f.type === "list") {
      segs.push(seg([TB.string], f.name, "type", "Element type 11 (string)"));
      segs.push(seg(bigEndian(v.length, 4), f.name, "len", `${plural(v.length, "element")}, as a 4-byte integer`));
      for (const x of v) {
        const b = utf8(x);
        segs.push(seg(bigEndian(b.length, 4), f.name, "len", `Element length ${b.length}, 4 bytes`));
        segs.push(seg(b, f.name, "value", `Element ${quote(x)} as UTF-8`));
      }
    }
  }
  segs.push(seg([0], null, "end", "Stop byte (type 0): end of the struct"));
  return segs;
}

const TC = { string: 8, long: 6, list: 9 };
const TC_NAME = { 1: "bool true", 2: "bool false", 6: "i64", 8: "binary", 9: "list" };

/** Thrift CompactProtocol: tag delta and type packed in one byte, zigzag varints, booleans inside the header. */
export function encodeThriftCompact(schema, rec) {
  const segs = [];
  let last = 0;
  for (const f of schema) {
    const v = rec[f.name];
    if (v === null || v === undefined) continue;
    const t = f.type === "bool" ? (v ? 1 : 2) : TC[f.type];
    const delta = f.tag - last;
    last = f.tag;
    if (delta > 0 && delta <= 15) {
      const why = f.type === "bool" ? `. Type ${t} means ${v}, so no value byte follows` : "";
      segs.push(seg([(delta << 4) | t], f.name, "header", `High 4 bits: tag delta ${delta} (so field ${f.tag}, ${f.name}). Low 4 bits: type ${t} (${TC_NAME[t]})${why}`));
    } else {
      segs.push(seg([t], f.name, "header", `Type ${t} (${TC_NAME[t]}); the tag jump is too big for 4 bits, so the tag follows`));
      segs.push(seg(varint(zigzag(f.tag)), f.name, "tag", `Field tag ${f.tag} as a zigzag varint`));
    }
    if (f.type === "string") {
      const b = utf8(v);
      segs.push(seg(varint(b.length), f.name, "len", `Length ${b.length} as a varint`));
      segs.push(seg(b, f.name, "value", `The text ${quote(v)} as UTF-8`));
    } else if (f.type === "long") {
      const z = zigzag(v);
      const vb = varint(z);
      segs.push(seg(vb, f.name, "value", `${v}, zigzag encoded to ${z}, then a ${plural(vb.length, "byte")} varint`));
    } else if (f.type === "list") {
      if (v.length < 15) segs.push(seg([(v.length << 4) | TC.string], f.name, "len", `List header: ${plural(v.length, "element")} in the high 4 bits, element type 8 (binary) in the low 4 bits`));
      else { segs.push(seg([0xf0 | TC.string], f.name, "len", "List header: 15 or more elements, count follows")); segs.push(seg(varint(v.length), f.name, "len", `${v.length} elements as a varint`)); }
      for (const x of v) {
        const b = utf8(x);
        segs.push(seg(varint(b.length), f.name, "len", `Element length ${b.length} as a varint`));
        segs.push(seg(b, f.name, "value", `Element ${quote(x)} as UTF-8`));
      }
    }
  }
  segs.push(seg([0], null, "end", "Stop byte: end of the struct"));
  return segs;
}

/** Protocol Buffers (proto2): key = (tag << 3) | wire type, as a varint. Count is sint64 (zigzag). */
export function encodeProtobuf(schema, rec) {
  const segs = [];
  const key = (f, wt, extra = "") => {
    const k = (f.tag << 3) | wt;
    const kind = wt === 0 ? "varint" : "length-delimited";
    return seg(varint(k), f.name, "header", `Key ${k} = (tag ${f.tag} << 3) | wire type ${wt} (${kind}). Field ${f.name}${extra}`);
  };
  for (const f of schema) {
    const v = rec[f.name];
    if (v === null || v === undefined) continue;
    if (f.type === "string") {
      const b = utf8(v);
      segs.push(key(f, 2));
      segs.push(seg(varint(b.length), f.name, "len", `Length ${b.length} as a varint`));
      segs.push(seg(b, f.name, "value", `The text ${quote(v)} as UTF-8`));
    } else if (f.type === "long") {
      const z = zigzag(v);
      const vb = varint(z);
      segs.push(key(f, 0));
      segs.push(seg(vb, f.name, "value", `${v} as sint64: zigzag to ${z}, then a ${plural(vb.length, "byte")} varint`));
    } else if (f.type === "bool") {
      segs.push(key(f, 0));
      segs.push(seg([v ? 1 : 0], f.name, "value", `${v} as a varint, one byte`));
    } else if (f.type === "list") {
      v.forEach((x, i) => {
        const b = utf8(x);
        segs.push(key(f, 2, i === 0 ? ". A repeated field writes its key again for every element" : `, element ${i + 1}`));
        segs.push(seg(varint(b.length), f.name, "len", `Length ${b.length} as a varint`));
        segs.push(seg(b, f.name, "value", `Element ${quote(x)} as UTF-8`));
      });
    }
  }
  return segs;
}

/** Avro: no tags and no types in the data. Values in schema order; the reader must know the writer schema. */
export function encodeAvro(schema, rec) {
  const segs = [];
  const avroLong = (v, field, what) => {
    const z = zigzag(v);
    const b = varint(z);
    return seg(b, field, what === "value" ? "value" : "len", `${what === "value" ? "Value" : what} ${v}, zigzag ${z}, varint of ${plural(b.length, "byte")}`);
  };
  for (const f of schema) {
    const v = rec[f.name];
    if (f.type === "string") {
      const b = utf8(v ?? "");
      segs.push(avroLong(b.length, f.name, "Length"));
      segs.push(seg(b, f.name, "value", `The text ${quote(v ?? "")} as UTF-8. Nothing says which field this is: position in the schema decides`));
    } else if (f.type === "long") {
      if (v === null || v === undefined) {
        segs.push(seg([0], f.name, "union", "Union branch 0 (null): the field is not set, so nothing more is written"));
      } else {
        segs.push(seg(varint(zigzag(1)), f.name, "union", "Union branch 1 (long), zigzag encoded. Branch 0 would mean null"));
        segs.push(avroLong(v, f.name, "value"));
      }
    } else if (f.type === "bool") {
      segs.push(seg([v ? 1 : 0], f.name, "value", `${!!v} as one byte`));
    } else if (f.type === "list") {
      const arr = v || [];
      if (arr.length) {
        segs.push(seg(varint(zigzag(arr.length)), f.name, "len", `Array block of ${plural(arr.length, "item")} (zigzag varint)`));
        for (const x of arr) {
          const b = utf8(x);
          segs.push(avroLong(b.length, f.name, "Length"));
          segs.push(seg(b, f.name, "value", `Item ${quote(x)} as UTF-8`));
        }
      }
      segs.push(seg([0], f.name, "end", "Block count 0: end of the array"));
    }
  }
  return segs;
}

/* ---------------- Doubles and 64-bit integers ---------------- */

/** What a JSON parser that stores every number as an IEEE 754 double (JavaScript, many others) reads. */
export function asDouble(big) {
  const d = Number(big); // rounds to the nearest representable double
  const back = BigInt(d);
  return { double: d, exact: back, error: back - BigInt(big), digits: back.toString() };
}

/** Count of significant bits in a positive BigInt. */
export const bitLength = (big) => (big <= 0n ? 0 : big.toString(2).length);
