// Chapter 11, lesson 3: windowed counting over a stream with delayed events and a watermark.
// Times are in seconds. t = event time, a = arrival at the processor, p = processing time.
import { rng, normal } from "../charts.js";

export const OUTAGE = [50, 72];

/**
 * Gate scans at a stadium. Base event times and ordinary delays are fixed by the seed;
 * `lateShare` decides which events are very late (a scanner that lost its connection),
 * so dragging that slider changes lateness without reshuffling everything else.
 */
export function genEvents({ seed = 5, duration = 120, lateShare = 0.1, outage = false } = {}) {
  const r = rng(seed);
  const events = [];
  let t = 0.3;
  while (t < duration) {
    // busy around kickoff and half time, quiet gap in between
    const busy = (t > 8 && t < 30) || (t > 82 && t < 104);
    const quiet = t > 62 && t < 74;
    const rate = quiet ? 0.12 : busy ? 1.6 : 0.8;
    t += -Math.log(1 - r()) / rate;
    if (t >= duration) break;
    const base = 0.4 + Math.abs(normal(r)) * 1.1;
    const u = r(), lateDelay = 14 + r() * 34;
    events.push({ id: events.length, t, delay: u < lateShare ? lateDelay : base, veryLate: u < lateShare });
  }
  for (const e of events) e.a = e.t + e.delay;
  const byArrival = [...events].sort((x, y) => x.a - y.a);
  let prev = 0;
  for (const e of byArrival) {
    if (outage && e.a >= OUTAGE[0] && e.a < OUTAGE[1]) e.p = Math.max(OUTAGE[1], prev + 0.08);
    else e.p = Math.max(e.a, prev + 0.02);
    prev = e.p;
  }
  return events;
}

/** Windows that contain time x. hop is used by hopping and sliding windows. */
export function assign(type, x, size, hop) {
  if (type === "tumbling") { const s = Math.floor(x / size) * size; return [[s, s + size]]; }
  const out = [];
  for (let k = Math.max(0, Math.floor((x - size) / hop) + 1); k * hop <= x + 1e-9; k++) {
    const s = k * hop;
    if (s + size > x) out.push([s, s + size]);
  }
  return out;
}

export function hopFor(type, size) { return type === "hopping" ? size / 2 : type === "sliding" ? 1 : size; }

/**
 * Run the windowed count up to processing time `until`.
 * opts: { type, size, gap, lag, policy: "drop" | "correct", by: "event" | "processing", end }
 * Returns windows (with first emitted count, corrections, drops), per-event status, and the watermark.
 */
export function run(events, opts, until = Infinity) {
  const { type, size, gap, lag, policy, by } = opts;
  const hop = hopFor(type, size);
  const key = (e) => (by === "event" ? e.t : e.p);
  const order = events.filter((e) => e.p <= until).sort((x, y) => x.p - y.p);
  const status = new Map(); // id -> "ok" | "dropped" | "corr"
  let maxT = -Infinity, wm = -Infinity;
  const windows = new Map();
  const sessions = [];
  const mark = (e, s) => { const cur = status.get(e.id); if (!cur || cur === "ok" || (cur === "dropped" && s === "corr")) status.set(e.id, s); };

  const emitReady = (now) => {
    if (type === "session") {
      for (const s of sessions) if (!s.emitted && s.end + gap <= wm) { s.emitted = true; s.emittedAt = by === "processing" ? s.end + gap : now; s.first = s.count; }
    } else {
      for (const w of windows.values()) if (!w.emitted && w.end <= wm) { w.emitted = true; w.emittedAt = by === "processing" ? w.end : now; w.first = w.count; }
    }
  };

  for (const e of order) {
    const x = key(e);
    if (by === "processing") { wm = e.p; emitReady(e.p); }
    if (type === "session") {
      const touch = sessions.filter((s) => x >= s.start - gap && x <= s.end + gap);
      if (!touch.length) {
        sessions.push({ start: x, end: x, count: 1, emitted: false, corrections: 0, dropped: 0 });
        mark(e, "ok");
      } else if (touch.some((s) => s.emitted) && policy === "drop") {
        touch.find((s) => s.emitted).dropped++;
        mark(e, "dropped");
      } else {
        const late = touch.some((s) => s.emitted);
        const m = touch[0];
        for (const s of touch.slice(1)) {
          m.start = Math.min(m.start, s.start); m.end = Math.max(m.end, s.end);
          m.count += s.count; m.corrections += s.corrections; m.dropped += s.dropped;
          if (s.emitted) { m.emitted = true; m.first = (m.first || 0) + s.first; m.emittedAt = Math.min(m.emittedAt ?? Infinity, s.emittedAt); }
          sessions.splice(sessions.indexOf(s), 1);
        }
        m.start = Math.min(m.start, x); m.end = Math.max(m.end, x);
        m.count++;
        if (late) { m.corrections++; mark(e, "corr"); } else mark(e, "ok");
      }
    } else {
      for (const [s, en] of assign(type, x, size, hop)) {
        const k = s.toFixed(3);
        let w = windows.get(k);
        if (!w) { w = { start: s, end: en, count: 0, emitted: false, corrections: 0, dropped: 0 }; windows.set(k, w); }
        if (w.emitted && policy === "drop") { w.dropped++; mark(e, "dropped"); }
        else if (w.emitted) { w.count++; w.corrections++; mark(e, "corr"); }
        else { w.count++; mark(e, "ok"); }
      }
    }
    if (by === "event") { maxT = Math.max(maxT, e.t); wm = maxT - lag; emitReady(e.p); }
  }
  // Time keeps moving even without events: processing-time windows close on the clock.
  if (by === "processing" && Number.isFinite(until)) { wm = until; emitReady(until); }
  const finished = until >= (opts.end ?? Infinity);
  if (finished) { // end of input: flush everything still open
    wm = Infinity;
    const at = opts.end;
    if (type === "session") for (const s of sessions) { if (!s.emitted) { s.emitted = true; s.emittedAt = at; s.first = s.count; s.atEnd = true; } }
    else for (const w of windows.values()) if (!w.emitted) { w.emitted = true; w.emittedAt = at; w.first = w.count; w.atEnd = true; }
  }

  const list = type === "session" ? sessions.sort((a, b) => a.start - b.start) : [...windows.values()].sort((a, b) => a.start - b.start);
  return { windows: list, status, watermark: by === "event" ? (finished ? maxT : wm) : until, processed: order.length };
}

/** Ground truth: every event counted in its event-time window, with nothing late. */
export function truth(events, { type, size, gap }) {
  const hop = hopFor(type, size);
  if (type === "session") {
    const ts = events.map((e) => e.t).sort((a, b) => a - b);
    const out = [];
    for (const t of ts) {
      const last = out[out.length - 1];
      if (last && t - last.end <= gap) { last.end = t; last.count++; } else out.push({ start: t, end: t, count: 1 });
    }
    return out;
  }
  const m = new Map();
  for (const e of events) for (const [s, en] of assign(type, e.t, size, hop)) {
    const k = s.toFixed(3);
    if (!m.has(k)) m.set(k, { start: s, end: en, count: 0 });
    m.get(k).count++;
  }
  return m;
}
