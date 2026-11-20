// Chapter 12, lesson 4: a scoring feedback loop, and re-identification in "anonymous" data.
// DOM-free and deterministic.
import { rng } from "../charts.js";

export const GROUPS = ["Northgate", "Southmere"];

function poisson(r, mean) {
  const L = Math.exp(-mean);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}

/**
 * Two neighbourhoods with identically reliable people. Southmere residents start with thinner
 * credit files (recent arrivals, cash economy). The score uses file length and an area prior.
 * Approved people who repay build history; denied people cannot.
 * learns: after each round, the area prior is refit on outcomes, and anyone denied counts as
 * "no repayment observed", so the model learns from data its own decisions produced.
 * explore: share of denied applicants given a small trial loan anyway.
 */
export function feedbackSim({ threshold = 50, learns = true, explore = 0, rounds = 20, n = 400, seed = 5, turnover = 0.08 } = {}) {
  const r = rng(seed);
  const person = (g) => ({ g, p: 0.55 + 0.43 * r(), h: poisson(r, g === 0 ? 4.5 : 2.0) });
  const people = [];
  for (let g = 0; g < 2; g++) for (let i = 0; i < n; i++) people.push(person(g));
  // Decisions use their own random stream so the same people get the same luck across settings.
  const luck = rng(seed + 101);
  const prior = [0.5, 0.5];
  const out = [];
  const score = (x) => 60 * (1 - Math.exp(-x.h / 3)) + 40 * prior[x.g];
  for (let t = 0; t < rounds; t++) {
    const st = [0, 1].map(() => ({ approved: 0, repaid: 0, worthyDenied: 0, worthy: 0, history: 0, prior: 0, meanP: 0 }));
    for (let i = 0; i < people.length; i++) {
      // Some people move away and are replaced by newcomers from the same neighbourhood.
      if (t > 0 && r() < turnover) people[i] = person(people[i].g);
      const x = people[i], s = st[x.g];
      const u1 = luck(), u2 = luck();
      const approved = score(x) >= threshold || u1 < explore;
      s.history += x.h; s.meanP += x.p;
      if (x.p >= 0.8) s.worthy++;
      if (approved) {
        s.approved++;
        // A repaid loan becomes part of the credit file. Denied people get no chance to add one.
        if (u2 < x.p) { s.repaid++; x.h += 1; }
      } else if (x.p >= 0.8) s.worthyDenied++;
    }
    st.forEach((s, g) => {
      s.rate = s.approved / n; s.history /= n; s.meanP /= n; s.prior = prior[g];
      s.repayAmongApproved = s.approved ? s.repaid / s.approved : 0;
    });
    out.push(st);
    if (learns) for (let g = 0; g < 2; g++) {
      const observed = st[g].repaid / n; // denied people silently count as "did not repay"
      prior[g] = 0.5 * prior[g] + 0.5 * observed;
    }
  }
  return out;
}

// ---------------- Re-identification ----------------

const POSTCODES = (() => {
  const r = rng(91), L = "ABDEFGHJKLMNPRSTW", out = [];
  while (out.length < 60) {
    const c = L[Math.floor(r() * L.length)] + L[Math.floor(r() * L.length)] + (1 + Math.floor(r() * 9));
    if (!out.includes(c)) out.push(c);
  }
  return out;
})();
const BRANDS = ["Lumo", "Corvid", "Tessel", "Pira", "Odin", "Vale"];
const MODELS = BRANDS.flatMap((b, i) => Array.from({ length: 7 }, (_, j) => `${b} ${["S", "X", "Go", "Pro", "Lite", "Max", "Mini"][j]}${3 + ((i + j) % 5)}`));
const LANGS = ["English", "Polish", "Urdu", "Spanish", "Romanian", "Punjabi", "Arabic", "Portuguese"];

export const ATTRS = [
  { key: "postcode", label: "Postcode prefix" },
  { key: "year", label: "Birth year" },
  { key: "gender", label: "Gender" },
  { key: "device", label: "Phone model" },
  { key: "lang", label: "App language" },
];

function zipfPicker(r, n, s) {
  const w = Array.from({ length: n }, (_, i) => 1 / (i + 1) ** s);
  const total = w.reduce((a, b) => a + b, 0);
  return () => { let x = r() * total; for (let i = 0; i < n; i++) { x -= w[i]; if (x <= 0) return i; } return n - 1; };
}

/** A synthetic population with realistic skew: big postcodes, popular phones, a main language. */
export function population(n = 20000, seed = 2026) {
  const r = rng(seed);
  const pc = zipfPicker(r, POSTCODES.length, 0.6);
  const dev = zipfPicker(r, MODELS.length, 1.0);
  const lang = zipfPicker(r, LANGS.length, 1.8);
  const people = [];
  for (let i = 0; i < n; i++) {
    const age = Math.min(80, Math.max(18, Math.round(42 + (r() + r() + r() + r() - 2) * 30)));
    const gx = r();
    people.push({
      postcode: POSTCODES[pc()],
      year: 2025 - age,
      gender: gx < 0.49 ? "F" : gx < 0.98 ? "M" : "X",
      device: MODELS[dev()],
      lang: LANGS[lang()],
    });
  }
  return people;
}

/** For a set of attribute keys, the anonymity set size of every person and a summary. */
export function anonymity(people, keys) {
  const counts = new Map();
  const keyOf = (p) => keys.map((k) => p[k]).join("|");
  for (const p of people) { const k = keyOf(p); counts.set(k, (counts.get(k) || 0) + 1); }
  const size = people.map((p) => counts.get(keyOf(p)));
  const buckets = { unique: 0, small: 0, medium: 0, large: 0 }; // 1, 2-4, 5-19, 20+
  for (const s of size) {
    if (s === 1) buckets.unique++; else if (s < 5) buckets.small++; else if (s < 20) buckets.medium++; else buckets.large++;
  }
  return { size, buckets, groups: counts.size };
}
