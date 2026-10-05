// Budgets of the save model on a synthetic 30-minute typing trace (about
// 65 wpm bursts with word, sentence and thinking pauses), replayed on a
// virtual clock through the real DocumentSession. The old 700 ms debounce
// uploaded 233 times and updated the status bar 6,626 times on this trace.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DocumentSession } from "../../src/documents.ts";

function random(seed) {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Keystroke times (ms) for `durationMs` of writing. */
function typingTrace(seed, durationMs) {
  const next = random(seed);
  const lognormal = (median, sigma) => {
    const u = Math.max(next(), 1e-9);
    return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next()));
  };
  const keys = [];
  let time = 0;
  let inWord = 0;
  let words = 0;
  while (time < durationMs) {
    time += Math.min(lognormal(150, 0.45), 900);
    keys.push(time);
    if (++inWord >= 4 + Math.floor(next() * 4)) {
      inWord = 0;
      words++;
      if (next() < 0.15) time += 400 + next() * 1100;
      if (words % 12 === 0 && next() < 0.7) time += 1000 + next() * 3000;
      if (words % 45 === 0) time += 5000 + next() * 25000;
    }
  }
  return keys.filter((key) => key < durationMs);
}

async function settle() {
  for (let i = 0; i < 4; i++) await new Promise((done) => setImmediate(done));
}

test("30 minutes of writing: at most 16 uploads and 60 status changes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const counts = { stages: 0, commits: 0, uploads: 0, states: 0 };
  let staged = null;
  const session = new DocumentSession({
    open: async () => ({ text: "", readOnly: false }),
    stage: async (_id, text) => { counts.stages++; staged = text; return "Staged"; },
    commit: async () => {
      counts.commits++;
      if (staged !== null) { counts.uploads++; staged = null; }
      return { status: "Saved" };
    },
  }, { state: () => { counts.states++; } });
  await session.open("doc", () => {});
  const keys = typingTrace(3, 30 * 60_000);
  let now = 0;
  for (const key of keys) {
    t.mock.timers.tick(key - now);
    now = key;
    await settle();
    session.edited(() => `text@${key}`);
  }
  for (let second = 0; second < 60; second++) {
    t.mock.timers.tick(1_000);
    await settle();
  }
  assert.ok(keys.length > 6_000);
  assert.ok(counts.uploads <= 16, `${counts.uploads} uploads`);
  assert.equal(counts.commits, counts.uploads, "no upload request without a staged edit");
  assert.ok(counts.states <= 60, `${counts.states} status changes`);
  assert.equal(staged, null, "everything is in S3 after a minute of idle");
  const calls = counts.stages + counts.commits;
  assert.equal(await session.save(), true);
  assert.equal(counts.stages + counts.commits, calls, "Cmd+S with nothing unsynced: 0 IPC");
});
