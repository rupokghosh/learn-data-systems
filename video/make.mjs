// First-look video for Learn Data Systems: one continuous browsing session.
//
// Rendered frame by frame, not recorded live. The `timeweb` library takes over the page's
// clock (timers, requestAnimationFrame, CSS transitions and animations), so for every output
// frame we advance virtual time by exactly 1/60 s and take a 4K screenshot. Each frame is
// drawn fresh at its exact zoom level, so text stays sharp while the camera moves, and motion
// is perfectly even no matter how long a screenshot takes. Frames are then encoded to H.264
// inside Chrome (WebCodecs + mp4-muxer): a 1080p file supersampled from 4K, and a 4K master.
//
//   node make.mjs                 render every segment, then encode
//   node make.mjs --only=btree    render one segment only (no encode)
//   node make.mjs --encode-only   re-encode from frames already on disk
//   node make.mjs --dark          film the dark theme instead of light
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:4321";
const VW = 1920, VH = 1080;      // layout viewport, in CSS pixels
const DSF = 2;                   // screenshots come out at 3840x2160
const FPS = 60, FRAME_MS = 1000 / FPS;
const BASE_ZOOM = 1.5;           // the page is laid out 1280 wide and magnified 1.5x by the camera
const args = process.argv.slice(2);
const ONLY = args.find((a) => a.startsWith("--only="))?.slice(7);
const ENCODE_ONLY = args.includes("--encode-only");
const LIGHT = !args.includes("--dark");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEWEB = fs.readFileSync(path.join(DIR, "node_modules/timeweb/dist/timeweb.js"), "utf8");

