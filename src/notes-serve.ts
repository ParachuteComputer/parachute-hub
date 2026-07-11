#!/usr/bin/env bun

/**
 * Tiny static-file server for a Parachute PWA bundle — originally written
 * for @openparachute/notes, generalized in hub-parity P5 (2026-07-11) to
 * also serve @openparachute/parachute-app (the super-surface front door,
 * port 1944, mount `/app`) via the same shim. Any package matching this
 * shape (a prebuilt SPA `dist/` with no server of its own) can reuse it.
 *
 * A served bundle is a SPA — no backend of its own. `parachute start
 * <svc>` invokes this shim with the installed `dist/` path so the PWA is
 * served at a known port and can be reverse-proxied by `parachute expose`
 * alongside the other services.
 *
 * Invoked as:
 *   bun <this-file> --port <n> [--dist <path>] [--mount <prefix>] [--package <npmName>]
 *
 * `--mount` (default `/notes`) is the path prefix the reverse proxy hands
 * us. We strip it before resolving against `dist/` so a request for
 * `/notes/sw.js` reads `{dist}/sw.js` rather than the nonexistent
 * `{dist}/notes/sw.js`. Without the strip, the SW + .webmanifest both
 * SPA-fall-back to index.html with content-type text/html, and the PWA
 * install prompt never fires. Pass `--mount ""` (or `--mount /`) when the
 * bundle is served at the origin root. THIS IS LOAD-BEARING for every
 * package served by this shim, not just notes — keep it exactly as-is.
 *
 * `--package` (default `@openparachute/notes`, back-compat) names the npm
 * package whose `dist/` we resolve when `--dist` is omitted. Passed by
 * FIRST_PARTY_FALLBACKS entries whose startCmd composes this shim for a
 * package other than notes (e.g. `app`'s `--package @openparachute/parachute-app`).
 *
 * If --dist is omitted, we resolve the package's dist directory via
 * Bun.resolveSync. If that fails (package not installed globally, or
 * package doesn't ship dist/), exit 1 with a clear error.
 *
 * `/health` (post-mount-strip) always answers 2xx — the doctor/status
 * probe (`probeModuleHealth`) only cares about the status code, but we
 * answer explicitly rather than relying on the SPA-shell catch-all so a
 * missing/corrupt `dist/index.html` can't take the health check down with it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Back-compat default — the shim's original (and still primary) consumer. */
const DEFAULT_PACKAGE = "@openparachute/notes";

interface Args {
  port: number;
  dist?: string;
  mount: string;
  pkg: string;
}

function parseArgs(argv: string[]): Args {
  let port = 5173;
  let dist: string | undefined;
  let mount = "/notes";
  let pkg = DEFAULT_PACKAGE;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const v = argv[++i];
      if (!v) throw new Error("--port requires a value");
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new Error(`--port must be 1..65535, got "${v}"`);
      }
      port = n;
    } else if (a === "--dist") {
      const v = argv[++i];
      if (!v) throw new Error("--dist requires a value");
      dist = resolve(v);
    } else if (a === "--mount") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--mount requires a value");
      mount = normalizeMount(v);
    } else if (a === "--package") {
      const v = argv[++i];
      if (!v) throw new Error("--package requires a value");
      pkg = v;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { port, dist, mount, pkg };
}

export function normalizeMount(raw: string): string {
  if (raw === "" || raw === "/") return "";
  return raw.replace(/\/+$/, "");
}

/**
 * Candidate base directories that `Bun.resolveSync` walks from when looking
 * for `<package>/package.json`. Order matters:
 *
 *   1. `process.cwd()` — works when the shim is invoked from inside the
 *      package's own checkout (e.g. via `installDir` cwd in lifecycle.ts) or
 *      from any project that depends on the package.
 *   2. `~/.bun/install/global/node_modules` — modern Bun's global-install
 *      layout. This is where `bun add -g <package>` lands the package, and
 *      where `bun link <package>` symlinks it.
 *   3. `~/.bun/install/global` — defensive fallback for older Bun layouts.
 *
 * Hub itself does NOT depend on the served package, so when `parachute
 * start <svc>` is run from the hub repo dir, the cwd-relative resolve walks
 * ancestral node_modules and finds nothing. Bun does not auto-consult the
 * global install dir, so bun-linked installs fail to resolve without
 * (2)/(3). hub#194: Aaron hit silent 502 on tailnet `/notes/` because of
 * this — fixed by trying the global install dirs.
 *
 * Exported (and parameterized via `cwd`/`home`) so tests can drive the
 * resolution order against a real fixture install without monkey-patching
 * `Bun.resolveSync`.
 */
export function notesDistCandidates(cwd: string, home: string): string[] {
  return [cwd, join(home, ".bun/install/global/node_modules"), join(home, ".bun/install/global")];
}

