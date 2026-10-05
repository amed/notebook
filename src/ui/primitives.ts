type IconName =
  | "archive"
  | "back"
  | "check"
  | "chevron"
  | "close"
  | "columns"
  | "document"
  | "folder"
  | "gear"
  | "image"
  | "list"
  | "lock"
  | "moon"
  | "pencil"
  | "plus"
  | "preview"
  | "refresh"
  | "search"
  | "shield"
  | "spark"
  | "trash"
  | "warning";

const ICONS: Record<IconName, string> = {
  archive:
    '<svg viewBox="0 0 24 24"><path d="M4 7.5h16v12H4zM3 4.5h18v3H3zM9 11h6"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  columns: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
  document:
    '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h5"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24"><path d="M3 6.5h7l2 2h9v11H3z"/></svg>',
  gear:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.5 1a8 8 0 0 0-1.7-1L14.3 3h-4.1L9.7 6A8 8 0 0 0 8 7L5.5 6l-2 3.4L5.6 11a7 7 0 0 0 0 2l-2.1 1.6 2 3.4L8 17a8 8 0 0 0 1.7 1l.5 3h4.1l.5-3a8 8 0 0 0 1.7-1l2.5 1 2-3.4-2.1-1.6a7 7 0 0 0 .1-1Z"/></svg>',
  image:
    '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 3 3 2-2 6 5"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 15.5A8 8 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  preview:
    '<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5M19 12a7 7 0 0 0-12-5L4 10M5 12a7 7 0 0 0 12 5l3-3"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 2.5 20 6v5.5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="m12 2 1.4 5.6L19 9l-5.6 1.4L12 16l-1.4-5.6L5 9l5.6-1.4zM19 15l.6 2.4L22 18l-2.4.6L19 21l-.6-2.4L16 18l2.4-.6z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 14h9l1-14M10 11v6M14 11v6"/></svg>',
  warning: '<svg viewBox="0 0 24 24"><path d="M12 3 2.5 20h19zM12 9v5M12 17.5v.1"/></svg>',
};

export function icon(name: IconName, label?: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "icon";
  span.innerHTML = ICONS[name];
  if (label) {
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", label);
  } else {
    span.setAttribute("aria-hidden", "true");
  }
  return span;
}

export function button(
  label: string,
  options: {
    icon?: IconName;
    className?: string;
    title?: string;
    type?: "button" | "submit";
  } = {},
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = options.type ?? "button";
  element.className = options.className ?? "button";
  if (options.icon) element.append(icon(options.icon));
  const text = document.createElement("span");
  text.textContent = label;
  element.append(text);
  if (options.title) element.title = options.title;
  return element;
}

export function clear(element: Element): void {
  element.replaceChildren();
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "";
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

export function formatDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function plural(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

export class Toasts {
  readonly element: HTMLElement;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "toast-region";
    this.element.setAttribute("aria-live", "polite");
    this.element.setAttribute("aria-atomic", "false");
    document.body.append(this.element);
  }

  show(message: string, tone: "default" | "success" | "warning" = "default"): void {
    const toast = document.createElement("div");
    toast.className = `toast toast-${tone}`;
    toast.setAttribute("role", tone === "warning" ? "alert" : "status");
    if (tone === "success") toast.append(icon("check"));
    if (tone === "warning") toast.append(icon("warning"));
    const text = document.createElement("span");
    text.textContent = message;
    toast.append(text);
    this.element.append(toast);
    requestAnimationFrame(() => toast.classList.add("toast-visible"));
    window.setTimeout(() => {
      toast.classList.remove("toast-visible");
      window.setTimeout(() => toast.remove(), 180);
    }, 4_800);
  }

  dispose(): void {
    this.element.remove();
  }
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  description?: string;
  danger?: boolean;
}

export class Modals {
  private active: HTMLElement | null = null;

  async confirm(options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    detail?: string;
  }): Promise<boolean> {
    const result = await this.choose({
      title: options.title,
      message: options.message,
      detail: options.detail,
      cancelLabel: options.cancelLabel ?? "Cancel",
      choices: [
        {
          value: "confirm",
          label: options.confirmLabel ?? "Continue",
          danger: options.danger,
        },
      ],
    });
    return result === "confirm";
  }

  prompt(options: {
    title: string;
    label: string;
    message?: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
    validate?: (value: string) => string | null;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      const { overlay, card, close } = this.frame(options.title, () => resolve(null));
      if (options.message) {
        const message = document.createElement("p");
        message.className = "modal-message";
        message.textContent = options.message;
        card.append(message);
      }
      const form = document.createElement("form");
      form.className = "modal-form";
      const label = document.createElement("label");
      label.textContent = options.label;
      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.autocomplete = "off";
      input.maxLength = 255;
      input.value = options.initialValue ?? "";
      input.placeholder = options.placeholder ?? "";
      label.append(input);
      const error = document.createElement("p");
      error.className = "field-error";
      error.setAttribute("role", "alert");
      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancel = button("Cancel", { className: "button button-ghost" });
      const submit = button(options.confirmLabel ?? "Save", {
        className: "button button-primary",
        type: "submit",
      });
      actions.append(cancel, submit);
      form.append(label, error, actions);
      card.append(form);
      cancel.addEventListener("click", () => {
        close();
        resolve(null);
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = input.value.trim();
        const validation = options.validate?.(value) ?? (value ? null : "Enter a name.");
        if (validation) {
          error.textContent = validation;
          input.setAttribute("aria-invalid", "true");
          input.focus();
          return;
        }
        close();
        resolve(value);
      });
      document.body.append(overlay);
      input.focus();
      input.select();
    });
  }

  choose<T extends string>(options: {
    title: string;
    message: string;
    detail?: string;
    choices: Choice<T>[];
    cancelLabel?: string;
  }): Promise<T | null> {
    return new Promise((resolve) => {
      const { overlay, card, close } = this.frame(options.title, () => resolve(null));
      const message = document.createElement("p");
      message.className = "modal-message";
      message.textContent = options.message;
      card.append(message);
      if (options.detail) {
        const detail = document.createElement("p");
        detail.className = "modal-detail";
        detail.textContent = options.detail;
        card.append(detail);
      }
      const choices = document.createElement("div");
      choices.className = "modal-choices";
      for (const item of options.choices) {
        const choice = button(item.label, {
          className: item.danger
            ? "button modal-choice button-danger"
            : "button modal-choice",
        });
        if (item.description) {
          const description = document.createElement("small");
          description.textContent = item.description;
          choice.append(description);
        }
        choice.addEventListener("click", () => {
          close();
          resolve(item.value);
        });
        choices.append(choice);
      }
      card.append(choices);
      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancel = button(options.cancelLabel ?? "Cancel", {
        className: "button button-ghost",
      });
      cancel.addEventListener("click", () => {
        close();
        resolve(null);
      });
      actions.append(cancel);
      card.append(actions);
      document.body.append(overlay);
      (choices.querySelector("button") as HTMLButtonElement | null)?.focus();
    });
  }

  private frame(
    titleText: string,
    cancel: () => void,
  ): { overlay: HTMLElement; card: HTMLElement; close: () => void } {
    this.active?.remove();
    const returnFocus = document.activeElement as HTMLElement | null;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const card = document.createElement("section");
    card.className = "modal-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    const heading = document.createElement("h2");
    heading.textContent = titleText;
    const titleId = `modal-${crypto.randomUUID()}`;
    heading.id = titleId;
    card.setAttribute("aria-labelledby", titleId);
    card.append(heading);
    overlay.append(card);
    this.active = overlay;

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      overlay.remove();
      if (this.active === overlay) this.active = null;
      returnFocus?.focus();
    };
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) {
        close();
        cancel();
      }
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        cancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        card.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    return { overlay, card, close };
  }
}

