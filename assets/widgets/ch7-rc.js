// Chapter 7, lesson 2: dirty reads, dirty writes, read skew, and an MVCC version viewer.
import { mountLab } from "./ch7-lab.js";

const GIG = { "gig:sold": 96, "gig:free": 4 };

const dirtyRead = {
  id: "dirty-read", name: "Dirty read",
  blurb: "A tour group tries to book the last 4 seats, then its card is declined. Meanwhile the website checks how many seats are free.",
  initial: GIG, keys: ["gig:sold", "gig:free"],
  build: () => [
    { name: "T1", role: "Tour group booking", ops: [
      { op: "write", key: "gig:sold", value: 100, label: "write gig:sold = 100" },
      { op: "write", key: "gig:free", value: 0, label: "write gig:free = 0" },
      { op: "abort", why: "card declined", label: "abort (card declined)" },
    ] },
    { name: "T2", role: "Website", ops: [
      { op: "read", key: "gig:free", as: "f" },
      { op: "commit" },
    ] },
  ],
  schedules: [
    { name: "Website reads mid-booking", order: [0, 0, 1, 1, 0] },
    { name: "Website reads afterwards", order: [0, 0, 0, 1, 1] },
  ],
  invariant: {
    ok: ({ tx }) => tx.T2.locals.f === 4,
    text: ({ tx }, ok) => ok ? "The website showed 4 free seats, the real number." : `The website told fans the gig had ${tx.T2.locals.f} free seats, a value that was never committed.`,
  },
};

const dirtyWrite = {
  id: "dirty-write", name: "Dirty write",
  blurb: "Mina and Oskar both buy seat A12. Each purchase writes the seat's owner and the invoice's name.",
  initial: { "seat:A12": "free", "invoice:A12": "none" }, keys: ["seat:A12", "invoice:A12"],
  build: () => ["Mina", "Oskar"].map((who, i) => ({
    name: "T" + (i + 1), role: `${who} buys A12`, ops: [
      { op: "write", key: "seat:A12", value: who, label: `write seat:A12 = ${who}` },
      { op: "write", key: "invoice:A12", value: who, label: `write invoice:A12 = ${who}` },
      { op: "commit" },
    ],
  })),
  schedules: [
    { name: "Interleaved", order: [0, 1, 1, 1, 0, 0] },
    { name: "One after the other", order: [0, 0, 0, 1, 1, 1] },
  ],
  invariant: {
    ok: ({ state }) => state["seat:A12"] === state["invoice:A12"],
    text: ({ state }, ok) => ok ? `Seat and invoice agree: both say ${state["seat:A12"]}.` : `The seat went to ${state["seat:A12"]} but the invoice was sent to ${state["invoice:A12"]}.`,
  },
};

const readSkew = {
  id: "read-skew", name: "Read skew",
  blurb: "A nightly report reads the sold and free counters, which must add up to the venue's 100 seats. A sale of the last 4 seats commits while the report runs.",
  initial: GIG, keys: ["gig:sold", "gig:free"],
  build: () => [
    { name: "T1", role: "Nightly report", ops: [
      { op: "read", key: "gig:sold", as: "s" },
      { op: "read", key: "gig:free", as: "f" },
      { op: "commit" },
    ] },
    { name: "T2", role: "Sale of 4 seats", ops: [
      { op: "write", key: "gig:sold", value: 100, label: "write gig:sold = 100" },
      { op: "write", key: "gig:free", value: 0, label: "write gig:free = 0" },
      { op: "commit" },
    ] },
  ],
  schedules: [
    { name: "Sale lands mid-report", order: [0, 1, 1, 1, 0, 0] },
    { name: "One after the other", order: [0, 0, 0, 1, 1, 1] },
  ],
  invariant: {
    ok: ({ tx }) => tx.T1.locals.s + tx.T1.locals.f === 100,
    text: ({ tx }, ok) => `The report saw ${tx.T1.locals.s} sold + ${tx.T1.locals.f} free = ${tx.T1.locals.s + tx.T1.locals.f} seats${ok ? "." : ", but the venue has 100."}`,
  },
};

mountLab(document.getElementById("lab-anomaly"), {
  scenarios: [dirtyRead, dirtyWrite, readSkew],
  levels: [
    { id: "none", label: "No isolation" },
    { id: "ru", label: "Read uncommitted" },
    { id: "rc", label: "Read committed" },
    { id: "si", label: "Snapshot isolation" },
  ],
  level: "rc",
  history: false,
});

// ---------- MVCC version viewer ----------
const sale = (name, role, n, abort) => ({
  name, role, ops: [
    { op: "read", key: "gig:free", as: "f" },
    { op: "write", key: "gig:free", value: (L) => L.f - n, label: `write gig:free = free − ${n}` },
    abort ? { op: "abort", why: "buyer cancelled", label: "abort (buyer cancelled)" } : { op: "commit" },
  ],
});
const report = { name: "T1", role: "Long report", ops: [
  { op: "read", key: "gig:free", label: "read gig:free (first look)" },
  { op: "read", key: "gig:free", label: "read gig:free (again)" },
  { op: "read", key: "gig:free", label: "read gig:free (last look)" },
  { op: "commit" },
] };
const ORDER = [0, 1, 1, 0, 1, 2, 2, 0, 2, 0];
mountLab(document.getElementById("lab-mvcc"), {
  scenarios: [
    { id: "both", name: "Both sales commit", initial: { "gig:free": 4 },
      blurb: "A long report reads the free-seat count three times while two sales change it.",
      build: () => [report, sale("T2", "Sells 1 seat", 1), sale("T3", "Sells 2 seats", 2)],
      schedules: [{ name: "Overlapping", order: ORDER }] },
    { id: "abort", name: "Second sale rolls back", initial: { "gig:free": 4 },
      blurb: "The same, but the second buyer cancels and T3 rolls back.",
      build: () => [report, sale("T2", "Sells 1 seat", 1), sale("T3", "Sells 2 seats", 2, true)],
      schedules: [{ name: "Overlapping", order: ORDER }] },
  ],
  scenarioLabel: "Story",
  levels: [{ id: "si", label: "Snapshot isolation" }],
  history: true,
});
