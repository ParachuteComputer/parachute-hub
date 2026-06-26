/**
 * `parachute hub <subcommand>` — hub-local configuration verbs that write
 * `~/.parachute/hub.db`.
 *
 * Subcommands:
 *   - `set-origin <url>` — persist the operator's canonical public hub origin
 *     into `hub_settings.hub_origin`. That row is tier-1 in `resolveIssuer`
 *     (hub-server.ts) — the OAuth `iss` claim hub stamps into every JWT — and,
 *     since the onboarding-streamline 2026-06-25 boot-issuer fix, also seeds the
 *     `PARACHUTE_HUB_ORIGINS` set hub injects into supervised modules
 *     (vault/scribe) so they accept tokens minted under the public origin.
 *
 * The headline use case is the zero-SSH Caddy-direct DigitalOcean path: a bare
 * droplet runs Caddy (Let's Encrypt TLS terminator + reverse proxy to the
 * loopback hub), and the hub never does TLS. The hub binds loopback and reads
 * its public origin from the DB. Before this verb the only way to set
 * `hub_origin` was the admin SPA's `PUT /api/settings/hub-origin` — which needs
 * a browser session you don't have on a freshly-provisioned headless box. The
 * CLI verb closes that gap so a cloud-init script (or an operator over the DO
 * console) can record the public origin without SSHing into the admin UI.
 *
 * Validation reuses `validateHubOrigin` (api-settings-hub-origin.ts) so the CLI
 * and the SPA enforce the EXACT same shape: http(s) scheme, a hostname, no
 * trailing slash / path / query / fragment / credentials. A loopback value is
 * allowed (a dev/test box may legitimately set one) but warned about, since a
 * loopback `hub_origin` would advertise a non-public issuer.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { validateHubOrigin } from "../api-settings-hub-origin.ts";
import { restart } from "../commands/lifecycle.ts";
import { CONFIG_DIR } from "../config.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { setHubOrigin } from "../hub-settings.ts";
import { type CommandResult, type Runner, defaultRunner } from "../tailscale/run.ts";
import { isLoopbackOrigin } from "../vault-hub-origin-env.ts";

/** Default path to the Parachute-managed Caddyfile (install/digitalocean.sh). */
const DEFAULT_CADDYFILE_PATH = "/etc/caddy/Caddyfile";

/**
 * Stable prefix of the marker comment the install script writes as line 1 of a
 * Parachute-managed Caddyfile (`# Managed by Parachute install …`). We match a
 * prefix, not the whole line, so a future heredoc tweak to the trailing text
 * doesn't break detection.
 */
const CADDY_MARKER_PREFIX = "# Managed by Parachute install";

export interface HubCommandDeps {
  configDir?: string;
  log?: (line: string) => void;
  /**
   * Test seam: open the hub DB. Production opens `hub.db` under the resolved
   * `configDir` (running migrations). Tests pass an in-memory / temp DB so the
   * write is exercised without touching the operator's live `~/.parachute`.
   */
  openDb?: (configDir: string) => Database;
  /**
   * Path to the Parachute-managed Caddyfile. Defaults to the install script's
   * hardcoded `/etc/caddy/Caddyfile`. Tests point it at a temp fixture.
   */
  caddyfilePath?: string;
  /** fs read seam (default `node:fs`). Returns undefined when the file is absent. */
  readFile?: (path: string) => string | undefined;
  /** fs write seam (default `node:fs`). */
  writeFile?: (path: string, content: string) => void;
  /** fs existence seam (default `node:fs`). */
  exists?: (path: string) => boolean;
  /**
   * Runner for `systemctl reload caddy` + the module restart fan-out. Canonical
   * {@link Runner} seam (the same one `expose.ts` injects). Tests mock it so
   * nothing real reloads.
   */
  run?: Runner;
  /** Effective uid (default `process.getuid`). Non-root → skip the write/reload. */
  getuid?: () => number | undefined;
  /**
   * Restart supervised modules so `PARACHUTE_HUB_ORIGINS` re-injects with the
   * fresh origin. Defaults to `restart(undefined, …)` (restarts the hub unit,
   * re-booting all modules). Tests mock it so the live supervisor isn't driven.
   */
  restartModules?: (configDir: string) => Promise<number>;
}