export interface ContextAction {
  label: string;
  /** A second, muted line under the label. */
  detail?: string;
  /** Makes the item a radio item with a check mark (shown when true). */
  checked?: boolean;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  run: () => void;
}

export class ContextMenu {
  private element: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;

  /**
   * Closes on Esc (focus returns where it was), a pointerdown outside the
   * menu, or window blur. A pointerdown inside it does not close it, so the
   * click on an item lands. Arrow keys, Home and End move between items.
   */
  show(x: number, y: number, actions: ContextAction[], options: { className?: string; onClose?: () => void; properties?: Record<string, string> } = {}): void {
    this.close();
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = document.createElement("div");
    menu.className = options.className ? `context-menu ${options.className}` : "context-menu";
    // CSS custom properties for the menu's own rules (for example its width).
    for (const [name, value] of Object.entries(options.properties ?? {})) menu.style.setProperty(name, value);
    menu.setAttribute("role", "menu");
    for (const action of actions) {
      if (action.separatorBefore) {
        const separator = document.createElement("div");
        separator.className = "menu-separator";
        separator.setAttribute("role", "separator");
        menu.append(separator);
      }
      const item = button(action.label, {
        icon: action.icon,
        className: action.danger ? "menu-item menu-danger" : "menu-item",
      });
      item.setAttribute("role", action.checked === undefined ? "menuitem" : "menuitemradio");
      if (action.checked !== undefined) {
        item.setAttribute("aria-checked", String(action.checked));
        const mark = icon("check");
        mark.classList.add("menu-check");
        item.prepend(mark);
      }
      if (action.detail) {
        const label = item.lastElementChild!;
        const text = document.createElement("span");
        text.className = "menu-item-text";
        const detail = document.createElement("small");
        detail.className = "menu-item-detail";
        detail.textContent = action.detail;
        label.replaceWith(text);
        text.append(label, detail);
        item.title = `${action.label} · ${action.detail}`;
      }
      item.disabled = action.disabled ?? false;
      item.addEventListener("click", () => {
        this.close();
        action.run();
      });
      menu.append(item);
    }
    document.body.append(menu);
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
    const dismiss = (event: Event): void => {
      if (!menu.contains(event.target as Node)) this.close();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      this.close();
      if (returnFocus?.isConnected) returnFocus.focus();
    };
    menu.addEventListener("keydown", (event) => {
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const focused = items.indexOf(document.activeElement as HTMLButtonElement);
      // Nothing focused: Down goes to the first item, Up to the last.
      const index = focused >= 0 ? focused : event.key === "ArrowUp" ? 0 : -1;
      const next = event.key === "ArrowDown" ? items[(index + 1) % items.length]
        : event.key === "ArrowUp" ? items[(index - 1 + items.length) % items.length]
          : event.key === "Home" ? items[0]
            : event.key === "End" ? items.at(-1)
              : undefined;
      if (!next) return;
      event.preventDefault();
      next.focus();
    });
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", this.close);
    window.addEventListener("keydown", escape);
    this.cleanup = () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", this.close);
      window.removeEventListener("keydown", escape);
      options.onClose?.();
    };
    this.element = menu;
    (menu.querySelector("button:not(:disabled)") as HTMLButtonElement | null)?.focus();
  }

  close = (): void => {
    this.cleanup?.();
    this.cleanup = null;
    this.element?.remove();
    this.element = null;
  };
}
