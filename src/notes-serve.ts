#!/usr/bin/env bun

/**
 * Tiny static-file server for the @openparachute/notes PWA bundle.
 *
 * Notes is a SPA — no backend of its own. `parachute start notes` invokes
 * this shim with the installed `dist/` path so the PWA is served at a
 * known port and can be reverse-proxied by `parachute expose` alongside
 * the other services.
 *
 * Invoked as:
 *   bun <this-file> --port <n> [--dist <path>] [--mount <prefix>]
 *
 * `--mount` (default `/notes`) is the path prefix the reverse proxy hands
 * us. We strip it before resolving against `dist/` so a request for
 * `/notes/sw.js` reads `{dist}/sw.js` rather than the nonexistent
 * `{dist}/notes/sw.js`. Without the strip, the SW + .webmanifest both
 * SPA-fall-back to index.html with content-type text/html, and the PWA
 * install prompt never fires. Pass `--mount ""` (or `--mount /`) when the
 * bundle is served at the origin root.
 *
 * If --dist is omitted, we resolve @openparachute/notes's dist directory
 * via Bun.resolveSync. If that fails (package not installed globally, or
 * package doesn't ship dist/), exit 1 with a clear error.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface Args {
  port: number;
  dist?: string;
  mount: string;
}

function parseArgs(argv: string[]): Args {
  let port = 5173;
  let dist: string | undefined;
  let mount = "/notes";
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
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { port, dist, mount };
}

export function normalizeMount(raw: string): string {
  if (raw === "" || raw === "/") return "";
  return raw.replace(/\/+$/, "");
}

/**
 * Candidate base directories that `Bun.resolveSync` walks from when looking
 * for `@openparachute/notes/package.json`. Order matters:
 *
 *   1. `process.cwd()` — works when notes-serve is invoked from inside the
 *      notes checkout (e.g. via `installDir` cwd in lifecycle.ts) or from
 *      any project that depends on `@openparachute/notes`.
 *   2. `~/.bun/install/global/node_modules` — modern Bun's global-install
 *      layout. This is where `bun add -g @openparachute/notes` lands the
 *      package, and where `bun link @openparachute/notes` symlinks it.
 *   3. `~/.bun/install/global` — defensive fallback for older Bun layouts.
 *
 * Hub itself does NOT depend on `@openparachute/notes`, so when
 * `parachute start notes` is run from the hub repo dir, the cwd-relative
 * resolve walks ancestral node_modules and finds nothing. Bun does not
 * auto-consult the global install dir, so bun-linked installs fail to
 * resolve without (2)/(3). hub#194: Aaron hit silent 502 on tailnet
 * `/notes/` because of this — fixed by trying the global install dirs.
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
  /** Override `Bun.resolveSync` for tests. */
  resolveSync?: (specifier: string, base: string) => string;
  existsSync?: (path: string) => boolean;
}

export function resolveNotesDistFrom(deps: ResolveNotesDistDeps = {}): string {
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();
  const resolveSync = deps.resolveSync ?? Bun.resolveSync;
  const exists = deps.existsSync ?? existsSync;
  const candidates = notesDistCandidates(cwd, home);
  const resolveErrors: string[] = [];
  for (const base of candidates) {
    let pkgPath: string;
    try {
      pkgPath = resolveSync("@openparachute/notes/package.json", base);
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
        `@openparachute/notes resolved at ${root} has no dist/ directory at ${dist}. The package may not ship a prebuilt bundle — ask the notes maintainer to add a prepublishOnly build step.`,
      );
    }
    return dist;
  }
  throw new Error(
    `Could not resolve @openparachute/notes from any of:\n${resolveErrors.join("\n")}\nIs the package installed? Try \`bun add -g @openparachute/notes\` or \`parachute install notes\`.`,
  );
}

function resolveNotesDist(): string {
  return resolveNotesDistFrom();
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

if (import.meta.main) {
  const { port, dist: distArg, mount } = parseArgs(process.argv.slice(2));

  let dist: string;
  try {
    dist = distArg ?? resolveNotesDist();
  } catch (err) {
    console.error(`parachute-notes-serve: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  Bun.serve({
    port,
    fetch: notesFetch(dist, mount),
  });

  console.log(`notes static-serve listening on :${port} (dist=${dist}, mount=${mount || "/"})`);
}
