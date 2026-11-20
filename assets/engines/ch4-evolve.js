// Chapter 4: schema evolution rules and a rolling-upgrade model. DOM-free.
//
// A schema is a list of fields: { name, tag, type, required, def }
//   type: "string" | "int" | "long" | "list"
//   required: true means "must be present" (Protobuf/Thrift required, Avro field with no default)
//   def: the default the reader fills in when the field is missing (undefined means none)

export const V1 = [
  { name: "owner", tag: 1, type: "string", required: true },
  { name: "sizeBytes", tag: 2, type: "int", required: false, def: null },
  { name: "labels", tag: 3, type: "list", required: false, def: [] },
];

export const CHANGES = [
  { id: "addOptional", label: "Add optional field checksum" },
  { id: "addRequired", label: "Add required field region" },
  { id: "regionDefault", label: "Give region a default", needs: "addRequired" },
  { id: "removeOptional", label: "Remove optional field labels" },
  { id: "removeRequired", label: "Remove required field owner" },
  { id: "rename", label: "Rename owner to uploader", conflicts: "removeRequired" },
  { id: "widen", label: "Change sizeBytes from int to long" },
];

/** Apply the toggled changes to V1 and return the v2 schema. Each field remembers what changed. */
export function evolve(on) {
  let f = V1.map((x) => ({ ...x, change: null }));
  if (on.removeRequired) f = f.filter((x) => x.name !== "owner");
  else if (on.rename) f = f.map((x) => (x.name === "owner" ? { ...x, name: "uploader", change: "renamed" } : x));
  if (on.removeOptional) f = f.filter((x) => x.name !== "labels");
  if (on.widen) f = f.map((x) => (x.name === "sizeBytes" ? { ...x, type: "long", change: "type" } : x));
  if (on.addOptional) f.push({ name: "checksum", tag: 4, type: "string", required: false, def: null, change: "added" });
  if (on.addRequired) {
    const d = on.regionDefault;
    f.push({ name: "region", tag: 5, type: "string", required: !d, requiredInTags: true, def: d ? "unknown" : undefined, change: "added" });
  }
  return f;
}

/** The record a writer with this schema produces. A v2 writer with a long size stores a file over 4 GiB. */
export function sample(schema) {
  const r = {};
  for (const f of schema) {
    if (f.name === "owner" || f.name === "uploader") r[f.name] = "kemi";
    else if (f.name === "sizeBytes") r[f.name] = f.type === "long" ? 5368709120 : 734003;
    else if (f.name === "labels") r[f.name] = ["raw"];
    else if (f.name === "checksum") r[f.name] = "c9e1";
    else if (f.name === "region") r[f.name] = "eu-2";
  }
  return r;
}

const TYPE = {
  protobuf: { string: "string", int: "int32", long: "int64", list: "repeated string" },
  thrift: { string: "string", int: "i32", long: "i64", list: "list<string>" },
  avro: { string: "string", int: "int", long: "long", list: "array<string>" },
};

/** Protobuf int64 to int32: keeps the low 32 bits, as two's complement. */
const toInt32 = (n) => Number(BigInt.asIntN(32, BigInt(n)));

/**
 * Decode a record written with `writer` using `reader`, following each format's rules.
 * Returns { status, notes, decoded, defaults, skipped } where status is "exact" | "compatible" | "lossy" | "fail"
 * and each decoded entry is { name, value, how } with how in "read" | "default" | "changed".
 */
