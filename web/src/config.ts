// The web version's configuration, kept in the browser like the desktop app
// keeps it on disk (src-tauri/src/notebook/workspaces.rs and secrets.rs):
// - localStorage "notebook.config.v2": the desktop's config.json v2 object,
//   same field names and meaning (version, auto_lock_minutes, theme, accent,
//   active_workspace, workspaces[{id, name, bucket, region, prefix,
//   endpoint, masked_access_key_id, remember_declined}]). Nothing secret.
// - localStorage "notebook.secrets.v1": the desktop's secrets.json shape,
//   {version: 1, workspaces: {<id>: {s3?, phrase?}}}, each value
//   base64(nonce || AES-256-GCM ciphertext and tag), sealed under a
//   non-extractable WebCrypto key kept in IndexedDB (the browser's stand-in
//   for the keychain-held master key) with the desktop's context
//   "notebook::secrets::v1::<workspace>::<field>" as associated data, so a
//   value copied to another workspace or field fails to open. The s3 value is
//   the desktop's StoredCredentials JSON.
// The storage and key store are injected, so tests/web runs this in Node.

import { base64Decode, base64Encode, concat, fromUtf8, utf8 } from "./bytes.ts";

export const CONFIG_KEY = "notebook.config.v2";
export const SECRETS_KEY = "notebook.secrets.v1";
export const CONFIG_VERSION = 2;
const SECRETS_VERSION = 1;
const NONCE_LEN = 12;
const MAX_NAME_CHARS = 64;
const THEMES = ["System", "Light", "Dark"] as const;
const ACCENTS = ["orange", "red", "pink", "purple", "blue", "teal", "green", "yellow", "graphite"] as const;

export type Theme = (typeof THEMES)[number];
export type SecretField = "s3" | "phrase";

export interface WorkspaceConfig {
  id: string;
  name: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string | null;
  masked_access_key_id?: string;
  remember_declined?: boolean;
}

export interface AppConfig {
  version: 2;
  auto_lock_minutes: number;
  theme: Theme;
  accent: string;
  active_workspace: string | null;
  workspaces: WorkspaceConfig[];
}

/** The desktop's StoredCredentials, field for field. */
export interface StoredCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token: string | null;
}

interface SecretsFile {
  version: number;
  workspaces: Record<string, { s3?: string; phrase?: string }>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where the sealing key lives. `get` never creates one. */
export interface KeyStore {
  get(): Promise<CryptoKey | null>;
  create(): Promise<CryptoKey>;
  destroy(): Promise<void>;
}

export function defaultConfig(): AppConfig {
  return { version: CONFIG_VERSION, auto_lock_minutes: 15, theme: "System", accent: "orange", active_workspace: null, workspaces: [] };
}

/** "••••MPLE", as the desktop shows an access key ID. */
export function maskedAccessKeyId(value: string): string {
  const chars = Array.from(value);
  return chars.length > 4 ? `••••${chars.slice(-4).join("")}` : "••••";
}

/** The name a workspace gets from its bucket (desktop `default_name`). */
export function defaultName(bucket: string): string {
  const name = Array.from(bucket.trim()).filter((char) => !/\p{Cc}/u.test(char)).slice(0, MAX_NAME_CHARS).join("").trim();
  return name || "Workspace";
}

const isString = (value: unknown): value is string => typeof value === "string";

function workspaceFrom(value: unknown): WorkspaceConfig | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isString(raw.id) || !raw.id || !isString(raw.name) || !isString(raw.bucket) || !isString(raw.region)) return null;
  const workspace: WorkspaceConfig = {
    id: raw.id,
    name: raw.name,
    bucket: raw.bucket,
    region: raw.region,
    prefix: isString(raw.prefix) ? raw.prefix : "",
    endpoint: isString(raw.endpoint) && raw.endpoint.trim() ? raw.endpoint : null,
  };
  if (isString(raw.masked_access_key_id)) workspace.masked_access_key_id = raw.masked_access_key_id;
  if (raw.remember_declined === true) workspace.remember_declined = true;
  return workspace;
}

/**
 * Reads a stored config the way the desktop's `parse_config` does: a newer
 * version is refused (null), out-of-range preferences fall back to their
 * defaults, and an active workspace that does not exist is cleared.
 */
export function parseConfig(text: string | null): AppConfig | null {
  if (!text) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || typeof raw.version !== "number" || raw.version > CONFIG_VERSION) return null;
  const config = defaultConfig();
  if (typeof raw.auto_lock_minutes === "number" && Number.isInteger(raw.auto_lock_minutes) && raw.auto_lock_minutes >= 0 && raw.auto_lock_minutes <= 1440) {
    config.auto_lock_minutes = raw.auto_lock_minutes;
  }
  if ((THEMES as readonly unknown[]).includes(raw.theme)) config.theme = raw.theme as Theme;
  if ((ACCENTS as readonly unknown[]).includes(raw.accent)) config.accent = raw.accent as string;
  const seen = new Set<string>();
  for (const item of Array.isArray(raw.workspaces) ? raw.workspaces : []) {
    const workspace = workspaceFrom(item);
    if (workspace && !seen.has(workspace.id)) {
      seen.add(workspace.id);
      config.workspaces.push(workspace);
    }
  }
  if (isString(raw.active_workspace) && seen.has(raw.active_workspace)) config.active_workspace = raw.active_workspace;
  return config;
}

