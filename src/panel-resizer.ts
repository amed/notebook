import {
  BIG_STEP,
  DEFAULT_LAYOUT,
  type LayoutContext,
  type PanelLayout,
  type ResolvedLayout,
  STEP,
  resolveLayout,
  sameLayout,
} from "./panel-layout";

export type PanelHandleName = "sidebar" | "outline" | "split";

export interface PanelResizerHost {
  /**
   * The containers (and handles) whose own rules use --sidebar-width,
   * --outline-width and --split-ratio; each gets them on its own style, as
   * theme.css registers them as not inherited.
   */
  containers: HTMLElement[];
  /** Shown while dragging: keeps the cursor and takes the pointer from frames. */
  overlay: HTMLElement;
  handles: Record<PanelHandleName, HTMLElement>;
  context(): Omit<LayoutContext, "viewport">;
  /** The user's sizes changed: called once a drag ends, or 500 ms after the last resize key. */
  commit(layout: PanelLayout): void;
}

/** A keyboard change is saved this long after the last resize key. */
const KEY_COMMIT_DELAY_MS = 500;

interface Drag {
  name: PanelHandleName;
  pointerId: number;
  startX: number;
  x: number;
  /** What was on screen when the drag started: a width in pixels, or the ratio. */
  start: number;
  /** The editor plus the preview at the start, for the ratio. */
  panes: number;
  before: PanelLayout;
}

/**
 * The three resize handles (role="separator"). A drag writes the widths as
 * CSS custom properties on the layout containers at most once per animation frame,
 * computed from the pointer and window.innerWidth only, so a drag reads no
 * layout; Monaco follows through its own ResizeObserver (automaticLayout).
 * The pointer is captured, and a transparent overlay covers the window while
 * dragging, so the HTML preview's iframe never takes the drag.
 */
