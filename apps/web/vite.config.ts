import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Resolve @termany/core straight to its TS source — no build step for the shared
// package during dev. Vite compiles the TS on the fly.
const coreSrc = fileURLToPath(new URL("../../packages/core/src", import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [react()],
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
      ? { "import.meta.env.VITE_PTY_URL": JSON.stringify("ws://127.0.0.1:5175") }
      : {},
  server: {
    port: 15173,
    // Never silently hop to another port. If Vite stole the PTY server's port
    // (because 15173 was busy), the terminal backend would collide and die.
    // Failing loudly here makes a stale instance obvious instead of cryptic.
    strictPort: true,
  },
}));
