// Chapter 9: a simplified, deterministic Raft simulation. DOM-free.
//
// Faithful to Raft in the parts that matter for safety: terms, one vote per
// term, randomized election timeouts, the log up-to-date check on votes,
// AppendEntries consistency checks with log truncation, and a leader counts
// replicas only for entries from its own term (it appends a no-op entry when
// it takes over, as real implementations do, so earlier entries get committed).
// Simplified: no snapshots, no membership changes, no pre-vote, no read path,
// at most a few entries per AppendEntries, and a fixed five-node cluster.
// Time is in abstract units; the widget decides how fast they play.
import { rng } from "../charts.js";

export const CONFIG = { heartbeat: 50, electionMin: 150, electionMax: 300, delayMin: 14, delayMax: 24, batch: 4 };

export class Raft {
  constructor({ n = 5, seed = 11, config = {} } = {}) {
    this.cfg = { ...CONFIG, ...config };
    this.rand = rng(seed);
    this.n = n;
    this.majority = Math.floor(n / 2) + 1;
    this.now = 0;
    this.msgs = [];
    this.msgSeq = 0;
    this.partition = null;
    this.leaders = new Map(); // term -> Set(node ids that became leader in that term)
    this.committed = []; // committed[i] = "term:cmd" first seen as committed at index i+1
    this.violations = [];
    this.events = [];
    this.cmdCount = 0;
    this.nodes = Array.from({ length: n }, (_, id) => ({
      id, up: true, role: "follower", term: 0, votedFor: null, log: [], commit: 0,
      timerStart: 0, deadline: this.timeout(), votes: new Set(), nextIndex: [], matchIndex: [], nextBeat: Infinity, leaderId: null,
    }));
  }

  timeout() { const { electionMin: a, electionMax: b } = this.cfg; return this.now + a + this.rand() * (b - a); }
  delay() { const { delayMin: a, delayMax: b } = this.cfg; return a + this.rand() * (b - a); }
  name(id) { return "N" + (id + 1); }
  note(text, kind = "") { this.events.push({ t: this.now, text, kind }); if (this.events.length > 60) this.events.shift(); }
  reachable(a, b) { return !this.partition || this.partition[a] === this.partition[b]; }

  resetTimer(node) { node.timerStart = this.now; node.deadline = this.timeout(); }

  send(from, to, body) {
    this.msgs.push({ id: ++this.msgSeq, from, to, ...body, sentAt: this.now, arriveAt: this.now + this.delay(), dropped: !this.reachable(from, to) });
  }

  // ---------- time ----------
  nextEventTime() {
    let t = Infinity;
    for (const m of this.msgs) t = Math.min(t, m.arriveAt);
    for (const nd of this.nodes) {
      if (!nd.up) continue;
      t = Math.min(t, nd.role === "leader" ? nd.nextBeat : nd.deadline);
    }
    return t;
  }

  /** Processes the single earliest event. Returns false if there is none. */
  stepOne() {
    const t = this.nextEventTime();
    if (!isFinite(t)) return false;
    this.now = Math.max(this.now, t);
    const m = this.msgs.find((x) => x.arriveAt === t);
    if (m) {
      this.msgs.splice(this.msgs.indexOf(m), 1);
      this.deliver(m);
      return true;
    }
    const nd = this.nodes.find((x) => x.up && (x.role === "leader" ? x.nextBeat : x.deadline) === t);
    if (nd.role === "leader") this.heartbeat(nd);
    else this.startElection(nd);
    return true;
  }

  advanceTo(target) {
    let guard = 0;
    while (this.nextEventTime() <= target && guard++ < 10000) this.stepOne();
    this.now = Math.max(this.now, target);
  }

  // ---------- roles ----------
  startElection(nd) {
    nd.role = "candidate";
    nd.term += 1;
    nd.votedFor = nd.id;
    nd.votes = new Set([nd.id]);
    nd.leaderId = null;
    this.resetTimer(nd);
    this.note(`${this.name(nd.id)} timed out and asks for votes in term ${nd.term}.`, "elect");
    const lastIndex = nd.log.length, lastTerm = lastIndex ? nd.log[lastIndex - 1].term : 0;
    for (const p of this.nodes) if (p.id !== nd.id) this.send(nd.id, p.id, { type: "RequestVote", term: nd.term, lastIndex, lastTerm });
  }