export interface ResolveNotesDistDeps {
  cwd?: string;
  home?: string;
  /** npm package name to resolve. Defaults to `@openparachute/notes` (back-compat). */
  pkg?: string;
  /** Override `Bun.resolveSync` for tests. */
  resolveSync?: (specifier: string, base: string) => string;
  existsSync?: (path: string) => boolean;
}

export function resolveNotesDistFrom(deps: ResolveNotesDistDeps = {}): string {
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();
  const pkg = deps.pkg ?? DEFAULT_PACKAGE;
  const resolveSync = deps.resolveSync ?? Bun.resolveSync;
  const exists = deps.existsSync ?? existsSync;
  const candidates = notesDistCandidates(cwd, home);
  const resolveErrors: string[] = [];
  for (const base of candidates) {
    let pkgPath: string;
    try {
      pkgPath = resolveSync(`${pkg}/package.json`, base);
    } catch (err) {
      resolveErrors.push(`  - ${base}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const root = dirname(pkgPath);
    const dist = join(root, "dist");
    if (!exists(dist)) {
      // Found the package but it has no dist/. This is a hard error
      // (package shipped without a prebuilt bundle); don't fall through to
      // other candidates — they'd resolve to the same package and report
      // the same problem.
      throw new Error(
        `${pkg} resolved at ${root} has no dist/ directory at ${dist}. The package may not ship a prebuilt bundle — ask the ${pkg} maintainer to add a prepublishOnly build step.`,
      );
    }
    return dist;
  }
  throw new Error(
    `Could not resolve ${pkg} from any of:\n${resolveErrors.join("\n")}\nIs the package installed? Try \`bun add -g ${pkg}\` or the matching \`parachute install <short>\`.`,
  );
}

function resolveNotesDist(pkg: string): string {
  return resolveNotesDistFrom({ pkg });
}

function mimeFor(path: string): string | undefined {
  // Bun.file infers MIME from extension but doesn't know .webmanifest;
  // without this the PWA install prompt sees text/html and bails.
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  return undefined;
}

export function notesFetch(dist: string, mount: string): (req: Request) => Response {
  const indexHtml = join(dist, "index.html");
  const spaShell = () =>
    new Response(Bun.file(indexHtml), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  return (req) => {
    const url = new URL(req.url);
    let pathname = url.pathname;
    if (mount && (pathname === mount || pathname.startsWith(`${mount}/`))) {
      pathname = pathname.slice(mount.length) || "/";
    }
    if (pathname === "/health") {
      // Explicit rather than falling through to the SPA shell: the doctor /
      // status probe (`probeModuleHealth`) only checks for a 2xx status, but
      // answering directly means a missing/corrupt `dist/index.html` can't
      // take the health check down with it. Every FIRST_PARTY_FALLBACKS
      // entry served by this shim declares `health` under its own mount
      // (e.g. `/notes/health`, `/app/health`) — this answers all of them.
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname === "/" || pathname.endsWith("/")) {
      return spaShell();
    }
    const filePath = join(dist, decodeURIComponent(pathname));
    if (!filePath.startsWith(dist)) {
      return new Response("forbidden", { status: 403 });
    }
    if (existsSync(filePath)) {
      const file = Bun.file(filePath);
      const mime = mimeFor(filePath);
      return new Response(file, mime ? { headers: { "content-type": mime } } : undefined);
    }
    return spaShell();
  };
}

/**
 * Build the `Bun.serve` config for the notes static server.
 *
 * `idleTimeout: 255` matches hub-server.ts. When this static-serve sits behind
 * an edge proxy that pools keep-alive connections (Render, Cloudflare, fly
 * proxy), the edge's idle timeout outlasts Bun's default — the proxy reuses a
 * connection we just closed and returns a "random" 502. 255s comfortably
 * exceeds Render's community-observed ~120s edge pool TTL. Closes the hub#399
 * residual on the second serve entrypoint (the Notes PWA path). Exported so a
 * test can assert the option is set without booting a server.
 */
export function notesServeOptions(
  port: number,
  dist: string,
  mount: string,
): { port: number; idleTimeout: number; fetch: (req: Request) => Response } {
  return {
    port,
    idleTimeout: 255,
    fetch: notesFetch(dist, mount),
  };
}

if (import.meta.main) {
  const { port, dist: distArg, mount, pkg } = parseArgs(process.argv.slice(2));

  let dist: string;
  try {
    dist = distArg ?? resolveNotesDist(pkg);
  } catch (err) {
    console.error(
      `parachute-static-serve (${pkg}): ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  Bun.serve(notesServeOptions(port, dist, mount));

  console.log(
    `static-serve listening on :${port} (pkg=${pkg}, dist=${dist}, mount=${mount || "/"})`,
  );
}
