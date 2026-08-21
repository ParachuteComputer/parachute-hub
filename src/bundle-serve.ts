#!/usr/bin/env bun

/**
 * Tiny static-file server for a Parachute PWA bundle — originally written
 * for @openparachute/notes, generalized in hub-parity P5 (2026-07-11) to
 * also serve @openparachute/app (the super-surface front door,
 * port 1944, mount `/app`) via the same shim. Any package matching this
 * shape (a prebuilt SPA `dist/` with no server of its own) can reuse it.
 *
 * A served bundle is a SPA — no backend of its own. `parachute start
 * <svc>` invokes this shim with the installed `dist/` path so the PWA is
 * served at a known port and can be reverse-proxied by `parachute expose`
 * alongside the other services.
 *
 * Invoked as:
 *   bun <this-file> --port <n> [--host <addr>] [--dist <path>] [--mount <prefix>]
 *                   [--package <npmName>]
 *
 * `--host` is the bind address, same contract as hub-server.ts: flag beats
 * `PARACHUTE_BIND_HOST`, env beats the `127.0.0.1` default. See
 * `resolveBindHost` for why the default is loopback.
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
 * package other than notes (e.g. `app`'s `--package @openparachute/app`).
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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Default bundle when `--package` is omitted.
 *
 * Was `@openparachute/notes` — the shim's original consumer. Notes is retired
 * (hub#788) and `@openparachute/app` is the front door now, so the default
 * points at app. Every FIRST_PARTY_FALLBACKS entry passes `--package`
 * explicitly, including the retired notes one, so this default only governs a
 * bare hand-run of the shim.
 */
const DEFAULT_PACKAGE = "@openparachute/app";

/**
 * Bind address when neither `--host` nor `PARACHUTE_BIND_HOST` says otherwise.
 *
 * Matches `hub-server.ts`'s `parseArgs` default. The shim used to pass no
 * `hostname` at all, so `Bun.serve` bound every interface — on a box whose hub
 * and vault both sat on `127.0.0.1`, the SPA alone answered unauthenticated on
 * the tailnet/LAN (hub#832). Nothing legitimate needs the wildcard: this shim
 * is reached through `parachute expose`'s reverse proxy, which connects over
 * loopback. The container images that DO need every interface set
 * `PARACHUTE_BIND_HOST=0.0.0.0` (Dockerfile / render.yaml / fly.toml), which
 * the supervisor passes down to the child through the inherited env.
 */
const DEFAULT_BIND_HOST = "127.0.0.1";

interface Args {
  port: number;
  host?: string;
  dist?: string;
  mount: string;
  pkg: string;
}

/**
 * Flag beats env, env beats default — the same precedence hub-server.ts uses
 * for its own listener, so one `PARACHUTE_BIND_HOST` governs every process the
 * hub supervises rather than just the hub itself.
 */
export function resolveBindHost(
  host: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // `||` not `??`, matching hub-server.ts: an empty `PARACHUTE_BIND_HOST=` is
  // "unset" here, not "bind to the empty string".
  return host || env.PARACHUTE_BIND_HOST || DEFAULT_BIND_HOST;
}

