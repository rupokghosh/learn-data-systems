// Shared page chrome: top bar, outline (table of contents), previous/next links.

const REPO = "https://github.com/rupokghosh/learn-data-systems";

export const CHAPTERS = [
  {
    n: 1, part: "I", title: "Reliable, Scalable, and Maintainable Applications", sub: "What it means for a data system to work well, and how to measure it.",
    lessons: [
      { slug: "data-intensive", title: "What makes an application data-intensive?", desc: "Follow one request through a cache, a database, and a search index." },
      { slug: "reliability", title: "Reliability: when things go wrong", desc: "A year of disk failures, and why one bug can beat every replica." },
      { slug: "describing-load", title: "Describing load: the timeline problem", desc: "Fan-out on read or on write, and what one celebrity does to both." },
      { slug: "percentiles", title: "Describing performance: percentiles", desc: "Why the mean lies, and how one slow backend slows every page." },
      { slug: "coping-with-load", title: "Coping with load", desc: "Response time against utilization, and scaling up versus out." },
      { slug: "maintainability", title: "Maintainability", desc: "Operability, simplicity, evolvability, and what one line of SQL hides." },
    ],
  },
  {
    n: 2, part: "I", title: "Data Models and Query Languages", sub: "The shape you give your data decides which questions are easy to ask.",
    lessons: [
      { slug: "relational-vs-document", title: "Relational and document models", desc: "One profile stored two ways, and what each costs to read." },
      { slug: "normalization", title: "Many-to-one, many-to-many, and normalization", desc: "Rename one region and count the writes. Then change the schema." },
      { slug: "query-languages", title: "Declarative and imperative queries", desc: "Say what you want, not how to get it, and let the database plan." },
      { slug: "graph-models", title: "Graph-like data models", desc: "Vertices, edges, and a query that walks a path of any length." },
    ],
  },
  {
    n: 3, part: "I", title: "Storage and Retrieval", sub: "How a database lays bytes on disk so it can find them again.",
    lessons: [
      { slug: "log-and-hash-index", title: "The log and the hash index", desc: "Build the simplest database, then make reads fast and keep the disk small." },
      { slug: "lsm-trees", title: "SSTables and LSM-trees", desc: "Sorted segments, a memtable, compaction, and Bloom filters." },
      { slug: "b-trees", title: "B-trees", desc: "Fixed-size pages, page splits, and a tree four levels deep." },
      { slug: "lsm-vs-btree", title: "Comparing B-trees and LSM-trees", desc: "Run the same workload through both and count the bytes." },
      { slug: "column-storage", title: "Analytics and column storage", desc: "Read only the columns you need, then compress them." },
    ],
  },
];