/** Outcome of an attempted in-place Caddyfile hostname rewrite. */
type CaddyRewriteResult =
  | { kind: "rewritten"; content: string; host: string }
  | { kind: "unchanged" } // host already matches — idempotent, no reload needed
  | { kind: "not-managed" } // no file, or no `# Managed by Parachute install` marker
  | { kind: "customized" }; // marker present but the site-address line shape is unrecognized

/**
 * Rewrite ONLY the site-address (hostname) line of a Parachute-managed Caddyfile
 * to `host`, leaving the `reverse_proxy` body + the security-load-bearing
 * `header_up -…` trust-signal strips byte-intact.
 *
 * The managed shape (install/digitalocean.sh write_caddyfile) is:
 *
 *   # Managed by Parachute install (install/digitalocean.sh). Re-run to refresh.
 *   <hostname> {
 *       reverse_proxy 127.0.0.1:<port> {
 *           header_up -Cf-Ray
 *           …
 *       }
 *   }
 *
 * Strategy: confirm the first non-empty line carries the marker prefix; then
 * find the first top-level site-opener line (`<token> {`) that is NOT the
 * `reverse_proxy …` line and replace its host token with `host`, preserving
 * indentation + the trailing ` {`. If the marker is present but no such line
 * matches (operator hand-edited), return `customized` and let the caller fall
 * back to manual steps rather than guess.
 */
export function rewriteCaddyfileHost(content: string, host: string): CaddyRewriteResult {
  const lines = content.split("\n");
  const firstNonEmpty = lines.find((l) => l.trim().length > 0);
  if (firstNonEmpty === undefined || !firstNonEmpty.trim().startsWith(CADDY_MARKER_PREFIX)) {
    return { kind: "not-managed" };
  }
  // The site-address opener is the first `<token> {`-terminated line that is NOT
  // the `reverse_proxy …` line. A bare host token: no whitespace, no scheme.
  const siteOpener = /^(\s*)(\S+)(\s*\{\s*)$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;
    if (trimmed.startsWith("reverse_proxy")) continue;
    const m = line.match(siteOpener);
    if (!m) continue;
    const [, indent, token, brace] = m;
    if (indent === undefined || token === undefined || brace === undefined) continue;
    if (token === host) return { kind: "unchanged" };
    lines[i] = `${indent}${host}${brace}`;
    return { kind: "rewritten", content: lines.join("\n"), host };
  }
  return { kind: "customized" };
}

/**
 * `parachute hub set-origin <url>`. Validates + canonicalizes the URL, persists
 * it to `hub_settings.hub_origin`, then — on a Parachute-managed Caddy-direct
 * box — rewrites the Caddyfile hostname, reloads Caddy, and restarts the
 * supervised modules so they re-pick the origin. Every post-DB step is
 * best-effort: on any miss (no managed Caddyfile, `--no-caddy`, non-root, a
 * failed reload/restart) the origin still persisted and the manual steps are
 * printed. Returns 0 on success (incl. soft Caddy/restart misses), 1 only on a
 * validation / DB-write failure.
 */
