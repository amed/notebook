// Importing dropped files and folders: walking the drop (the FileSystemEntry
// API that WKWebView, WebKitGTK and WebView2 share), planning which folders
// and documents to create where, and summarizing the outcome. No DOM and no
// IPC, so tests/unit can run it.

/** Each imported document is at most this large. */
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
/** One drop creates at most this much; a larger drop is refused whole. */
const IMPORT_LIMITS: ImportLimits = { files: 5_000, folders: 2_000, entries: 20_000 };
/** Folders and documents created at the same time. */
export const IMPORT_PARALLEL = 8;
/** Names of skipped or failed items listed in the summary. */
const SUMMARY_NAMES = 20;

const RESERVED = new Set(["_deleted", "_delete", ".secure-vault-trash", ".notebook_dir"]);
/** Control characters (C0, DEL, C1) and bidi marks, overrides and isolates: they could forge lines or disguise extensions. */
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const UNSAFE_CHARS_ALL = new RegExp(UNSAFE_CHARS.source, "g");

type ImportLimits = { files: number; folders: number; entries: number };

/** What the walk needs of a File. */
interface FileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

/** The parts of FileSystemEntry the walk uses. */
export interface DroppedEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

interface FileEntry<F> extends DroppedEntry {
  file(success: (file: F) => void, failure?: (error: unknown) => void): void;
}

interface DirectoryEntry extends DroppedEntry {
  createReader(): { readEntries(success: (entries: DroppedEntry[]) => void, failure?: (error: unknown) => void): void };
}

/** A dropped item that was not imported, and why. Never its contents. */
export interface Skip {
  path: string;
  reason: string;
}

interface ScannedFile<F> {
  /** Folder names from the drop target down to the file. */
  folders: string[];
  file: F;
}

interface Scan<F> {
  /** Every folder of the drop, parents before children, as name paths. */
  folders: string[][];
  files: ScannedFile<F>[];
  skipped: Skip[];
  /** Entries whose name starts with ".", left out without listing them. */
  hidden: number;
  /** The limit the drop went over (the walk stopped there), if any. */
  over: keyof ImportLimits | null;
}

function isImportableFile(file: FileLike): boolean {
  return /\.(?:md|markdown|txt|html?)$/i.test(file.name) || /^text\//i.test(file.type);
}

/** Names are trimmed when created, so " .git" is hidden too. */
function isHidden(name: string): boolean {
  return name.trimStart().startsWith(".");
}

function isEntry(value: unknown): value is DroppedEntry {
  return typeof value === "object" && value !== null && "isDirectory" in value && "isFile" in value;
}

function fileOf<F>(entry: FileEntry<F>): Promise<F> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * Every entry of a directory, in name order: readEntries answers in batches
 * until an empty one. `more(count)` is told each batch's size and stops the
 * reading when it returns false.
 */
