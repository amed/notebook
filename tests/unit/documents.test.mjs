// Run with `node --test tests/unit/` (Node 22.18+ strips the TypeScript types).
// Scenarios (a) to (c) are the wrong-document saves found in review; the rest
// cover the save model: outbox ("stage") within a second (5 s for texts over
// 2 Mi characters), S3 ("commit") on Cmd+S, switch, idle, exit and retries.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DocumentSession } from "../../src/documents.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run (setImmediate is never mocked here). */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((done) => setImmediate(done));
}

/**
 * A fake vault. `saved` is S3, `journal` the encrypted outbox. `open` answers
 * from them unless a test holds the request back with `hold(id)`, whose
 * `started` resolves once the request is in flight. Every test runs on a
 * virtual clock.
 */
function harness(t, texts = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const saved = new Map(Object.entries(texts));
  const journal = new Map();
  const uploads = [];
  const calls = [];
  const states = [];
  const conflicts = [];
  const opens = new Map();
  const failing = new Set();
  const conflicting = new Map();
  const network = { offline: false, hanging: false, diskFull: false };
  const store = {
    open: (id) => {
      calls.push(`open ${id}`);
      const gate = opens.get(id);
      if (gate) { gate.started.resolve(); return gate.promise; }
      if (journal.has(id)) return Promise.resolve({ text: journal.get(id), readOnly: false, dirty: true });
      return saved.has(id)
        ? Promise.resolve({ text: saved.get(id), readOnly: false })
        : Promise.reject({ code: "DECRYPT_FAILED", message: "The document is damaged." });
    },
    stage: async (id, text) => {
      calls.push(`stage ${id}`);
      if (network.diskFull) throw { code: "OUTBOX_WRITE", message: "The operation could not be completed." };
      if (saved.get(id) === text) { journal.delete(id); return "Clean"; }
      journal.set(id, text);
      return "Staged";
    },
    commit: async (id) => {
      calls.push(`commit ${id}`);
      if (network.hanging) return new Promise(() => {});
      if (failing.has(id)) throw { code: "ACCESS_DENIED", message: "S3 denied access." };
      if (network.offline) return { status: "Offline" };
      if (!journal.has(id)) return { status: "Saved" };
      const text = journal.get(id);
      journal.delete(id);
      const copy = conflicting.get(id);
      if (copy) { saved.set(copy, text); uploads.push([copy, text]); return { status: "ConflictCopy", document_id: copy }; }
      saved.set(id, text);
      uploads.push([id, text]);
      return { status: "Saved" };
    },
  };
  const shown = [];
  const session = new DocumentSession(store, {
    state: (state) => states.push(state),
    conflict: () => conflicts.push(session.openId),
  });
  const open = (id) => session.open(id, (data) => shown.push([id, data.text]));
  const hold = (id) => {
    const gate = { ...deferred(), started: deferred() };
    opens.set(id, gate);
    return gate;
  };
  const tick = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  return { session, open, hold, tick, saved, journal, uploads, calls, states, shown, conflicts, failing, conflicting, network };
}

test("(a) an edit is saved into the document it was typed in after switching", async (t) => {
  const { session, open, uploads, calls, shown } = harness(t, { A: "alpha", B: "beta" });
  await open("A");
  session.edited("alpha EDITED");
  await open("B");
  await settle();
  assert.deepEqual(uploads, [["A", "alpha EDITED"]]);
  assert.deepEqual(calls, ["open A", "stage A", "open B", "commit A"], "in the outbox before the next request, uploaded after");
  assert.deepEqual(shown, [["A", "alpha"], ["B", "beta"]]);
  assert.equal(session.openId, "B");
});

test("(b) a failed open keeps the open document, and edits still go to it", async (t) => {
  const { session, open, uploads } = harness(t, { B: "beta" });
  await open("B");
  await assert.rejects(open("E"), { code: "DECRYPT_FAILED" });
  assert.equal(session.openId, "B");
  session.edited("beta TYPED");
  assert.equal(await session.save(), true);
  assert.deepEqual(uploads, [["B", "beta TYPED"]]);
});

