// The web version's whole UI: connect, unlock, browse, read, edit and save.
// It reuses the desktop's modules (theme.css and theme.ts, the CodeMirror
// editor, the HTML preview frame, the navigation guards, the tree model,
// vault links, new-file path rules) and adds only what the browser needs:
// web/src/vault.ts in place of the Rust commands, web/src/config.ts in place
// of config.json, secrets.json and the keychain.
// Nothing here logs: no secret, name or note text reaches the console.

// The editor (CodeMirror, most of the bundle) loads on the first Edit: reading needs none of it.
import type { DocumentLanguage, Editor } from "../../src/editor/editor.ts";
import { HtmlPreview } from "../../src/html-preview.ts";
import { installNavigationGuards, MAX_LINK_LENGTH, openInBrowserTab, previewTarget, scrollPaneTo, setExternalLinkHandler, setInternalLinkHandler } from "../../src/navigation.ts";
import { applyAccent, isAccent, setTheme } from "../../src/theme.ts";
import { ROOT_ID } from "../../src/tree-model.ts";
import { icon } from "../../src/ui/primitives.ts";
import { parseInternalHref, resolveInternalLink, VaultIndex } from "../../src/vault-links.ts";
import { countText } from "../../src/word-count.ts";
import { CodecError, NotebookV1Codec } from "./codec.ts";
import {
  type AppConfig, defaultName, IndexedDbKeyStore, LocalStore, maskedAccessKeyId, MemoryKeyStore,
  persistentKeysAvailable, type StoredCredentials, type WorkspaceConfig,
} from "./config.ts";
import { TEST_NOTEBOOK } from "../dev/test-notebook.ts";
import { renderMarkdown } from "./markdown.ts";
import { locationProblem, normalizedPrefix, S3Client, type S3Location } from "./s3.ts";
import { documentId, documentLanguage, fileName, folderId, parentPath, Vault } from "./vault.ts";

type Mode = "preview" | "edit" | "split";
/** The last open note per workspace, as its S3 key (ciphertext), never its name. */
const LAST_NOTE_KEY = "notebook.web.last.v1";
/** Like iOS Notes: edits are saved after a short pause, and when the app goes to the background. */
const AUTOSAVE_DELAY_MS = 2500;
type Child = Node | string | null | undefined | false;

interface OpenDocument {
  id: string;
  path: string;
  language: DocumentLanguage;
  etag: string;
  /** The text as last saved or opened, line endings as the editor keeps them (LF). */
  saved: string;
}

