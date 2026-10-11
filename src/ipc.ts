import { invoke } from "@tauri-apps/api/core";
import { type PanelLayout, type PanelLayoutWire, layoutFromWire } from "./panel-layout";
import { zoomFromWire } from "./preview-zoom";
import { type Accent, DEFAULT_ACCENT, isAccent } from "./theme";
import { workspacePayload } from "./workspaces";

export type ThemePreference = "System" | "Light" | "Dark";

/** `config_get`: the global preferences and the active workspace (if any). */
interface VaultConfig {
  workspace_id?: string | null;
  workspace_name?: string | null;
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string | null;
  auto_lock_minutes: number;
  theme: ThemePreference;
  accent: Accent;
  /** Pane sizes; configs written before them get the defaults. */
  layout: PanelLayout;
  /** The preview zoom in percent (config.json "layout".preview_zoom); 100 when missing. */
  preview_zoom: number;
  credentials_stored: boolean;
  /** The active workspace's encryption phrase is remembered on this device. */
  phrase_stored?: boolean;
  masked_access_key_id?: string | null;
}

/** A named S3 location. Secrets are reported only as stored or not. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string | null;
  credentials_stored: boolean;
  phrase_stored: boolean;
  /** Remember was last unchecked for this workspace: the unlock screen offers it unchecked. */
  remember_declined: boolean;
  masked_access_key_id: string | null;
}

/** `workspaces_list`: the workspaces in name order and the active id. */
export interface WorkspaceList {
  workspaces: WorkspaceSummary[];
  active: string | null;
}

/**
 * `workspace_save`: without `id` a workspace is created (the first one becomes
 * active). An absent `credentials` or `phrase` keeps what is stored;
 * `remember_phrase: false` forgets the stored phrase. `leave_pending` saves a
 * new location although edits queued at the old one are not uploaded yet
 * (otherwise `OUTBOX_PENDING`).
 */
export interface WorkspaceInput {
  id?: string;
  name: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string | null;
  credentials?: CredentialsInput;
  phrase?: string;
  remember_phrase?: boolean;
  leave_pending?: boolean;
}

interface CredentialsInput {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string | null;
}

export type NodeKindName =
  | "Root"
  | "Trash"
  | "Folder"
  | "Document"
  | "TrashEntry"
  | "TrashOrigin";

/** A Trash entry as Notebook lists it. Paths are workspace-relative. */
interface OriginSummary {
  name: string;
  original_path: string;
  /** The original parent folder; "" is the workspace root. */
  location: string;
  /** Unix milliseconds; null when unknown (entries of earlier builds). */
  deleted_at: number | null;
  item_kind: "Folder" | "Document";
  /** Notebook's "N items": every file and folder below a deleted folder. */
  item_count: number;
  doc_count: number;
  folder_count: number;
  image_count: number;
  legacy: boolean;
}

/** Ids derive from kind and path: a renamed or moved item is a new node. */
export interface TreeNode {
  id: string;
  parent: string | null;
  name: string;
  kind: NodeKindName | Record<string, unknown>;
  origin?: OriginSummary | null;
  trash_entry_id?: string | null;
}

export interface TreeSnapshot {
  nodes: TreeNode[];
  root_id?: string;
  trash_id?: string;
  /** The tree version; a delta applies only to the version it starts from. */
  version?: number;
}

/** A change's effect on the tree: version `from` becomes `to`. */
export interface TreeDelta {
  from: number;
  to: number;
  upsert: TreeNode[];
  remove: string[];
}

interface CreatedNode {
  id: string;
  final_name?: string;
  tree?: TreeDelta;
}

interface TrashResult {
  entry_id: string;
  tree?: TreeDelta;
}

export interface RestoreResult {
  restored_id?: string;
  final_name?: string;
  final_path?: string;
  tree?: TreeDelta;
}

interface PurgeResult {
  documents: number;
  folders: number;
  images: number;
  tree?: TreeDelta;
}

/** "Original" restores to the original path; `To` names a folder id. */
type RestoreMode = "Original" | { To: string };

interface OpenDocument {
  /** Null when `knownRev` was this text's rev: the editor still holds it. */
  text: string | null;
  /** The text's SHA-256 (hex), passed back as `knownRev`. */
  rev: string;
  read_only: boolean;
  rollback_warning: boolean;
  /** The text is an edit from the local outbox that S3 does not hold yet. */
  dirty: boolean;
}

/**
 * `document_window_info`: what a document window shows, answered by its
 * label (window.rs), never by its URL.
 */
interface DocumentWindowInfo {
  id: string;
  name: string;
  /** The document's vault path ("Notes/plan.md"); its preview's relative links start in its folder. */
  path: string;
  theme: ThemePreference;
  accent: Accent;
  /** The global preview zoom in percent. */
  preview_zoom: number;
}

