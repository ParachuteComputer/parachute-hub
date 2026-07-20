#!/usr/bin/env bun

/**
 * Serving the Parachute app AT the hub's origin root (`root_mode = serve-app`).
 *
 * When an operator flips the root mode to `serve-app` (or a fresh hub installs
 * the app during setup), the hub answers its own origin root with the installed
 * `@openparachute/parachute-app` bundle instead of 302-ing to `/admin`. This is
 * the self-hosted mirror of the hosted door: hit your box's URL, land in the
 * app — no redirect hop.
 *
 * Why this is asset-correct with no rebuild: the app's Vite build is ROOT-based
 * (absolute `/assets/*`, PWA scope `/`, OAuth redirect URIs at the origin root).
 * The `/app` service mount serves the SAME dist through the `notes-serve.ts`
 * shim with a `/app` prefix-strip; here we serve that identical dist verbatim at
 * `/`, which is exactly the origin the build assumes. So `serveAppAtRoot` and
 * the `/app` mount hand back byte-identical bundle files — the only difference
 * is the URL prefix.
 *
 * Precedence is the caller's job (hub-server.ts): the fresh-hub setup wizard
 * funnel and the pre-admin 503 lockout run BEFORE the root `/` handler, and
 * every hub-owned route (/admin, /oauth, /.well-known, /vault, /git, /api,
 * service mounts) dispatches BEFORE the SPA-fallback tail. This module only
 * decides "given an already-unclaimed GET, does the app dist answer it?".
 *
 * NO chrome injection ever rides a root-served response — the app owns its whole
 * page (same posture as the public/surface chrome opt-out). We build the
 * responses here directly rather than routing through `decorateWithChrome`.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveNotesDistFrom } from "./notes-serve.ts";

/** The npm package whose built `dist/` is the app front door. */
export const APP_PACKAGE = "@openparachute/parachute-app";

/**
 * Namespaces that keep the hub's branded 404 even in serve-app mode. These are
 * hub / protocol surfaces, never app client-side routes, so an SPA shell there
 * would be wrong — and would mask a genuine 404 for an API/OAuth/well-known
 * typo. (Real dist files never live under these prefixes anyway; this makes the
 * "don't shell it" decision explicit rather than incidental.)
 */
export const ROOT_SERVE_RESERVED_PREFIXES: readonly string[] = [
  "/api/",
  "/oauth/",
  "/.well-known/",
];

/**
 * Build a resolver for the installed app's `dist/` directory.
 *
 * Resolution goes through the SAME `resolveNotesDistFrom` machinery the `/app`
 * mount's static-serve shim uses (so root-serve and `/app` resolve to one dist).
 * A SUCCESSFUL resolution is memoized for the process lifetime — a resolved dist
 * path doesn't move while the hub runs, and re-walking `Bun.resolveSync` on every
 * asset request would be needless work. A FAILURE is NOT cached: an operator who
 * set `serve-app` before installing the app, then runs `parachute install app`,
 * is picked up on the next request without a hub restart (dynamic recovery).
 *
 * `resolve` is the test seam (defaults to the real package resolution). Return
 * value is the dist dir, or `null` when the app can't be resolved (not installed
 * / ships no `dist/`).
 */
export function makeAppDistResolver(
  resolve: () => string = () => resolveNotesDistFrom({ pkg: APP_PACKAGE }),
): () => string | null {
  let cached: string | null = null;
  return () => {
    if (cached !== null) return cached;
    try {
      cached = resolve();
      return cached;
    } catch {
      return null;
    }
  };
}

/** MIME overrides Bun.file doesn't infer (mirrors notes-serve.ts). */
function mimeFor(path: string): string | undefined {
  // Without this the PWA install prompt sees text/html for the manifest + bails.
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  return undefined;
}

/**
 * Answer an already-unclaimed request from the app's root-based `dist/`, or
 * return `null` to tell the caller to fall through to its normal handling
 * (the `/` 302 fallback, or the branded 404 tail).
 *
 * Contract:
 *   - non-GET                                     → null (fall through)
 *   - a reserved hub/protocol prefix              → null (keep the branded 404)
 *   - GET + an existing file under dist           → that file (asset-correct MIME)
 *   - GET `/` or a trailing-slash "dir" request   → dist/index.html (SPA shell)
 *   - GET + no file + Accept: text/html           → dist/index.html (SPA deep link)
 *   - GET + no file + non-HTML (API probe, etc.)  → null (branded 404)
 *
 * `dist` is a resolved directory (from `makeAppDistResolver`); if its
 * `index.html` has since vanished (app uninstalled after a successful resolve)
 * we return `null` rather than serving a broken shell.
 */
export function serveAppAtRoot(dist: string, req: Request, pathname: string): Response | null {
  // Only GET is served (HEAD/POST/etc. keep the caller's default — a non-GET to
  // an unclaimed path stays a 404, and a non-GET `/` keeps its 302).
  if (req.method !== "GET") return null;

  // Hub/protocol namespaces are never the app's — leave their 404 branded.
  for (const prefix of ROOT_SERVE_RESERVED_PREFIXES) {
    if (pathname.startsWith(prefix)) return null;
  }

  const indexHtml = join(dist, "index.html");
  // The resolved bundle lost its shell (uninstalled mid-flight) → fall through.
  if (!existsSync(indexHtml)) return null;

  const spaShell = () =>
    new Response(Bun.file(indexHtml), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  // Bare root or a trailing-slash "directory" request → the SPA shell.
  if (pathname === "/" || pathname.endsWith("/")) return spaShell();

  // An existing dist file: /assets/*, /icon.svg, /manifest.webmanifest, /sw.js …
  // Path-traversal guard: the joined path must stay strictly under dist/.
  const filePath = join(dist, decodeURIComponent(pathname));
  if (filePath.startsWith(`${dist}/`) && existsSync(filePath) && statSync(filePath).isFile()) {
    const mime = mimeFor(filePath);
    return new Response(
      Bun.file(filePath),
      mime ? { headers: { "content-type": mime } } : undefined,
    );
  }

  // No matching file. Serve the SPA shell ONLY for HTML navigations (a deep link
  // like /some-note the app routes client-side). A browser navigation sends
  // `Accept: text/html`; a non-HTML unclaimed request (API probe, a missing
  // asset fetched with `Accept: */*`) falls through to the branded 404.
  const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
  return wantsHtml ? spaShell() : null;
}
