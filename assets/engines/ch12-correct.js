// Chapter 12, lesson 3: end-to-end operation IDs, and uniqueness through a partitioned log.
// DOM-free and deterministic.
import { rng } from "../charts.js";

export const LANES = ["Browser", "App server", "Database"];
export const OP_ID = "op-5c1e";

export const FAULTS = [
  { key: "none", label: "No failure" },
  { key: "request", label: "Request lost" },
  { key: "response", label: "Reply lost" },
  { key: "crash", label: "Server crashes" },
  { key: "double", label: "Double click" },
];

/**
 * Builds the step-by-step story of one payment of 40 euros for a pottery class.
 * Every attempt runs inside a proper database transaction. The only difference
 * between the two modes is whether an operation ID travels from the browser to the database.
 * Step kinds: msg {from, to, label, lost}, local {lane, label, tone}. Each step carries a rows snapshot.
 */
export function paymentScript(fault, e2e) {
  const steps = [];
  const rows = [];
  const snap = () => rows.map((r) => ({ ...r }));
  const msg = (from, to, label, text, extra = {}) => steps.push({ kind: "msg", from, to, label, text, rows: snap(), ...extra });
  const local = (lane, label, text, tone = "") => steps.push({ kind: "local", lane, label, text, tone, rows: snap() });
  const reqLabel = e2e ? `pay €40 ${OP_ID}` : "pay €40";
  let attempt = 0;

  function request(lost = false, note = "") {
    attempt++;
    const what = attempt === 1 ? "The browser sends the payment request" : "The retry sends the payment request again";
    msg(0, 1, reqLabel, `${what}${e2e ? `, carrying the operation ID ${OP_ID} that was generated when the form was rendered` : ""}.${note}`, { lost });
  }
  function transaction(server = "The app server") {
    msg(1, 2, "INSERT, COMMIT", `${server} opens a transaction and inserts a payment row.`);
    if (e2e && rows.some((r) => r.op === OP_ID)) {
      local(2, "duplicate op ID: rejected", `A unique index on op_id rejects the insert: ${OP_ID} is already recorded. Nothing is charged twice.`, "good");
      msg(2, 1, "already done", "The database reports the earlier payment, and the server returns that result as if it had just happened.");
      return;
    }
    rows.push({ id: `pay-${rows.length + 1}`, amount: 40, op: e2e ? OP_ID : "none" });
    const dup = rows.length > 1;
    local(2, dup ? "COMMIT (second charge)" : "COMMIT", dup
      ? "The transaction commits. To the database this is a brand-new, perfectly valid payment."
      : "The transaction commits: one payment row, durably stored.", dup ? "bad" : "");
    msg(2, 1, "ok", "The database confirms the commit.");
  }
  function reply(lost = false) {
    msg(1, 0, "200 paid", lost ? "The server replies, but the reply is lost on the way back." : "The server replies: payment accepted.", { lost });
  }
  const timeout = (text) => local(0, "timeout", text, "warn");
  const retry = () => local(0, "user clicks Pay again", "The page shows an error. Lena cannot tell whether she was charged, so she clicks Pay again.", "warn");

  if (fault === "none") {
    request(); transaction(); reply();
    local(0, "shows Paid", "The page shows a confirmation.", "good");
  } else if (fault === "request") {
    request(true);
    timeout("After ten seconds without a reply, the browser gives up.");
    retry(); request(); transaction(); reply();
    local(0, "shows Paid", "The page shows a confirmation. The retry was harmless only because the first request never arrived.", "good");
  } else if (fault === "response") {
    request(); transaction(); reply(true);
    timeout("After ten seconds without a reply, the browser gives up, although the payment did commit.");
    retry(); request(); transaction(); reply();
    local(0, "shows Paid", "The page shows a confirmation.", e2e ? "good" : "bad");
  } else if (fault === "crash") {
    request(); transaction();
    local(1, "crash before replying", "The app server process crashes after the commit and before it can reply.", "bad");
    timeout("The load balancer returns 502 Bad Gateway.");
    retry(); request(false, " The load balancer routes it to a healthy server."); transaction("A different app server"); reply();
    local(0, "shows Paid", "The page shows a confirmation.", e2e ? "good" : "bad");
  } else if (fault === "double") {
    attempt++;
    msg(0, 1, reqLabel, `Lena double-clicks. The first click sends the request${e2e ? ` with ${OP_ID}` : ""}.`);
    attempt++;
    msg(0, 1, reqLabel, `The second click sends an identical request${e2e ? ` with the same ${OP_ID}, because the ID belongs to the rendered form, not to the click` : ""}.`);
    transaction("Server thread 1");
    transaction("Server thread 2");
    reply(); reply();
    local(0, "shows Paid", "The page shows a confirmation.", e2e ? "good" : "bad");
  }
  const charged = rows.reduce((a, r) => a + r.amount, 0);
  return { steps, rows, charged };
}