export function resolve(format, writer, reader) {
  const data = sample(writer);
  const notes = [];
  const decoded = [];
  let fail = false, lossy = false, soft = false, defaults = 0, skipped = 0;
  const byTag = format !== "avro";
  const find = (rf) => writer.find((w) => (byTag ? w.tag === rf.tag : w.name === rf.name));

  for (const rf of reader) {
    const wf = find(rf);
    const required = byTag ? (rf.requiredInTags || rf.required) : rf.required;
    if (!wf) {
      if (required) {
        fail = true;
        if (byTag) {
          const extra = rf.def !== undefined ? " A default does not satisfy a required check; the field would have to be optional." : "";
          notes.push({ cls: "bad", text: `Required field ${rf.name} (tag ${rf.tag}) is missing, so parsing throws.${extra}` });
        } else {
          const alias = writer.some((w) => w.tag === rf.tag) ? ` The writer calls it ${writer.find((w) => w.tag === rf.tag).name}; Avro matches by name, so the reader field would need an alias.` : "";
          notes.push({ cls: "bad", text: `Reader field ${rf.name} is not in the writer schema and has no default.${alias}` });
        }
        continue;
      }
      soft = true;
      defaults++;
      const shown = rf.def === null || rf.def === undefined ? "not set" : JSON.stringify(rf.def);
      notes.push({ cls: "ok", text: `${rf.name} is missing from the data; the reader uses ${rf.def === null || rf.def === undefined ? "its empty value" : "the default"} (${shown}).` });
      decoded.push({ name: rf.name, value: shown, how: "default" });
      continue;
    }
    let value = data[wf.name];
    if (byTag && wf.name !== rf.name) {
      notes.push({ cls: "ok", text: `Tag ${rf.tag} is called ${wf.name} by the writer and ${rf.name} by the reader. Names are not in the bytes, so the rename is harmless.` });
    }
    if (wf.type !== rf.type) {
      if (format === "protobuf") {
        if (rf.type === "long") {
          notes.push({ cls: "ok", text: `${rf.name}: int32 data read as int64. Both are varints, so the value comes through unchanged.` });
        } else {
          const t = toInt32(value);
          if (t !== value) {
            lossy = true;
            notes.push({ cls: "warn", text: `${rf.name}: int64 data read as int32. The varint parses, but the value is cut to 32 bits: ${value} becomes ${t}.` });
            decoded.push({ name: rf.name, value: String(t), how: "changed" });
            continue;
          }
        }
      } else if (format === "thrift") {
        lossy = true;
        notes.push({ cls: "warn", text: `${rf.name}: the data says ${TYPE.thrift[wf.type]} but the reader expects ${TYPE.thrift[rf.type]}. Generated Thrift code skips a field whose type does not match, so the value is silently dropped.` });
        decoded.push({ name: rf.name, value: "not set", how: "changed" });
        continue;
      } else {
        if (wf.type === "int" && rf.type === "long") {
          notes.push({ cls: "ok", text: `${rf.name}: Avro promotes a writer int to a reader long.` });
        } else {
          fail = true;
          notes.push({ cls: "bad", text: `${rf.name}: the writer used long and the reader expects int. Avro can widen int to long but never narrows, so resolution fails.` });
          continue;
        }
      }
    }
    decoded.push({ name: rf.name, value: JSON.stringify(value), how: "read" });
  }

  for (const wf of writer) {
    const known = reader.some((rf) => (byTag ? rf.tag === wf.tag : rf.name === wf.name));
    if (!known) {
      soft = true;
      skipped++;
      notes.push({ cls: "ok", text: byTag
        ? `Tag ${wf.tag} (${wf.name}) is unknown to this reader. The type in its header says how long it is, so the parser skips it.`
        : `Writer field ${wf.name} is not in the reader schema, so it is read and thrown away.` });
    }
  }

  const status = fail ? "fail" : lossy ? "lossy" : soft ? "compatible" : "exact";
  return { status, notes, decoded: fail ? [] : decoded, defaults, skipped };
}

const removed = (schema, base) => (base ? base.filter((b) => !schema.some((f) => f.tag === b.tag)) : []);

/** Source text of a schema in each format's own syntax. Lines carry the change marker for highlighting. */
export function schemaText(format, schema, base = null) {
  const lines = [];
  const mark = (f) => (base ? f.change : null);
  if (format === "protobuf") {
    lines.push({ text: "message Upload {" });
    for (const f of schema) {
      const label = f.type === "list" ? "" : (f.requiredInTags || f.required) ? "required " : "optional ";
      const def = f.def !== undefined && f.def !== null && f.type === "string" ? ` [default = "${f.def}"]` : "";
      lines.push({ text: `  ${label}${TYPE.protobuf[f.type]} ${f.name} = ${f.tag}${def};`, change: mark(f) });
    }
    for (const f of removed(schema, base)) lines.push({ text: `  reserved ${f.tag}; // was ${f.name}`, change: "removed" });
    lines.push({ text: "}" });
  } else if (format === "thrift") {
    lines.push({ text: "struct Upload {" });
    for (const f of schema) {
      const label = (f.requiredInTags || f.required) ? "required" : "optional";
      const def = f.def !== undefined && f.def !== null && f.type === "string" ? ` = "${f.def}"` : "";
      lines.push({ text: `  ${f.tag}: ${label} ${TYPE.thrift[f.type]} ${f.name}${def},`, change: mark(f) });
    }
    for (const f of removed(schema, base)) lines.push({ text: `  // ${f.tag}: ${f.name} removed; never reuse tag ${f.tag}`, change: "removed" });
    lines.push({ text: "}" });
  } else {
    lines.push({ text: "record Upload {" });
    for (const f of schema) {
      let t = TYPE.avro[f.type];
      let def = "";
      if (f.def === null) { t = `union { null, ${t} }`; def = " = null"; }
      else if (Array.isArray(f.def)) def = " = []";
      else if (typeof f.def === "string") def = ` = "${f.def}"`;
      lines.push({ text: `  ${t} ${f.name}${def};`, change: mark(f) });
    }
    for (const f of removed(schema, base)) lines.push({ text: `  // ${f.name} removed`, change: "removed" });
    lines.push({ text: "}" });
  }
  return lines;
}