interface ConnectValues {
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

const PHONE = "(max-width: 640px)";
const WIDE = "(min-width: 1100px)";
const SEARCH_LIMIT = 200;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (name === "class") element.className = String(value);
    else if (name === "text") element.textContent = String(value);
    else element.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

function iconButton(name: Parameters<typeof icon>[0], label: string, extra = ""): HTMLButtonElement {
  const button = h("button", { type: "button", class: `icon-button web-icon-button ${extra}`.trim(), "aria-label": label, title: label });
  button.append(icon(name));
  return button;
}

function menuIcon(): HTMLSpanElement {
  const span = h("span", { class: "icon", "aria-hidden": "true" });
  // Static markup, the same kind as src/ui/primitives.ts icons.
  span.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  return span;
}

function message(error: unknown): string {
  if (error instanceof CodecError) return error.code === "EMPTY_PHRASE" ? "Enter the encryption phrase." : "The data could not be decrypted.";
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

function field(label: string, input: HTMLInputElement, hint?: string): HTMLLabelElement {
  return h("label", { class: "field" }, label, hint ? h("span", { class: "field-hint", text: hint }) : null, input);
}

function textInput(name: string, props: Record<string, string | boolean | undefined> = {}): HTMLInputElement {
  return h("input", { name, type: "text", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", ...props });
}

export class App {
  private readonly root: HTMLElement;
  private store!: LocalStore;
  private config!: AppConfig;
  private persistent = false;
  private vault: Vault | null = null;
  private workspace: WorkspaceConfig | null = null;
  /** In memory while unlocked, for the next unlock after Lock when nothing is remembered. */
  private credentials: StoredCredentials | null = null;
  private editor: Editor | null = null;
  private readonly html = new HtmlPreview((url) => this.confirmLink(url));
  private doc: OpenDocument | null = null;
  private mode: Mode = "preview";
  private readonly expanded = new Set<string>();
  /** Where New note and New folder go: a folder's logical path, "" for the root. */
  private folder = "";
  private query = "";
  private saving: Promise<boolean> | null = null;
  private editorLoading: Promise<void> | null = null;
  private previewTimer: number | undefined;
  private autosaveTimer: number | undefined;
  /** The first open after unlock reopens the last note in the editor on every screen size. */
  private restoring = false;
  private els: {
    shell: HTMLElement; sidebar: HTMLElement; main: HTMLElement; tree: HTMLElement; search: HTMLInputElement;
    title: HTMLElement; crumbs: HTMLElement; docArea: HTMLElement; editorHost: HTMLElement; preview: HTMLElement;
    empty: HTMLElement; status: HTMLElement; save: HTMLButtonElement; modeButton: HTMLButtonElement;
    splitButton: HTMLButtonElement; counts: HTMLElement; menu: HTMLButtonElement;
  } | null = null;
  private readonly phone = matchMedia(PHONE);
  private readonly wide = matchMedia(WIDE);

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start(): Promise<void> {
    installNavigationGuards();
    setExternalLinkHandler((url) => this.confirmLink(url));
    setInternalLinkHandler((href) => void this.followInternalLink(href));
    this.fitViewport();
    this.persistent = await persistentKeysAvailable();
    this.store = new LocalStore(window.localStorage, this.persistent ? new IndexedDbKeyStore() : new MemoryKeyStore());
    this.config = this.store.loadConfig();
    setTheme(this.config.theme);
    applyAccent(isAccent(this.config.accent) ? this.config.accent : "orange");
    document.addEventListener("keydown", (event) => this.onKey(event), { capture: true });
    window.addEventListener("beforeunload", (event) => {
      if (this.dirty()) event.preventDefault();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && this.dirty()) void this.save();
    });
    window.addEventListener("pagehide", () => {
      if (this.dirty()) void this.save();
    });
    this.phone.addEventListener("change", () => this.syncDrawer());
    this.wide.addEventListener("change", () => {
      if (!this.wide.matches && this.mode === "split") this.setMode("edit");
      this.renderModeButtons();
    });
    const workspace = this.activeWorkspace();
    if (!workspace) this.renderConnect();
    else if (this.store.has(workspace.id, "s3") && this.store.has(workspace.id, "phrase")) void this.openRemembered(workspace);
    else this.renderUnlock(workspace);
  }

  /** The iOS keyboard shrinks the visual viewport, not the layout: the shell follows it. */
  private fitViewport(): void {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const fit = (): void => {
      const style = document.documentElement.style;
      style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
      style.setProperty("--app-top", `${Math.round(viewport.offsetTop)}px`);
    };
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    fit();
  }

  private activeWorkspace(): WorkspaceConfig | null {
    const id = this.config.active_workspace;
    return this.config.workspaces.find((workspace) => workspace.id === id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Connect, unlock, open

  private authScreen(title: string, intro: string, ...content: Child[]): HTMLElement {
    const logo = h("div", { class: "auth-logo" });
    logo.append(icon("lock"));
    const card = h("div", { class: "auth-card web-auth-card" }, logo, h("h1", { text: title }), h("p", { text: intro }), ...content);
    const screen = h("main", { class: "auth-screen web-auth" }, card);
    this.els = null;
    this.root.replaceChildren(screen);
    return card;
  }

  private secureNote(): HTMLElement {
    const shield = h("span");
    shield.append(icon("shield"));
    return h("div", { class: "secure-note" }, shield, h("span", {
      text: "Names and notes are encrypted in this browser before they reach S3, in the desktop app's format. Remembered credentials and the phrase are sealed with a key this browser cannot export.",
    }));
  }

  private renderConnect(problem = ""): void {
    const inputs = {
      bucket: textInput("bucket", { required: true }),
      region: textInput("region", { value: "eu-central-1", required: true }),
      prefix: textInput("prefix", { placeholder: "Optional, for example notes" }),
      endpoint: textInput("endpoint", { type: "url", placeholder: "Optional, https://… for S3-compatible storage", inputmode: "url" }),
      accessKeyId: textInput("access-key-id", { required: true }),
      secretAccessKey: textInput("secret-access-key", { type: "password", required: true, autocomplete: "new-password" }),
      sessionToken: textInput("session-token", { type: "password", placeholder: "Optional", autocomplete: "off" }),
      phrase: textInput("phrase", { type: "password", required: true, autocomplete: "new-password" }),
    };
    // `npm run dev:web` only: the dev server's test notebook (web/dev/), one tap on Connect away.
    if (import.meta.env.DEV) {
      inputs.bucket.value = TEST_NOTEBOOK.bucket;
      inputs.region.value = TEST_NOTEBOOK.region;
      inputs.endpoint.value = `${location.origin}${TEST_NOTEBOOK.path}`;
      inputs.accessKeyId.value = TEST_NOTEBOOK.accessKeyId;
      inputs.secretAccessKey.value = TEST_NOTEBOOK.secretAccessKey;
      inputs.phrase.value = TEST_NOTEBOOK.phrase;
    }
    const remember = h("input", { type: "checkbox", name: "remember", checked: this.persistent, disabled: !this.persistent });
    const error = h("p", { class: "error web-form-error", role: "alert", text: problem });
    const submit = h("button", { type: "submit", class: "button button-primary", text: "Connect" });
    const form = h("form", { class: "form-grid web-connect", novalidate: true },
      field("Bucket", inputs.bucket),
      field("Region", inputs.region),
      field("Prefix", inputs.prefix, "optional"),
      field("Endpoint", inputs.endpoint, "optional"),
      h("div", { class: "form-section", text: "Credentials" }),
      field("Access key ID", inputs.accessKeyId),
      field("Secret access key", inputs.secretAccessKey),
      field("Session token", inputs.sessionToken, "optional"),
      h("div", { class: "form-section", text: "Encryption" }),
      field("Encryption phrase", inputs.phrase),
      h("label", { class: "check-field" }, remember, h("span", {},
        "Remember on this device",
        h("span", { class: "field-hint field-hint-block", text: this.persistent
          ? "Turn off on shared devices: nothing is stored and you sign in again next time."
          : "This browser cannot keep a sealed key, so nothing is remembered." }))),
      error,
      h("div", { class: "auth-actions" }, submit),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values: ConnectValues = {
        name: "", bucket: inputs.bucket.value.trim(), region: inputs.region.value.trim(), prefix: inputs.prefix.value,
        endpoint: inputs.endpoint.value.trim(), accessKeyId: inputs.accessKeyId.value.trim(), secretAccessKey: inputs.secretAccessKey.value.trim(),
        sessionToken: inputs.sessionToken.value.trim(), phrase: inputs.phrase.value, remember: remember.checked,
      };
      void this.busy(form, submit, "Connecting…", error, () => this.connect(values, null));
    });
    const origin = h("p", { class: "field-hint web-origin" }, "The bucket's CORS rule must allow this site: ", h("code", { text: location.origin }));
    this.authScreen("Connect your workspace", "Open an S3 bucket written by Notebook, or start an empty one. The same bucket and phrase open in the desktop app.", form, origin, this.secureNote());
    inputs.bucket.focus();
  }

  private renderUnlock(workspace: WorkspaceConfig, problem = ""): void {
    const storedCredentials = this.store.has(workspace.id, "s3");
    const accessKeyId = textInput("access-key-id", { required: true });
    const secretAccessKey = textInput("secret-access-key", { type: "password", required: true, autocomplete: "current-password" });
    const sessionToken = textInput("session-token", { type: "password", placeholder: "Optional" });
    const phrase = textInput("phrase", { type: "password", required: true, autocomplete: "current-password" });
    const remember = h("input", { type: "checkbox", name: "remember", checked: this.persistent && !workspace.remember_declined, disabled: !this.persistent });
    const error = h("p", { class: "error web-form-error", role: "alert", text: problem });
    const submit = h("button", { type: "submit", class: "button button-primary", text: "Unlock" });
    const forget = h("button", { type: "button", class: "button button-ghost web-danger-text", text: "Forget this device" });
    const needCredentials = !storedCredentials && !this.credentials;
    const remembered = this.store.has(workspace.id, "phrase") && storedCredentials;
    const open = remembered ? h("button", { type: "button", class: "button web-open-remembered", text: "Open with the remembered phrase" }) : null;
    open?.addEventListener("click", () => void this.openRemembered(workspace));
    const form = h("form", { class: "form-grid web-connect", novalidate: true },
      needCredentials ? field("Access key ID", accessKeyId, workspace.masked_access_key_id) : null,
      needCredentials ? field("Secret access key", secretAccessKey) : null,
      needCredentials ? field("Session token", sessionToken, "optional") : null,
      open,
      field("Encryption phrase", phrase),
      h("label", { class: "check-field" }, remember, h("span", { text: "Remember on this device" })),
      error,
      h("div", { class: "auth-actions" }, forget, h("span", { class: "auth-spacer" }), submit),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.busy(form, submit, "Unlocking…", error, async () => {
        const credentials = needCredentials
          ? { access_key_id: accessKeyId.value.trim(), secret_access_key: secretAccessKey.value.trim(), session_token: sessionToken.value.trim() || null }
          : this.credentials ?? (await this.store.openCredentials(workspace.id));
        if (!credentials) {
          this.store.removeSecrets(workspace.id);
          this.renderUnlock(workspace, "The stored credentials could not be opened on this device. Enter them again.");
          return;
        }
        await this.connect({
          name: workspace.name, bucket: workspace.bucket, region: workspace.region, prefix: workspace.prefix, endpoint: workspace.endpoint ?? "",
          accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key, sessionToken: credentials.session_token ?? "",
          phrase: phrase.value, remember: remember.checked,
        }, workspace);
      });
    });
    forget.addEventListener("click", () => void this.forgetDevice());
    const location = [workspace.bucket, normalizedPrefix(workspace.prefix)].filter(Boolean).join(" / ");
    this.authScreen(workspace.name, `Unlock ${location}${workspace.endpoint ? ` at ${workspace.endpoint}` : ""}.`, form);
    (needCredentials ? accessKeyId : phrase).focus();
  }

  /** Remembered credentials and phrase: open at once; any failure falls back to the unlock form. */
  private async openRemembered(workspace: WorkspaceConfig): Promise<void> {
    const progress = h("div", { class: "auth-progress", role: "progressbar", "aria-label": "Opening" });
    const card = this.authScreen(workspace.name, "Opening your workspace…", progress);
    card.classList.add("auth-opening");
    try {
      const [credentials, phrase] = await Promise.all([this.store.openCredentials(workspace.id), this.store.open(workspace.id, "phrase")]);
      if (!credentials || !phrase) {
        this.renderUnlock(workspace, "The remembered sign-in could not be opened on this device. Enter it again.");
        return;
      }
      await this.connect({
        name: workspace.name, bucket: workspace.bucket, region: workspace.region, prefix: workspace.prefix, endpoint: workspace.endpoint ?? "",
        accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key, sessionToken: credentials.session_token ?? "",
        phrase, remember: true,
      }, workspace);
    } catch (error) {
      this.renderUnlock(workspace, message(error));
    }
  }

  private async busy(form: HTMLFormElement, submit: HTMLButtonElement, label: string, error: HTMLElement, work: () => Promise<void>): Promise<void> {
    const text = submit.textContent;
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) control.disabled = true;
    submit.textContent = label;
    error.textContent = "";
    try {
      await work();
    } catch (problem) {
      if (!form.isConnected) return;
      error.textContent = message(problem);
      for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) control.disabled = false;
      const remember = form.querySelector<HTMLInputElement>('input[name="remember"]');
      if (remember && !this.persistent) remember.disabled = true;
      submit.textContent = text;
    }
  }

  private checkValues(values: ConnectValues): S3Location {
    if (!values.bucket) throw new Error("Enter the bucket name.");
    const location: S3Location = { bucket: values.bucket, region: values.region, prefix: normalizedPrefix(values.prefix), endpoint: values.endpoint || null };
    const problem = locationProblem(location);
    if (problem) throw new Error(problem);
    if (!values.accessKeyId || !/^[\x21-\x7e]+$/.test(values.accessKeyId)) throw new Error("The access key ID may contain only printable ASCII characters.");
    if (!values.secretAccessKey) throw new Error("Enter the secret access key.");
    if (!values.phrase.trim()) throw new Error("Enter the encryption phrase.");
    return location;
  }

  /** Derives the keys, lists the workspace (a wrong phrase fails here) and only then stores anything. */
  private async connect(values: ConnectValues, existing: WorkspaceConfig | null): Promise<void> {
    const location = this.checkValues(values);
    const credentials: StoredCredentials = { access_key_id: values.accessKeyId, secret_access_key: values.secretAccessKey, session_token: values.sessionToken || null };
    const codec = await NotebookV1Codec.create(values.phrase);
    const client = new S3Client(location, { accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key, sessionToken: credentials.session_token });
    const vault = new Vault(location, codec, client);
    try {
      await vault.load();
    } catch (error) {
      codec.wipe();
      throw error;
    }
    const workspace: WorkspaceConfig = {
      id: existing?.id ?? crypto.randomUUID(),
      name: values.name.trim() ? Array.from(values.name.trim()).slice(0, 64).join("") : defaultName(values.bucket),
      bucket: location.bucket,
      region: location.region,
      prefix: location.prefix,
      endpoint: location.endpoint,
      masked_access_key_id: maskedAccessKeyId(credentials.access_key_id),
    };
    const remember = values.remember && this.persistent;
    if (!remember) workspace.remember_declined = true;
    // One workspace in the web version: connecting another replaces it.
    for (const old of this.config.workspaces) if (old.id !== workspace.id) this.store.removeSecrets(old.id);
    this.config = { ...this.config, active_workspace: workspace.id, workspaces: [workspace] };
    this.store.saveConfig(this.config);
    if (remember) {
      await this.store.saveCredentials(workspace.id, credentials);
      await this.store.seal(workspace.id, "phrase", values.phrase);
    } else {
      this.store.removeSecrets(workspace.id);
    }
    this.credentials = credentials;
    this.enter(vault, workspace);
  }

  // -------------------------------------------------------------------------
  // The workspace view

  private enter(vault: Vault, workspace: WorkspaceConfig): void {
    this.vault = vault;
    this.workspace = workspace;
    this.doc = null;
    this.folder = "";
    this.query = "";
    this.expanded.clear();
    this.buildShell(workspace);
    this.renderTree();
    const last = this.lastNote(vault, workspace);
    if (last) {
      this.setDrawer(false);
      this.restoring = true;
      void this.openDocument(documentId(last));
      return;
    }
    this.showEmpty();
    this.setDrawer(this.phone.matches);
  }

  private lastNote(vault: Vault, workspace: WorkspaceConfig): string | undefined {
    try {
      const keys = JSON.parse(window.localStorage.getItem(LAST_NOTE_KEY) ?? "{}") as Record<string, unknown>;
      const key = keys[workspace.id];
      return typeof key === "string" ? vault.pathOfKey(key) : undefined;
    } catch {
      return undefined;
    }
  }

  private rememberNote(path: string): void {
    const workspace = this.workspace;
    const key = this.vault?.storedKey(path);
    if (!workspace || !key) return;
    try {
      const keys = JSON.parse(window.localStorage.getItem(LAST_NOTE_KEY) ?? "{}") as Record<string, unknown>;
      keys[workspace.id] = key;
      window.localStorage.setItem(LAST_NOTE_KEY, JSON.stringify(keys));
    } catch {
      // Storage full or blocked: the next start simply shows the note list.
    }
  }

  private buildShell(workspace: WorkspaceConfig): void {
    const newNote = iconButton("pencil", "New note");
    const newFolder = iconButton("folder", "New folder");
    const refresh = iconButton("refresh", "Refresh");
    const close = iconButton("close", "Close files", "web-drawer-close");
    const search = h("input", { type: "search", class: "search", placeholder: "Search titles", "aria-label": "Search titles", autocomplete: "off", spellcheck: "false" });
    const searchWrap = h("div", { class: "search-wrap web-search" }, search);
    searchWrap.prepend(icon("search"));
    const tree = h("div", { class: "web-tree", role: "tree", "aria-label": "Files" });
    const lock = h("button", { type: "button", class: "button button-ghost", text: "Lock" });
    lock.prepend(icon("lock"));
    const forget = h("button", { type: "button", class: "button button-ghost web-danger-text", text: "Forget this device" });
    const sidebar = h("aside", { class: "web-sidebar", id: "web-sidebar", "aria-label": "Files" },
      h("div", { class: "web-side-head" }, h("div", { class: "web-workspace", title: workspace.name, text: workspace.name }), newNote, newFolder, refresh, close),
      searchWrap,
      tree,
      h("div", { class: "web-side-foot" }, lock, forget),
    );
    const menu = h("button", { type: "button", class: "icon-button web-icon-button web-menu", "aria-label": "Files", title: "Files", "aria-controls": "web-sidebar", "aria-expanded": "false" });
    menu.append(menuIcon());
    const crumbs = h("span", { class: "web-crumbs" });
    const title = h("span", { class: "web-name" });
    const modeButton = h("button", { type: "button", class: "button web-mode", text: "Edit" });
    const splitButton = h("button", { type: "button", class: "button button-ghost web-split", text: "Split", "aria-pressed": "false" });
    const save = h("button", { type: "button", class: "button button-primary web-save", text: "Save", disabled: true, title: "Save (Ctrl+S / ⌘S)" });
    const status = h("div", { class: "web-status", role: "status", "aria-live": "polite" });
    const editorHost = h("div", { class: "editor-host" });
    const preview = h("div", { class: "preview", tabindex: "-1" });
    const empty = h("div", { class: "empty web-empty" });
    const docArea = h("div", { class: "web-doc", "data-mode": "none" }, editorHost, preview, empty);
    const counts = h("span", { class: "web-counts" });
    const main = h("main", { class: "web-main" },
      h("header", { class: "web-topbar" }, menu, h("div", { class: "web-title" }, crumbs, title), h("div", { class: "web-actions" }, splitButton, modeButton, save)),
      status,
      docArea,
      counts,
    );
    const scrim = h("div", { class: "web-scrim", "aria-hidden": "true" });
    const shell = h("div", { class: "web-shell" }, sidebar, scrim, main);
    this.root.replaceChildren(shell);
    this.els = { shell, sidebar, main, tree, search, title, crumbs, docArea, editorHost, preview, empty, status, save, modeButton, splitButton, counts, menu };

    newNote.addEventListener("click", () => void this.newNote());
    newFolder.addEventListener("click", () => void this.newFolder());
    refresh.addEventListener("click", () => void this.refresh());
    close.addEventListener("click", () => this.setDrawer(false));
    menu.addEventListener("click", () => this.setDrawer(!shell.classList.contains("drawer-open")));
    scrim.addEventListener("click", () => this.setDrawer(false));
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderTree();
    });
    tree.addEventListener("click", (event) => {
      const row = (event.target as Element).closest<HTMLElement>(".tree-row");
      if (row?.dataset.id) void this.activate(row.dataset.id);
    });
    lock.addEventListener("click", () => void this.lock());
    forget.addEventListener("click", () => void this.forgetDevice());
    modeButton.addEventListener("click", () => this.setMode(this.mode === "preview" ? (this.wide.matches ? "split" : "edit") : "preview"));
    splitButton.addEventListener("click", () => this.setMode(this.mode === "split" ? "edit" : "split"));
    save.addEventListener("click", () => void this.save());
  }

  private onKey(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (this.doc) void this.save();
      return;
    }
    if (event.key === "Escape" && this.els?.shell.classList.contains("drawer-open") && this.phone.matches && !document.querySelector(".modal-overlay")) {
      this.setDrawer(false);
      this.els.menu.focus();
    }
  }

  /** Phones: the file list is a drawer over the document. Wider screens always show it. */
  private setDrawer(open: boolean): void {
    if (!this.els) return;
    this.els.shell.classList.toggle("drawer-open", open);
    this.syncDrawer();
    if (open && this.phone.matches) this.els.search.focus({ preventScroll: true });
  }

  private syncDrawer(): void {
    if (!this.els) return;
    const open = this.els.shell.classList.contains("drawer-open");
    const overlay = this.phone.matches;
    this.els.sidebar.inert = overlay && !open;
    this.els.main.inert = overlay && open;
    this.els.menu.setAttribute("aria-expanded", String(overlay ? open : true));
  }

  private renderTree(): void {
    const els = this.els;
    const vault = this.vault;
    if (!els || !vault) return;
    const rows = document.createDocumentFragment();
    const query = this.query.trim();
    const items = query ? vault.tree.search(query, SEARCH_LIMIT).items : vault.tree.visible(this.expanded);
    for (const { node, depth } of items) {
      const folder = node.kind === "Folder";
      const row = h("button", { type: "button", class: "tree-row", role: "treeitem", "data-id": node.id });
      row.style.setProperty("--depth", String(depth));
      if (folder) {
        row.setAttribute("aria-expanded", String(this.expanded.has(node.id)));
        const disclosure = h("span", { class: `disclosure${this.expanded.has(node.id) ? " open" : ""}` });
        disclosure.append(icon("chevron"));
        row.append(disclosure);
      } else {
        row.append(h("span", { class: "disclosure web-leaf" }));
      }
      row.append(h("span", { class: "node-label", text: node.name }));
      if (query) {
        const where = parentPath(vault.pathOf(node.id));
        if (where) row.append(h("span", { class: "web-row-path", text: where }));
      }
      if (this.doc?.id === node.id || (folder && !this.doc && this.folder && folderId(this.folder) === node.id)) row.classList.add("selected");
      if (this.doc?.id === node.id) row.setAttribute("aria-current", "page");
      rows.append(row);
    }
    if (!items.length) {
      rows.append(h("p", { class: "web-tree-empty", text: query ? "No titles match." : "This workspace is empty. Create a note to start." }));
    }
    els.tree.replaceChildren(rows);
  }

  private async activate(id: string): Promise<void> {
    const vault = this.vault;
    const node = vault?.tree.get(id);
    if (!vault || !node) return;
    if (node.kind === "Folder") {
      this.folder = vault.pathOf(id);
      if (this.query) {
        this.query = "";
        if (this.els) this.els.search.value = "";
        for (let at: string | null = node.id; at && at !== ROOT_ID; at = vault.tree.get(at)?.parent ?? null) this.expanded.add(at);
      } else if (this.expanded.has(id)) this.expanded.delete(id);
      else this.expanded.add(id);
      this.renderTree();
      return;
    }
    await this.openDocument(id);
  }

  // -------------------------------------------------------------------------
  // Documents

  private dirty(): boolean {
    return Boolean(this.doc && this.editor?.hasDocument && this.editor.text() !== this.doc.saved);
  }

  private currentText(): string {
    return this.doc && this.editor?.hasDocument ? this.editor.text() : this.doc?.saved ?? "";
  }

  private setStatus(text: string, tone: "info" | "warning" | "error" = "info"): void {
    if (!this.els) return;
    this.els.status.textContent = text;
    this.els.status.dataset.tone = tone;
  }

  private updateDirty(): void {
    if (!this.els) return;
    const dirty = this.dirty();
    this.els.save.disabled = !dirty || this.saving !== null;
    this.els.shell.classList.toggle("doc-dirty", dirty);
    if (dirty && this.els.status.dataset.tone !== "error" && this.els.status.dataset.tone !== "warning") this.setStatus("Unsaved changes");
    this.renderCounts();
  }

  private renderCounts(): void {
    if (!this.els) return;
    if (!this.doc) {
      this.els.counts.textContent = "";
      return;
    }
    const { words, characters } = countText(this.currentText());
    this.els.counts.textContent = `${words.toLocaleString()} words · ${characters.toLocaleString()} characters`;
  }

  /** Saves the open document if it changed; false when it could not be saved. */
  async save(): Promise<boolean> {
    if (this.saving) {
      await this.saving;
      if (!this.dirty()) return true;
    }
    const doc = this.doc;
    const vault = this.vault;
    if (!doc || !vault || !this.dirty()) return true;
    const text = this.editor!.text();
    const run = (async (): Promise<boolean> => {
      this.setStatus("Saving…");
      try {
        const outcome = await vault.save(doc.path, doc.etag, text);
        if (outcome.status === "saved") {
          doc.etag = outcome.etag;
          doc.saved = text;
          this.setStatus("Saved");
        } else {
          const id = documentId(outcome.path);
          this.editor?.retarget(doc.id, id);
          this.html.retarget(doc.id, id);
          if (this.doc === doc) this.doc = { ...doc, id, path: outcome.path, etag: outcome.etag, saved: text };
          this.expandTo(id);
          this.renderTitle();
          this.renderTree();
          this.setStatus(`This note changed elsewhere. Your version was saved as “${fileName(outcome.path)}”.`, "warning");
        }
        return true;
      } catch (error) {
        this.setStatus(`Not saved: ${message(error)}`, "error");
        return false;
      }
    })();
    this.saving = run;
    this.updateDirty();
    try {
      return await run;
    } finally {
      this.saving = null;
      this.updateDirty();
    }
  }

  /** Before another document, Lock or Forget: the open one is saved, or the user chooses to leave it. */
  private async leave(): Promise<boolean> {
    if (!this.dirty()) return true;
    if (await this.save()) return true;
    return this.confirm("Leave without saving?", "This note could not be saved. Your changes will be lost if you continue.", "Leave");
  }

  private expandTo(id: string): void {
    const vault = this.vault;
    for (let at = vault?.tree.get(id)?.parent ?? null; vault && at && at !== ROOT_ID; at = vault.tree.get(at)?.parent ?? null) this.expanded.add(at);
  }

  private async openDocument(id: string, fragment: string | null = null, mode?: Mode): Promise<void> {
    const vault = this.vault;
    const els = this.els;
    if (!vault || !els) return;
    if (this.doc?.id === id) {
      if (this.phone.matches) this.setDrawer(false);
      if (mode) this.setMode(mode);
      if (fragment) this.scrollToFragment(fragment);
      return;
    }
    if (!(await this.leave())) return;
    const path = vault.pathOf(id);
    this.setStatus("Opening…");
    try {
      const opened = await vault.open(path);
      const language = documentLanguage(fileName(path));
      this.doc = { id, path, language, etag: opened.etag, saved: opened.text.replace(/\r\n?/g, "\n") };
      this.folder = parentPath(path);
      this.expandTo(id);
      this.editor?.close();
      if (this.editor) this.editor.open(id, opened.text, false, language);
      if (mode) this.mode = mode;
      else if (this.phone.matches || this.restoring) this.mode = language === "html" ? "preview" : "edit";
      else if (this.mode === "split" && !this.wide.matches) this.mode = "preview";
      this.rememberNote(path);
      this.setStatus("");
      this.renderTitle();
      this.renderTree();
      this.renderDocument();
      if (this.phone.matches) this.setDrawer(false);
      if (fragment) this.scrollToFragment(fragment);
    } catch (error) {
      this.setStatus(message(error), "error");
    } finally {
      this.restoring = false;
    }
  }

  private renderTitle(): void {
    const els = this.els;
    if (!els) return;
    const path = this.doc?.path ?? "";
    const parent = parentPath(path);
    els.crumbs.textContent = parent ? `${parent.split("/").join(" / ")} /` : "";
    els.title.textContent = path ? fileName(path) : (this.workspace?.name ?? "");
    document.title = path ? `${fileName(path)} – Notebook` : "Notebook";
    this.renderModeButtons();
  }

  private renderModeButtons(): void {
    const els = this.els;
    if (!els) return;
    const open = Boolean(this.doc);
    els.modeButton.hidden = els.save.hidden = !open;
    els.splitButton.hidden = !open || !this.wide.matches;
    els.modeButton.textContent = this.mode === "preview" ? "Edit" : "Preview";
    els.modeButton.setAttribute("aria-label", this.mode === "preview" ? "Edit this note" : "Show the preview");
    els.splitButton.setAttribute("aria-pressed", String(this.mode === "split"));
  }

  /** Loads the editor module once per unlocked workspace; the document is opened in it by renderDocument. */
  private loadEditor(): Promise<void> {
    this.editorLoading ??= import("../../src/editor/editor.ts").then(({ Editor }) => {
      if (!this.els || this.editor) return;
      this.editor = new Editor(this.els.editorHost, () => {
        this.updateDirty();
        window.clearTimeout(this.autosaveTimer);
        if (this.dirty()) this.autosaveTimer = window.setTimeout(() => void this.save(), AUTOSAVE_DELAY_MS);
        if (this.mode === "split") {
          window.clearTimeout(this.previewTimer);
          this.previewTimer = window.setTimeout(() => this.renderPreview(), 250);
        }
      });
    });
    return this.editorLoading;
  }

  /** The open document in the editor; false while the editor is still loading. */
  private ensureEditor(): boolean {
    const editor = this.editor;
    const doc = this.doc;
    if (!editor) {
      const waiting = doc;
      void this.loadEditor().then(() => {
        if (this.doc === waiting && this.mode !== "preview") {
          this.renderDocument();
          this.editor?.focus();
        }
      }, (error: unknown) => this.setStatus(`The editor could not be loaded: ${message(error)}`, "error"));
      return false;
    }
    if (doc && !editor.hasDocument) editor.open(doc.id, doc.saved, false, doc.language);
    return true;
  }

  private setMode(mode: Mode): void {
    if (mode === "split" && !this.wide.matches) mode = "edit";
    const leavingEdit = this.mode !== "preview";
    this.mode = mode;
    this.renderDocument();
    if (mode !== "preview") this.editor?.focus();
    else if (leavingEdit) this.els?.preview.focus({ preventScroll: true });
  }

  private showEmpty(): void {
    const els = this.els;
    if (!els) return;
    els.docArea.dataset.mode = "none";
    const browse = h("button", { type: "button", class: "button web-browse", text: "Browse files" });
    const create = h("button", { type: "button", class: "button button-primary", text: "New note" });
    browse.addEventListener("click", () => this.setDrawer(true));
    create.addEventListener("click", () => void this.newNote());
    els.empty.replaceChildren(h("div", { class: "web-empty-inner" },
      h("p", { text: this.vault?.isEmpty() ? "This workspace is empty." : "Select a note to read it." }),
      h("div", { class: "web-empty-actions" }, browse, create)));
    this.renderTitle();
    this.renderCounts();
  }

  private renderDocument(): void {
    const els = this.els;
    const doc = this.doc;
    if (!els || !doc) {
      this.showEmpty();
      return;
    }
    els.docArea.dataset.mode = this.mode;
    els.docArea.dataset.language = doc.language;
    if (this.mode !== "preview") this.ensureEditor();
    if (this.mode !== "edit") this.renderPreview();
    this.renderModeButtons();
    this.updateDirty();
  }

  private renderPreview(): void {
    const els = this.els;
    const doc = this.doc;
    if (!els || !doc) return;
    const text = this.currentText();
    const preview = els.preview;
    if (doc.language === "html") {
      preview.classList.add("html-mode");
      this.html.render(preview, doc.id, text);
      return;
    }
    if (preview.classList.contains("html-mode")) {
      preview.classList.remove("html-mode");
      this.html.reset();
    }
    const scroll = preview.dataset.doc === doc.id ? preview.scrollTop : 0;
    if (doc.language === "plaintext") preview.replaceChildren(h("pre", { class: "plain-preview", text }));
    else preview.replaceChildren(renderMarkdown(text));
    preview.dataset.doc = doc.id;
    preview.scrollTop = scroll;
  }

  private scrollToFragment(fragment: string): void {
    const preview = this.els?.preview;
    if (!preview) return;
    if (this.mode === "edit") this.setMode("preview");
    const target = previewTarget(preview, fragment);
    if (target) scrollPaneTo(preview, target);
  }

  private async followInternalLink(href: string): Promise<void> {
    const vault = this.vault;
    const doc = this.doc;
    const link = parseInternalHref(href);
    if (!vault || !doc || !link) return;
    const entries = [...vault.tree.nodes()]
      .filter((node) => node.kind === "Folder" || node.kind === "Document")
      .map((node) => ({ id: node.id, parent: node.parent, name: node.name, folder: node.kind === "Folder" }));
    const target = resolveInternalLink(new VaultIndex(ROOT_ID, entries), `/${doc.path}`, link);
    if (target.kind === "document") await this.openDocument(target.id, link.fragment);
    else if (target.kind === "folder") {
      this.expandTo(target.id);
      this.expanded.add(target.id);
      this.renderTree();
      this.setDrawer(true);
    } else this.setStatus(target.kind === "ambiguous" ? `${target.count} notes have that name.` : "The linked note does not exist.", "warning");
  }

  private confirmLink(url: string): void {
    if (url.length > MAX_LINK_LENGTH) return;
    void this.confirm("Open this link?", url, "Open").then((yes) => {
      if (yes) openInBrowserTab(url);
    });
  }

  // -------------------------------------------------------------------------
  // New note, new folder, refresh, lock, forget

  private async newNote(): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const input = await this.prompt("New note", "A path from the workspace root. Missing folders are created; without an extension the note is Markdown (.md).", `${this.folder ? `${this.folder}/` : ""}Untitled`, "Create");
    if (input === null) return;
    try {
      const path = await vault.createDocument(input);
      this.query = "";
      if (this.els) this.els.search.value = "";
      this.expandTo(documentId(path));
      this.renderTree();
      await this.openDocument(documentId(path), null, this.wide.matches ? "split" : "edit");
      this.setStatus(`Created “${fileName(path)}”.`);
    } catch (error) {
      this.setStatus(message(error), "error");
    }
  }

  private async newFolder(): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const input = await this.prompt("New folder", "A path from the workspace root. Missing folders on the way are created too.", `${this.folder ? `${this.folder}/` : ""}New folder`, "Create");
    if (input === null) return;
    try {
      const path = await vault.createFolderAt(input);
      this.expandTo(folderId(path));
      this.expanded.add(folderId(path));
      this.folder = path;
      this.renderTree();
      this.setStatus(`Created folder “${fileName(path)}”.`);
    } catch (error) {
      this.setStatus(message(error), "error");
    }
  }

  private async refresh(): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    this.setStatus("Refreshing…");
    try {
      await vault.load();
      this.renderTree();
      if (!this.doc) this.showEmpty();
      this.setStatus(this.doc && !vault.tree.has(this.doc.id) ? "This note is no longer in the workspace. Saving keeps it as a conflict copy." : "Up to date.", this.doc && !vault.tree.has(this.doc.id) ? "warning" : "info");
    } catch (error) {
      this.setStatus(message(error), "error");
    }
  }

  private closeWorkspace(): void {
    this.vault?.close();
    this.vault = null;
    this.doc = null;
    this.editor?.destroy();
    this.editor = null;
    this.editorLoading = null;
    this.html.reset();
    this.expanded.clear();
  }

  private async lock(): Promise<void> {
    if (!(await this.leave())) return;
    const workspace = this.workspace;
    this.closeWorkspace();
    if (!workspace) {
      this.renderConnect();
      return;
    }
    this.renderUnlock(workspace);
  }

  private async forgetDevice(): Promise<void> {
    const yes = await this.confirm(
      "Forget this device?",
      "This removes the workspace settings and the stored credentials and phrase from this browser. Your notes in S3 are not touched.",
      "Forget",
    );
    if (!yes) return;
    if (this.vault && !(await this.leave())) return;
    this.closeWorkspace();
    this.credentials = null;
    this.workspace = null;
    await this.store.forgetDevice();
    try { window.localStorage.removeItem(LAST_NOTE_KEY); } catch { /* blocked storage: nothing stored */ }
    this.config = this.store.loadConfig();
    this.store = new LocalStore(window.localStorage, this.persistent ? new IndexedDbKeyStore() : new MemoryKeyStore());
    this.renderConnect();
  }

  // -------------------------------------------------------------------------
  // Dialogs (theme.css .modal)

  private dialog<T>(title: string, detail: string, body: (close: (value: T) => void) => Child[], cancelValue: T): Promise<T> {
    return new Promise((resolve) => {
      const previous = document.activeElement as HTMLElement | null;
      const overlay = h("div", { class: "modal-overlay web-modal" });
      const close = (value: T): void => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        previous?.focus?.({ preventScroll: true });
        resolve(value);
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close(cancelValue);
        }
      };
      const modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("header", {}, h("div", {}, h("h2", { text: title }), h("p", { text: detail }))),
        h("div", { class: "modal-body" }, ...body(close)));
      overlay.append(modal);
      overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) close(cancelValue);
      });
      document.addEventListener("keydown", onKey, true);
      document.body.append(overlay);
      (modal.querySelector<HTMLElement>("input, .confirm") ?? modal).focus();
    });
  }

  private confirm(title: string, detail: string, action: string): Promise<boolean> {
    return this.dialog<boolean>(title, detail, (close) => {
      const cancel = h("button", { type: "button", class: "button cancel", text: "Cancel" });
      const ok = h("button", { type: "button", class: "button button-primary confirm", text: action });
      cancel.addEventListener("click", () => close(false));
      ok.addEventListener("click", () => close(true));
      return [h("div", { class: "modal-actions" }, cancel, ok)];
    }, false);
  }

  private prompt(title: string, detail: string, value: string, action: string): Promise<string | null> {
    return this.dialog<string | null>(title, detail, (close) => {
      const input = textInput("name", { value, "aria-label": title });
      const cancel = h("button", { type: "button", class: "button cancel", text: "Cancel" });
      const ok = h("button", { type: "submit", class: "button button-primary confirm", text: action });
      const form = h("form", { class: "modal-form" }, input, h("div", { class: "modal-actions" }, cancel, ok));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (input.value.trim()) close(input.value);
      });
      cancel.addEventListener("click", () => close(null));
      queueMicrotask(() => input.select());
      return [form];
    }, null);
  }
}
