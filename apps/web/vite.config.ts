import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Resolve @termany/core straight to its TS source — no build step for the shared
// package during dev. Vite compiles the TS on the fly.
const coreSrc = fileURLToPath(new URL("../../packages/core/src", import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: "termany-state-full-reload",
      handleHotUpdate(ctx) {
        // The Zustand store is a process-local singleton. Hot-swapping this
        // module creates a fresh store with the fallback `ws 1` workspace while
        // main.tsx (and therefore SQLite hydration) does not run again. Reload
        // the document for state-layer edits so startup rehydrates the real
        // workspaces before the UI is painted.
        if (/[\\/]src[\\/]state[\\/](store|sync)\.ts$/.test(ctx.file)) {
          ctx.server.ws.send({ type: "full-reload", path: "*" });
          return [];
        }
      },
    },
  ],
  resolve: {
    alias: {
      "@termany/core": coreSrc,
    },
  },
  // The DEV server pair lives on 5175 (see apps/server) so it can coexist with
  // an installed Termany.app, whose bundled server owns 5174. Production builds
  // keep the 5174 default baked into manager.ts. An explicit VITE_PTY_URL
  // (e.g. pointing dev at a remote box) still wins.
  define:
    command === "serve" && !process.env.VITE_PTY_URL
      ? { "import.meta.env.VITE_PTY_URL": JSON.stringify("ws://localhost:5175") }
      : {},
  server: {
    port: 15173,
    // Never silently hop to another port. If Vite stole the PTY server's port
    // (because 15173 was busy), the terminal backend would collide and die.
    // Failing loudly here makes a stale instance obvious instead of cryptic.
    strictPort: true,
  },
}));