/** `document-link`: a document window's preview link (`nb-doc:` / `nb-wiki:`) for the main window, from the folder of `from`. */
export interface DocumentLink {
  from: string;
  href: string;
}

/** `document-window-moved`: a rename, move or conflict copy gave the window's document a new id. */
export interface HeldMove {
  from: string;
  to: string;
  name: string;
}

interface SaveResult {
  status: "Saved" | "Offline" | "ConflictCopy";
  document_id?: string | null;
  /** A conflict copy joined the tree. */
  tree?: TreeDelta;
}

interface PassphraseChangeResult {
  cleanup_pending: boolean;
}

export interface IpcFailure {
  code: string;
  message: string;
}

function optionalString(value: string): string | null {
  const clean = value.trim();
  return clean.length > 0 ? clean : null;
}

function normalizeConfig(raw: Omit<VaultConfig, "layout" | "preview_zoom"> & { layout?: unknown }): VaultConfig {
  const record = raw as VaultConfig & {
    autoLockMinutes?: number;
    credentialsStored?: boolean;
    maskedAccessKeyId?: string | null;
  };
  return {
    workspace_id: raw.workspace_id ?? null,
    workspace_name: raw.workspace_name ?? null,
    bucket: raw.bucket ?? "",
    region: raw.region ?? "",
    prefix: raw.prefix ?? "",
    endpoint: raw.endpoint ?? null,
    auto_lock_minutes: raw.auto_lock_minutes ?? record.autoLockMinutes ?? 15,
    theme: raw.theme ?? "System",
    accent: isAccent(raw.accent) ? raw.accent : DEFAULT_ACCENT,
    layout: layoutFromWire(raw.layout),
    preview_zoom: zoomFromWire(raw.layout),
    credentials_stored:
      raw.credentials_stored ?? record.credentialsStored ?? false,
    phrase_stored: raw.phrase_stored ?? false,
    masked_access_key_id:
      raw.masked_access_key_id ?? record.maskedAccessKeyId ?? null,
  };
}

function normalizeSnapshot(raw: TreeSnapshot | TreeNode[]): TreeSnapshot {
  return Array.isArray(raw) ? { nodes: raw } : raw;
}

// In tree-model.ts, which has no runtime imports, so Node's unit tests can load it.
export { kindName } from "./tree-model";

export function isIpcFailure(value: unknown): value is IpcFailure {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && typeof record.message === "string";
}

