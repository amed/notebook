// Workspace form checks, the workspace_save payload, launch routing, and the
// in-memory stand-in browser mode uses for the Rust workspace commands.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MemoryWorkspaces,
  checkWorkspaceForm,
  defaultWorkspaceName,
  isStartupProblem,
  launchStep,
  locationChanged,
  locationLabel,
  normalizedPrefix,
  rememberByDefault,
  unlockFailureStep,
  workspaceErrorMessage,
  workspaceInitial,
  workspaceInput,
  workspacePayload,
} from "../../src/workspaces.ts";

function summary(overrides = {}) {
  return {
    id: "w1",
    name: "Personal",
    bucket: "notes",
    region: "eu-central-1",
    prefix: "vault",
    endpoint: null,
    credentials_stored: true,
    phrase_stored: false,
    remember_declined: false,
    masked_access_key_id: "••••ABCD",
    ...overrides,
  };
}

function form(overrides = {}) {
  return {
    name: "Personal",
    bucket: "notes",
    region: "eu-central-1",
    prefix: "vault",
    endpoint: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    phrase: "",
    remember: true,
    ...overrides,
  };
}

test("a new workspace is named after its bucket", () => {
  assert.equal(defaultWorkspaceName("  team-docs "), "team-docs");
  assert.equal(defaultWorkspaceName(""), "Workspace");
  assert.equal(defaultWorkspaceName("   "), "Workspace");
  assert.equal(Array.from(defaultWorkspaceName("b".repeat(80))).length, 64);
  assert.equal(workspaceInitial("ärger"), "Ä");
  assert.equal(workspaceInitial(""), "W");
});

test("locations are shown and compared as the backend stores them", () => {
  assert.equal(normalizedPrefix(" /a/b/ "), "a/b");
  assert.equal(locationLabel(summary()), "notes/vault");
  assert.equal(locationLabel(summary({ prefix: "" })), "notes");
  assert.equal(locationLabel(summary({ endpoint: "https://minio.lab:9000/" })), "notes/vault · minio.lab:9000");
  const before = summary();
  assert.equal(locationChanged(before, form({ prefix: "/vault/" })), false);
  assert.equal(locationChanged(before, form({ name: "Renamed" })), false);
  assert.equal(locationChanged(before, form({ bucket: "other" })), true);
  assert.equal(locationChanged(before, form({ region: "us-east-1" })), true);
  assert.equal(locationChanged(before, form({ endpoint: "https://s3.example.com" })), true);
});

test("the form names the first field to fix", () => {
  const others = [summary(), summary({ id: "w2", name: "Work" })];
  const check = (values, existing = null, extra = {}) =>
    checkWorkspaceForm(form(values), { existing, others, ...extra })?.field ?? null;
  assert.equal(check({ name: "" , accessKeyId: "AK", secretAccessKey: "s" }), "name");
  assert.equal(check({ name: "x".repeat(65), accessKeyId: "AK", secretAccessKey: "s" }), "name");
  // Names are unique ignoring case, except against the workspace being edited.
  assert.equal(check({ name: "work", accessKeyId: "AK", secretAccessKey: "s" }), "name");
  assert.equal(check({ name: "PERSONAL" }, others[0]), null);
  assert.equal(check({ name: "New", bucket: "has space", accessKeyId: "AK", secretAccessKey: "s" }), "bucket");
  assert.equal(check({ name: "New", region: "eu central", accessKeyId: "AK", secretAccessKey: "s" }), "region");
  assert.equal(check({ name: "New", endpoint: "minio.local", accessKeyId: "AK", secretAccessKey: "s" }), "endpoint");
  // A new workspace needs both keys; an edit keeps stored ones when both are blank.
  assert.equal(check({ name: "New" }), "accessKeyId");
  assert.equal(check({ name: "New", accessKeyId: "AK" }), "secretAccessKey");
  assert.equal(check({ name: "New", secretAccessKey: "s" }), "accessKeyId");
  assert.equal(check({}, others[0]), null);
  assert.equal(check({}, summary({ credentials_stored: false })), "accessKeyId");
  // The connect screen opens the workspace: a phrase is typed or remembered.
  assert.equal(check({}, others[0], { requirePhrase: true }), "phrase");
  assert.equal(check({}, summary({ phrase_stored: true }), { requirePhrase: true }), null);
});

