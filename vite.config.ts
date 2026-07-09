import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig(({ command }) => ({
  root: resolve(__dirname, "src"),
  publicDir: resolve(__dirname, "public"),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "esnext",
    // Only ship sourcemaps for `vite`/`vite dev` (serve), never for a prod
    // `vite build` - the multi-MB .map files have no business in a shipped
    // NSIS/DMG/DEB bundle.
    sourcemap: command === "serve",
    rollupOptions: {
      // Multi-page build: overlay.html (src-tauri/src/ipc/overlay_window.rs)
      // is a separate entry from index.html so the floating overlay window's
      // chunk doesn't pull in main.ts's full statically-imported view graph.
      // Explicit once rollupOptions.input is set, Vite's implicit
      // `<root>/index.html` default no longer applies - both entries must be
      // listed or the production build would silently drop one.
      input: {
        main: resolve(__dirname, "src/index.html"),
        overlay: resolve(__dirname, "src/overlay.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
}));
