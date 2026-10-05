// Which document is open, and where its edits go. An edit is saved into the
// document it was typed in, journal writes run one after another, and only
// the newest open request may switch the editor. No DOM here, so tests/unit
// can run it.
//
// Save model: an edit is durable once Rust has written it to the encrypted
// local outbox ("stage": 1 s after typing pauses, no network) and synced
// once S3 holds it ("commit": Cmd/Ctrl+S, document switch, window blur,
// close, lock, 30 s idle, or 120 s of continuous editing). Typing never waits
// on S3, and close and lock wait for it at most 3 s.

export type DocumentData = { text: string; readOnly: boolean; dirty?: boolean };
/** The status-bar dot. "busy": an upload has been running for over 1 s. */
export type SyncState = "clean" | "dirty" | "busy" | "offline" | "failed";
export type CommitResult = {
  status: "Saved" | "Offline" | "ConflictCopy";
  document_id?: string | null;
};

export interface DocumentStore {
  open(id: string): Promise<DocumentData>;
  /** Writes the edit to the encrypted local outbox. Never touches S3. */
  stage(id: string, text: string): Promise<"Clean" | "Staged">;
  /** Uploads the staged edit of `id`; sends nothing when none is staged. */
  commit(id: string): Promise<CommitResult>;
}

export interface SessionEvents {
  /** Called only when the visible state changes. */
  state(state: SyncState): void;
  /** Another device changed the document; the edit became a copy beside it. */
  conflict?(from: string, to: string): void;
}

export const SAVE_TIMING = {
  stageMs: 1_000,
  idleMs: 30_000,
  maxDirtyMs: 120_000,
  busyMs: 1_000,
  exitBudgetMs: 3_000,
  retryMs: [15_000, 30_000, 60_000, 120_000, 300_000],
};
export type SaveTiming = typeof SAVE_TIMING;

type PendingText = string | (() => string);
type Outcome = "saved" | "offline" | "failed";

/** Edit numbers per document: typed, in the outbox, and in S3. */
type Doc = {
  id: string;
  edit: number;
  staged: number;
  committed: number;
  uploading: Promise<Outcome> | null;
  /** Its last upload failed; retried with backoff, on focus and online. */
  unsynced: Outcome | null;
};
type Job = { doc: Doc; text: string; edit: number };

export class DocumentSession {
  /** The document the editor shows; edits are saved only to this id. */
  openId: string | null = null;
  private readonly timing: SaveTiming;
  private sequence = 0;
  private edits = 0;
  private docs = new Map<string, Doc>();
  private pending: { doc: Doc; text: PendingText; edit: number } | null = null;
  /** A journal write that failed; retried before the next one. */
  private failedJob: Job | null = null;
  private staging: Promise<boolean> = Promise.resolve(true);
  private lastEditAt = 0;
  private dirtySince: number | null = null;
  private retryAt: number | null = null;
  private retries = 0;
  private holds = 0;
  private uploads = 0;
  private busy = false;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;
  private shown: SyncState = "clean";
  /** Bumped by `reset`, so answers from before a lock change nothing. */
  private epoch = 0;
  private readonly store: DocumentStore;
  private readonly events: SessionEvents;
  private readonly now: () => number;

  constructor(
    store: DocumentStore,
    events: SessionEvents,
    timing: Partial<SaveTiming> = {},
    now: () => number = () => Date.now(),
  ) {
    this.store = store;
    this.events = events;
    this.timing = { ...SAVE_TIMING, ...timing };
    this.now = now;
  }

  /** Records an edit of the open document. Only a state change touches the UI. */
  edited(text: PendingText): void {
    if (!this.openId) return;
    const doc = this.track(this.openId);
    doc.edit = ++this.edits;
    this.pending = { doc, text, edit: doc.edit };
    this.lastEditAt = this.now();
    this.dirtySince ??= this.lastEditAt;
    this.render();
    this.schedule();
  }

  /**
   * Writes the pending edit to the local outbox now, after every earlier
   * write. Resolves false only when the outbox could not be written.
   */
  persist(): Promise<boolean> {
    // Read the text now: the editor may switch models before the write runs.
    const pending = this.pending;
    this.pending = null;
    const job = pending && {
      doc: pending.doc,
      edit: pending.edit,
      text: typeof pending.text === "function" ? pending.text() : pending.text,
    };
    const epoch = this.epoch;
    this.staging = this.staging.then(async () => {
      const retry = this.failedJob;
      this.failedJob = null;
      let written = true;
      for (const item of [retry, job]) {
        if (item && epoch === this.epoch && item.doc.staged < item.edit) {
          written = (await this.stage(item)) && written;
        }
      }
      return written && this.failedJob === null;
    });
    return this.staging;
  }

  /**
   * Cmd/Ctrl+S: uploads the open document now. A document without unsynced
   * edits sends nothing. Resolves true once S3 holds every edit.
   */
  async save(): Promise<boolean> {
    const doc = this.openDoc();
    if (!doc || !isDirty(doc)) return true;
    return (await this.commit(doc)) === "saved";
  }