// Part I (continued), Part II, and Part III.
CHAPTERS.push(
  {
    n: 4, part: "I", title: "Encoding and Evolution", sub: "How data stays readable while the code that reads and writes it keeps changing.",
    lessons: [
      { slug: "encoding-formats", title: "Formats for encoding data", desc: "The same record as JSON and as binary, byte by byte." },
      { slug: "thrift-protobuf-avro", title: "Thrift, Protocol Buffers, and Avro", desc: "Field tags, writer and reader schemas, and why the bytes shrink." },
      { slug: "schema-evolution", title: "Forward and backward compatibility", desc: "Change a schema and see which old and new readers still work." },
      { slug: "dataflow-modes", title: "Modes of dataflow", desc: "Data that flows through databases, services, and message brokers." },
    ],
  },
  {
    n: 5, part: "II", title: "Replication", sub: "Keeping copies of the same data on several machines, and what goes wrong.",
    lessons: [
      { slug: "leaders-and-followers", title: "Leaders and followers", desc: "Synchronous and asynchronous replication, new followers, and failover." },
      { slug: "replication-lag", title: "Problems with replication lag", desc: "Read your own writes, monotonic reads, and consistent prefix reads." },
      { slug: "multi-leader", title: "Multi-leader replication", desc: "Several data centres accepting writes, and resolving the conflicts." },
      { slug: "leaderless", title: "Leaderless replication and quorums", desc: "Pick n, w, and r, then fail some nodes and watch the reads." },
      { slug: "concurrent-writes", title: "Detecting concurrent writes", desc: "Happens-before, last write wins, and version vectors." },
    ],
  },
  {
    n: 6, part: "II", title: "Partitioning", sub: "Splitting a dataset that is too big for one machine across many.",
    lessons: [
      { slug: "partitioning-key-value", title: "Partitioning key-value data", desc: "Key ranges, hashes, and the hot spot one popular key creates." },
      { slug: "secondary-indexes", title: "Partitioning and secondary indexes", desc: "Local indexes that scatter reads, global indexes that scatter writes." },
      { slug: "rebalancing", title: "Rebalancing partitions", desc: "Add a node and count how many keys move under each strategy." },
      { slug: "request-routing", title: "Request routing", desc: "How a request finds the node that holds its key." },
    ],
  },
  {
    n: 7, part: "II", title: "Transactions", sub: "Grouping reads and writes so they succeed or fail together, safely.",
    lessons: [
      { slug: "acid", title: "The meaning of ACID", desc: "Atomicity, consistency, isolation, and durability, without the marketing." },
      { slug: "read-committed-snapshot", title: "Read committed and snapshot isolation", desc: "Dirty reads, read skew, and multi-version concurrency control." },
      { slug: "lost-updates-write-skew", title: "Lost updates, write skew, and phantoms", desc: "Interleave two transactions and watch an invariant break." },
      { slug: "serializability", title: "Serializability", desc: "Serial execution, two-phase locking, and serializable snapshot isolation." },
    ],
  },
  {
    n: 8, part: "II", title: "The Trouble with Distributed Systems", sub: "Partial failures, unreliable networks, and clocks you cannot trust.",
    lessons: [
      { slug: "unreliable-networks", title: "Faults and unreliable networks", desc: "Lost, delayed, and duplicated messages, and choosing a timeout." },
      { slug: "unreliable-clocks", title: "Unreliable clocks", desc: "Clock skew, last write wins, and the process that paused mid-thought." },
      { slug: "knowledge-truth-lies", title: "Knowledge, truth, and lies", desc: "Majorities, leases, fencing tokens, and Byzantine faults." },
    ],
  },
  {
    n: 9, part: "II", title: "Consistency and Consensus", sub: "The strongest guarantees a distributed system can give, and their cost.",
    lessons: [
      { slug: "linearizability", title: "Linearizability", desc: "Draw operations on a timeline and check whether they could be atomic." },
      { slug: "ordering-guarantees", title: "Ordering guarantees", desc: "Causality, Lamport timestamps, and total order broadcast." },
      { slug: "two-phase-commit", title: "Distributed transactions and two-phase commit", desc: "Crash the coordinator at each step and see who is left in doubt." },
      { slug: "consensus", title: "Fault-tolerant consensus", desc: "Leader election, quorums, and coordination services." },
    ],
  },
  {
    n: 10, part: "III", title: "Batch Processing", sub: "Turning large inputs into derived outputs, from Unix pipes to dataflow engines.",
    lessons: [
      { slug: "unix-tools", title: "Batch processing with Unix tools", desc: "A log analysis pipeline, and the ideas that make pipes composable." },
      { slug: "mapreduce", title: "MapReduce and distributed filesystems", desc: "Map, shuffle, sort, and reduce across a cluster." },
      { slug: "batch-joins", title: "Joins in batch processing", desc: "Sort-merge, broadcast hash, and partitioned hash joins, and skew." },
      { slug: "beyond-mapreduce", title: "Beyond MapReduce", desc: "Dataflow engines, materialization, and iterative graph processing." },
    ],
  },
  {
    n: 11, part: "III", title: "Stream Processing", sub: "Processing unbounded data as it arrives.",
    lessons: [
      { slug: "message-brokers", title: "Transmitting event streams", desc: "Message brokers, log-based brokers, consumer offsets, and replay." },
      { slug: "change-data-capture", title: "Databases and streams", desc: "Change data capture, event sourcing, and keeping systems in sync." },
      { slug: "stream-time-windows", title: "Reasoning about time", desc: "Event time, processing time, windows, and late events." },
      { slug: "stream-joins-fault-tolerance", title: "Stream joins and fault tolerance", desc: "Joining streams and tables, and getting exactly-once effects." },
    ],
  },
  {
    n: 12, part: "III", title: "The Future of Data Systems", sub: "Composing data systems from derived data, correctly and responsibly.",
    lessons: [
      { slug: "data-integration", title: "Data integration", desc: "Systems of record, derived data, and combining batch with streams." },
      { slug: "unbundling-databases", title: "Unbundling databases", desc: "Treating indexes, caches, and views as dataflow you control." },
      { slug: "aiming-for-correctness", title: "Aiming for correctness", desc: "The end-to-end argument, constraints, and integrity over timeliness." },
      { slug: "doing-the-right-thing", title: "Doing the right thing", desc: "Predictive analytics, privacy, and responsibility for data." },
    ],
  },
);

