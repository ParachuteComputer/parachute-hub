import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The hub mounts this SPA at `/vault/` (primary, since hub#168-realignment) and
// keeps `/hub/` mounted for back-compat (`/hub/permissions` lives there). Asset
// URLs are origin-absolute and resolve under `/vault/assets/...` regardless of
// which mount served the HTML — the same drift paraclaw#25 hit when its base
// was `/`. Override with `VITE_BASE_PATH=/` for stand-alone dev served at the
// origin root.
const basePath = normalizeBase(process.env.VITE_BASE_PATH ?? "/vault/");

function normalizeBase(input: string): string {
  let b = input.startsWith("/") ? input : `/${input}`;
  if (!b.endsWith("/")) b += "/";
  return b;
}

export default defineConfig({
  base: basePath,
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      // Dev server runs under /vault/ to mirror the production mount. The hub's
      // admin + vault API lives at the origin root (/admin/*, /vaults,
      // /.well-known/*) so we only proxy those exact prefixes — everything
      // else falls through to the SPA's static assets.
      "/admin": {
        target: process.env.HUB_ORIGIN ?? "http://127.0.0.1:1939",
        changeOrigin: true,
      },
      "/vaults": {
        target: process.env.HUB_ORIGIN ?? "http://127.0.0.1:1939",
        changeOrigin: true,
      },
      "/.well-known": {
        target: process.env.HUB_ORIGIN ?? "http://127.0.0.1:1939",
        changeOrigin: true,
      },
    },
  },
});
