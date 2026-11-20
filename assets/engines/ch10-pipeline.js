// Chapter 10: a tiny emulation of a Unix log-analysis pipeline. DOM-free.
// Each stage takes an array of lines and returns an array of lines, like a filter in a pipe.

export const SAMPLE_LOG = [
  "2026-03-14T09:12:03 198.51.100.23 GET /menu 200 41ms",
  "2026-03-14T09:12:05 203.0.113.9 GET /bread/rye 200 38ms",
  "2026-03-14T09:12:05 198.51.100.23 GET /static/app.css 304 2ms",
  "2026-03-14T09:12:09 192.0.2.71 GET /menu 200 44ms",
  "2026-03-14T09:12:11 203.0.113.9 POST /order 201 120ms",
  "2026-03-14T09:12:14 192.0.2.140 GET /bread/baguette 200 35ms",
  "2026-03-14T09:12:18 198.51.100.5 GET /menu 200 40ms",
  "2026-03-14T09:12:18 192.0.2.71 GET /static/app.css 304 3ms",
  "2026-03-14T09:12:21 203.0.113.44 GET /bread/rye 200 37ms",
  "2026-03-14T09:12:26 198.51.100.5 GET /wp-login.php 404 6ms",
  "2026-03-14T09:12:27 198.51.100.5 GET /wp-login.php 404 5ms",
  "2026-03-14T09:12:30 192.0.2.140 POST /order 500 902ms",
  "2026-03-14T09:12:31 203.0.113.44 GET /menu 200 39ms",
  "2026-03-14T09:12:35 192.0.2.140 POST /order 201 131ms",
  "2026-03-14T09:12:40 198.51.100.23 GET /bread/rye 200 36ms",
  "2026-03-14T09:12:42 203.0.113.9 GET /static/app.css 304 2ms",
  "2026-03-14T09:12:47 192.0.2.71 GET /bread/sourdough 200 42ms",
  "2026-03-14T09:12:51 198.51.100.5 GET /wp-login.php 404 5ms",
  "2026-03-14T09:12:55 203.0.113.44 GET /menu 200 43ms",
  "2026-03-14T09:12:58 192.0.2.71 GET /bread/rye 200 39ms",
];

export const FIELDS = {
  path: { n: 4, label: "path" },
  ip: { n: 2, label: "client IP" },
  status: { n: 5, label: "status" },
};

export function parseLines(text) {
  return text.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
}

/** awk '{print $n}': split on runs of whitespace, 1-based field index. Missing fields print an empty line. */
export function awkField(lines, n) {
  return lines.map((l) => l.trim().split(/\s+/)[n - 1] ?? "");
}

/** sort with LC_ALL=C: plain byte (code unit) order. */
export function sortLines(lines) {
  return [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** uniq -c: collapse adjacent equal lines into "count line". Only adjacent duplicates are merged. */
export function uniqCount(lines) {
  const out = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.text === l) last.count++;
    else out.push({ text: l, count: 1 });
  }
  return out.map((r) => `${String(r.count).padStart(7)} ${r.text}`);
}

/** sort -rn: numeric by leading number, descending. Ties fall back to whole-line comparison, also reversed. */
export function sortRevNumeric(lines) {
  const num = (l) => { const m = l.match(/^\s*(-?\d+(\.\d+)?)/); return m ? +m[1] : 0; };
  return [...lines].sort((a, b) => num(b) - num(a) || (a < b ? 1 : a > b ? -1 : 0));
}

export function head(lines, n) { return lines.slice(0, n); }

/** Run the whole pipeline and keep every intermediate output. */
export function runPipeline(lines, fieldN, headN = 5) {
  const stages = [];
  const add = (id, cmd, out) => stages.push({ id, cmd, out });
  add("cat", "cat access.log", [...lines]);
  const f = awkField(lines, fieldN);
  add("awk", `awk '{print $${fieldN}}'`, f);
  const s = sortLines(f);
  add("sort", "sort", s);
  const u = uniqCount(s);
  add("uniq", "uniq -c", u);
  const r = sortRevNumeric(u);
  add("sortn", "sort -rn", r);
  add("head", `head -n ${headN}`, head(r, headN));
  return stages;
}