/* ------------------------------------------------------- in-page helpers */
// A tap indicator (a ring that glides and ripples), smooth scrolling, and a camera on <body>.
// Scroll and camera moves are driven from requestAnimationFrame, so they follow virtual time
// and the body gets a plain static transform on every frame (which Chrome redraws sharply).
const HELPERS = `
(() => {
  const css = document.createElement("style");
  css.textContent = \`
    html { overflow-x: hidden; }
    body { transform-origin: 0 0; }
    #__cur { position: fixed; left: 0; top: 0; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%; z-index: 2147483000; pointer-events: none;
             border: 2.5px solid ${LIGHT ? "rgba(20,20,20,.8)" : "rgba(255,255,255,.9)"}; background: ${LIGHT ? "rgba(20,20,20,.12)" : "rgba(255,255,255,.14)"};
             transition: transform 420ms cubic-bezier(0.77, 0, 0.175, 1); }
    #__cur::after { content: ""; position: absolute; inset: -2.5px; border-radius: 50%; border: 2.5px solid ${LIGHT ? "rgba(20,20,20,.65)" : "rgba(255,255,255,.8)"}; opacity: 0; }
    #__cur.tap { background: ${LIGHT ? "rgba(20,20,20,.28)" : "rgba(255,255,255,.3)"}; }
    #__cur.tap::after { animation: __rip 420ms cubic-bezier(0.23, 1, 0.32, 1); }
    @keyframes __rip { from { opacity: .9; transform: scale(1); } to { opacity: 0; transform: scale(2.3); } }
  \`;
  document.head.appendChild(css);
  const cur = document.createElement("div");
  cur.id = "__cur";
  document.documentElement.appendChild(cur);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);   // ease-in-out cubic
  const body = document.body;
  // Lay the page out 1280 wide and let the camera magnify it to fill the 1920 frame.
  body.style.width = innerWidth / ${BASE_ZOOM} + "px";
  body.style.transform = "scale(${BASE_ZOOM})";
  let camRun = 0, scrollRun = 0;
  const v = (window.__v = {
    cam: { k: ${BASE_ZOOM}, tx: 0, ty: 0 },
    place(x, y) { cur.style.transition = "none"; cur.style.transform = "translate(" + x + "px," + y + "px)"; void cur.offsetWidth; cur.style.transition = ""; },
    moveTo(el) { const r = el.getBoundingClientRect(); cur.style.transform = "translate(" + (r.left + r.width / 2) + "px," + (r.top + r.height / 2) + "px)"; },
    tap(el) { cur.classList.remove("tap"); void cur.offsetWidth; cur.classList.add("tap"); setTimeout(() => cur.classList.remove("tap"), 300); if (el) el.click(); },
    cursor() { const r = cur.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; },
    // Starts a scroll and returns at once; the motion plays out over the following frames.
    scrollTo(y, ms) {
      const run = ++scrollRun, y0 = scrollY, t0 = performance.now();
      const step = () => { if (run !== scrollRun) return; const p = Math.min(1, (performance.now() - t0) / ms); scrollTo(0, y0 + (y - y0) * ease(p)); if (p < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    },
    // Union rectangle of a figure's children from index a to b (inclusive), in viewport coordinates.
    region(figSel, a, b) {
      const kids = [...document.querySelector(figSel).children].slice(a, b + 1).filter((k) => k.offsetParent !== null);
      const rs = kids.map((k) => k.getBoundingClientRect());
      const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top));
      const rr = Math.max(...rs.map((r) => r.right)), bb = Math.max(...rs.map((r) => r.bottom));
      return { x: l, y: t, w: rr - l, h: bb - t };
    },
    camTo(target, ms) {
      const run = ++camRun, from = { ...v.cam }, t0 = performance.now();
      const apply = (c) => { v.cam = c; body.style.transform = "translate(" + c.tx + "px," + c.ty + "px) scale(" + c.k + ")"; };
      if (!ms) return apply(target);
      const step = () => {
        if (run !== camRun) return;
        const p = Math.min(1, (performance.now() - t0) / ms), e = ease(p);
        apply({ k: from.k + (target.k - from.k) * e, tx: from.tx + (target.tx - from.tx) * e, ty: from.ty + (target.ty - from.ty) * e });
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    // Move the camera so the given on-screen rectangle fills the frame.
    zoom(rect, ms, pad) {
      const vw = innerWidth, vh = innerHeight, c = v.cam;
      // Convert the on-screen rectangle back to layout coordinates under the current camera.
      const lw = rect.w / c.k, lh = rect.h / c.k;
      const lcx = (rect.x - c.tx) / c.k + lw / 2, lcy = (rect.y + scrollY - c.ty) / c.k + lh / 2;
      const k = Math.min((vw - pad * 2) / lw, (vh - pad * 2) / lh, 3.4);
      v.camTo({ k, tx: vw / 2 - lcx * k, ty: vh / 2 + scrollY - lcy * k }, ms);
    },
    zoomOut(ms) { v.camTo({ k: ${BASE_ZOOM}, tx: 0, ty: 0 }, ms); },
    find(figSel, text) {
      return [...document.querySelector(figSel).querySelectorAll("button, label.btn")].find((b) => b.textContent.trim().startsWith(text) && b.offsetParent !== null);
    },
  });
})();
`;

/* --------------------------------------------------------------- segments */
const ZOOM_MS = 1100;      // camera move into a widget
const DISSOLVE_MS = 180;   // a page load: just long enough to soften the swap

// Each action runs in the page when the segment's clock reaches `t` ms. Actions only *start*
// things (a scroll, a camera move, a tap); the motion then plays out frame by frame.
const act = (t, fn, ...args) => ({ t, fn, args });
const tapButton = (t, fig, text) => [
  act(t - 440, (fig, text) => { window.__t = __v.find(fig, text); __v.moveTo(window.__t); }, fig, text),
  act(t, () => __v.tap(window.__t)),
];
// Page offset that puts an index row a little below the middle of the frame.
const rowTop = (href) => `(() => { const a = document.querySelector('a[href="${href}"]'); window.__a = a; return a.getBoundingClientRect().top + scrollY - innerHeight * 0.55; })()`;
const tapRow = (tMove, tTap) => [
  act(tMove, () => __v.moveTo(window.__a.querySelector(".t"))),
  act(tTap, () => { __v.tap(); window.__a.querySelector(".t").style.textDecoration = "underline"; }),
];