export async function hubSetOrigin(
  args: readonly string[],
  deps: HubCommandDeps = {},
): Promise<number> {
  const configDir = deps.configDir ?? CONFIG_DIR;
  const log = deps.log ?? ((line) => console.log(line));
  const err = (line: string) => console.error(line);
  const openDb = deps.openDb ?? ((dir: string) => openHubDb(hubDbPath(dir)));
  const caddyfilePath = deps.caddyfilePath ?? DEFAULT_CADDYFILE_PATH;
  const exists = deps.exists ?? ((path: string) => existsSync(path));
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const writeFile =
    deps.writeFile ?? ((path: string, content: string) => writeFileSync(path, content));
  const run = deps.run ?? defaultRunner;
  const getuid =
    deps.getuid ?? (() => (typeof process.getuid === "function" ? process.getuid() : undefined));
  const restartModules =
    deps.restartModules ??
    ((dir: string) => restart(undefined, { configDir: dir, supervisor: {} }));

  const noCaddy = args.includes("--no-caddy");
  const noRestart = args.includes("--no-restart");
  const positional = args.filter((a) => !a.startsWith("-"));
  const raw = positional[0];
  if (raw === undefined) {
    err("usage: parachute hub set-origin <url>");
    err("example: parachute hub set-origin https://box.sslip.io");
    return 1;
  }
  if (positional.length > 1) {
    err(`parachute hub set-origin: unexpected argument "${positional[1]}"`);
    err("usage: parachute hub set-origin <url>");
    return 1;
  }

  // Strip a trailing slash up front so the convenient `https://host/` form is
  // accepted (the operator copy-pastes a browser URL). `validateHubOrigin`
  // itself REJECTS a trailing slash (it's the SPA's PUT body validator, where a
  // strict shape is wanted) — we canonicalize here, then validate the rest of
  // the shape (scheme / hostname / no-path / no-credentials) through the shared
  // validator so the CLI and SPA agree on everything else.
  const trimmed = raw.replace(/\/+$/, "");
  const result = validateHubOrigin(trimmed);
  if (!result.ok) {
    err(`parachute hub set-origin: ${result.description}`);
    return 1;
  }
  // `validateHubOrigin` maps empty / null to `normalized: null` (clear the row).
  // `set-origin` with an explicit non-empty arg should never land there — a
  // present positional that normalizes to null means the operator passed an
  // empty string, which is not a valid public origin for this verb.
  if (result.normalized === null) {
    err("parachute hub set-origin: a non-empty origin URL is required");
    err("usage: parachute hub set-origin <url>");
    return 1;
  }
  const origin = result.normalized;

  // Loopback is allowed (a dev/test box may set one deliberately) but warned —
  // a loopback hub_origin advertises a non-public issuer, so remote devices
  // and supervised resource servers reached over a public URL would reject it.
  if (isLoopbackOrigin(origin)) {
    log(`⚠ ${origin} is a loopback origin — it won't be reachable from other devices.`);
    log("  Set the box's PUBLIC URL (e.g. https://<droplet-ip>.sslip.io) for a real deploy.");
  }

  const db = openDb(configDir);
  try {
    setHubOrigin(db, origin);
  } finally {
    db.close();
  }

  log(`✓ Canonical hub origin set to ${origin}.`);
  log("  Stored in hub_settings — the OAuth issuer (`iss`) hub stamps on every token,");
  log("  and the origin set injected into supervised modules so they accept it.");

  // The DB write is the load-bearing contract; everything below is best-effort
  // automation of the manual restart/rewrite steps. Any miss falls back to
  // printing the manual instructions and still returns 0.
  //
  // The Caddy site address is a BARE host (Caddy auto-TLS on HTTPS-default),
  // taken from the ALREADY-VALIDATED URL — `new URL(origin).host` (no scheme),
  // never a raw arg, so there's nothing to inject (the rewrite is a file edit,
  // the reload/restart are argv-form Bun.spawn, no shell).
  const host = new URL(origin).host;

  if (noCaddy) {
    log("");
    log("(--no-caddy) Skipping the Caddyfile rewrite + reload.");
  } else if (!exists(caddyfilePath)) {
    // Tailscale / Cloudflare / manual-proxy box — no managed Caddyfile to touch.
    log("");
    log(
      `No Parachute-managed Caddyfile at ${caddyfilePath} — origin set; restart modules to apply.`,
    );
  } else {
    let content: string | undefined;
    try {
      content = readFile(caddyfilePath);
    } catch {
      content = undefined;
    }
    const rewrite =
      content === undefined
        ? ({ kind: "not-managed" } as const)
        : rewriteCaddyfileHost(content, host);
    if (rewrite.kind === "not-managed") {
      log("");
      log(
        `No Parachute-managed Caddyfile at ${caddyfilePath} — origin set; restart modules to apply.`,
      );
    } else if (rewrite.kind === "customized") {
      log("");
      log(`The Caddyfile at ${caddyfilePath} looks customized — not rewriting its host line.`);
      log(`  Update the site address to "${host}" by hand, then: sudo systemctl reload caddy`);
    } else if (rewrite.kind === "unchanged") {
      // Host already matches — nothing to write or reload.
      log("");
      log(`Caddyfile already points at ${host} — no change needed.`);
    } else if (getuid() !== undefined && getuid() !== 0) {
      // Writing /etc/caddy/Caddyfile + `systemctl reload` need root; the hub
      // never shells `sudo` itself. Persist + print the manual steps.
      log("");
      log(`Not running as root — can't rewrite ${caddyfilePath} or reload Caddy.`);
      log(
        `  As root: set the Caddyfile site address to "${host}", then: sudo systemctl reload caddy`,
      );
    } else {
      // Root + managed file + host changed → rewrite, then (only if the write
      // landed) reload.
      let wrote = false;
      try {
        writeFile(caddyfilePath, rewrite.content);
        wrote = true;
      } catch (e) {
        log("");
        log(`Could not write ${caddyfilePath}: ${e instanceof Error ? e.message : String(e)}`);
        log(`  Update its site address to "${host}" by hand, then: sudo systemctl reload caddy`);
      }
      if (wrote) {
        const reload = await runCaddyReload(run);
        if (reload.code === 0) {
          log("");
          log(`✓ Rewrote ${caddyfilePath} → ${host}, reloaded Caddy.`);
        } else {
          log("");
          log(`✓ Rewrote ${caddyfilePath} → ${host}, but Caddy reload reported an error:`);
          if (reload.stderr.trim().length > 0) log(`  ${reload.stderr.trim()}`);
          log("  Reload it manually: sudo systemctl reload caddy");
        }
      }
    }
  }

  // Restart supervised modules so they re-pick the origin via PARACHUTE_HUB_ORIGINS
  // (injected at child-spawn time). One hub-unit restart re-boots all modules —
  // strictly better than the old "restart vault / restart scribe" two-step.
  if (noRestart) {
    log("");
    log("(--no-restart) Skipping the module restart. Apply with: parachute restart");
  } else {
    let restarted = false;
    try {
      restarted = (await restartModules(configDir)) === 0;
    } catch {
      restarted = false;
    }
    if (restarted) {
      log("✓ Restarted modules (vault, scribe) so they accept the new origin.");
    } else {
      log("");
      log("Restart already-running modules so they pick up the new origin:");
      log("  parachute restart");
    }
  }

  return 0;
}