  becomeLeader(nd) {
    nd.role = "leader";
    nd.leaderId = nd.id;
    nd.nextIndex = this.nodes.map(() => nd.log.length + 1);
    nd.matchIndex = this.nodes.map(() => 0);
    if (!this.leaders.has(nd.term)) this.leaders.set(nd.term, new Set());
    const set = this.leaders.get(nd.term);
    set.add(nd.id);
    if (set.size > 1) this.violations.push(`two leaders in term ${nd.term}`);
    this.note(`${this.name(nd.id)} has ${nd.votes.size} of ${this.n} votes and leads term ${nd.term}.`, "leader");
    nd.log.push({ term: nd.term, cmd: "no-op" });
    this.heartbeat(nd);
  }

  stepDownIfStale(nd, term) {
    if (term <= nd.term) return;
    const was = nd.role;
    nd.term = term;
    nd.votedFor = null;
    if (was !== "follower") {
      nd.role = "follower";
      nd.nextBeat = Infinity;
      this.resetTimer(nd);
      if (was === "leader") this.note(`${this.name(nd.id)} sees term ${term} and steps down.`, "down");
    }
  }

  heartbeat(nd) {
    for (const p of this.nodes) if (p.id !== nd.id) this.sendAppend(nd, p.id);
    nd.nextBeat = this.now + this.cfg.heartbeat;
  }

  sendAppend(nd, peer) {
    const prevIndex = nd.nextIndex[peer] - 1;
    const prevTerm = prevIndex > 0 ? nd.log[prevIndex - 1].term : 0;
    const entries = nd.log.slice(prevIndex, prevIndex + this.cfg.batch).map((e) => ({ ...e }));
    this.send(nd.id, peer, { type: "AppendEntries", term: nd.term, prevIndex, prevTerm, entries, leaderCommit: nd.commit });
  }

  // ---------- messages ----------
  deliver(m) {
    const nd = this.nodes[m.to];
    if (m.dropped || !nd.up || !this.reachable(m.from, m.to)) return;
    this.stepDownIfStale(nd, m.term);
    if (m.type === "RequestVote") {
      const myLastIndex = nd.log.length, myLastTerm = myLastIndex ? nd.log[myLastIndex - 1].term : 0;
      const upToDate = m.lastTerm > myLastTerm || (m.lastTerm === myLastTerm && m.lastIndex >= myLastIndex);
      const granted = m.term === nd.term && (nd.votedFor === null || nd.votedFor === m.from) && upToDate;
      if (granted) { nd.votedFor = m.from; this.resetTimer(nd); }
      this.send(nd.id, m.from, { type: "Vote", term: nd.term, granted });
    } else if (m.type === "Vote") {
      if (nd.role !== "candidate" || m.term !== nd.term || !m.granted) return;
      nd.votes.add(m.from);
      if (nd.votes.size >= this.majority) this.becomeLeader(nd);
    } else if (m.type === "AppendEntries") {
      if (m.term < nd.term) { this.send(nd.id, m.from, { type: "AppendReply", term: nd.term, success: false, match: 0 }); return; }
      if (nd.role !== "follower") { nd.role = "follower"; nd.nextBeat = Infinity; }
      nd.leaderId = m.from;
      this.resetTimer(nd);
      const prevOk = m.prevIndex === 0 || (m.prevIndex <= nd.log.length && nd.log[m.prevIndex - 1].term === m.prevTerm);
      if (!prevOk) { this.send(nd.id, m.from, { type: "AppendReply", term: nd.term, success: false, match: 0 }); return; }
      m.entries.forEach((e, k) => {
        const idx = m.prevIndex + 1 + k;
        const mine = nd.log[idx - 1];
        if (mine && mine.term !== e.term) nd.log.length = idx - 1;
        if (!nd.log[idx - 1]) nd.log.push({ ...e });
      });
      const match = m.prevIndex + m.entries.length;
      // A commit index never moves backwards, even if this message covers fewer entries.
      if (m.leaderCommit > nd.commit) this.setCommit(nd, Math.max(nd.commit, Math.min(m.leaderCommit, match)));
      this.send(nd.id, m.from, { type: "AppendReply", term: nd.term, success: true, match });
    } else if (m.type === "AppendReply") {
      if (nd.role !== "leader" || m.term !== nd.term) return;
      if (m.success) {
        nd.matchIndex[m.from] = Math.max(nd.matchIndex[m.from], m.match);
        nd.nextIndex[m.from] = nd.matchIndex[m.from] + 1;
        this.advanceCommit(nd);
        if (nd.nextIndex[m.from] <= nd.log.length) this.sendAppend(nd, m.from);
      } else {
        nd.nextIndex[m.from] = Math.max(1, nd.nextIndex[m.from] - 1);
        this.sendAppend(nd, m.from);
      }
    }
  }

