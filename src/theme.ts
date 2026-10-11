// Theme selection for src/theme.css, the single source of truth for every
// colour and metric: <html data-theme> and <html data-accent> pick the token
// sets, and everything styled with the tokens (the editor included) follows.

type ThemeMode = "dark" | "light";
export type ThemePreference = "System" | "Light" | "Dark";

const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

/** Turns a preference into the mode that should be shown right now. */
function resolveTheme(preference: ThemePreference): ThemeMode {
  if (preference === "Dark") return "dark";
  if (preference === "Light") return "light";
  return darkQuery?.matches === false ? "light" : "dark";
}

/** Calls `listener` whenever the OS switches between light and dark. */
function onSystemThemeChange(listener: () => void): void {
  darkQuery?.addEventListener("change", listener);
}

/** The accent palette in theme.css (html[data-accent]); orange is the app icon's. */
export const ACCENTS = ["orange", "red", "pink", "purple", "blue", "teal", "green", "yellow", "graphite"] as const;
export type Accent = (typeof ACCENTS)[number];
export const DEFAULT_ACCENT: Accent = "orange";

export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value);
}

/** Selects the accent in theme.css. */
export function applyAccent(accent: Accent): void {
  document.documentElement.dataset.accent = accent;
}

/** Selects the token set in theme.css by setting <html data-theme>. */
function applyDocumentTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
}

let themePreference: ThemePreference = "System";
let followingSystem = false;

/** Applies the app theme; "System" follows OS changes while it is selected. */
export function setTheme(theme: ThemePreference): void {
  themePreference = theme;
  if (theme === "System" && !followingSystem) {
    followingSystem = true;
    onSystemThemeChange(() => {
      if (themePreference === "System") applyDocumentTheme(resolveTheme(themePreference));
    });
  }
  applyDocumentTheme(resolveTheme(theme));
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
