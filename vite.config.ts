import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "esnext",
    minify: "oxc",
    sourcemap: false,
    chunkSizeWarningLimit: 4_000,
  },
});