function context(workspace: string, field: SecretField): Uint8Array<ArrayBuffer> {
  return utf8(`notebook::secrets::v${SECRETS_VERSION}::${workspace}::${field}`);
}

export class LocalStore {
  private readonly storage: StorageLike;
  private readonly keys: KeyStore;

  constructor(storage: StorageLike, keys: KeyStore) {
    this.storage = storage;
    this.keys = keys;
  }

  loadConfig(): AppConfig {
    return parseConfig(this.storage.getItem(CONFIG_KEY)) ?? defaultConfig();
  }

  saveConfig(config: AppConfig): void {
    this.storage.setItem(CONFIG_KEY, JSON.stringify(config, null, 2));
  }

  private secrets(): SecretsFile {
    try {
      const parsed = JSON.parse(this.storage.getItem(SECRETS_KEY) ?? "null") as SecretsFile | null;
      if (parsed && parsed.version === SECRETS_VERSION && parsed.workspaces && typeof parsed.workspaces === "object") return parsed;
    } catch {
      /* A damaged file holds nothing usable. */
    }
    return { version: SECRETS_VERSION, workspaces: {} };
  }

  private writeSecrets(file: SecretsFile): void {
    if (Object.keys(file.workspaces).length === 0) this.storage.removeItem(SECRETS_KEY);
    else this.storage.setItem(SECRETS_KEY, JSON.stringify(file, null, 2));
  }

  has(workspace: string, field: SecretField): boolean {
    return Boolean(this.secrets().workspaces[workspace]?.[field]);
  }

  /** Seals `plaintext` for `workspace`'s `field`, creating the device key on first use. */
  async seal(workspace: string, field: SecretField, plaintext: string): Promise<void> {
    const key = (await this.keys.get()) ?? (await this.keys.create());
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LEN));
    const message = utf8(plaintext);
    const sealed = new Uint8Array(
      await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: context(workspace, field) }, key, message),
    );
    message.fill(0);
    const file = this.secrets();
    const entry = (file.workspaces[workspace] ??= {});
    entry[field] = base64Encode(concat(nonce, sealed));
    this.writeSecrets(file);
  }

  /** The plaintext of `field`, or null when it is not stored or no longer opens (another key or context, tampering). */
  async open(workspace: string, field: SecretField): Promise<string | null> {
    const stored = this.secrets().workspaces[workspace]?.[field];
    if (!stored) return null;
    const key = await this.keys.get();
    const bytes = base64Decode(stored);
    if (!key || !bytes || bytes.length < NONCE_LEN + 16) return null;
    try {
      const plain = new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes.slice(0, NONCE_LEN), additionalData: context(workspace, field) },
          key,
          bytes.slice(NONCE_LEN),
        ),
      );
      const text = fromUtf8(plain);
      plain.fill(0);
      return text;
    } catch {
      return null;
    }
  }

  async saveCredentials(workspace: string, credentials: StoredCredentials): Promise<void> {
    await this.seal(workspace, "s3", JSON.stringify(credentials));
  }

  async openCredentials(workspace: string): Promise<StoredCredentials | null> {
    const text = await this.open(workspace, "s3");
    if (!text) return null;
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      if (!isString(raw.access_key_id) || !isString(raw.secret_access_key)) return null;
      return { access_key_id: raw.access_key_id, secret_access_key: raw.secret_access_key, session_token: isString(raw.session_token) ? raw.session_token : null };
    } catch {
      return null;
    }
  }

  removeSecrets(workspace: string): void {
    const file = this.secrets();
    delete file.workspaces[workspace];
    this.writeSecrets(file);
  }

  /** "Forget this device": the config, every sealed secret and the sealing key. */
  async forgetDevice(): Promise<void> {
    this.storage.removeItem(SECRETS_KEY);
    this.storage.removeItem(CONFIG_KEY);
    await this.keys.destroy();
  }
}

/** Keys in memory only (tests, and browsers without IndexedDB: nothing is remembered across reloads). */
export class MemoryKeyStore implements KeyStore {
  private key: CryptoKey | null = null;

  async get(): Promise<CryptoKey | null> {
    return this.key;
  }

  async create(): Promise<CryptoKey> {
    this.key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return this.key;
  }

  async destroy(): Promise<void> {
    this.key = null;
  }
}

const DB_NAME = "notebook-web";
const DB_STORE = "keys";
const KEY_ID = "secrets-master-key";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** A non-extractable AES-GCM key in IndexedDB: script can use it, never read its bytes. */
export class IndexedDbKeyStore implements KeyStore {
  private open(): Promise<IDBDatabase> {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    return request(req);
  }

  async get(): Promise<CryptoKey | null> {
    const db = await this.open();
    try {
      const key = await request(db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(KEY_ID));
      return key instanceof CryptoKey ? key : null;
    } finally {
      db.close();
    }
  }

  async create(): Promise<CryptoKey> {
    const key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const db = await this.open();
    try {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(key, KEY_ID);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      });
    } finally {
      db.close();
    }
    return key;
  }

  async destroy(): Promise<void> {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
}

/** Whether this browser can keep a sealing key across reloads. */
export async function persistentKeysAvailable(): Promise<boolean> {
  try {
    if (typeof indexedDB === "undefined") return false;
    const db = await request(indexedDB.open(`${DB_NAME}-probe`, 1));
    db.close();
    indexedDB.deleteDatabase(`${DB_NAME}-probe`);
    return true;
  } catch {
    return false;
  }
}