function parseArgs(argv: string[]): Args {
  let port = 5173;
  let host: string | undefined;
  let dist: string | undefined;
  let mount = "/notes";
  let pkg = DEFAULT_PACKAGE;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") {
      const v = argv[++i];
      if (!v) throw new Error("--host requires a value");
      host = v;
    } else if (a === "--port") {
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
  return { port, host, dist, mount, pkg };
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
 *      from any project that depends on the package. OMITTED when cwd is `/`
 *      (see the hub#780 carve-out below).
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
 * hub#780 — the `/` carve-out. The supervisor launches shim-served services
 * (notes/app) with **cwd = `/`** (launchd/systemd hand a supervised child `/`
 * when no per-module cwd is set). From `/`, `Bun.resolveSync` finds nothing up
 * the tree and falls through to bun's own install *cache*
 * (`~/.bun/install/cache/<pkg>@<ver>@@@1`) — a copy laid down by any
 * `bun add`/install. That cached copy then WINS as candidate (1), before the
 * global link at (2) is ever consulted, so a bun-linked checkout is silently
 * ignored in favour of an arbitrarily old published version (Aaron's box served
 * `@openparachute/app@0.22.5` for nine hours while `status` reported the linked
 * checkout). A real checkout cwd is never `/`, so dropping `/` as a candidate
 * loses nothing legitimate and forces resolution through the global link table
 * — the intended source for a supervised service.
 *
 * Exported (and parameterized via `cwd`/`home`) so tests can drive the
 * resolution order against a real fixture install without monkey-patching
 * `Bun.resolveSync`.
 */
export function notesDistCandidates(cwd: string, home: string): string[] {
  const globals = [
    join(home, ".bun/install/global/node_modules"),
    join(home, ".bun/install/global"),
  ];
  return cwd === "/" ? globals : [cwd, ...globals];
}

export interface ResolveBundleDistDeps {
  cwd?: string;
  home?: string;
  /** npm package name to resolve. Defaults to `@openparachute/notes` (back-compat). */
  pkg?: string;
  /** Override `Bun.resolveSync` for tests. */
  resolveSync?: (specifier: string, base: string) => string;
  existsSync?: (path: string) => boolean;
}

export function resolveBundleDistFrom(deps: ResolveBundleDistDeps = {}): string {
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
  return resolveBundleDistFrom({ pkg });
}

function mimeFor(path: string): string | undefined {
  // Bun.file infers MIME from extension but doesn't know .webmanifest;
  // without this the PWA install prompt sees text/html and bails.
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  return undefined;
}

/**
 * Re-root the bundle's ROOT-ABSOLUTE asset URLs onto the mount.
 *
 * ## Why this is needed at serve time
 *
 * A bundle built with an absolute Vite `base` emits `src="/assets/x.js"`. That
 * is correct at the origin root and wrong at every mount: served at `/app`, the
 * browser asks for `/assets/x.js`, which the mount never sees, and the page
 * loads as an unstyled blank with two 404s. Found live on a self-hosted box
 * right after `parachute install app` — the assets resolve perfectly at
 * `/app/assets/...`, the HTML simply never asks for them there.
 *
 * Rewriting here rather than in the bundle is deliberate: ONE published package
 * gets served at several mounts (`/app`, `/notes`, `/surface/<name>`, and the
 * origin root), so no single build-time base is right for all of them. The
 * mount is known only here. This is the "serve-time index.html rewrite" the
 * app's own vite config names as the alternative to build-per-mount.
 *
 * Deliberately narrow: only `src=` / `href=` values beginning with a single
 * `/`. Protocol-relative (`//cdn…`) and absolute (`https://…`) URLs are left
 * alone, and nothing outside those two attributes is touched, so inline styles
 * and scripts are untouched. A no-op when `mount` is empty.
 */
/**
 * Tell the bundle where it's mounted, via the contract the bundle already has.
 *
 * `@openparachute/app` resolves its React Router basename at runtime through
 * `detectMountBase()`, whose HIGHEST-priority source is
 * `<meta name="parachute-mount" content="...">` — documented as "the canonical
 * contract: … once the host injects one". Nothing injected one.
 *
 * Its fallback is a list of recognised mount shapes: `/surface/<slug>` and the
 * legacy `/notes/`. `/app` is not among them — it became the front door in
 * hub#791, long after that list was written — so a bundle served at `/app` fell
 * through to `ROOT_FALLBACK` (`""`) and believed it lived at the origin root.
 * Every route it generated came out origin-rooted: opening a note produced
 * `https://host/n/<id>` instead of `https://host/app/n/<id>`, which hub doesn't
 * route to the app at all.
 *
 * Injecting the meta tag fixes it for ALREADY-PUBLISHED bundles, and does so
 * through the app's own documented contract rather than by teaching hub to
 * rewrite router internals. The host knows the mount; this is how it says so.
 *
 * Idempotent: a bundle that already carries the tag (a surface host that
 * injects its own) is left alone, so the host's contract still wins.
 */
export function injectMountMeta(html: string, mount: string): string {
  if (!mount) return html;
  if (/<meta\s+name=["']parachute-mount["']/i.test(html)) return html;
  const tag = `<meta name="parachute-mount" content="${mount}">`;
  // Must land inside <head>, before the module script that reads it.
  if (/<head[^>]*>/i.test(html)) return html.replace(/(<head[^>]*>)/i, `$1\n    ${tag}`);
  return `${tag}\n${html}`;
}

export function rewriteRootAbsoluteUrls(html: string, mount: string): string {
  if (!mount) return html;
  return html.replace(
    /\b(src|href)="\/(?!\/)([^"]*)"/g,
    (_m, attr: string, rest: string) => `${attr}="${mount}/${rest}"`,
  );
}

/**
 * Re-root a PWA manifest's `start_url` / `scope` onto the mount.
 *
 * A manifest declaring `scope: "/"` while the app is served at `/app` claims
 * the WHOLE ORIGIN for the installed PWA — so an installed app would capture
 * `/admin` and every vault URL alongside its own. `start_url: "/"` likewise
 * launches the installed app at the hub root rather than at the app.
 *
 * Only these two keys are touched. Icon `src`s in the wild are already
 * relative, and relative entries resolve against the manifest URL — which is
 * now correctly under the mount — so rewriting them would double the prefix.
 * Malformed JSON is returned untouched rather than throwing: a bad manifest
 * should degrade the install prompt, not the page.
 */
export function rewriteManifestScope(json: string, mount: string): string {
  if (!mount) return json;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return json;
  }
  if (typeof parsed !== "object" || parsed === null) return json;
  for (const key of ["start_url", "scope"]) {
    const v = parsed[key];
    if (typeof v === "string" && v.startsWith("/") && !v.startsWith("//")) {
      parsed[key] = v === "/" ? `${mount}/` : `${mount}${v}`;
    }
  }
  return JSON.stringify(parsed);
}

export function notesFetch(dist: string, mount: string): (req: Request) => Response {
  const indexHtml = join(dist, "index.html");
  // Read + rewrite once. The dist is immutable for this process's lifetime (an
  // upgrade restarts the shim), so re-reading per request would buy nothing and
  // cost a file read plus a regex pass on the hottest path.
  let shellHtml: string | undefined;
  const spaShell = () => {
    if (shellHtml === undefined) {
      try {
        shellHtml = injectMountMeta(
          rewriteRootAbsoluteUrls(readFileSync(indexHtml, "utf8"), mount),
          mount,
        );
      } catch {
        // Missing/unreadable index.html — fall back to streaming the file so
        // the existing 404/500 behaviour is unchanged rather than throwing here.
        return new Response(Bun.file(indexHtml), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
    }
    return new Response(shellHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

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
      // The manifest declares the installed PWA's scope; served under a mount
      // it has to be re-rooted or the install claims the whole origin.
      if (mount && pathname.endsWith(".webmanifest")) {
        try {
          return new Response(rewriteManifestScope(readFileSync(filePath, "utf8"), mount), {
            headers: { "content-type": "application/manifest+json" },
          });
        } catch {
          /* fall through to streaming it unmodified */
        }
      }
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
 *
 * `hostname` is REQUIRED rather than optional: omitting it is what let this
 * shim bind every interface (hub#832), and an optional parameter would let the
 * same omission come back silently. Callers resolve it via `resolveBindHost`.
 */
export function notesServeOptions(
  port: number,
  dist: string,
  mount: string,
  hostname: string,
): {
  port: number;
  hostname: string;
  idleTimeout: number;
  fetch: (req: Request) => Response;
} {
  return {
    port,
    hostname,
    idleTimeout: 255,
    fetch: notesFetch(dist, mount),
  };
}

if (import.meta.main) {
  const { port, host, dist: distArg, mount, pkg } = parseArgs(process.argv.slice(2));
  const hostname = resolveBindHost(host);

  let dist: string;
  try {
    dist = distArg ?? resolveNotesDist(pkg);
  } catch (err) {
    console.error(
      `parachute-static-serve (${pkg}): ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  Bun.serve(notesServeOptions(port, dist, mount, hostname));

  console.log(
    `static-serve listening on ${hostname}:${port} (pkg=${pkg}, dist=${dist}, mount=${mount || "/"})`,
  );
}
