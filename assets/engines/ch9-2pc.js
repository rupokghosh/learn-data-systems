// Chapter 9: two-phase commit as a step-by-step state machine. DOM-free.
// One coordinator ("c") and participants 0..n-1. Each call to step() performs
// the next action the protocol would take and reports the messages it sent.
// Crashes and restarts can be injected between steps. Recovery follows the
// usual rules: the coordinator trusts only its log (no decision logged means
// abort), and a participant that logged "prepared" must wait for the decision.

export class TwoPC {
  constructor(names) {
    this.names = names;
    this.reset();
  }

  reset() {
    this.coord = { up: true, phase: "idle", votes: {}, decision: null, acked: new Set(), log: ["begin tx 81"] };
    this.parts = this.names.map((name) => ({
      name, up: true, state: "active", gotPrepare: false, voteNo: this.parts?.find((p) => p.name === name)?.voteNo || false,
      log: ["tx 81: writes done"],
    }));
    this.steps = 0;
  }

  /** Locks are held while the work is unfinished or the outcome is unknown. */
  holdsLocks(p) {
    return p.state === "prepared" || (p.state === "active" && p.up);
  }

  inDoubt(p) { return p.state === "prepared"; }

  /** Describes the next action without performing it. */
  agenda() {
    const c = this.coord;
    const voters = this.parts.map((p, i) => i).filter((i) => {
      const p = this.parts[i];
      return p.up && p.gotPrepare && p.state === "active";
    });
    if (voters.length) return { kind: "vote", who: voters };
    if (c.up) {
      if (c.phase === "idle") return { kind: "prepare" };
      if (c.phase === "preparing") {
        const vals = this.parts.map((_, i) => c.votes[i]);
        if (vals.includes("no")) return { kind: "decide", decision: "abort", why: "no" };
        if (vals.every((v) => v === "yes")) return { kind: "decide", decision: "commit" };
        return { kind: "decide", decision: "abort", why: "timeout" };
      }
      if (c.phase === "decided") {
        const pending = this.parts.map((_, i) => i).filter((i) => !c.acked.has(i));
        const reachable = pending.filter((i) => this.parts[i].up);
        if (!pending.length) return { kind: "end" };
        if (reachable.length) return { kind: "send", who: reachable };
        return { kind: "wait", text: `The coordinator keeps retrying the decision, but ${this.list(pending)} ${pending.length > 1 ? "are" : "is"} down.` };
      }
      return { kind: "none", text: "The transaction is finished." };
    }
    const idle = this.parts.map((_, i) => i).filter((i) => this.parts[i].up && this.parts[i].state === "active");
    if (idle.length) return { kind: "unilateral", who: idle };
    const doubt = this.parts.map((_, i) => i).filter((i) => this.inDoubt(this.parts[i]));
    if (doubt.length) return { kind: "wait", text: `The coordinator is down. ${this.list(doubt)} voted yes and cannot decide alone, so ${doubt.length > 1 ? "they wait" : "it waits"}, in doubt and holding locks.` };
    return { kind: "wait", text: "The coordinator is down, but no participant is waiting on it." };
  }

  list(ix) {
    const ns = ix.map((i) => this.parts[i].name);
    return ns.length <= 1 ? ns.join("") : ns.slice(0, -1).join(", ") + " and " + ns[ns.length - 1];
  }

