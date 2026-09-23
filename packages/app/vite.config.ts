import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { forgeWebPlugin } from "./vite-plugin-forge-web.ts";

/**
 * Cross-origin isolation (COOP + COEP) makes SharedArrayBuffer — and with it WASM threads for
 * Forge — available. The desktop shell sends the same headers from its `app://` protocol.
 */
export const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

export default defineConfig({
  // Relative asset URLs: the bundle is served from app://aicad/ by the desktop shell (and can be
  // hosted under any path on the web).
  base: "./",
  plugins: [react(), forgeWebPlugin()],
  worker: {
    format: "es",
    plugins: () => [forgeWebPlugin()],
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    target: "es2023",
    sourcemap: true,
    // Monaco and the TypeScript compiler (CadScript runs on it) are large by nature.
    chunkSizeWarningLimit: 12_000,
  },
});