test("blank secret fields are left out of the payload, so stored ones are kept", () => {
  const kept = workspaceInput(form({ name: " Personal " }), summary(), { withPhrase: true });
  assert.deepEqual(kept, {
    id: "w1",
    name: "Personal",
    bucket: "notes",
    region: "eu-central-1",
    prefix: "vault",
    endpoint: null,
    remember_phrase: true,
  });
  const replaced = workspaceInput(
    form({ accessKeyId: " AKIA1 ", secretAccessKey: " secret ", sessionToken: " ", phrase: " phrase " }),
    null,
    { withPhrase: true },
  );
  assert.deepEqual(replaced.credentials, { access_key_id: "AKIA1", secret_access_key: " secret ", session_token: null });
  assert.equal(replaced.phrase, " phrase ", "a phrase is sent exactly as typed");
  assert.equal("id" in replaced, false);
  // Unchecking Remember forgets the stored phrase and never sends a typed one.
  const forgotten = workspaceInput(form({ phrase: "typed", remember: false }), summary(), { withPhrase: true });
  assert.equal(forgotten.remember_phrase, false);
  assert.equal("phrase" in forgotten, false);
  // The connect screen sends the phrase to the unlock, not to workspace_save.
  const connect = workspaceInput(form({ phrase: "typed" }), null, { withPhrase: false });
  assert.equal("phrase" in connect, false);
  assert.equal("remember_phrase" in connect, false);
  assert.equal(workspacePayload({ ...connect, endpoint: "  " }).endpoint, null);
});

test("launch routing follows the active workspace", () => {
  assert.deepEqual(launchStep({ workspaces: [], active: null }), { kind: "setup" });
  const a = summary({ id: "a", name: "A" });
  const b = summary({ id: "b", name: "B", phrase_stored: true });
  const c = summary({ id: "c", name: "C", credentials_stored: false, phrase_stored: true });
  assert.equal(launchStep({ workspaces: [a, b], active: null }).kind, "select");
  assert.equal(launchStep({ workspaces: [a, b], active: "gone" }).workspace.id, "a");
  assert.equal(launchStep({ workspaces: [a, b], active: "a" }).kind, "unlock");
  assert.equal(launchStep({ workspaces: [a, b], active: "b" }).kind, "open");
  assert.equal(launchStep({ workspaces: [a, b, c], active: "c" }).kind, "connect");
  assert.equal(unlockFailureStep("NO_CREDENTIALS"), "connect");
  assert.equal(unlockFailureStep("KEYCHAIN_UNAVAILABLE"), "connect");
  assert.equal(unlockFailureStep("NO_WORKSPACE"), "setup");
  assert.equal(unlockFailureStep("WRONG_PHRASE"), "unlock");
  for (const code of ["NO_WORKSPACE", "WORKSPACE_CHANGED", "WORKSPACE_UNLOCKED", "NO_STORED_PHRASE"]) {
    assert.ok(workspaceErrorMessage(code));
  }
  assert.equal(workspaceErrorMessage("WRONG_PHRASE"), null);
});

test("the browser stand-in follows the workspace command rules", async () => {
  const store = new MemoryWorkspaces();
  const first = await store.save({ name: "Work", bucket: "docs", region: "us-east-1", prefix: "/team/", credentials: { access_key_id: "AKIAWORK1234", secret_access_key: "s" } });
  assert.equal(first.prefix, "team");
  assert.equal(first.masked_access_key_id, "••••1234");
  assert.equal((await store.list()).active, first.id, "the first workspace becomes active");
  await assert.rejects(store.save({ name: "WORK", bucket: "x", region: "us-east-1", prefix: "" }), { code: "INVALID_INPUT" });
  const second = await store.save({ name: "Archive", bucket: "old", region: "us-east-1", prefix: "" });
  assert.equal(second.credentials_stored, false);
  assert.deepEqual((await store.list()).workspaces.map((workspace) => workspace.name), ["Archive", "Work"]);

  // Remembered phrase: used when none is typed, never replaced by a wrong one.
  await assert.rejects(store.unlock(null), { code: "NO_STORED_PHRASE" });
  await assert.rejects(store.unlock("wrong", true), { code: "WRONG_PHRASE" });
  await store.unlock("right", true);
  assert.equal((await store.list()).workspaces.find((w) => w.id === first.id).phrase_stored, true);
  await assert.rejects(store.remove(first.id), { code: "WORKSPACE_UNLOCKED" });
  await store.lock();
  await assert.rejects(store.unlock("wrong", true), { code: "WRONG_PHRASE" });
  await store.unlock(null);
  // Editing without secrets keeps them; unchecking Remember forgets the phrase.
  const renamed = await store.save({ id: first.id, name: "Team", bucket: "docs", region: "us-east-1", prefix: "team" });
  assert.equal(renamed.credentials_stored, true);
  assert.equal(renamed.phrase_stored, true);
  assert.equal((await store.save({ ...renamed, remember_phrase: false, phrase: "ignored" })).phrase_stored, false);

  await store.select(second.id);
  await assert.rejects(store.unlock("phrase"), { code: "NO_CREDENTIALS" });
  const after = await store.remove(second.id);
  assert.deepEqual(after.workspaces.map((workspace) => workspace.id), [first.id]);
  assert.equal(after.active, first.id, "deleting the active workspace activates the first by name");
});