export function errorCode(value: unknown): string {
  if (isIpcFailure(value)) return value.code;
  if (typeof value === "object" && value !== null) {
    const code = (value as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return "UNKNOWN";
}

/** Only backend-declared safe messages are shown. Arbitrary thrown values are hidden. */
export function safeErrorMessage(
  value: unknown,
  fallback = "The operation could not be completed.",
): string {
  if (isIpcFailure(value) && value.message.trim().length > 0) {
    return value.message;
  }
  if (typeof value === "object" && value !== null) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string" && message.length <= 240) return message;
  }
  return fallback;
}

export const ipc = {
  configGet: async (): Promise<VaultConfig> =>
    normalizeConfig(await invoke<Omit<VaultConfig, "layout" | "preview_zoom"> & { layout?: unknown }>("config_get")),

  /** Pane sizes or the preview zoom, saved with the global preferences (Rust keeps the values not given); never an S3 request. */
  layoutSet: async (layout: Partial<PanelLayoutWire & { preview_zoom: number }>): Promise<void> => invoke("layout_set", { ...layout }),

  settingsSet: async (
    autoLockMinutes: number,
    theme: ThemePreference,
    accent: Accent,
  ): Promise<void> => invoke("settings_set", { autoLockMinutes, theme, accent }),

  /**
   * Without `passphrase` the remembered phrase is used (`NO_STORED_PHRASE` when
   * none). `remember: true` stores a typed phrase after a successful unlock,
   * `false` forgets the stored one, absent leaves it as it is.
   */
  vaultUnlock: async (passphrase?: string | null, remember?: boolean): Promise<TreeSnapshot> =>
    normalizeSnapshot(
      await invoke<TreeSnapshot | TreeNode[]>("vault_unlock", {
        passphrase: passphrase ?? null,
        remember: remember ?? null,
      }),
    ),

  workspacesList: async (): Promise<WorkspaceList> => invoke<WorkspaceList>("workspaces_list"),
  workspaceSave: async (input: WorkspaceInput): Promise<WorkspaceSummary> =>
    invoke<WorkspaceSummary>("workspace_save", { workspace: workspacePayload(input) }),
  /**
   * Refused (`WORKSPACE_UNLOCKED`) for the active workspace while unlocked, and
   * (`OUTBOX_PENDING`) while edits queued for its location are not uploaded,
   * unless `leavePending` keeps them on this device.
   */
  workspaceDelete: async (id: string, leavePending = false): Promise<WorkspaceList> =>
    invoke<WorkspaceList>("workspace_delete", { id, leavePending }),
  /** Ends the current session: flush the open document first. */
  workspaceSelect: async (id: string): Promise<WorkspaceSummary> =>
    invoke<WorkspaceSummary>("workspace_select", { id }),

  vaultLock: async (): Promise<void> => invoke("vault_lock"),
  passphraseChange: async (
    oldPassphrase: string,
    newPassphrase: string,
  ): Promise<PassphraseChangeResult> =>
    invoke("passphrase_change", { oldPassphrase, newPassphrase }),
  activityPing: async (): Promise<void> => invoke("activity_ping"),

  /** `relist`: list S3 again (the Refresh button); otherwise the session's own tree, no request. */
  treeGet: async (relist: boolean): Promise<TreeSnapshot> =>
    normalizeSnapshot(await invoke<TreeSnapshot | TreeNode[]>("tree_get", { relist })),

  folderCreate: async (parentId: string, name?: string): Promise<CreatedNode> =>
    invoke("folder_create", { parentId, name: name ? optionalString(name) : null }),
  /** One parallel round: the document, plus a marker per missing folder in `folders`. */
  docCreate: async (parentId: string, name?: string, text?: string, folders: string[] = []): Promise<CreatedNode> =>
    invoke("doc_create", { parentId, name: name ? optionalString(name) : null, text: text ?? null, folders }),
  /** Ids follow the path, so the renamed or moved item has the returned id. */
  nodeRename: async (id: string, name: string): Promise<CreatedNode> =>
    invoke("node_rename", { id, name }),
  nodeMove: async (id: string, newParentId: string): Promise<CreatedNode> =>
    invoke("node_move", { id, newParentId }),
  nodeTrash: async (id: string): Promise<TrashResult> => invoke("node_trash", { id }),

  trashRestore: async (
    entryId: string,
    mode: RestoreMode,
    name?: string,
  ): Promise<RestoreResult> =>
    invoke("trash_restore", { entryId, mode, name: name ?? null }),
  trashPurge: async (entryIds: string[]): Promise<PurgeResult> =>
    invoke("trash_purge", { entryIds }),
  trashEmpty: async (): Promise<PurgeResult> => invoke("trash_empty"),

  docOpen: async (id: string, knownRev: string | null = null): Promise<OpenDocument> =>
    invoke("doc_open", { id, knownRev }),
  /** Writes the edit to the encrypted local outbox; no S3 request. `rev`: the text's, as doc_open gives it. */
  docStage: async (id: string, text: string): Promise<{ status: "Clean" | "Staged"; rev: string }> =>
    invoke("doc_stage", { id, text }),
  /** Uploads the staged edit, if any (otherwise no S3 request). */
  docCommit: async (id: string): Promise<SaveResult> => invoke("doc_commit", { id }),
  /** Uploads every staged edit and any outbox entry left from earlier. */
  flushAll: async (): Promise<void> => invoke("flush_all"),

  imageAdd: async (bytes: Uint8Array, filename: string): Promise<string> =>
    invoke("image_add", { bytes, filename }),
  previewRender: async (text: string): Promise<string> =>
    invoke<string>("preview_render", { text }),
  linkOpen: async (url: string): Promise<void> => invoke("link_open", { url }),
  /** Main window: `documentId` moves to a window of its own, which writes it (or that window is shown). */
  openDocumentWindow: async (documentId: string): Promise<void> =>
    invoke("open_document_window", { documentId }),
  /** Main window: every document window saves and closes (lock, switch, quit); fails when one stays open. */
  documentWindowsClose: async (): Promise<void> => invoke("document_windows_close"),
  documentWindowInfo: async (): Promise<DocumentWindowInfo> => {
    const info = await invoke<DocumentWindowInfo>("document_window_info");
    const theme: ThemePreference = info.theme === "Light" || info.theme === "Dark" ? info.theme : "System";
    return { ...info, theme, accent: isAccent(info.accent) ? info.accent : DEFAULT_ACCENT, preview_zoom: zoomFromWire(info) };
  },
  /** A document window: the main window opens the vault document `href` links to, from this window's document, and comes to the front. */
  documentLinkOpen: async (href: string): Promise<void> => invoke("document_link_open", { href }),
  /** A document window's Close window button: it closes itself (through the close guard), never another window. */
  documentWindowClose: async (): Promise<void> => invoke("document_window_close"),
  /** A document window wrote its pending edit to the outbox, as Rust asked (`request`). */
  documentWindowFlushed: async (request: number): Promise<void> =>
    invoke("document_window_flushed", { request }),
  /** Ends a close that waited for the open document to be saved. */
  closeAfterFlush: async (): Promise<void> => invoke("close_after_flush"),
  cancelClose: async (): Promise<void> => invoke("cancel_close"),
};