// One continuous browsing session. Every scene change follows a tap:
//   index -> tap "B-trees" -> lesson -> back to the index -> tap "Fault-tolerant consensus" -> lesson.
const SEGMENTS = [
  {
    name: "home", url: "/", dur: 3300,
    setup: async ({ ev }) => ev(() => __v.place(1350, 640)),
    actions: [
      act(300, (y) => __v.scrollTo(eval(y), 1700), rowTop("/lessons/b-trees.html")),
      ...tapRow(2150, 2650),
    ],
  },
  {
    name: "btree", url: "/lessons/b-trees.html", dur: 5200,
    actions: [
      // The lesson opens at the top. Scroll to the tree, ease in, split some pages, ease back out.
      act(250, () => __v.scrollTo(document.querySelector("#btree").getBoundingClientRect().top + scrollY - 230, 950)),
      act(1300, (ms) => __v.zoom(__v.region("#btree", 2, 4), ms, 90), ZOOM_MS),
      ...tapButton(2800, "#btree", "Insert 5 random"),
      ...tapButton(3600, "#btree", "Insert 5 random"),
      act(4350, () => __v.zoomOut(800)),
    ],
  },
  {
    name: "index", url: "/", dur: 2700,
    // Back on the index, exactly where we left it.
    setup: async ({ ev }) => ev((y) => scrollTo(0, eval(y)), rowTop("/lessons/b-trees.html")),
    actions: [
      // Keep scrolling through Part II to Chapter 9 and tap the consensus lesson.
      act(250, (y) => __v.scrollTo(eval(y), 1500), rowTop("/lessons/consensus.html")),
      ...tapRow(1800, 2300),
    ],
  },
  {
    name: "raft", url: "/lessons/consensus.html", dur: 5400,
    setup: async ({ ev, advance }) => {
      const hasLeader = () => ev(() => [...document.querySelectorAll("#raft button")].some((b) => /\(leader/.test(b.textContent)));
      // The simulation only runs while it is on screen. Let it elect a leader first,
      // then go back to the top so the lesson opens the way a reader would see it.
      await ev(() => scrollTo(0, document.querySelector("#raft").getBoundingClientRect().top + scrollY - 150));
      await sleep(200);
      await ev(() => { const s = document.querySelector("#rf-speed"); s.value = s.max; s.dispatchEvent(new Event("input", { bubbles: true })); });
      for (let i = 0; i < 100 && !(await hasLeader()); i++) await advance(250);
      await advance(400);
      console.log("  raft has a leader before filming:", await hasLeader());
      await ev(() => scrollTo(0, 0));
      await sleep(200);
    },
    actions: [
      // Lesson top, scroll to the cluster, ease in, then cut the network.
      act(250, () => __v.scrollTo(document.querySelector("#raft").getBoundingClientRect().top + scrollY - 150, 950)),
      act(1300, (ms) => __v.zoom(__v.region("#raft", 3, 6), ms, 60), ZOOM_MS),
      ...tapButton(2750, "#raft", "Isolate the leader"),
    ],
  },
];

/* -------------------------------------------------------------- rendering */
let lastCursor = null;
async function renderSegment(browser, seg) {
  const page = await browser.newPage();
  await page.setViewport({ width: VW, height: VH, deviceScaleFactor: DSF });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: LIGHT ? "light" : "dark" }, { name: "prefers-reduced-motion", value: "no-preference" }]);
  await page.evaluateOnNewDocument(TIMEWEB);          // take over the clock before any page script runs
  await page.goto(BASE + seg.url, { waitUntil: "networkidle0" });
  await page.evaluate(() => { try { localStorage.removeItem("lds-read-v1"); } catch {} });
  await page.addScriptTag({ content: HELPERS });
  await page.evaluate(() => document.fonts.ready);
  const ev = (fn, ...a) => page.evaluate(fn, ...a);

  // Virtual clock for this page. `advance` runs time forward one frame at a time without filming.
  let vt = 0;
  const tick = async () => { vt += FRAME_MS; await ev((ms) => timeweb.goTo(ms), vt); };
  const advance = async (ms) => { for (let n = Math.round(ms / FRAME_MS); n > 0; n--) await tick(); };

  await advance(300);                                  // let widgets finish their first render
  if (lastCursor) await ev((p) => __v.place(p[0], p[1]), lastCursor);   // the pointer stays put across a page load
  if (seg.setup) await seg.setup({ ev, advance, page });
  await advance(100);

  const outDir = path.join(DIR, "frames", seg.name);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const queue = [...seg.actions].sort((a, b) => a.t - b.t);
  const total = Math.round((seg.dur / 1000) * FPS);
  const started = Date.now();
  for (let i = 0; i < total; i++) {
    const t = i * FRAME_MS;
    while (queue.length && queue[0].t <= t) { const a = queue.shift(); await ev(a.fn, ...a.args); }
    await tick();
    await page.screenshot({ path: path.join(outDir, `f${String(i).padStart(5, "0")}.png`), type: "png", optimizeForSpeed: true });
  }
  lastCursor = await ev(() => __v.cursor());
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({ name: seg.name, dur: seg.dur, count: total }));
  console.log(`  ${seg.name}: ${total} frames rendered in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  await page.close();
}

/* -------------------------------------------------------------- encoding */
function buildTimeline(names) {
  const per = names.map((name) => {
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, "frames", name, "meta.json"), "utf8"));
    return Array.from({ length: meta.count }, (_, i) => `/video/frames/${name}/f${String(i).padStart(5, "0")}.png`);
  });
  // Join them: an entry is either a URL, or [fromUrl, toUrl, mix] during a dissolve.
  const X = Math.round((DISSOLVE_MS / 1000) * FPS);
  const smooth = (t) => t * t * (3 - 2 * t);
  const list = [];
  per.forEach((urls, k) => {
    const head = k > 0 ? X : 0;                    // already used by the previous dissolve
    const tail = k < per.length - 1 ? X : 0;
    for (let i = head; i < urls.length - tail; i++) list.push(urls[i]);
    if (tail) {
      const next = per[k + 1];
      for (let i = 0; i < X; i++) list.push([urls[urls.length - X + i], next[i], smooth((i + 1) / (X + 1))]);
    }
  });
  return list;
}

async function encode(browser, names, { width, height, bitrate, codec, file }) {
  const list = buildTimeline(names);
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) console.log("  page error:", m.text()); });
  await page.goto(`${BASE}/video/encode.html`, { waitUntil: "networkidle0" });
  const ok = await page.evaluate((c) => VideoEncoder.isConfigSupported(c).then((r) => r.supported), { codec, width, height, bitrate, framerate: FPS });
  if (!ok) { console.log(`  skipping ${file}: this Chrome cannot encode ${width}x${height} ${codec}`); await page.close(); return; }
  console.log(`encoding ${file}: ${list.length} frames (${(list.length / FPS).toFixed(1)}s) at ${width}x${height}`);
  const size = await page.evaluate((list, o) => window.encodeVideo(list, o), list, { fps: FPS, width, height, bitrate, codec });
  fs.mkdirSync(path.join(DIR, "out"), { recursive: true });
  const out = path.join(DIR, "out", file);
  const fd = fs.openSync(out, "w");
  const CHUNK = 3 * 1024 * 1024;
  for (let off = 0; off < size; off += CHUNK) {
    const b64 = await page.evaluate((off, n) => window.readChunk(off, n), off, CHUNK);
    fs.writeSync(fd, Buffer.from(b64, "base64"));
  }
  fs.closeSync(fd);
  await page.close();
  console.log(`  wrote ${out} (${(size / 1e6).toFixed(1)} MB)`);
}

/* ------------------------------------------------------------------ main */
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  protocolTimeout: 30 * 60 * 1000,
  args: ["--hide-scrollbars", "--force-color-profile=srgb", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
});
try {
  const segs = ONLY ? SEGMENTS.filter((s) => s.name === ONLY) : SEGMENTS;
  if (!ENCODE_ONLY) for (const s of segs) await renderSegment(browser, s);
  if (!ONLY) {
    const names = SEGMENTS.map((s) => s.name);
    const suffix = LIGHT ? "" : "-dark";
    // 1080p, supersampled from the 4K frames: the one to post.
    await encode(browser, names, { width: 1920, height: 1080, bitrate: 20_000_000, codec: "avc1.64002a", file: `trailer${suffix}.mp4` });
    // 4K master, for anywhere that accepts it.
    await encode(browser, names, { width: 3840, height: 2160, bitrate: 50_000_000, codec: "avc1.640034", file: `trailer${suffix}-4k.mp4` });
  }
} finally {
  await browser.close();
}