test("(c) only the newest open switches the editor", async (t) => {
  const { session, open, hold, uploads, shown } = harness(t, { A: "alpha", C: "gamma" });
  await open("A");
  const slow = hold("B");
  const first = open("B");
  await slow.started.promise;
  const second = open("C");
  assert.equal(await second, true);
  slow.resolve({ text: "beta", readOnly: false });
  assert.equal(await first, false);
  assert.deepEqual(shown.map(([id]) => id), ["A", "C"]);
  session.edited("gamma EDITED");
  await session.save();
  assert.deepEqual(uploads, [["C", "gamma EDITED"]]);
});

test("an edit typed while the next document loads is saved into the previous one", async (t) => {
  const { session, open, hold, uploads, journal } = harness(t, { A: "alpha" });
  await open("A");
  const gate = hold("B");
  const opening = open("B");
  await gate.started.promise;
  session.edited("alpha LATE");
  gate.resolve({ text: "beta", readOnly: false });
  await opening;
  await settle();
  assert.deepEqual(uploads, [["A", "alpha LATE"]]);
  assert.equal(journal.size, 0);
  assert.equal(session.openId, "B");
});

test("a superseded failure is not reported", async (t) => {
  const { open, hold } = harness(t, { C: "gamma" });
  const gate = hold("E");
  const failing = open("E");
  await gate.started.promise;
  await open("C");
  gate.reject({ code: "DECRYPT_FAILED", message: "x" });
  assert.equal(await failing, false);
});

test("outbox writes run in order, and a refused upload stays queued for retry", async (t) => {
  const { session, open, uploads, journal, calls, states, failing } = harness(t, { A: "alpha" });
  await open("A");
  session.edited("one");
  const first = session.persist();
  session.edited("two");
  const second = session.persist();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(calls.slice(1), ["stage A", "stage A"]);
  assert.equal(journal.get("A"), "two");
  failing.add("A");
  session.edited("three");
  assert.equal(await session.save(), false);
  assert.equal(states.at(-1), "failed");
  assert.equal(await session.save(), false, "the edit stays in the outbox for retry");
  failing.delete("A");
  assert.equal(await session.save(), true, "retry succeeds once S3 accepts it");
  assert.deepEqual(uploads, [["A", "three"]]);
  assert.equal(states.at(-1), "clean");
});

test("timed writes wait during a rename and then follow the new id", async (t) => {
  const { session, open, tick, uploads, calls } = harness(t, { A: "alpha" });
  await open("A");
  calls.length = 0;
  session.hold();
  session.edited("alpha RENAMED");
  await tick(60_000);
  assert.deepEqual(calls, []);
  session.retarget("A", "A2");
  session.release();
  await tick(0);
  assert.deepEqual(calls, ["stage A2", "commit A2"]);
  assert.deepEqual(uploads, [["A2", "alpha RENAMED"]]);
  assert.equal(session.openId, "A2");
});

test("a trashed open document drops its pending edit", async (t) => {
  const { session, open, uploads, calls } = harness(t, { A: "alpha" });
  await open("A");
  session.edited("gone");
  session.retarget("A", null);
  await session.persist();
  assert.deepEqual(uploads, []);
  assert.deepEqual(calls, ["open A"]);
  assert.equal(session.openId, null);
  session.edited("ignored without an open document");
  await session.persist();
  assert.deepEqual(calls, ["open A"]);
});

test("a document handed to another window is never uploaded or retried from here", async (t) => {
  const { session, open, tick, journal, calls, states, failing } = harness(t, { A: "alpha", B: "beta" });
  await open("A");
  session.edited("alpha EDITED");
  // Open in new window: the edit reaches the outbox first, then A belongs to that window.
  assert.equal(await session.persist(), true);
  assert.equal(journal.get("A"), "alpha EDITED");
  failing.add("A");
  session.handOff("A");
  calls.length = 0;
  await tick(10 * 60_000);
  assert.deepEqual(calls, [], "no upload, no retry");
  assert.equal(await session.save(), true);
  await session.syncNow();
  assert.deepEqual(calls, []);
  assert.equal(states.at(-1), "clean");
  assert.equal(session.openId, "A", "the editor keeps showing it, read-only");
  // Switching away uploads nothing of A either.
  await open("B");
  await settle();
  assert.deepEqual(calls, ["open B"]);
});

