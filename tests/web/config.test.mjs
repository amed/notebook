// web/src/config.ts: the localStorage config has the desktop's config.json v2
// shape; secrets are sealed (AES-GCM, non-extractable key, workspace and
// field bound as associated data) in the desktop's secrets.json shape, never
// stored in plaintext; "Forget this device" removes everything.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_KEY, defaultName, LocalStore, maskedAccessKeyId, MemoryKeyStore, parseConfig, SECRETS_KEY } from "../../web/src/config.ts";

class MemoryStorage {
  map = new Map();
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

const workspace = { id: "6f2c1d7e-1111-4222-8333-944455556666", name: "Notes", bucket: "my-notes", region: "eu-central-1", prefix: "vault", endpoint: null, masked_access_key_id: "••••MPLE" };

test("a fresh device has no config, no workspace and no secrets", () => {
  const storage = new MemoryStorage();
  const store = new LocalStore(storage, new MemoryKeyStore());
  assert.deepEqual(store.loadConfig(), { version: 2, auto_lock_minutes: 15, theme: "System", accent: "orange", active_workspace: null, workspaces: [] });
  assert.equal(storage.map.size, 0, "reading writes nothing");
});

test("the stored config is the desktop's config.json v2 object", () => {
  const storage = new MemoryStorage();
  const store = new LocalStore(storage, new MemoryKeyStore());
  const config = store.loadConfig();
  config.workspaces.push(workspace);
  config.active_workspace = workspace.id;
  store.saveConfig(config);
  const raw = JSON.parse(storage.getItem(CONFIG_KEY));
  assert.deepEqual(Object.keys(raw), ["version", "auto_lock_minutes", "theme", "accent", "active_workspace", "workspaces"]);
  assert.deepEqual(Object.keys(raw.workspaces[0]), ["id", "name", "bucket", "region", "prefix", "endpoint", "masked_access_key_id"]);
  assert.deepEqual(store.loadConfig(), config);
});

test("config parsing follows the desktop's parse_config", () => {
  // A desktop config.json (with its layout) reads as the same workspaces and preferences.
  const desktop = JSON.stringify({ version: 2, auto_lock_minutes: 5, theme: "Dark", accent: "teal", layout: { sidebar_width: 280 }, active_workspace: workspace.id, workspaces: [workspace] });
  const parsed = parseConfig(desktop);
  assert.equal(parsed.theme, "Dark");
  assert.equal(parsed.accent, "teal");
  assert.equal(parsed.auto_lock_minutes, 5);
  assert.deepEqual(parsed.workspaces, [workspace]);
  assert.equal(parseConfig(JSON.stringify({ version: 3 })), null, "a newer version is refused");
  const repaired = parseConfig(JSON.stringify({ version: 2, auto_lock_minutes: 99999, theme: "Neon", accent: "lime", active_workspace: "gone", workspaces: [workspace, { id: "", bucket: 1 }] }));
  assert.deepEqual([repaired.auto_lock_minutes, repaired.theme, repaired.accent, repaired.active_workspace, repaired.workspaces.length], [15, "System", "orange", null, 1]);
  assert.equal(parseConfig("{not json"), null);
});

test("secrets are sealed per workspace and field; plaintext never reaches storage", async () => {
  const storage = new MemoryStorage();
  const keys = new MemoryKeyStore();
  const store = new LocalStore(storage, keys);
  const credentials = { access_key_id: "AKIACANARYKEY1234", secret_access_key: "canary-secret-access-key", session_token: null };
  await store.saveCredentials(workspace.id, credentials);
  await store.seal(workspace.id, "phrase", "canary phrase words");
  const raw = storage.getItem(SECRETS_KEY);
  for (const secret of ["AKIACANARYKEY1234", "canary-secret-access-key", "canary phrase words", "CANARY", "canary"]) assert.ok(!raw.includes(secret), secret);
  const file = JSON.parse(raw);
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.workspaces[workspace.id]).sort(), ["phrase", "s3"]);
  assert.match(file.workspaces[workspace.id].phrase, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.deepEqual(await store.openCredentials(workspace.id), credentials);
  assert.equal(await store.open(workspace.id, "phrase"), "canary phrase words");
  const key = await keys.get();
  assert.equal(key.extractable, false, "the sealing key cannot be exported");
  assert.deepEqual(key.usages.sort(), ["decrypt", "encrypt"]);
});

test("a sealed value moved to another workspace or field, tampered or under another key does not open", async () => {
  const storage = new MemoryStorage();
  const store = new LocalStore(storage, new MemoryKeyStore());
  await store.seal("ws-a", "phrase", "phrase a");
  const file = JSON.parse(storage.getItem(SECRETS_KEY));
  const sealed = file.workspaces["ws-a"].phrase;
  file.workspaces["ws-b"] = { phrase: sealed, s3: sealed };
  storage.setItem(SECRETS_KEY, JSON.stringify(file));
  assert.equal(await store.open("ws-b", "phrase"), null, "other workspace");
  assert.equal(await store.open("ws-a", "s3"), null, "other field");
  const bytes = Buffer.from(sealed, "base64");
  bytes[bytes.length - 1] ^= 1;
  file.workspaces["ws-a"].phrase = bytes.toString("base64");
  storage.setItem(SECRETS_KEY, JSON.stringify(file));
  assert.equal(await store.open("ws-a", "phrase"), null, "tampered");
  const other = new LocalStore(storage, new MemoryKeyStore());
  await other.seal("ws-c", "phrase", "c");
  assert.equal(await other.open("ws-b", "phrase"), null, "another device key");
});

test("forget this device removes the config, the secrets and the key", async () => {
  const storage = new MemoryStorage();
  const keys = new MemoryKeyStore();
  const store = new LocalStore(storage, keys);
  store.saveConfig({ ...store.loadConfig(), workspaces: [workspace], active_workspace: workspace.id });
  await store.seal(workspace.id, "phrase", "p");
  store.removeSecrets("unknown");
  await store.forgetDevice();
  assert.equal(storage.map.size, 0);
  assert.equal(await keys.get(), null);
  assert.equal(await store.open(workspace.id, "phrase"), null);
});

test("display helpers match the desktop", () => {
  assert.equal(maskedAccessKeyId("AKIAIOSFODNN7EXAMPLE"), "••••MPLE");
  assert.equal(maskedAccessKeyId("abcd"), "••••");
  assert.equal(defaultName("  my-bucket\u0007 "), "my-bucket");
  assert.equal(defaultName("   "), "Workspace");
});