/**
 * `systemctl reload caddy` through the injected Runner. Kept tiny so the call
 * site reads as one step; the Runner default (`defaultRunner`) env-inherits +
 * pre-flights the binary, and tests mock it.
 */
async function runCaddyReload(run: Runner): Promise<CommandResult> {
  return run(["systemctl", "reload", "caddy"]);
}

/**
 * `parachute hub <subcommand>` dispatcher. Mirrors `auth`'s shape (a thin
 * router over subcommand handlers, each catching its own errors).
 */
export async function hub(args: readonly string[], deps: HubCommandDeps = {}): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(hubHelp());
    return 0;
  }
  if (sub === "set-origin") {
    try {
      return await hubSetOrigin(args.slice(1), deps);
    } catch (err) {
      console.error(
        `parachute hub set-origin: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }
  console.error(`parachute hub: unknown subcommand "${sub}"`);
  console.error("");
  console.error(hubHelp());
  return 1;
}

export function hubHelp(): string {
  return `parachute hub — hub-local configuration

Usage:
  parachute hub set-origin <url> [--no-caddy] [--no-restart]

Subcommands:
  set-origin <url>    Persist the canonical public origin (OAuth issuer) to the
                      hub DB. This is the URL the hub stamps as the \`iss\` claim
                      on every token AND the origin it tells supervised modules
                      (vault, scribe) to accept. Use it on a reverse-proxy /
                      Caddy-direct box where the hub binds loopback but is reached
                      over a public HTTPS URL — no admin browser session needed.

                      The URL must be http(s), with a hostname and no trailing
                      slash / path / query.

                      On a Parachute-managed Caddy-direct box (a
                      /etc/caddy/Caddyfile written by the install script), this
                      ALSO rewrites the Caddyfile's hostname line to the new
                      origin (the reverse_proxy body + trust-signal header strips
                      are left intact), reloads Caddy, and restarts the modules so
                      the new origin propagates — a one-command domain change. If
                      no managed Caddyfile is present, the rewrite is skipped and
                      the manual steps are printed. Pass --no-caddy to skip the
                      Caddyfile rewrite + reload, or --no-restart to skip the
                      module restart.

Examples:
  parachute hub set-origin https://box.sslip.io
  parachute hub set-origin https://parachute.example.com
  parachute hub set-origin https://parachute.example.com --no-caddy
`;
}
