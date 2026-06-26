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
import { validateHubOrigin } from "../api-settings-hub-origin.ts";
import { CONFIG_DIR } from "../config.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { setHubOrigin } from "../hub-settings.ts";
import { isLoopbackOrigin } from "../vault-hub-origin-env.ts";

export interface HubCommandDeps {
  configDir?: string;
  log?: (line: string) => void;
  /**
   * Test seam: open the hub DB. Production opens `hub.db` under the resolved
   * `configDir` (running migrations). Tests pass an in-memory / temp DB so the
   * write is exercised without touching the operator's live `~/.parachute`.
   */
  openDb?: (configDir: string) => Database;
}

/**
 * `parachute hub set-origin <url>`. Validates + canonicalizes the URL, persists
 * it to `hub_settings.hub_origin`, and prints the restart note (already-running
 * supervised modules pick up the widened `PARACHUTE_HUB_ORIGINS` set only on
 * their next `parachute restart`, because that set is injected at child-spawn
 * time). Returns 0 on success, 1 on a validation / write failure.
 */
export async function hubSetOrigin(
  args: readonly string[],
  deps: HubCommandDeps = {},
): Promise<number> {
  const configDir = deps.configDir ?? CONFIG_DIR;
  const log = deps.log ?? ((line) => console.log(line));
  const err = (line: string) => console.error(line);
  const openDb = deps.openDb ?? ((dir: string) => openHubDb(hubDbPath(dir)));

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
  log("");
  log("Already-running modules (vault, scribe) pick up the widened origin set only on");
  log("their next restart (it's injected at spawn time). Restart them to apply now:");
  log("  parachute restart vault");
  log("  parachute restart scribe   # if installed");
  return 0;
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
  parachute hub set-origin <url>    set the canonical public hub origin

Subcommands:
  set-origin <url>    Persist the canonical public origin (OAuth issuer) to the
                      hub DB. This is the URL the hub stamps as the \`iss\` claim
                      on every token AND the origin it tells supervised modules
                      (vault, scribe) to accept. Use it on a reverse-proxy /
                      Caddy-direct box where the hub binds loopback but is reached
                      over a public HTTPS URL — no admin browser session needed.

                      The URL must be http(s), with a hostname and no trailing
                      slash / path / query. After it's set, restart already-running
                      modules so they pick up the widened origin set.

Examples:
  parachute hub set-origin https://box.sslip.io
  parachute hub set-origin https://parachute.example.com
`;
}