// The three parts of the book (1st edition), in order.
export const PARTS = [
  { n: "I", title: "Foundations of Data Systems" },
  { n: "II", title: "Distributed Data" },
  { n: "III", title: "Derived Data" },
].map((p) => ({ ...p, chapters: CHAPTERS.filter((c) => c.part === p.n) }));

export const ALL = CHAPTERS.flatMap((c) => c.lessons.map((l, i) => ({ ...l, chapter: c, index: i })));

/* ---------- Read tracking (stored in this browser only) ---------- */
const READ_KEY = "lds-read-v1";
function loadRead() { try { return JSON.parse(localStorage.getItem(READ_KEY)) || {}; } catch { return {}; } }
export function isRead(slug) { return !!loadRead()[slug]; }
export function setRead(slug, value) {
  const r = loadRead();
  if (value) r[slug] = Date.now(); else delete r[slug];
  try { localStorage.setItem(READ_KEY, JSON.stringify(r)); } catch { /* storage unavailable: tracking is best effort */ }
}
// How much of a list of lessons has been read: { read, total, pct }. Defaults to the whole course.
export function progress(lessons = ALL) {
  const read = lessons.filter((l) => isRead(l.slug)).length;
  const total = lessons.length;
  return { read, total, pct: total ? Math.round((read / total) * 100) : 0 };
}
// A thin bar and a label, used on the home page and at the end of each lesson.
export function progressBar(pct, label) {
  return `<span class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${label}"><span style="width:${pct}%"></span></span>`;
}
// The site can live at a domain root or under a path (rupokghosh.com/…), so build
// links from where this script was loaded rather than from "/".
const ROOT = new URL("../", import.meta.url).pathname;
const href = (slug) => `${ROOT}lessons/${slug}.html`;
const currentSlug = document.body.dataset.lesson || null;
const current = ALL.find((l) => l.slug === currentSlug);

function buildTopbar() {
  const bar = document.querySelector(".topbar");
  if (!bar) return;
  bar.innerHTML = `
    <a class="wordmark" href="${ROOT}"><svg viewBox="0 0 18 14" aria-hidden="true"><rect x="0" y="0" width="5" height="14" rx="1" style="fill:var(--ink-4)"/><rect x="6.5" y="0" width="5" height="14" rx="1" style="fill:var(--ink-3)"/><rect x="13" y="0" width="5" height="14" rx="1" style="fill:var(--accent)"/></svg>Learn Data Systems</a>
    <nav class="topnav"><a href="${ROOT}">Chapters</a><a href="https://dataintensive.net" target="_blank" rel="noopener">The book</a></nav>`;
}

function buildByline() {
  if (!current) return;
  const head = document.querySelector(".post-head");
  if (!head || head.querySelector(".byline")) return;
  const part = PARTS.find((p) => p.n === current.chapter.part);
  head.insertAdjacentHTML("beforeend",
    `<p class="byline">Chapter ${current.chapter.n} · ${current.chapter.title}</p>
     <p class="byline">Part ${part.n}: ${part.title} · Lesson ${current.index + 1} of ${current.chapter.lessons.length}</p>`);
  document.title = `${current.title} · Learn Data Systems`;
}

function buildToc() {
  const toc = document.querySelector(".toc");
  const heads = [...document.querySelectorAll(".post h2")];
  if (!toc || heads.length < 2) return;
  // Give each heading an id for its outline link, but never one already on the page:
  // widget scripts find their figure by id, and a heading must not take it first.
  heads.forEach((h, i) => {
    if (h.id) return;
    const base = h.textContent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `s${i}`;
    let id = base;
    for (let k = 2; document.getElementById(id); k++) id = `${base}-${k}`;
    h.id = id;
  });
  toc.innerHTML = `<div class="toc-inner"><ul>${heads.map((h) => `<li><a href="#${h.id}">${h.textContent}</a></li>`).join("")}</ul></div>`;
  const links = [...toc.querySelectorAll("a")];
  const spy = () => {
    let idx = 0;
    heads.forEach((h, i) => { if (h.getBoundingClientRect().top < 120) idx = i; });
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 8) idx = heads.length - 1;
    links.forEach((a, i) => a.classList.toggle("active", i === idx));
  };
  addEventListener("scroll", spy, { passive: true });
  spy();
}

