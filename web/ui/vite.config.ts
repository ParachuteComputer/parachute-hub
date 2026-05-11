import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// As of hub#231 the hub mounts this SPA at `/admin/` exclusively. Asset URLs
// are origin-absolute and resolve under `/admin/assets/...`; pre-rename
// `/vault` and `/hub/*` paths are 301-redirected by `hub-server.ts` so cached
// operator URLs keep working. Override with `VITE_BASE_PATH=/` for stand-alone
// dev served at the origin root.
const basePath = normalizeBase(process.env.VITE_BASE_PATH ?? "/admin/");

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
      // Dev server runs under /admin/ to mirror the production mount. The hub
      // serves a few non-SPA paths under the same prefix (`/admin/login`,
      // `/admin/host-admin-token`, etc.) and the vault APIs at the origin root
      // (`/vaults`, `/.well-known/*`). Proxy those to the running hub so the
      // dev SPA hits real auth + data instead of 404ing on every fetch.
      //
      // Exact-prefix proxying for /admin/login and friends — but NOT a blanket
      // /admin proxy, which would steal the SPA's own /admin/vaults route.
      "/login": {
        target: process.env.HUB_ORIGIN ?? "http://127.0.0.1:1939",
        changeOrigin: true,
      },
      "/logout": {
        target: process.env.HUB_ORIGIN ?? "http://127.0.0.1:1939",
        changeOrigin: true,
      },
      "/admin/host-admin-token": {
        target: process.env.HUB_ORIGIN ?? "http://127.0.0.1:1939",
        changeOrigin: true,
      },
      "/admin/vault-admin-token": {
        target: process.env.HUB_ORIGIN ?? "http://127.0.0.1:1939",
        changeOrigin: true,
      },
      "/api": {
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