  /** Window blur or hidden: the open document syncs in the background. */
  background(): void {
    void this.save();
  }

  /**
   * Close and lock: writes the outbox (resolves false when that failed, and
   * the caller then stays open), then lets the upload run for at most 3 s.
   * An edit not uploaded by then is in the outbox, and the next unlock sends it.
   */
  async flushForExit(): Promise<boolean> {
    if (!(await this.persist())) return false;
    await within(this.save(), this.timing.exitBudgetMs);
    return true;
  }

  /** Retries every upload that failed (backoff timer, focus, back online). */
  async retryNow(): Promise<void> {
    this.retryAt = null;
    const docs = [...this.docs.values()].filter((doc) => doc.unsynced);
    await Promise.all(docs.map((doc) => this.commit(doc)));
  }

  /** The status dot's click: uploads the open document and retries the rest. */
  async syncNow(): Promise<void> {
    await Promise.all([this.save(), this.retryNow()]);
  }

  /**
   * Opens `id`: writes the previous document's edit to the outbox first,
   * loads, and calls `show` only if no newer open (or `invalidate`) came in
   * meanwhile; the previous document then uploads in the background.
   * Resolves false when superseded; rejects only when the newest load
   * failed, and then the previously open document stays open.
   */
  async open(id: string, show: (data: DocumentData) => void): Promise<boolean> {
    const sequence = ++this.sequence;
    const previous = this.openDoc();
    if (!(await this.persist())) {
      if (sequence !== this.sequence) return false;
      throw new Error("The current document could not be saved on this device.");
    }
    if (sequence !== this.sequence) return false;
    let data: DocumentData;
    try {
      data = await this.store.open(id);
    } catch (error) {
      if (sequence !== this.sequence) return false;
      throw error;
    }
    if (sequence !== this.sequence) return false;
    // Typed into the previous document while this one was loading.
    if (this.pending) void this.persist();
    this.openId = id;
    const doc = this.track(id);
    // An edit from the outbox that S3 does not hold yet.
    if (data.dirty && !isDirty(doc)) doc.edit = doc.staged = ++this.edits;
    this.lastEditAt = this.now();
    this.dirtySince = isDirty(doc) ? this.lastEditAt : null;
    show(data);
    if (previous && previous !== doc && isDirty(previous)) void this.commit(previous);
    this.render();
    this.schedule();
    return true;
  }

  /** No document is open any more. */
  close(): void {
    this.invalidate();
    this.openId = null;
    this.dirtySince = null;
    this.render();
  }

  /** Opens still in flight never switch the editor (lock, settings). */
  invalidate(): void {
    this.sequence++;
  }

  /** While a rename, move or trash runs, timed journal writes and uploads wait. */
  hold(): void {
    this.holds++;
    this.schedule();
  }

  release(): void {
    this.holds = Math.max(0, this.holds - 1);
    this.schedule();
  }

  /** A rename or move gave the document `from` a new id; null when it left the tree. */
  retarget(from: string, to: string | null): void {
    const doc = this.docs.get(from);
    if (doc) {
      this.docs.delete(from);
      if (to) {
        doc.id = to;
        this.docs.set(to, doc);
      } else {
        doc.unsynced = null;
        if (this.pending?.doc === doc) this.pending = null;
        if (this.failedJob?.doc === doc) this.failedJob = null;
      }
    }
    if (this.openId === from) this.openId = to;
    this.settleProblems();
    this.render();
    this.schedule();
  }

  /** Forgets everything after a lock; the outbox keeps what was written. */
  reset(): void {
    this.epoch++;
    this.invalidate();
    this.openId = null;
    this.pending = null;
    this.failedJob = null;
    this.docs.clear();
    this.holds = 0;
    this.uploads = 0;
    this.retries = 0;
    this.retryAt = null;
    this.dirtySince = null;
    this.busy = false;
    this.shown = "clean";
    if (this.busyTimer !== null) clearTimeout(this.busyTimer);
    this.busyTimer = null;
    this.cancelTimer();
  }