// ---------------- Uniqueness through a partitioned log ----------------

export const CLIENTS = ["Ines", "Tomas", "Wren", "Yusuf"];
// Each client tries to claim a few short handles at about the same moment.
export const WANTS = {
  Ines: ["tide", "juno"],
  Tomas: ["tide", "pike", "fern"],
  Wren: ["moss", "juno", "tide"],
  Yusuf: ["moss", "fern", "pike"],
};
export const PARTITIONS = 3;
const PROCESS_MS = 150; // time an app server needs between reading and committing

/** Deterministic string hash, so a handle always lands in the same partition. */
export function partitionOf(handle, n = PARTITIONS) {
  let h = 2166136261;
  for (const ch of handle) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % n;
}

/** All claims, with send times inside a 150 ms window and random network delays. */
export function makeClaims(seed = 1) {
  const r = rng(seed * 7919 + 3);
  const out = [];
  let id = 1;
  for (const client of CLIENTS) for (const handle of WANTS[client]) {
    const sent = Math.round(r() * 150);
    const delay = Math.round(20 + r() * 380);
    out.push({ id: `c${id++}`, client, handle, sent, arrive: sent + delay });
  }
  out.sort((a, b) => a.arrive - b.arrive || a.id.localeCompare(b.id));
  return out;
}

/** Route every claim to the partition for its handle; one sequential processor per partition. */
export function runLog(claims) {
  const parts = Array.from({ length: PARTITIONS }, () => []);
  for (const c of claims) parts[partitionOf(c.handle)].push({ ...c, partition: partitionOf(c.handle) });
  const owners = {};
  const decided = [];
  // Partitions are independent; within one, the order of the log decides.
  parts.forEach((log) => log.forEach((c, i) => {
    c.offset = i;
    if (owners[c.handle]) { c.granted = false; c.reason = `taken by ${owners[c.handle][0]}`; }
    else { owners[c.handle] = [c.client]; c.granted = true; }
    decided.push(c);
  }));
  return { parts, owners, duplicates: 0 };
}

/** No log: three app servers each check the table, then insert, with overlapping windows. */
export function runCheckThenInsert(claims, servers = 3) {
  const lanes = Array.from({ length: servers }, () => []);
  const commits = []; // { handle, client, at }
  const all = claims.map((c, i) => ({ ...c, partition: i % servers, start: c.arrive, end: c.arrive + PROCESS_MS }));
  for (const c of all) {
    // The check sees only what was committed before it started.
    const seen = commits.filter((x) => x.handle === c.handle && x.at <= c.start);
    if (seen.length) { c.granted = false; c.reason = `taken by ${seen[0].client}`; }
    else { c.granted = true; commits.push({ handle: c.handle, client: c.client, at: c.end }); }
    lanes[c.partition].push(c);
  }
  lanes.forEach((l) => l.forEach((c, i) => (c.offset = i)));
  const owners = {};
  for (const x of commits.sort((a, b) => a.at - b.at)) (owners[x.handle] ||= []).push(x.client);
  const duplicates = Object.values(owners).filter((o) => o.length > 1).length;
  return { parts: lanes, owners, duplicates };
}
