// Reads design tokens from src/theme.css at runtime. The stylesheet is the
// single source of truth; code that needs a colour or a metric (for example
// the Monaco theme) asks for the resolved custom property instead of
// hard-coding a value.

export type ThemeMode = "dark" | "light";
export type ThemePreference = "System" | "Light" | "Dark";

const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

/** Turns a preference into the mode that should be shown right now. */
export function resolveTheme(preference: ThemePreference): ThemeMode {
  if (preference === "Dark") return "dark";
  if (preference === "Light") return "light";
  return darkQuery?.matches === false ? "light" : "dark";
}

/** Calls `listener` whenever the OS switches between light and dark. */
export function onSystemThemeChange(listener: () => void): void {
  darkQuery?.addEventListener("change", listener);
}

/** The accent palette in theme.css (html[data-accent]); orange is the app icon's. */
export const ACCENTS = ["orange", "red", "pink", "purple", "blue", "teal", "green", "yellow", "graphite"] as const;
export type Accent = (typeof ACCENTS)[number];
export const DEFAULT_ACCENT: Accent = "orange";

export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value);
}

/** Selects the accent in theme.css. Re-apply the editor theme afterwards: it reads these colours. */
export function applyAccent(accent: Accent): void {
  document.documentElement.dataset.accent = accent;
}

/** Selects the token set in theme.css by setting <html data-theme>. */
export function applyDocumentTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
}

/** The computed text of a custom property, for example "700px" or a font stack (on `element`, by default the root). */
export function cssValue(name: string, element: Element = document.documentElement): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

/** A custom property holding a plain length in px, for example `--file-line-width` (on `element`, by default the root). */
export function cssPixels(name: string, fallback: number, element?: Element): number {
  const value = Number.parseFloat(cssValue(name, element));
  return Number.isFinite(value) ? value : fallback;
}

let probe: HTMLElement | null = null;

/**
 * A colour token as #rrggbb or #rrggbbaa. The browser resolves the value
 * (var(), hsl(), calc(), rgba()) on a hidden probe element.
 */
export function cssColor(name: string, fallback: string): string {
  if (!cssValue(name)) return fallback;
  if (!probe || !probe.isConnected) {
    probe = document.createElement("span");
    probe.hidden = true;
    probe.setAttribute("aria-hidden", "true");
    document.documentElement.append(probe);
  }
  probe.style.color = "";
  probe.style.color = `var(${name})`;
  return toHex(getComputedStyle(probe).color) ?? fallback;
}

function toHex(color: string): string | null {
  const parsed = parseCssColor(color);
  return parsed ? hex(parsed.rgb, parsed.alpha) : null;
}

/**
 * A computed colour (`rgb()`, `rgba()` or `color(srgb …)`) as 0–255 channels
 * and an alpha from 0 to 1; null for any other notation.
 */
export function parseCssColor(color: string): { rgb: [number, number, number]; alpha: number } | null {
  const legacy = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(color.trim());
  if (legacy) {
    const alpha = legacy[4] === undefined ? 1 : Number(legacy[4]) / (legacy[5] ? 100 : 1);
    return { rgb: [Number(legacy[1]), Number(legacy[2]), Number(legacy[3])], alpha };
  }
  const modern = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/i.exec(color.trim());
  if (modern) {
    const alpha = modern[4] === undefined ? 1 : Number(modern[4]) / (modern[5] ? 100 : 1);
    return { rgb: [Number(modern[1]) * 255, Number(modern[2]) * 255, Number(modern[3]) * 255], alpha };
  }
  return null;
}

function hex(channels: number[], alpha: number): string {
  const part = (value: number): string => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
  const rgb = channels.map(part).join("");
  return alpha >= 1 ? `#${rgb}` : `#${rgb}${part(alpha * 255)}`;
}