test("a document another window writes opens read-only and is never uploaded from here", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = [];
  const states = [];
  const session = new DocumentSession({
    open: async (id) => { calls.push(`open ${id}`); return { text: "staged there", readOnly: true, dirty: true }; },
    stage: async (id) => { calls.push(`stage ${id}`); return "Staged"; },
    commit: async (id) => { calls.push(`commit ${id}`); return { status: "Saved" }; },
  }, { state: (state) => states.push(state) });
  await session.open("A", () => {});
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(await session.save(), true);
  assert.deepEqual(calls, ["open A"]);
  assert.deepEqual(states, [], "stays clean");
});

test("lock writes the outbox first, and an open still loading never shows afterwards", async (t) => {
  const { session, open, hold, uploads, shown } = harness(t, { A: "alpha" });
  await open("A");
  session.edited("alpha LOCKED");
  const gate = hold("B");
  const opening = open("B");
  await gate.started.promise;
  session.invalidate();
  assert.equal(await session.flushForExit(), true);
  session.reset();
  gate.resolve({ text: "beta", readOnly: false });
  assert.equal(await opening, false);
  assert.deepEqual(uploads, [["A", "alpha LOCKED"]]);
  assert.deepEqual(shown.map(([id]) => id), ["A"]);
  assert.equal(session.openId, null);
});

test("the text is read once, when the edit is written to the outbox", async (t) => {
  const { session, open, journal } = harness(t, { A: "alpha" });
  await open("A");
  let text = "first";
  let reads = 0;
  session.edited(() => { reads++; return text; });
  text = "latest";
  assert.equal(reads, 0);
  await session.persist();
  assert.equal(reads, 1);
  assert.equal(journal.get("A"), "latest");
});

test("Cmd+S on a document without unsynced edits sends nothing", async (t) => {
  const { session, open, calls } = harness(t, { A: "alpha" });
  await open("A");
  calls.length = 0;
  assert.equal(await session.save(), true);
  assert.deepEqual(calls, []);
  session.edited("alpha 2");
  assert.equal(await session.save(), true);
  assert.deepEqual(calls, ["stage A", "commit A"]);
  calls.length = 0;
  assert.equal(await session.save(), true);
  assert.deepEqual(calls, [], "0 store calls, 0 IPC");
});

test("typing writes the outbox after a 1 s pause and uploads after 30 s idle", async (t) => {
  const { session, open, tick, calls, states, uploads } = harness(t, { A: "alpha" });
  await open("A");
  calls.length = 0;
  for (let i = 0; i < 36; i++) {
    session.edited(`alpha ${i}`);
    await tick(150);
  }
  assert.deepEqual(calls, [], "nothing while typing");
  await tick(1_000);
  assert.deepEqual(calls, ["stage A"]);
  await tick(28_000);
  assert.deepEqual(calls, ["stage A"]);
  await tick(1_000);
  assert.deepEqual(calls, ["stage A", "commit A"]);
  assert.deepEqual(uploads, [["A", "alpha 35"]]);
  assert.deepEqual(states, ["dirty", "clean"], "36 keystrokes, two status changes");
});

test("a text over 2 Mi characters is staged after a 5 s pause, not every 1 s pause", async (t) => {
  const { session, open, tick, calls, journal } = harness(t, { A: "alpha", B: "beta" });
  await open("A");
  calls.length = 0;
  const big = 3 * 1024 * 1024;
  // Bursts of typing with 1.5 s pauses: a small text would be staged four times.
  for (let burst = 0; burst < 4; burst++) {
    for (let i = 0; i < 5; i++) {
      session.edited(`big ${burst}.${i}`, big);
      await tick(80);
    }
    await tick(1_500);
  }
  assert.deepEqual(calls, [], "no stage of the large text in 1.5 s pauses");
  await tick(3_500);
  assert.deepEqual(calls, ["stage A"], "one stage after a 5 s pause");
  assert.equal(journal.get("A"), "big 3.4");
  // Shrunk below the limit: back to the 1 s pause.
  session.edited("small again", 100);
  await tick(1_000);
  assert.deepEqual(calls, ["stage A", "stage A"]);
});