  /** Performs the next action. Returns { text, msgs: [{from, to, label, lost}] , idle?: true }. */
  step() {
    const a = this.agenda();
    const c = this.coord;
    const msgs = [];
    const send = (from, to, label) => {
      const target = to === "c" ? c : this.parts[to];
      const lost = !target.up;
      msgs.push({ from, to, label, lost });
      return !lost;
    };
    let text;
    switch (a.kind) {
      case "prepare": {
        c.phase = "preparing";
        c.log.push("sent PREPARE");
        this.parts.forEach((p, i) => { if (send("c", i, "PREPARE")) p.gotPrepare = true; });
        const missed = this.parts.map((_, i) => i).filter((i) => !this.parts[i].up);
        text = "Phase 1. The coordinator asks every participant: can you promise to commit?" +
          (missed.length ? ` ${this.list(missed)} ${missed.length > 1 ? "are" : "is"} down and never ${missed.length > 1 ? "see" : "sees"} the request.` : "");
        break;
      }
      case "vote": {
        const yes = [], no = [];
        for (const i of a.who) {
          const p = this.parts[i];
          if (p.voteNo) {
            p.state = "aborted";
            p.log.push("vote NO, rolled back");
            if (send(i, "c", "NO") && c.phase === "preparing") c.votes[i] = "no";
            no.push(i);
          } else {
            p.state = "prepared";
            p.log.push("PREPARED (fsync)");
            if (send(i, "c", "YES") && c.phase === "preparing") c.votes[i] = "yes";
            yes.push(i);
          }
        }
        const parts = [];
        if (yes.length) parts.push(`${this.list(yes)} ${yes.length > 1 ? "write" : "writes"} the changes and a prepare record to disk, then ${yes.length > 1 ? "vote" : "votes"} yes. From here, ${yes.length > 1 ? "they cannot" : "it cannot"} back out.`);
        if (no.length) parts.push(`${this.list(no)} cannot commit (a constraint fails), so it rolls back and votes no.`);
        if (!c.up) parts.push("The coordinator is down, so the votes are lost.");
        text = parts.join(" ");
        break;
      }
      case "decide": {
        c.decision = a.decision;
        c.phase = "decided";
        c.acked = new Set();
        c.log.push(a.decision === "commit" ? "COMMIT (fsync)" : "ABORT (fsync)");
        if (a.decision === "commit") text = "Every vote is yes. The coordinator writes COMMIT to its log. This is the commit point: from now on the transaction must commit, whatever fails.";
        else if (a.why === "no") text = "A participant voted no. The coordinator writes ABORT to its log.";
        else text = "Some votes never arrived. The coordinator times out and writes ABORT to its log.";
        break;
      }
      case "send": {
        const label = c.decision === "commit" ? "COMMIT" : "ABORT";
        for (const i of a.who) {
          const p = this.parts[i];
          send("c", i, label);
          if (p.state === "prepared" || p.state === "active") {
            p.state = c.decision === "commit" ? "committed" : "aborted";
            p.log.push(c.decision === "commit" ? "COMMITTED" : "ABORTED");
          }
          send(i, "c", "ACK");
          c.acked.add(i);
        }
        text = `Phase 2. The coordinator sends ${label} to ${this.list(a.who)}. Each one applies it, releases its locks, and acknowledges.`;
        break;
      }
      case "end": {
        c.phase = "done";
        c.log.push("END");
        text = "Every participant has acknowledged. The coordinator writes an end record and can forget the transaction.";
        break;
      }
      case "unilateral": {
        for (const i of a.who) {
          const p = this.parts[i];
          p.state = "aborted";
          p.log.push("timeout, ABORTED");
        }
        text = `${this.list(a.who)} never voted, so ${a.who.length > 1 ? "they are" : "it is"} still free to give up. After a timeout ${a.who.length > 1 ? "they abort" : "it aborts"} and ${a.who.length > 1 ? "release" : "releases"} locks.`;
        break;
      }
      default:
        return { text: a.text, msgs: [], idle: true };
    }
    this.steps++;
    return { text, msgs };
  }

  crash(who) {
    if (who === "c") {
      const c = this.coord;
      c.up = false;
      c.votes = {};
      c.acked = new Set();
      return "The coordinator crashes. Its memory (the votes it has collected) is gone; its log on disk survives.";
    }
    const p = this.parts[who];
    p.up = false;
    return `${p.name} crashes.` + (p.state === "active" ? " Its unfinished work was never made durable." : "");
  }

  restart(who) {
    if (who === "c") {
      const c = this.coord;
      c.up = true;
      if (c.log.includes("END")) { c.phase = "done"; return "The coordinator restarts. Its log says the transaction already ended."; }
      if (c.decision) {
        c.phase = "decided";
        c.acked = new Set();
        return `The coordinator restarts, reads ${c.decision.toUpperCase()} in its log, and will send it to every participant again.`;
      }
      c.decision = "abort";
      c.phase = "decided";
      c.acked = new Set();
      c.log.push("restart: ABORT (fsync)");
      return "The coordinator restarts and finds no decision in its log, so it decides to abort and will tell every participant.";
    }
    const p = this.parts[who];
    p.up = true;
    if (p.state === "active") {
      p.state = "aborted";
      p.log.push("restart: no prepare, ABORTED");
      return `${p.name} restarts. It never logged a prepare record, so it rolls the transaction back.`;
    }
    if (p.state === "prepared") {
      p.log.push("restart: still prepared");
      return `${p.name} restarts and finds a prepare record but no outcome. It takes its locks again and asks the coordinator what was decided.`;
    }
    return `${p.name} restarts. Its log already holds the outcome.`;
  }

  /** Atomicity: never one committed and another aborted. */
  atomic() {
    const s = new Set(this.parts.map((p) => p.state));
    return !(s.has("committed") && s.has("aborted"));
  }

  outcome() {
    const states = this.parts.map((p) => p.state);
    if (states.every((s) => s === "committed")) return "committed";
    if (states.every((s) => s === "aborted")) return "aborted";
    return "open";
  }
}