function buildFooter() {
  const foot = document.querySelector(".post-foot");
  if (!foot || !current) return;
  const i = ALL.indexOf(current);
  const prev = ALL[i - 1], next = ALL[i + 1];
  foot.innerHTML = `
    ${prev ? `<a href="${href(prev.slug)}"><small>Previous</small><span>${prev.title}</span></a>` : `<a href="${ROOT}"><small>Back to</small><span>All chapters</span></a>`}
    ${next ? `<a class="next" href="${href(next.slug)}"><small>Next${next.chapter !== current.chapter ? ` · Chapter ${next.chapter.n}` : ""}</small><span>${next.title}</span></a>` : ""}`;
}

function buildReadStatus() {
  const foot = document.querySelector(".post-foot");
  if (!foot || !current) return;
  const row = document.createElement("div");
  row.className = "read-status";
  foot.before(row);
  const paint = () => {
    const read = isRead(current.slug);
    const all = progress();
    const ch = progress(current.chapter.lessons);
    row.innerHTML = `
      <div class="read-row">${read
        ? `<span class="is-read">You have read this lesson</span><button class="link-btn" data-unread>Mark as unread</button>`
        : `<span>Reach the end to mark this lesson as read</span><button class="link-btn" data-read>Mark as read</button>`}</div>
      <div class="read-progress">
        <span class="read-progress-label"><a href="${ROOT}#chapters">Course progress</a><b>${all.pct}%</b></span>
        ${progressBar(all.pct, "Course progress")}
        <span class="read-progress-sub">${all.read} of ${all.total} lessons read · Chapter ${current.chapter.n}: ${ch.read} of ${ch.total}</span>
      </div>`;
  };
  row.addEventListener("click", (e) => {
    if (e.target.matches("[data-unread]")) { setRead(current.slug, false); manual = true; paint(); }
    if (e.target.matches("[data-read]")) { setRead(current.slug, true); paint(); }
  });
  // Mark as read automatically once the reader reaches the end of the lesson,
  // unless they explicitly marked it unread during this visit.
  let manual = false;
  new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting) && !manual && !isRead(current.slug)) { setRead(current.slug, true); paint(); }
  }, { rootMargin: "0px 0px -10% 0px" }).observe(row);
  paint();
}

// A thin bar along the top of a lesson that fills as you scroll through it.
function buildReadingBar() {
  const post = document.querySelector(".post");
  if (!post || !current) return;
  const bar = document.createElement("div");
  bar.className = "reading-bar";
  bar.setAttribute("aria-hidden", "true");
  document.body.prepend(bar);
  let queued = false;
  const update = () => {
    queued = false;
    const top = post.getBoundingClientRect().top + scrollY;
    const span = Math.max(1, post.offsetHeight - innerHeight);
    const f = Math.min(1, Math.max(0, (scrollY - top) / span));
    bar.style.transform = `scaleX(${f})`;
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  addEventListener("scroll", queue, { passive: true });
  addEventListener("resize", queue);
  update();
}

// Wide diagrams keep a minimum width so their labels stay readable, which means on a
// phone they scroll sideways. Mark the ones that do, so CSS can fade the cut edge and
// show a hint, and drop the hint once the reader has swiped.
function markScrollers() {
  const boxes = document.querySelectorAll(".scroll-x");
  if (!boxes.length) return;
  const check = (el) => {
    const more = el.scrollWidth - el.clientWidth > 4;
    el.classList.toggle("can-scroll", more);
    el.classList.toggle("at-end", !more || el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
  };
  const ro = new ResizeObserver((entries) => entries.forEach((e) => check(e.target)));
  boxes.forEach((el) => {
    ro.observe(el);
    el.addEventListener("scroll", () => { check(el); if (el.scrollLeft > 8) el.classList.add("swiped"); }, { passive: true });
  });
}

// Shown at the bottom of every page: this site is a fan project, not an official one.
function buildNotice() {
  const host = document.querySelector(".post, main.home");
  if (!host) return;
  const note = document.createElement("p");
  note.className = "site-note";
  note.innerHTML = `An unofficial companion to <em>Designing Data-Intensive Applications</em>. Not affiliated with or endorsed by Martin Kleppmann or O'Reilly Media. Found a mistake? <a href="${REPO}/issues">Open an issue</a> or <a href="${REPO}">send a fix on GitHub</a>.`;
  host.append(note);
}

buildTopbar();
buildByline();
buildToc();
buildFooter();
buildReadStatus();
buildReadingBar();
markScrollers();
buildNotice();