test("typing that never pauses long enough is still staged every 10 s", async (t) => {
  const { session, open, tick, calls, journal } = harness(t, { A: "alpha", B: "beta" });
  await open("A");
  calls.length = 0;
  // A large text typed with 2 s pauses (under its 5 s pause) for 30 s.
  for (let i = 0; i < 15; i++) {
    session.edited(`big ${i}`, 3 * 1024 * 1024);
    await tick(2_000);
  }
  const stages = calls.filter((call) => call === "stage A").length;
  assert.ok(stages >= 2 && stages <= 3, `${stages} stages in 30 s`);
  await open("B");
  calls.length = 0;
  // A small text typed without a 1 s pause for 25 s.
  for (let i = 0; i < 166; i++) {
    session.edited(`beta ${i}`);
    await tick(150);
  }
  assert.deepEqual(calls.filter((call) => call.startsWith("stage")), ["stage B", "stage B"]);
  assert.ok(Number(journal.get("B").split(" ")[1]) >= 130, "with the text typed up to then");
});

test("a large text is staged at once on switch, Cmd+S, blur and close", async (t) => {
  const { session, open, tick, calls, journal, uploads } = harness(t, { A: "alpha", B: "beta" });
  const big = 3 * 1024 * 1024;
  await open("A");
  session.edited("big switch", big);
  await tick(100);
  calls.length = 0;
  await open("B");
  assert.deepEqual(calls.slice(0, 2), ["stage A", "open B"], "switching stages the previous document first");
  await tick(0);
  assert.equal(journal.get("A") ?? uploads.at(-1)?.[1], "big switch");
  session.edited("big save", big);
  assert.equal(await session.save(), true);
  assert.deepEqual(uploads.at(-1), ["B", "big save"]);
  session.edited("big blur", big);
  calls.length = 0;
  session.background();
  await tick(0);
  assert.deepEqual(calls, ["stage B", "commit B"], "blur stages and uploads without the 5 s pause");
  session.edited("big close", big);
  assert.equal(await session.flushForExit(), true);
  assert.deepEqual(uploads.at(-1), ["B", "big close"]);
});

test("120 s of continuous typing uploads without waiting for a pause", async (t) => {
  const { session, open, tick, uploads } = harness(t, { A: "alpha" });
  await open("A");
  for (let i = 0; i < 800; i++) {
    session.edited(`alpha ${i}`);
    await tick(150);
  }
  assert.equal(uploads.length, 1, "one upload in 120 s of typing");
  assert.ok(Number(uploads[0][1].split(" ")[1]) >= 790, "with the text typed up to then");
});

test("typing back to the uploaded text is clean without an upload", async (t) => {
  const { session, open, calls, states } = harness(t, { A: "alpha" });
  await open("A");
  session.edited("alpha!");
  await session.persist();
  session.edited("alpha");
  await session.persist();
  assert.equal(states.at(-1), "clean");
  assert.equal(await session.save(), true);
  assert.deepEqual(calls, ["open A", "stage A", "stage A"]);
});

test("switching documents never waits for S3", async (t) => {
  const { session, open, calls, network } = harness(t, { A: "alpha", B: "beta" });
  await open("A");
  network.hanging = true;
  session.edited("alpha edited");
  assert.equal(await open("B"), true);
  await settle();
  assert.deepEqual(calls, ["open A", "stage A", "open B", "commit A"]);
  assert.equal(session.openId, "B");
});

test("closing while S3 hangs answers within the 3 s budget, edit in the outbox", async (t) => {
  const { session, open, tick, journal, states, network } = harness(t, { A: "alpha" });
  await open("A");
  session.edited("last words");
  network.hanging = true;
  let answered = false;
  const closing = session.flushForExit().then((durable) => { answered = true; return durable; });
  await settle();
  assert.equal(journal.get("A"), "last words", "durable within milliseconds");
  await tick(1_000);
  assert.equal(states.at(-1), "busy");
  await tick(1_999);
  assert.equal(answered, false);
  await tick(1);
  assert.equal(answered, true);
  assert.equal(await closing, true);
});

