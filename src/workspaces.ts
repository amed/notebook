// Workspace logic without DOM or Tauri: form checks, the payload sent to
// `workspace_save`, launch routing, and the in-memory stand-in that browser
// mode (`npm run dev`) uses instead of the Rust commands. Only type imports,
// so the unit tests can load this file directly.
import type {
  IpcFailure,
  TreeSnapshot,
  WorkspaceInput,
  WorkspaceList,
  WorkspaceSummary,
} from "./ipc";

const MAX_WORKSPACE_NAME = 64;
const DEFAULT_WORKSPACE_NAME = "Workspace";

/** What the workspace forms collect. Secret fields left blank keep what is stored. */
export interface WorkspaceFormValues {
  name: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  phrase: string;
  remember: boolean;
}

interface FormProblem {
  field: keyof WorkspaceFormValues;
  message: string;
}

/** The backend's operations on workspaces; browser mode has an in-memory one. */
export interface WorkspaceStore {
  list(): Promise<WorkspaceList>;
  save(input: WorkspaceInput): Promise<WorkspaceSummary>;
  /** `leavePending`: delete although its queued edits are not uploaded (they stay on this device). */
  remove(id: string, leavePending?: boolean): Promise<WorkspaceList>;
  /** Ends the current session. Flush the open document first. */
  select(id: string): Promise<WorkspaceSummary>;
  /** Opens the active workspace; `null` means the browser sample tree. */
  unlock(phrase: string | null, remember?: boolean): Promise<TreeSnapshot | null>;
  lock(): Promise<void>;
}

type LaunchStep =
  /** No workspace yet: the first-run screen creates one. */
  | { kind: "setup" }
  /** Workspaces but none active (an earlier delete): make this one active. */
  | { kind: "select"; workspace: WorkspaceSummary }
  /** No usable S3 credentials: ask for them again. */
  | { kind: "connect"; workspace: WorkspaceSummary }
  /** Credentials and a remembered phrase: open without asking. */
  | { kind: "open"; workspace: WorkspaceSummary }
  | { kind: "unlock"; workspace: WorkspaceSummary };

const CONTROL = /\p{Cc}/u;

/** A workspace named after its bucket, as the backend names a migrated one. */
export function defaultWorkspaceName(bucket: string): string {
  const name = Array.from(bucket.trim())
    .filter((character) => !CONTROL.test(character))
    .slice(0, MAX_WORKSPACE_NAME)
    .join("")
    .trim();
  return name || DEFAULT_WORKSPACE_NAME;
}

function sameWorkspaceName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** The prefix as the backend stores it: trimmed, without outer slashes. */
export function normalizedPrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+|\/+$/g, "");
}

export function activeWorkspace(list: WorkspaceList): WorkspaceSummary | null {
  return list.workspaces.find((workspace) => workspace.id === list.active) ?? null;
}

/** The first letter of the name, for the workspace badge. */
export function workspaceInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : "W";
}

/** "bucket/prefix", plus the endpoint's host for a custom endpoint. */
export function locationLabel(workspace: Pick<WorkspaceSummary, "bucket" | "prefix" | "endpoint">): string {
  const prefix = normalizedPrefix(workspace.prefix);
  const path = prefix ? `${workspace.bucket}/${prefix}` : workspace.bucket;
  const endpoint = workspace.endpoint?.trim();
  if (!endpoint) return path;
  let host = endpoint;
  try {
    host = new URL(endpoint).host || endpoint;
  } catch {
    /* Shown as typed. */
  }
  return `${path} · ${host}`;
}

/** Whether saving `values` moves `before` to another bucket, region, prefix or endpoint. */
export function locationChanged(before: WorkspaceSummary, values: Pick<WorkspaceFormValues, "bucket" | "region" | "prefix" | "endpoint">): boolean {
  return (
    before.bucket !== values.bucket.trim() ||
    before.region !== values.region.trim() ||
    normalizedPrefix(before.prefix) !== normalizedPrefix(values.prefix) ||
    (before.endpoint?.trim() || null) !== (values.endpoint.trim() || null)
  );
}

/**
 * The first problem in a workspace form, checked before anything is sent.
 * The backend checks everything again; this only names the field to fix.
 */
