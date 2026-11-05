import "./theme.css";
import { installNavigationGuards } from "./navigation";

installNavigationGuards();

// The app is loaded through a dynamic import so that a failure while
// evaluating the editor bundle shows a message instead of a blank window.
function showStartupFailure(): void {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) return;
  root.replaceChildren();
  const screen = document.createElement("main");
  screen.className = "auth-screen";
  const card = document.createElement("section");
  card.className = "auth-card";
  card.setAttribute("role", "alert");
  const title = document.createElement("h1");
  title.textContent = "Notebook could not start";
  const detail = document.createElement("p");
  detail.textContent =
    "Nothing was read from or written to your bucket. Restart the app; if this keeps happening, install the latest release.";
  card.append(title, detail);
  screen.append(card);
  root.append(screen);
}

import("./main")
  .then((app) => app.started)
  .catch((error: unknown) => {
    console.error("startup failed", error instanceof Error ? error.name : typeof error);
    showStartupFailure();
  });