/* ---------------- Rolling upgrade ---------------- */
// Three app servers share one database row. v1 code knows tags 1-3, v2 also knows tag 4 (checksum).
// A server edits the row by read-modify-write: decode, change, encode the whole thing back.

export const KNOWS = { 1: [1, 2, 3], 2: [1, 2, 3, 4] };
export const FIELD_NAMES = { 1: "owner", 2: "sizeBytes", 3: "labels", 4: "checksum" };
const LABELS = ["shared", "q3", "draft", "final", "audio", "scan", "legal", "team"];

export function initialUpgrade() {
  return {
    servers: [{ id: "app-1", v: 1 }, { id: "app-2", v: 1 }, { id: "app-3", v: 1 }],
    row: [{ tag: 1, value: "kemi" }, { tag: 2, value: 734003 }, { tag: 3, value: ["raw"] }],
    lost: 0,
    edits: 0,
    ghost: false,
  };
}

const checksumOf = (row) => {
  const s = JSON.stringify(row.filter((f) => f.tag !== 4).map((f) => f.value));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).slice(0, 4);
};

/**
 * One server edits the row. Returns the new state and the step-by-step story:
 * { state, steps: [{ phase: "read" | "change" | "write", text, mem, unknown }], lostNow }
 */
export function edit(state, i, preserve) {
  const s = structuredClone(state);
  const srv = s.servers[i];
  const knows = KNOWS[srv.v];
  const steps = [];
  const mem = s.row.filter((f) => knows.includes(f.tag)).map((f) => ({ ...f }));
  const unknown = s.row.filter((f) => !knows.includes(f.tag)).map((f) => ({ ...f }));
  const unk = unknown.map((f) => `tag ${f.tag}`).join(", ");
  steps.push({ phase: "read", mem, unknown: preserve ? unknown : [],
    text: unknown.length
      ? (preserve
        ? `${srv.id} (v${srv.v}) reads the row. It does not know ${unk}, but it keeps those bytes aside, untouched.`
        : `${srv.id} (v${srv.v}) reads the row. It does not know ${unk}, so the decoder skips it and forgets it.`)
      : `${srv.id} (v${srv.v}) reads the row and understands every field.` });

  const labels = mem.find((f) => f.tag === 3);
  const next = LABELS[s.edits % LABELS.length];
  s.edits++;
  if (labels) labels.value = [...labels.value, next].slice(-3);
  let change = `It adds the label "${next}".`;
  if (srv.v === 2) {
    const sum = checksumOf(mem);
    const c = mem.find((f) => f.tag === 4);
    if (c) c.value = sum; else mem.push({ tag: 4, value: sum });
    change = `It adds the label "${next}" and, being v2 code, stores a checksum (${sum}).`;
  }
  steps.push({ phase: "change", mem: mem.map((f) => ({ ...f })), unknown: preserve ? unknown : [], text: change });

  const hadChecksum = s.row.some((f) => f.tag === 4);
  const out = [...mem, ...(preserve ? unknown : [])].sort((a, b) => a.tag - b.tag);
  const lostNow = hadChecksum && !out.some((f) => f.tag === 4);
  s.row = out;
  if (lostNow) { s.lost++; s.ghost = true; }
  else if (out.some((f) => f.tag === 4)) s.ghost = false;
  steps.push({ phase: "write", mem: out, unknown: [],
    text: lostNow
      ? `${srv.id} writes the whole row back. The checksum was never in its memory, so it is gone from the database. Nobody got an error.`
      : unknown.length && preserve
        ? `${srv.id} writes the row back with the unknown field appended unchanged. The checksum survives.`
        : `${srv.id} writes the row back.` });
  return { state: s, steps, lostNow };
}

export function upgrade(state, i) {
  const s = structuredClone(state);
  s.servers[i].v = 2;
  return s;
}