export function checkWorkspaceForm(
  values: WorkspaceFormValues,
  context: {
    existing: WorkspaceSummary | null;
    others: readonly WorkspaceSummary[];
    /** The connect screen opens the workspace, so a phrase must be known. */
    requirePhrase?: boolean;
  },
): FormProblem | null {
  const name = values.name.trim();
  const length = Array.from(name).length;
  if (length === 0 || length > MAX_WORKSPACE_NAME) {
    return { field: "name", message: `Enter a workspace name of 1 to ${MAX_WORKSPACE_NAME} characters.` };
  }
  if (CONTROL.test(name)) return { field: "name", message: "The workspace name cannot contain control characters." };
  const taken = context.others.some(
    (workspace) => workspace.id !== context.existing?.id && sameWorkspaceName(workspace.name, name),
  );
  if (taken) return { field: "name", message: "Another workspace already uses this name." };
  const bucket = values.bucket.trim();
  if (!bucket || /\s|\p{Cc}/u.test(bucket)) return { field: "bucket", message: "Enter the bucket name." };
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(values.region.trim())) {
    return { field: "region", message: "Enter an AWS region such as eu-central-1." };
  }
  const endpoint = values.endpoint.trim();
  if (endpoint && !/^https?:\/\/[^\s/]+/i.test(endpoint)) {
    return { field: "endpoint", message: "Enter the endpoint as a URL, such as https://s3.example.com." };
  }
  const access = values.accessKeyId.trim();
  const secret = values.secretAccessKey;
  if (access && !secret) return { field: "secretAccessKey", message: "Enter the secret access key as well." };
  if (secret && !access) return { field: "accessKeyId", message: "Enter the access key ID as well." };
  // A token alone would be dropped (blank keys keep the stored credentials).
  if (values.sessionToken.trim() && !access) {
    return { field: "accessKeyId", message: "Enter the access key ID and secret access key with the session token." };
  }
  if (!access && !secret && !context.existing?.credentials_stored) {
    return { field: "accessKeyId", message: "Enter the access key ID and secret access key." };
  }
  if (context.requirePhrase && !values.phrase && !context.existing?.phrase_stored) {
    return { field: "phrase", message: "Enter the encryption phrase." };
  }
  return null;
}

/**
 * The `workspace_save` input for a form. With `withPhrase`, a typed phrase is
 * remembered when Remember is checked, and an unchecked Remember forgets the
 * stored phrase. Without it (the connect screen) the phrase goes to the
 * unlock instead, which stores it only once it opened the workspace.
 */
export function workspaceInput(
  values: WorkspaceFormValues,
  existing: Pick<WorkspaceSummary, "id"> | null,
  options: { withPhrase: boolean },
): WorkspaceInput {
  const input: WorkspaceInput = {
    ...(existing ? { id: existing.id } : {}),
    name: values.name,
    bucket: values.bucket,
    region: values.region,
    prefix: values.prefix,
    endpoint: values.endpoint,
    credentials: {
      access_key_id: values.accessKeyId,
      secret_access_key: values.secretAccessKey,
      session_token: values.sessionToken,
    },
  };
  if (options.withPhrase) {
    input.remember_phrase = values.remember;
    if (values.remember && values.phrase) input.phrase = values.phrase;
  }
  return workspacePayload(input);
}

/** Blank secret fields mean "keep what is stored": they are left out. */
export function workspacePayload(input: WorkspaceInput): WorkspaceInput {
  const credentials = input.credentials;
  const hasCredentials =
    !!credentials &&
    (credentials.access_key_id.trim() !== "" || credentials.secret_access_key !== "");
  return {
    ...(input.id ? { id: input.id } : {}),
    name: input.name.trim(),
    bucket: input.bucket.trim(),
    region: input.region.trim(),
    prefix: input.prefix.trim(),
    endpoint: input.endpoint?.trim() || null,
    ...(hasCredentials && credentials
      ? {
          credentials: {
            access_key_id: credentials.access_key_id.trim(),
            secret_access_key: credentials.secret_access_key,
            session_token: credentials.session_token?.trim() || null,
          },
        }
      : {}),
    ...(input.phrase ? { phrase: input.phrase } : {}),
    ...(input.remember_phrase === undefined ? {} : { remember_phrase: input.remember_phrase }),
    ...(input.leave_pending ? { leave_pending: true } : {}),
  };
}

/** Whether Remember starts checked for `workspace`: yes, unless the user last unchecked it. */
export function rememberByDefault(workspace: Pick<WorkspaceSummary, "phrase_stored" | "remember_declined"> | null): boolean {
  return !workspace || workspace.phrase_stored || !workspace.remember_declined;
}

/** Codes that stop the app before any workspace can be shown. */
export function isStartupProblem(code: string): boolean {
  return code === "PROFILE_IN_USE" || code === "CONFIG_UNREADABLE" || code === "SECRETS_UNREADABLE";
}

