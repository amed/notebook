// Entry of the web version (web/index.html). theme.css is the desktop
// app's stylesheet; web.css only lays it out for phones, tablets and desktops.
import "../../src/theme.css";
import "./web.css";
import { App } from "./app.ts";

const root = document.getElementById("app");
if (root) void new App(root).start();
