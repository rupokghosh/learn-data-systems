// Chapter 7, lesson 3: lost updates, write skew, and phantoms, with toggleable fixes.
import { mountLab } from "./ch7-lab.js";

const POINTS = [50, 30];

const lostUpdate = {
  id: "lost", name: "Lost update",
  blurb: "Two match servers each add a win bonus to the Ravens clan score at the same moment: +50 and +30. Both read the score, add, and write it back.",
  initial: { "clan:ravens": 1200 }, keys: ["clan:ravens"],
  fixes: ["atomic", "forupdate"],
  build: (fixes) => POINTS.map((p, i) => ({
    name: "T" + (i + 1), role: `Match server ${"AB"[i]} (+${p})`,
    ops: fixes.has("atomic")
      ? [{ op: "inc", key: "clan:ravens", by: p, label: `score = score + ${p} (atomic)` }, { op: "commit" }]
      : [
        { op: "read", key: "clan:ravens", as: "s", forUpdate: fixes.has("forupdate"), label: fixes.has("forupdate") ? "read score FOR UPDATE" : "read score" },
        { op: "write", key: "clan:ravens", value: (L) => L.s + p, label: `write score = read + ${p}` },
        { op: "commit" },
      ],
  })),
  schedules: [
    { name: "Interleaved", order: [0, 1, 0, 0, 1, 1] },
    { name: "One after the other", order: [0, 0, 0, 1, 1, 1] },
  ],
  invariant: {
    ok: (c) => c.state["clan:ravens"] === expected(c),
    text: (c, ok) => ok ? `The score is ${c.state["clan:ravens"]}: every committed bonus is counted.` : `The score is ${c.state["clan:ravens"]}, but the committed bonuses add up to ${expected(c)}: ${expected(c) - c.state["clan:ravens"]} points vanished.`,
  },
};
function expected({ db }) {
  return 1200 + db.txns.reduce((s, t, i) => s + (t.status === "committed" ? POINTS[i] : 0), 0);
}

const GUARDS = { "guard:ivy": "off duty", "guard:noor": "on duty", "guard:theo": "on duty" };
const writeSkew = {
  id: "skew", name: "Write skew",
  blurb: "The pool needs at least one lifeguard on duty. Noor and Theo both ask for a break at once. Each request counts the guards on duty and goes on break only if someone else would still be watching.",
  initial: GUARDS, keys: ["guard:ivy", "guard:noor", "guard:theo"],
  fixes: ["forupdate"],
  build: (fixes) => ["noor", "theo"].map((g, i) => ({
    name: "T" + (i + 1), role: `${g[0].toUpperCase() + g.slice(1)} asks for a break`,
    ops: [
      { op: "scan", prefix: "guard:", where: (v) => v === "on duty", as: "on", forUpdate: fixes.has("forupdate"), label: fixes.has("forupdate") ? "count guards on duty FOR UPDATE" : "count guards on duty" },
      { op: "write", key: "guard:" + g, value: "break", if: (L) => L.on.length >= 2, label: `if 2 or more: ${g} goes on break`, skip: "only 1 on duty: request refused" },
      { op: "commit" },
    ],
  })),
  schedules: [
    { name: "Interleaved", order: [0, 1, 0, 1, 0, 1] },
    { name: "One after the other", order: [0, 0, 0, 1, 1, 1] },
  ],
  invariant: {
    ok: ({ state }) => Object.values(state).filter((v) => v === "on duty").length >= 1,
    text: ({ state }, ok) => { const n = Object.values(state).filter((v) => v === "on duty").length; return ok ? `${n} lifeguard${n > 1 ? "s" : ""} on duty.` : "Nobody is watching the pool."; },
  },
};

const ACCTS = { "acct:1001": "@juno", "acct:1002": "@pike" };
const phantom = {
  id: "phantom", name: "Phantom",
  blurb: "Ana and Ben both sign up with the handle @river. Each signup checks that no account uses it, then inserts a new account row.",
  initial: ACCTS, keys: ["acct:1001", "acct:1002"],
  fixes: ["forupdate", "unique"],
  build: (fixes) => [["Ana", 1003], ["Ben", 1004]].map(([who, id], i) => {
    const ops = [
      { op: "scan", prefix: "acct:", where: (v) => v === "@river", as: "m", forUpdate: fixes.has("forupdate"), label: fixes.has("forupdate") ? "find @river FOR UPDATE" : "find accounts with @river" },
      { op: "write", key: "acct:" + id, value: "@river", if: (L) => L.m.length === 0, label: `if none: insert acct:${id}`, skip: "handle taken: signup refused" },
    ];
    if (fixes.has("unique")) ops.push({ op: "insert", key: "uniq:@river", value: "acct:" + id, if: (L) => L.m.length === 0, label: "add unique index entry", skip: "no index entry needed" });
    ops.push({ op: "commit" });
    return { name: "T" + (i + 1), role: `${who} signs up`, ops };
  }),
  schedules: [
    { name: "Interleaved", order: [0, 1, 0, 1, 0, 1, 0, 1] },
    { name: "One after the other", order: [0, 0, 0, 0, 1, 1, 1, 1] },
  ],
  invariant: {
    ok: ({ state }) => Object.entries(state).filter(([k, v]) => k.startsWith("acct:") && v === "@river").length <= 1,
    text: ({ state }, ok) => { const n = Object.entries(state).filter(([k, v]) => k.startsWith("acct:") && v === "@river").length; return ok ? (n ? "Exactly one account owns @river." : "Nobody owns @river.") : `${n} accounts now share the handle @river.`; },
  },
};

mountLab(document.getElementById("lab-lost"), {
  scenarios: [lostUpdate, writeSkew, phantom],
  levels: [
    { id: "rc", label: "Read committed" },
    { id: "si-mysql", label: "Repeatable read (MySQL)" },
    { id: "si", label: "Repeatable read (PostgreSQL)" },
    { id: "ssi", label: "Serializable" },
  ],
  level: "rc",
  fixes: [
    { id: "atomic", label: "Atomic increment" },
    { id: "forupdate", label: "SELECT … FOR UPDATE" },
    { id: "unique", label: "Unique index" },
  ],
  history: false,
});