/** What the app shows at launch (and after a switch) for the active workspace. */
export function launchStep(list: WorkspaceList): LaunchStep {
  const active = activeWorkspace(list);
  if (!active) {
    const first = list.workspaces[0];
    return first ? { kind: "select", workspace: first } : { kind: "setup" };
  }
  if (!active.credentials_stored) return { kind: "connect", workspace: active };
  return { kind: active.phrase_stored ? "open" : "unlock", workspace: active };
}

/** Where an unlock that failed with `code` sends the user. */
export function unlockFailureStep(code: string): "connect" | "setup" | "unlock" {
  if (code === "NO_CREDENTIALS" || code === "KEYCHAIN_UNAVAILABLE") return "connect";
  if (code === "NO_WORKSPACE") return "setup";
  return "unlock";
}

/** Messages for the workspace error codes; others use the backend's safe message. */
export function workspaceErrorMessage(code: string): string | null {
  switch (code) {
    case "NO_WORKSPACE":
      return "Set up a workspace first.";
    case "WORKSPACE_CHANGED":
      return "The workspace was switched or edited meanwhile. Try again.";
    case "WORKSPACE_UNLOCKED":
      return "This workspace is open. Lock it or switch to another one before deleting it.";
    case "NO_STORED_PHRASE":
      return "No encryption phrase is remembered for this workspace. Enter it to unlock.";
    case "OUTBOX_PENDING":
      return "Some edits of this workspace are saved on this device but not uploaded to S3 yet.";
    case "PROFILE_IN_USE":
      return "Notebook is already open on this device. Switch to that window, or quit it and open Notebook again.";
    case "CONFIG_UNREADABLE":
      return "Notebook could not read its settings on this device. Nothing was changed; quit Notebook and open it again.";
    case "SECRETS_UNREADABLE":
      return "Notebook could not read the stored workspace secrets on this device. Nothing was changed; quit Notebook and open it again.";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Browser mode: the same rules as the Rust commands, kept in memory. Any
// phrase opens the sample workspace except "wrong" (WRONG_PHRASE); an unlock
// can wait `latencyMs`, as listing S3 does, so the opening state shows.

interface MemoryWorkspace {
  summary: WorkspaceSummary;
  phrase: string | null;
  /** Edits queued at its location and not uploaded (as the outbox would hold). */
  queued: boolean;
}

interface MemorySeed {
  name: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string | null;
  accessKeyId?: string;
  phrase?: string;
  /** Edits wait in its outbox: moving or deleting it asks first. */
  queued?: boolean;
}

function failure(code: string, message: string): IpcFailure {
  return { code, message };
}

function masked(accessKeyId: string): string {
  const characters = Array.from(accessKeyId);
  return characters.length > 4 ? `••••${characters.slice(-4).join("")}` : "••••";
}

export class MemoryWorkspaces implements WorkspaceStore {
  private items: MemoryWorkspace[] = [];
  private active: string | null = null;
  private unlocked = false;
  private nextId = 1;
  private readonly latencyMs: number;

  constructor(seeds: readonly MemorySeed[] = [], options: { latencyMs?: number } = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    for (const seed of seeds) {
      const id = this.newId();
      this.items.push({
        summary: {
          id,
          name: seed.name,
          bucket: seed.bucket,
          region: seed.region,
          prefix: normalizedPrefix(seed.prefix),
          endpoint: seed.endpoint ?? null,
          credentials_stored: !!seed.accessKeyId,
          phrase_stored: !!seed.phrase,
          remember_declined: false,
          masked_access_key_id: seed.accessKeyId ? masked(seed.accessKeyId) : null,
        },
        phrase: seed.phrase ?? null,
        queued: !!seed.queued,
      });
      this.active ??= id;
    }
  }

  async list(): Promise<WorkspaceList> {
    const workspaces = this.items
      .map((item) => ({ ...item.summary }))
      .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));
    return { workspaces, active: this.active };
  }

  async save(raw: WorkspaceInput): Promise<WorkspaceSummary> {
    const input = workspacePayload(raw);
    const existing = input.id ? this.items.find((item) => item.summary.id === input.id) : undefined;
    if (input.id && !existing) throw failure("INVALID_INPUT", "This workspace no longer exists.");
    const values: WorkspaceFormValues = {
      name: input.name,
      bucket: input.bucket,
      region: input.region,
      prefix: input.prefix,
      endpoint: input.endpoint ?? "",
      accessKeyId: input.credentials?.access_key_id ?? "",
      secretAccessKey: input.credentials?.secret_access_key ?? "",
      sessionToken: input.credentials?.session_token ?? "",
      phrase: input.phrase ?? "",
      remember: input.remember_phrase !== false,
    };
    // A new workspace may be saved without credentials, as in Rust.
    const problem = checkWorkspaceForm(values, {
      existing: { ...(existing?.summary ?? placeholderSummary()), credentials_stored: true },
      others: this.items.map((item) => item.summary),
    });
    if (problem) throw failure("INVALID_INPUT", problem.message);
    const item: MemoryWorkspace = existing ?? { summary: { ...placeholderSummary(), id: this.newId() }, phrase: null, queued: false };
    const moved = !!existing && locationChanged(existing.summary, values);
    // As in Rust: a new endpoint of the same bucket and prefix takes queued edits along.
    const sameObjects = !!existing && existing.summary.bucket === values.bucket.trim() && existing.summary.prefix === normalizedPrefix(values.prefix);
    if (moved && item.queued && !sameObjects) {
      if (!input.leave_pending) throw failure("OUTBOX_PENDING", "Some edits of this workspace are saved on this device but not uploaded yet.");
      item.queued = false;
    }
    const summary = item.summary;
    summary.name = input.name;
    summary.bucket = input.bucket;
    summary.region = input.region;
    summary.prefix = normalizedPrefix(input.prefix);
    summary.endpoint = input.endpoint ?? null;
    if (input.credentials) {
      summary.credentials_stored = true;
      summary.masked_access_key_id = masked(input.credentials.access_key_id);
    }
    if (input.remember_phrase === false) item.phrase = null;
    else if (input.phrase) item.phrase = input.phrase;
    if (input.remember_phrase !== undefined) summary.remember_declined = !input.remember_phrase;
    summary.phrase_stored = item.phrase !== null;
    if (!existing) this.items.push(item);
    this.active ??= summary.id;
    if (moved && summary.id === this.active) this.unlocked = false;
    return { ...summary };
  }

  async remove(id: string, leavePending = false): Promise<WorkspaceList> {
    const item = this.items.find((candidate) => candidate.summary.id === id);
    if (!item) throw failure("INVALID_INPUT", "This workspace no longer exists.");
    if (id === this.active && this.unlocked) {
      throw failure("WORKSPACE_UNLOCKED", "Lock this workspace or switch to another one before deleting it.");
    }
    if (item.queued && !leavePending) {
      throw failure("OUTBOX_PENDING", "Some edits of this workspace are saved on this device but not uploaded yet.");
    }
    this.items = this.items.filter((item) => item.summary.id !== id);
    if (this.active === id) this.active = (await this.list()).workspaces[0]?.id ?? null;
    return this.list();
  }

  async select(id: string): Promise<WorkspaceSummary> {
    const item = this.items.find((candidate) => candidate.summary.id === id);
    if (!item) throw failure("INVALID_INPUT", "This workspace no longer exists.");
    if (this.active !== id) {
      this.active = id;
      this.unlocked = false;
    }
    return { ...item.summary };
  }

  async unlock(phrase: string | null, remember?: boolean): Promise<null> {
    const item = this.items.find((candidate) => candidate.summary.id === this.active);
    if (!item) throw failure("NO_WORKSPACE", "Set up a workspace first.");
    if (!item.summary.credentials_stored) {
      throw failure("NO_CREDENTIALS", "S3 credentials are not stored for this workspace. Edit the workspace to enter them.");
    }
    if (this.latencyMs > 0) await new Promise((done) => setTimeout(done, this.latencyMs));
    const used = phrase ?? item.phrase;
    if (used === null) throw failure("NO_STORED_PHRASE", "No encryption phrase is remembered for this workspace.");
    if (used === "" || used === "wrong") {
      throw failure("WRONG_PHRASE", "This encryption phrase does not open the workspace.");
    }
    if (remember === true && phrase !== null) item.phrase = phrase;
    if (remember === false) item.phrase = null;
    if (remember !== undefined) item.summary.remember_declined = !remember;
    item.summary.phrase_stored = item.phrase !== null;
    this.unlocked = true;
    return null;
  }

  async lock(): Promise<void> {
    this.unlocked = false;
  }

  private newId(): string {
    return `memory-${this.nextId++}`;
  }
}

function placeholderSummary(): WorkspaceSummary {
  return {
    id: "",
    name: "",
    bucket: "",
    region: "",
    prefix: "",
    endpoint: null,
    credentials_stored: false,
    phrase_stored: false,
    remember_declined: false,
    masked_access_key_id: null,
  };
}