test("a session token is never dropped silently", () => {
  const context = { existing: summary({ credentials_stored: true }), others: [] };
  assert.deepEqual(
    checkWorkspaceForm(form({ accessKeyId: "", secretAccessKey: "", sessionToken: "token" }), context),
    { field: "accessKeyId", message: "Enter the access key ID and secret access key with the session token." },
  );
  assert.equal(checkWorkspaceForm(form({ accessKeyId: "", secretAccessKey: "", sessionToken: "  " }), context), null);
  assert.equal(checkWorkspaceForm(form({ accessKeyId: "AKIANEW", secretAccessKey: "s", sessionToken: "token" }), context), null);
});

test("Remember starts checked unless the user last unchecked it", () => {
  assert.equal(rememberByDefault(null), true);
  assert.equal(rememberByDefault(summary()), true);
  assert.equal(rememberByDefault(summary({ remember_declined: true })), false);
  assert.equal(rememberByDefault(summary({ remember_declined: true, phrase_stored: true })), true);
});

test("startup problems and queued edits have their own messages", () => {
  for (const code of ["PROFILE_IN_USE", "CONFIG_UNREADABLE", "SECRETS_UNREADABLE"]) {
    assert.equal(isStartupProblem(code), true);
    assert.match(workspaceErrorMessage(code), /quit/i);
  }
  assert.equal(isStartupProblem("NO_WORKSPACE"), false);
  assert.match(workspaceErrorMessage("OUTBOX_PENDING"), /not uploaded/);
  assert.equal(workspacePayload({ ...form(), name: "n", leave_pending: true }).leave_pending, true);
  assert.equal("leave_pending" in workspacePayload({ ...form(), name: "n", leave_pending: false }), false);
});

test("the stand-in keeps queued edits and the Remember choice as Rust does", async () => {
  const store = new MemoryWorkspaces([
    { name: "Open", bucket: "open", region: "eu-central-1", prefix: "", accessKeyId: "AKIAOPEN0001", phrase: "p" },
    { name: "Queued", bucket: "queued", region: "eu-central-1", prefix: "notes", accessKeyId: "AKIAQUEUED01", queued: true },
  ]);
  const queued = (await store.list()).workspaces.find((workspace) => workspace.name === "Queued");
  const base = { id: queued.id, name: "Queued", bucket: "queued", region: "eu-central-1", prefix: "notes" };
  await assert.rejects(store.save({ ...base, bucket: "elsewhere" }), { code: "OUTBOX_PENDING" });
  // A new endpoint for the same bucket and prefix takes them along.
  await store.save({ ...base, endpoint: "https://s3.example.com" });
  await assert.rejects(store.remove(queued.id), { code: "OUTBOX_PENDING" });
  await store.save({ ...base, bucket: "elsewhere", leave_pending: true });
  await store.remove(queued.id);

  const open = (await store.list()).workspaces[0];
  await store.unlock("p", false);
  assert.equal((await store.list()).workspaces[0].remember_declined, true);
  await store.unlock("p", true);
  assert.equal((await store.list()).workspaces[0].remember_declined, false);
  const saved = await store.save({ id: open.id, name: "Open", bucket: "open", region: "eu-central-1", prefix: "", remember_phrase: false });
  assert.equal(saved.remember_declined, true);
});