async function entriesOf(directory: DirectoryEntry, more: (count: number) => boolean): Promise<DroppedEntry[]> {
  const reader = directory.createReader();
  const all: DroppedEntry[] = [];
  for (;;) {
    const batch = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    all.push(...batch);
    if (!more(batch.length)) break;
  }
  return all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Walks the dropped items: files (plain Files where the entry API is
 * missing) and folders, recursively. Hidden entries are counted and never
 * entered; files that are not Markdown, text or HTML are skipped. The walk
 * stops as soon as the drop goes over a limit.
 */
export async function scanDrop<F extends FileLike>(
  roots: ReadonlyArray<DroppedEntry | F>,
  limits: ImportLimits = IMPORT_LIMITS,
): Promise<Scan<F>> {
  const scan: Scan<F> = { folders: [], files: [], skipped: [], hidden: 0, over: null };
  let seen = roots.length;
  const within = (): boolean => {
    if (scan.over) return false;
    if (seen > limits.entries) scan.over = "entries";
    else if (scan.folders.length > limits.folders) scan.over = "folders";
    else if (scan.files.length > limits.files) scan.over = "files";
    return scan.over === null;
  };
  const addFile = (file: F, folders: string[]): void => {
    if (isImportableFile(file)) scan.files.push({ folders, file });
    else scan.skipped.push({ path: [...folders, file.name].join("/"), reason: "unsupported file type" });
  };
  // Depth first, in name order: parents are listed before their children.
  const visit = async (item: DroppedEntry | F, folders: string[]): Promise<void> => {
    if (isHidden(item.name)) { scan.hidden++; return; }
    if (!isEntry(item)) { addFile(item, folders); return; }
    const path = [...folders, item.name];
    try {
      if (item.isDirectory) {
        scan.folders.push(path);
        if (!within()) return;
        const children = await entriesOf(item as DirectoryEntry, (count) => { seen += count; return within(); });
        for (const child of children) {
          if (!within()) return;
          await visit(child, path);
        }
      } else if (item.isFile) {
        addFile(await fileOf(item as FileEntry<F>), folders);
      }
    } catch {
      // An unreadable folder is neither created nor counted; its children were not visited yet.
      if (scan.folders[scan.folders.length - 1] === path) scan.folders.pop();
      scan.skipped.push({ path: path.join("/"), reason: "could not be read" });
    }
  };
  for (const root of roots) {
    if (!within()) break;
    await visit(root, []);
  }
  within();
  return scan;
}

/** Why `name` cannot be a folder or document name, or null. Mirrors validate_name in Rust. */
export function nameProblem(name: string): string | null {
  const value = name.trim();
  if (!value) return "has no name";
  if (RESERVED.has(value.toLowerCase())) return "the name is reserved for deleted items";
  if (value === "." || value === ".." || /[/\\\0]/.test(value)) return "the name contains a character that is not allowed";
  if (UNSAFE_CHARS.test(value)) return "the name contains a control or text-direction character";
  if (new TextEncoder().encode(value).length > 255) return "the name is longer than 255 bytes";
  return null;
}

/** `wanted`, or "stem 2.ext", "stem 3.ext"… when taken (without case), as Rust's unique_name. */
export function uniqueName(taken: ReadonlySet<string>, wanted: string): string {
  if (!taken.has(wanted.toLowerCase())) return wanted;
  const dot = wanted.lastIndexOf(".");
  const stem = dot > 0 ? wanted.slice(0, dot) : wanted;
  const extension = dot > 0 ? wanted.slice(dot) : "";
  for (let number = 2; ; number++) {
    const candidate = `${stem} ${number}${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

interface PlannedFolder {
  index: number;
  /** The planned folder it goes in, or null for the drop target. */
  parent: number | null;
  name: string;
  depth: number;
  /** Where it came from in the drop, for messages. */
  path: string;
}

interface PlannedFile<F> {
  folder: number | null;
  name: string;
  path: string;
  file: F;
}

interface ImportPlan<F> {
  /** Parents before children. */
  folders: PlannedFolder[];
  files: PlannedFile<F>[];
  skipped: Skip[];
}

type PlanNode<F> = { name: string; folders: Map<string, PlanNode<F>>; files: F[] };

/**
 * What to create for a scanned drop below the drop target, whose items are
 * named `existing`. Names stay unique without case in every folder, as the
 * backend keeps them: a taken name gets a number, so nothing is overwritten
 * or merged. Reserved or invalid names are refused (a folder with its
 * contents), and files over 16 MiB are skipped.
 */
export function planImport<F extends FileLike>(scan: Scan<F>, existing: readonly string[]): ImportPlan<F> {
  const root: PlanNode<F> = { name: "", folders: new Map(), files: [] };
  const nodeAt = (path: readonly string[]): PlanNode<F> => {
    let node = root;
    for (const name of path) {
      let next = node.folders.get(name);
      if (!next) { next = { name, folders: new Map(), files: [] }; node.folders.set(name, next); }
      node = next;
    }
    return node;
  };
  for (const folder of scan.folders) nodeAt(folder);
  for (const { folders, file } of scan.files) nodeAt(folders).files.push(file);
  const plan: ImportPlan<F> = { folders: [], files: [], skipped: [...scan.skipped] };
  const place = (node: PlanNode<F>, parent: number | null, depth: number, from: string, taken: Set<string>): void => {
    const at = (name: string): string => (from ? `${from}/${name}` : name);
    for (const folder of node.folders.values()) {
      const problem = nameProblem(folder.name);
      if (problem) { plan.skipped.push({ path: at(folder.name), reason: `${problem}; the folder and its contents were skipped` }); continue; }
      const name = uniqueName(taken, folder.name.trim());
      taken.add(name.toLowerCase());
      const index = plan.folders.length;
      plan.folders.push({ index, parent, name, depth, path: at(folder.name) });
      place(folder, index, depth + 1, at(folder.name), new Set());
    }
    for (const file of node.files) {
      const problem = nameProblem(file.name) ?? (file.size > MAX_IMPORT_BYTES ? "files are limited to 16 MiB" : null);
      if (problem) { plan.skipped.push({ path: at(file.name), reason: problem }); continue; }
      const name = uniqueName(taken, file.name.trim());
      taken.add(name.toLowerCase());
      plan.files.push({ folder: parent, name, path: at(file.name), file });
    }
  };
  place(root, null, 0, "", new Set(existing.map((name) => name.toLowerCase())));
  // Parents before children, level by level, for creation in rounds.
  plan.folders.sort((a, b) => a.depth - b.depth || a.index - b.index);
  return plan;
}

/** Folders by depth: each level can be created at once, after its parents. */
export function foldersByLevel(folders: readonly PlannedFolder[]): PlannedFolder[][] {
  const levels: PlannedFolder[][] = [];
  for (const folder of folders) (levels[folder.depth] ??= []).push(folder);
  return levels.filter(Boolean);
}

/** Runs `work` on every item, at most `limit` at a time. `work` handles its own errors. */
export async function runPool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The text of a dropped file: strict UTF-8, at most 16 MiB. */
export async function readImportText(file: FileLike & { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error("files are limited to 16 MiB");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error("the file is not UTF-8 text");
  }
}

export function importProgress(done: number, total: number): string {
  return `Importing ${Math.min(done + 1, total).toLocaleString("en-US")} of ${total.toLocaleString("en-US")}…`;
}

/** Why a drop over a limit was refused. */
export function limitMessage(over: keyof ImportLimits, limits: ImportLimits = IMPORT_LIMITS): string {
  const most = `Import at most ${limits.files.toLocaleString("en-US")} files and ${limits.folders.toLocaleString("en-US")} folders at a time.`;
  if (over === "files") return `This drop has more than ${limits.files.toLocaleString("en-US")} files to import. ${most}`;
  if (over === "folders") return `This drop has more than ${limits.folders.toLocaleString("en-US")} folders. ${most}`;
  return `This drop has more than ${limits.entries.toLocaleString("en-US")} items. ${most}`;
}

interface ImportOutcome {
  files: number;
  folders: number;
  skipped: readonly Skip[];
  failed: readonly Skip[];
  hidden: number;
}

/** A dropped name as a dialog may show it: no line breaks or direction overrides of its own. */
export function shownName(name: string): string {
  return name.replace(UNSAFE_CHARS_ALL, "\uFFFD");
}

/** The dialog after a lock or switch ended an import: counts only, no names. */
export function importStopped(files: number, folders: number): string {
  const made = [files ? plural(files, "file") : "", folders ? plural(folders, "folder") : ""].filter(Boolean);
  const before = made.length ? `${made.join(" and ")} were imported before it stopped.` : "Nothing was imported.";
  return `The import stopped because the workspace was locked or switched. ${before}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/**
 * The one dialog after an import: counts, then the first names with their
 * reasons (never contents). Null when everything was imported; hidden items
 * alone (.DS_Store) are not worth a dialog.
 */
export function importSummary(outcome: ImportOutcome, names = SUMMARY_NAMES): { title: string; text: string } | null {
  const problems = [...outcome.failed, ...outcome.skipped];
  if (!problems.length) return null;
  const lines: string[] = [];
  const made = [outcome.files ? plural(outcome.files, "file") : "", outcome.folders ? plural(outcome.folders, "folder") : ""].filter(Boolean);
  if (made.length) lines.push(`Imported ${made.join(" and ")}.`);
  const counts = [
    outcome.skipped.length ? `${plural(outcome.skipped.length, "item")} skipped` : "",
    outcome.failed.length ? `${plural(outcome.failed.length, "item")} failed` : "",
    outcome.hidden ? `${plural(outcome.hidden, "hidden item")} left out` : "",
  ].filter(Boolean);
  lines.push(`${counts.join(", ")}.`);
  for (const problem of problems.slice(0, names)) lines.push(`${shownName(problem.path)}: ${problem.reason}`);
  if (problems.length > names) lines.push(`…and ${(problems.length - names).toLocaleString("en-US")} more.`);
  return {
    title: outcome.files || outcome.folders ? "Some items were not imported" : "Nothing was imported",
    text: lines.join("\n"),
  };
}