  advanceCommit(nd) {
    for (let N = nd.log.length; N > nd.commit; N--) {
      if (nd.log[N - 1].term !== nd.term) break;
      const count = 1 + this.nodes.filter((p) => p.id !== nd.id && nd.matchIndex[p.id] >= N).length;
      if (count >= this.majority) {
        const from = nd.commit;
        this.setCommit(nd, N);
        const cmds = nd.log.slice(from, N).filter((e) => e.cmd !== "no-op").map((e) => e.cmd);
        this.note(`${this.name(nd.id)} has entry ${N} on ${count} nodes, a majority, and commits it${cmds.length ? ` (${cmds.join(", ")})` : ""}.`, "commit");
        return;
      }
    }
  }

  setCommit(nd, N) {
    for (let i = nd.commit; i < N; i++) {
      const sig = nd.log[i].term + ":" + nd.log[i].cmd;
      if (this.committed[i] === undefined) this.committed[i] = sig;
      else if (this.committed[i] !== sig) this.violations.push(`index ${i + 1} committed with two different entries`);
    }
    nd.commit = N;
  }

  // ---------- reader actions ----------
  /** A client sends a command to a node that believes it is leader. */
  clientCommand(id) {
    const nd = this.nodes[id];
    if (!nd.up || nd.role !== "leader") return null;
    const cmd = "x=" + ++this.cmdCount;
    nd.log.push({ term: nd.term, cmd });
    this.note(`A client sends ${cmd} to ${this.name(id)}, which appends it at index ${nd.log.length}.`, "cmd");
    for (const p of this.nodes) if (p.id !== id) this.sendAppend(nd, p.id);
    nd.nextBeat = this.now + this.cfg.heartbeat;
    return cmd;
  }

  crash(id) {
    const nd = this.nodes[id];
    if (!nd.up) return;
    nd.up = false;
    // Volatile state is lost; term, vote, and log are on disk.
    nd.role = "follower";
    nd.votes = new Set();
    nd.commit = 0;
    nd.leaderId = null;
    nd.nextBeat = Infinity;
    this.note(`${this.name(id)} crashes.`, "down");
  }

  restart(id) {
    const nd = this.nodes[id];
    if (nd.up) return;
    nd.up = true;
    this.resetTimer(nd);
    this.note(`${this.name(id)} restarts with its term, vote, and log from disk.`);
  }

  /** groups: array giving a group number per node, or null to heal. */
  setPartition(groups) {
    this.partition = groups;
    for (const m of this.msgs) if (!this.reachable(m.from, m.to)) m.dropped = true;
    if (groups) {
      const sides = [...new Set(groups)].map((g) => groups.map((x, i) => (x === g ? this.name(i) : null)).filter(Boolean).join(", "));
      this.note(`The network splits into {${sides.join("} and {")}}.`, "down");
    } else this.note("The network heals.");
  }

  // ---------- views ----------
  leadersNow() { return this.nodes.filter((n) => n.up && n.role === "leader"); }

  /** Highest commit index known on any live node. */
  commitIndex() { return Math.max(0, ...this.nodes.filter((n) => n.up).map((n) => n.commit)); }

  /** True when no two nodes disagree about any committed index. */
  safe() {
    if (this.violations.length) return false;
    for (const a of this.nodes) for (const b of this.nodes) {
      const k = Math.min(a.commit, b.commit);
      for (let i = 0; i < k; i++) if (a.log[i].term !== b.log[i].term || a.log[i].cmd !== b.log[i].cmd) return false;
    }
    return true;
  }
}