export class PanelResizers {
  private layout: PanelLayout;
  private resolved: ResolvedLayout;
  private written = new Map<string, string>();
  private drag: Drag | null = null;
  private frame: number | null = null;
  private keyTimer: number | null = null;
  private keyPending = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly host: PanelResizerHost, layout: PanelLayout) {
    this.layout = { ...layout };
    this.resolved = this.resolve();
    for (const name of Object.keys(host.handles) as PanelHandleName[]) this.bind(name, host.handles[name]);
    this.listen(window, "resize", () => this.update());
    this.update();
  }

  /** The user's sizes (what is saved), not the ones the window fits. */
  get value(): PanelLayout {
    return { ...this.layout };
  }

  /** The sizes on screen. */
  get current(): ResolvedLayout {
    return this.resolved;
  }

  /** Fits the sizes to the window, view mode and outline; writes only what changed. */
  update(): void {
    this.resolved = this.resolve();
    const { sidebar, outline, ratio, limits } = this.resolved;
    this.write("--sidebar-width", `${sidebar}px`);
    this.write("--outline-width", `${outline}px`);
    this.write("--split-ratio", String(ratio));
    const handles = this.host.handles;
    setValues(handles.sidebar, sidebar, limits.sidebar.min, limits.sidebar.max, `${sidebar} pixels`);
    setValues(handles.outline, outline, limits.outline.min, limits.outline.max, `${outline} pixels`);
    const percent = (value: number): number => Math.round(value * 100);
    setValues(handles.split, percent(ratio), percent(limits.ratio.min), percent(limits.ratio.max), `Editor ${percent(ratio)}%, preview ${100 - percent(ratio)}%`);
  }

  /** Saves a keyboard change still waiting for its pause (the window is closing). */
  flush(): void {
    if (this.keyTimer !== null) window.clearTimeout(this.keyTimer);
    this.keyTimer = null;
    if (!this.keyPending) return;
    this.keyPending = false;
    this.host.commit(this.value);
  }

  /** Removes the listeners; a drag in progress or a keyboard change still waiting is saved now. */
  dispose(): void {
    this.endDrag();
    this.flush();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private resolve(): ResolvedLayout {
    return resolveLayout(this.layout, { viewport: window.innerWidth, ...this.host.context() });
  }

  private write(name: string, value: string): void {
    if (this.written.get(name) === value) return;
    this.written.set(name, value);
    for (const container of this.host.containers) container.style.setProperty(name, value);
  }

  private listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    target.addEventListener(type, listener);
    this.cleanups.push(() => target.removeEventListener(type, listener));
  }

  private bind(name: PanelHandleName, handle: HTMLElement): void {
    // Dragging keeps the focus (and the editor's caret) where it was.
    this.listen(handle, "mousedown", (event) => event.preventDefault());
    this.listen(handle, "pointerdown", (event) => this.startDrag(name, handle, event as PointerEvent));
    this.listen(handle, "pointermove", (event) => this.moveDrag(event as PointerEvent));
    this.listen(handle, "pointerup", (event) => this.pointerEnded(event as PointerEvent));
    this.listen(handle, "pointercancel", (event) => this.pointerEnded(event as PointerEvent));
    this.listen(handle, "lostpointercapture", (event) => this.pointerEnded(event as PointerEvent));
    this.listen(handle, "dblclick", (event) => {
      event.preventDefault();
      // The default is saved even where this window shows less of it.
      const before = this.value;
      this.layout = { ...this.layout, [field(name)]: DEFAULT_LAYOUT[field(name)] };
      this.update();
      if (!sameLayout(before, this.layout)) this.host.commit(this.value);
    });
    this.listen(handle, "keydown", (event) => this.onKey(name, event as KeyboardEvent));
  }

  private startDrag(name: PanelHandleName, handle: HTMLElement, event: PointerEvent): void {
    if (event.button !== 0 || this.drag) return;
    event.preventDefault();
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    // From what the window shows now, even if its resize event is still to come.
    this.update();
    this.drag = {
      name,
      pointerId: event.pointerId,
      startX: event.clientX,
      x: event.clientX,
      start: this.shown(name),
      panes: this.resolved.panes,
      before: this.value,
    };
    handle.classList.add("dragging");
    this.host.overlay.hidden = false;
  }

  private moveDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.drag.x = event.clientX;
    this.frame ??= requestAnimationFrame(() => {
      this.frame = null;
      this.followPointer();
    });
  }

  private followPointer(): void {
    const drag = this.drag;
    if (!drag) return;
    const dx = drag.x - drag.startX;
    this.set(drag.name, drag.name === "split" ? drag.start + dx / drag.panes : drag.start + dx);
  }

  private pointerEnded(event: PointerEvent): void {
    if (this.drag && event.pointerId === this.drag.pointerId) this.endDrag();
  }

  /** Ends a drag where the pointer is and saves the sizes once, if they changed. */
  private endDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.followPointer();
    this.drag = null;
    const handle = this.host.handles[drag.name];
    handle.classList.remove("dragging");
    if (handle.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
    this.host.overlay.hidden = true;
    if (!sameLayout(drag.before, this.layout)) this.host.commit(this.value);
  }

  private onKey(name: PanelHandleName, event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    this.update();
    const limits = this.resolved.limits[name === "split" ? "ratio" : name];
    const step = (event.shiftKey ? BIG_STEP : STEP) / (name === "split" ? this.resolved.panes : 1);
    let value: number;
    if (event.key === "ArrowLeft") value = this.shown(name) - step;
    else if (event.key === "ArrowRight") value = this.shown(name) + step;
    else if (event.key === "Home") value = limits.min;
    else if (event.key === "End") value = limits.max;
    else return;
    event.preventDefault();
    const before = this.value;
    this.set(name, value);
    if (sameLayout(before, this.layout)) return;
    this.keyPending = true;
    if (this.keyTimer !== null) window.clearTimeout(this.keyTimer);
    this.keyTimer = window.setTimeout(() => {
      this.keyTimer = null;
      this.keyPending = false;
      this.host.commit(this.value);
    }, KEY_COMMIT_DELAY_MS);
  }

  /** What `name` shows now. */
  private shown(name: PanelHandleName): number {
    return name === "sidebar" ? this.resolved.sidebar : name === "outline" ? this.resolved.outline : this.resolved.ratio;
  }

  /**
   * Sets `name` to `value` as far as the window allows, and saves what is
   * shown. If nothing moved (already at a limit of this window), the saved
   * value stays, which may be wider than this window allows.
   */
  private set(name: PanelHandleName, value: number): void {
    this.update();
    const key = field(name);
    const before = this.layout;
    const shownBefore = this.shown(name);
    this.layout = { ...before, [key]: value };
    this.update();
    const shown = this.shown(name);
    this.layout = shown === shownBefore ? before : { ...this.layout, [key]: shown };
  }
}

function field(name: PanelHandleName): keyof PanelLayout {
  return name === "sidebar" ? "sidebarWidth" : name === "outline" ? "outlineWidth" : "splitRatio";
}

function setValues(handle: HTMLElement, now: number, min: number, max: number, text: string): void {
  const values: [string, string][] = [
    ["aria-valuenow", String(now)],
    ["aria-valuemin", String(min)],
    ["aria-valuemax", String(max)],
    ["aria-valuetext", text],
  ];
  for (const [name, value] of values) {
    if (handle.getAttribute(name) !== value) handle.setAttribute(name, value);
  }
}