  private track(id: string): Doc {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = { id, edit: 0, staged: 0, committed: 0, uploading: null, unsynced: null };
      this.docs.set(id, doc);
    }
    return doc;
  }

  private openDoc(): Doc | undefined {
    return this.openId === null ? undefined : this.docs.get(this.openId);
  }

  private async stage(job: Job): Promise<boolean> {
    const epoch = this.epoch;
    try {
      const result = await this.store.stage(job.doc.id, job.text);
      if (epoch !== this.epoch) return true;
      job.doc.staged = Math.max(job.doc.staged, job.edit);
      // Typed back to the text S3 already holds.
      if (result === "Clean") job.doc.committed = Math.max(job.doc.committed, job.edit);
      if (this.failedJob?.doc === job.doc && this.failedJob.edit <= job.edit) this.failedJob = null;
      if (job.doc.id === this.openId && !isDirty(job.doc)) this.dirtySince = null;
      this.render();
      return true;
    } catch {
      if (epoch === this.epoch && (!this.failedJob || this.failedJob.edit < job.edit)) this.failedJob = job;
      this.render();
      return false;
    }
  }

  /** One upload per document at a time; a caller arriving meanwhile joins it. */
  private commit(doc: Doc): Promise<Outcome> {
    if (doc.uploading) {
      return doc.uploading.then((outcome) =>
        outcome === "saved" && doc.edit > doc.committed ? this.commit(doc) : outcome);
    }
    const run = this.upload(doc);
    doc.uploading = run;
    void run.then(() => {
      if (doc.uploading === run) doc.uploading = null;
      this.render();
      this.schedule();
    });
    return run;
  }

  private async upload(doc: Doc): Promise<Outcome> {
    const epoch = this.epoch;
    if (!(await this.persist()) && doc.staged < doc.edit) return "failed";
    if (epoch !== this.epoch || doc.staged <= doc.committed) return "saved";
    const target = doc.staged;
    const startedAt = this.now();
    this.uploadStarted();
    try {
      const result = await this.store.commit(doc.id);
      if (epoch !== this.epoch) return "saved";
      if (result.status === "Offline") return this.unsynced(doc, "offline");
      doc.committed = Math.max(doc.committed, target);
      doc.unsynced = null;
      if (doc.id === this.openId) this.dirtySince = isDirty(doc) ? startedAt : null;
      if (result.status === "ConflictCopy" && result.document_id && result.document_id !== doc.id) {
        const from = doc.id;
        this.retarget(from, result.document_id);
        this.events.conflict?.(from, result.document_id);
      }
      this.settleProblems();
      return "saved";
    } catch {
      return epoch === this.epoch ? this.unsynced(doc, "failed") : "saved";
    } finally {
      if (epoch === this.epoch) this.uploadEnded();
    }
  }

  private unsynced(doc: Doc, outcome: "offline" | "failed"): Outcome {
    doc.unsynced = outcome;
    if (outcome === "offline" && this.retryAt === null) {
      const delays = this.timing.retryMs;
      this.retryAt = this.now() + delays[Math.min(this.retries, delays.length - 1)]!;
      this.retries++;
    }
    return outcome;
  }

  /** Once nothing is unsynced, the backoff starts over. */
  private settleProblems(): void {
    if ([...this.docs.values()].some((doc) => doc.unsynced)) return;
    this.retries = 0;
    this.retryAt = null;
  }

  private uploadStarted(): void {
    if (this.uploads++ === 0) {
      this.busyTimer = setTimeout(() => {
        this.busyTimer = null;
        this.busy = this.uploads > 0;
        this.render();
      }, this.timing.busyMs);
    }
  }

  private uploadEnded(): void {
    if (--this.uploads > 0) return;
    if (this.busyTimer !== null) clearTimeout(this.busyTimer);
    this.busyTimer = null;
    this.busy = false;
  }

  private render(): void {
    const docs = [...this.docs.values()];
    const open = this.openDoc();
    const state: SyncState =
      this.failedJob || docs.some((doc) => doc.unsynced === "failed") ? "failed"
        : docs.some((doc) => doc.unsynced === "offline") ? "offline"
          : this.busy ? "busy"
            : open && isDirty(open) ? "dirty"
              : "clean";
    if (state === this.shown) return;
    this.shown = state;
    this.events.state(state);
  }

  /** When the next journal write, upload or retry is due; null when none is. */
  private nextDue(): number | null {
    if (this.holds > 0) return null;
    let due = Infinity;
    if (this.pending) due = this.lastEditAt + this.timing.stageMs;
    const open = this.openDoc();
    if (open && isDirty(open) && !open.uploading && !open.unsynced) {
      due = Math.min(due, this.lastEditAt + this.timing.idleMs, (this.dirtySince ?? this.lastEditAt) + this.timing.maxDirtyMs);
    }
    if (this.retryAt !== null) due = Math.min(due, this.retryAt);
    return due === Infinity ? null : due;
  }

  /**
   * One timer for everything. Typing only moves `lastEditAt`; an earlier
   * timer stays armed and re-checks when it fires, so a keystroke never
   * clears or creates a timer.
   */
  private schedule(): void {
    const due = this.nextDue();
    if (due === null) {
      this.cancelTimer();
      return;
    }
    if (this.timer !== null && this.timerAt <= due) return;
    this.cancelTimer();
    this.timerAt = due;
    this.timer = setTimeout(this.tick, Math.max(0, due - this.now()));
  }

  private tick = (): void => {
    this.timer = null;
    this.timerAt = Infinity;
    if (this.holds > 0) return;
    const now = this.now();
    if (this.pending && now >= this.lastEditAt + this.timing.stageMs) void this.persist();
    const open = this.openDoc();
    if (open && isDirty(open) && !open.uploading && !open.unsynced
      && (now >= this.lastEditAt + this.timing.idleMs || now >= (this.dirtySince ?? now) + this.timing.maxDirtyMs)) {
      void this.commit(open);
    }
    if (this.retryAt !== null && now >= this.retryAt) void this.retryNow();
    this.schedule();
  };

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }
}

function isDirty(doc: Doc): boolean {
  return doc.edit > doc.committed;
}

/** Waits for `promise`, but at most `ms`. */
export function within(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
