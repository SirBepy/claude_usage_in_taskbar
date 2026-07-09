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