test("a failed outbox write keeps the window open and is retried", async (t) => {
  const { session, open, journal, uploads, states, network } = harness(t, { A: "alpha" });
  await open("A");
  session.edited("unsaved");
  network.diskFull = true;
  assert.equal(await session.flushForExit(), false);
  assert.equal(states.at(-1), "failed");
  await assert.rejects(open("A2"), /could not be saved on this device/);
  network.diskFull = false;
  assert.equal(await session.flushForExit(), true);
  assert.equal(journal.size, 0);
  assert.deepEqual(uploads, [["A", "unsaved"]]);
  assert.equal(states.at(-1), "clean");
});

test("offline uploads back off, pause idle uploads, and recover", async (t) => {
  const { session, open, tick, calls, states, uploads, network } = harness(t, { A: "alpha" });
  await open("A");
  network.offline = true;
  session.edited("offline edit");
  assert.equal(await session.save(), false);
  assert.equal(states.at(-1), "offline");
  calls.length = 0;
  await tick(14_999);
  assert.deepEqual(calls, [], "no idle upload while offline");
  await tick(1);
  assert.deepEqual(calls, ["commit A"], "first retry after 15 s");
  await tick(29_999);
  assert.deepEqual(calls, ["commit A"]);
  network.offline = false;
  await tick(1);
  assert.deepEqual(calls, ["commit A", "commit A"], "second retry 30 s later");
  assert.deepEqual(uploads, [["A", "offline edit"]]);
  assert.equal(states.at(-1), "clean");
});

test("focus or a reconnect retries failed uploads only", async (t) => {
  const { session, open, uploads, calls, network } = harness(t, { A: "alpha", B: "beta" });
  await open("A");
  network.offline = true;
  session.edited("queued");
  await session.save();
  await open("B");
  session.edited("beta, still typing");
  network.offline = false;
  calls.length = 0;
  await session.retryNow();
  assert.deepEqual(calls, ["commit A"], "the open document waits for its own triggers");
  assert.deepEqual(uploads, [["A", "queued"]]);
  await session.syncNow();
  assert.deepEqual(uploads.at(-1), ["B", "beta, still typing"]);
});

test("a conflict copy takes over the open document", async (t) => {
  const { session, open, uploads, conflicts, conflicting, journal } = harness(t, { A: "alpha" });
  await open("A");
  conflicting.set("A", "A (conflict)");
  session.edited("mine");
  assert.equal(await session.save(), true);
  assert.deepEqual(uploads, [["A (conflict)", "mine"]]);
  assert.deepEqual(conflicts, ["A (conflict)"]);
  assert.equal(session.openId, "A (conflict)");
  session.edited("mine, continued");
  await session.save();
  assert.equal(journal.size, 0);
  assert.deepEqual(uploads.at(-1), ["A (conflict)", "mine, continued"]);
});

test("a document reopened with an edit in the outbox is unsynced", async (t) => {
  const { session, open, journal, uploads, states } = harness(t, { A: "alpha", B: "beta" });
  journal.set("B", "beta from the outbox");
  await open("B");
  assert.equal(states.at(-1), "dirty");
  assert.equal(await session.save(), true);
  assert.deepEqual(uploads, [["B", "beta from the outbox"]]);
  assert.equal(states.at(-1), "clean");
});

test("an edit refused while its document moves is saved under the new id", async (t) => {
  const { session, open, journal, uploads, network, saved } = harness(t, { A: "alpha" });
  await open("A");
  // A document window: Rust renames its document; timed writes wait.
  session.hold();
  session.edited("typed as the move started");
  network.diskFull = true; // Rust refuses the stage (BUSY) while the objects move
  assert.equal(await session.persist(), false);
  // The move is over: the document is A2, and the window writes again (resumeAfterMove).
  saved.set("A2", saved.get("A"));
  saved.delete("A");
  network.diskFull = false;
  session.retarget("A", "A2");
  session.release();
  assert.equal(await session.persist(), true);
  await session.retryNow();
  assert.equal(await session.save(), true);
  assert.deepEqual(uploads, [["A2", "typed as the move started"]]);
  assert.equal(journal.size, 0);
});
