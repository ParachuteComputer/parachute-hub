#!/usr/bin/env bun

/**
 * Localhost HTTP backing for the hub page.
 *
 * macOS `tailscaled` runs sandboxed and cannot read files under arbitrary
 * user paths — `tailscale serve … --set-path=/ <file>` returns "an error
 * occurred reading the file or directory". The reliable shape is HTTP proxy:
 * `tailscale serve … --set-path=/ http://127.0.0.1:<port>`. This shim is
 * that localhost backing.
 *
 * Routes (all bound to 127.0.0.1) — listed in dispatch order. Order is
 * load-bearing: 301 redirects fire before the proxies and SPA mount they
 * preempt; admin API endpoints fire before the /admin/* SPA catch-all.
 *
 *   # Pre-rename 301 back-compat (hub#231 — first so they preempt any
 *   # remaining handlers under /vault or /hub).
 *   /vault, /vault/, /vault/new                → 301 → /vault/admin/ (B5:
 *                                                vault's daemon-level admin)
 *   /hub/vaults*                               → 301 → /admin/vaults*
 *   /hub/permissions                           → 301 → /admin/permissions
 *   /hub/tokens                                → 301 → /admin/tokens
 *   /hub, /hub/                                → 301 → /admin/vaults
 *   /admin/login, /admin/logout                → 301 → /login, /logout
 *
 *   # Notes-as-app migration Phase 2 (parachute-app design doc §16).
 *   /notes, /notes/, /notes/*                  → 301 → /surface/notes[/...]
 *                                                (opt-out via
 *                                                 hub_settings.notes_redirect_disabled)
 *
 *   # Discovery + well-known.
 *   /, /hub.html                               → hub.html (the discovery page)
 *   /.well-known/parachute.json                → built dynamically from services.json
 *   /.well-known/parachute-revocation.json     → revoked-jti list (hub#212 Phase 1)
 *   /.well-known/jwks.json                     → JWKS from hub.db
 *   /.well-known/oauth-authorization-server    → RFC 8414 metadata (issuer, endpoints)
 *
 *   # OAuth issuer.
 *   /oauth/authorize  (GET + POST)             → login → consent → auth code
 *   /oauth/authorize/approve (POST)            → inline DCR approve form (#208)
 *   /oauth/token      (POST)                   → authorization_code + refresh_token grants
 *   /oauth/register   (POST)                   → RFC 7591 dynamic client registration
 *   /oauth/revoke     (POST)                   → RFC 7009 refresh-token revocation
 *
 *   # Admin API + bearer-mint surfaces (must precede /admin/* SPA mount).
 *   /vaults                       (POST)       → create vault
 *   /vaults/<name>                (DELETE)     → destroy vault + identity cascade
 *                                                 (B1: confirm body, host:admin,
 *                                                 tokens/grants/user_vaults/invites/
 *                                                 connections sweep, CLI remove,
 *                                                 supervisor restart)
 *   /admin/host-admin-token       (GET)        → SPA bearer mint (cookie-gated)
 *   /admin/vault-admin-token/<n>  (GET)        → per-vault bearer mint (cookie-gated)
 *   /admin/agent-token            (GET)        → agent UI bearer mint (cookie-gated)
 *   /admin/channel-token          (GET)        → 301 → /admin/agent-token (legacy; channel→agent rename 2026-06-17)
 *   /admin/module-token/<short>   (GET)        → generic module config-UI bearer mint <short>:admin (cookie-gated)
 *   /api/connections/catalog      (GET)        → events/actions across installed modules (cookie-gated)
 *   /admin/connections            (POST/GET)   → connection provision/list (cookie-gated; POST CSRF-belted)
 *   /admin/connections/<id>       (DELETE)     → connection teardown (cookie-gated; CSRF-belted)
 *   /admin/connections/<id>/renew (POST)       → credential renewal (H4; Bearer = the credential itself, proof of possession)
 *   /admin/connections/<id>/claim (POST)       → claim/reconcile a directly-delivered credential → pending record (surface#113; Bearer = the credential itself)
 *   /admin/connections/<id>/approve (POST)     → operator approval of a pending claim (cookie-gated; CSRF-belted)
 *   /admin/grants                 (PUT/GET)    → agent-connector grant upsert/list (4b-1; host-admin Bearer)
 *   /admin/grants/<id>/material   (GET)        → injectable secret for an APPROVED grant (4b-1; host-admin Bearer)
 *   /admin/grants/<id>/approve    (POST)       → operator approves a grant — mint (vault) / store (service) / static-bearer-or-start-OAuth (mcp, 4b-2) (cookie-gated; CSRF-belted)
 *   /admin/grants/<id>/revoke     (POST)       → operator revokes a grant — drop the stored secret + best-effort issuer revoke (mcp, 4b-2) (cookie-gated; CSRF-belted)
 *   /oauth/agent-grant/callback   (GET)        → OAuth-client redirect target for an mcp grant consent (4b-2; single-use state, no Bearer, NOT same-origin-belted — cross-site redirect in)
 *
 *   # "CSRF-belted" = strict same-origin Origin check on cookie-authed
 *   # mutations (hub#632, boundary C1) — origin-check.ts
 *   # `assertSameOriginForCookieMutation` carries the canonical enumeration.
 *   /api/me                       (GET)        → who-am-I (session+CSRF+two_factor_enabled or hasSession:false)
 *   /api/admin-lock               (GET)        → screen-lock status (cookie-gated; first-admin)
 *   /api/admin-lock/{set,change,remove,unlock,lock,heartbeat} (POST) → manage the optional admin idle PIN lock (cookie-gated; CSRF)
 *   /api/account/2fa/{start,confirm,disable} (POST) → self-service 2FA for the SPA (cookie-gated; CSRF; self-only) — hub#85
 *   /api/account/password         (POST)       → self-service password change for the SPA (cookie-gated; CSRF; self-only) — hub#85
 *   /api/hub                      (GET)        → hub version + uptime + install-source (host:admin)
 *   /api/hub/upgrade              (POST)       → SPA-driven hub self-upgrade → 202 + detached helper (host:admin, §5.3/D4)
 *   /api/hub/upgrade/status       (GET)        → poll the on-disk hub-upgrade status (host:admin)
 *   /api/modules                  (GET)        → curated + installed module catalog (host:auth)
 *   /api/modules/channel          (PUT)        → operator channel toggle (host:admin)
 *   /api/modules/:short/install   (POST)       → bun add + spawn (async op)
 *   /api/modules/:short/start     (POST)       → supervisor.start of an installed module (sync)
 *   /api/modules/:short/stop      (POST)       → supervisor.stop (sync)
 *   /api/modules/:short/restart   (POST)       → supervisor restart (sync)
 *   /api/modules/:short/upgrade   (POST)       → bun add @<channel> + restart (async op)
 *   /api/modules/:short/uninstall (POST)       → stop child + bun remove + drop row (sync)
 *   /api/modules/operations/:id   (GET)        → poll async op status
 *   /api/settings/hub-origin      (GET + PUT)  → canonical hub URL (host:admin)
 *   /api/settings/root-redirect   (GET + PUT)  → bare-`/` redirect target (host:admin)
 *   /api/auth/mint-token          (POST)       → CLI/automation token mint (bearer)
 *   /api/auth/revoke-token        (POST)       → revoke registry-row token by jti
 *   /api/auth/tokens              (GET)        → paginated registry list
 *   /api/grants                   (GET)        → OAuth consent grants list
 *   /api/grants/<client_id>       (DELETE)     → revoke a single OAuth grant
 *   /api/oauth/clients/<id>       (GET)        → OAuth client details
 *   /api/oauth/clients/<id>/approve (POST)     → flip a pending client to approved
 *   /api/users                    (GET + POST) → list / create user (host:admin)
 *   /api/users/vaults             (GET)        → vault-name list for assigned-vault picker (host:admin)
 *   /api/users/<id>               (DELETE)     → hard-delete user + revoke tokens (host:admin)
 *   /api/users/<id>/reset-password (POST)      → admin-initiated password reset (host:admin)
 *   /api/vault-caps               (GET)        → list vaults + persisted storage caps (host:admin)
 *   /api/vault-caps/<name>        (PUT)        → set/update a vault's storage cap (host:admin)
 *   /login                        (GET + POST) → operator password login
 *   /login/2fa                    (POST)       → second-factor (TOTP/backup) step
 *                                                 (hub#473; reached after a correct
 *                                                 password for a 2FA-enrolled user)
 *   /logout                       (POST)       → end admin session
 *   /account/change-password      (GET + POST) → user self-service change-password
 *                                                 (force-redirect target for users
 *                                                 with password_changed=false; also
 *                                                 reachable directly to rotate). With
 *                                                 hub#469, EVERY other /account/* route
 *                                                 + the per-vault proxy is hard-gated
 *                                                 per-request on password_changed===true
 *                                                 (forceChangePasswordGate); only this
 *                                                 route and /logout stay reachable
 *                                                 pre-rotation.
 *   /account/2fa                  (GET + POST) → user self-service 2FA enroll/disenroll
 *                                                 (hub#473; QR + backup codes)
 *   /account/vault-token/<name>   (POST)       → friend mints a scoped
 *                                                 vault:<name>:read|write bearer for
 *                                                 an ASSIGNED vault (headless clients;
 *                                                 session + assignment + scope-capped)
 *   /admin/config*                             → 301 → /admin/vaults (legacy
 *                                                portal retired post-SPA-rework)
 *
 *   # Vault MODULE daemon-level admin surface (B-route, 2026-06-09
 *   # hub-module-boundary). Runs BEFORE the per-vault proxy; "admin" is a
 *   # reserved vault name so no instance can claim the mount.
 *   /vault/admin, /vault/admin/*               → proxy to the vault module's daemon
 *
 *   # Per-vault content proxy (user-facing vault data: Notes PWA, MCP, etc.).
 *   /vault/<name>/*                            → proxy to the vault backend
 *
 *   # Admin SPA mount (catch-all under /admin; runs after all admin API
 *   # handlers above, so /admin/<known> reaches the right handler and
 *   # /admin/<spa-route> serves the SPA shell).
 *   /admin, /admin/, /admin/*                  → SPA shell (vaults / new / permissions / tokens)
 *
 *   # Generic services.json-driven proxy (non-vault modules: notes, scribe, agent).
 *   /<service-mount>/*                         → proxy via services.json longest-prefix
 *
 *   anything else                              → 404
 *
 * Invoked as:
 *   bun <this-file> --port <n> --well-known-dir <path> [--db <path>] [--issuer <url>]
 *
 * `--well-known-dir` is the directory containing `hub.html` (written by
 * `parachute expose`). The well-known doc is no longer served from this
 * directory — it's built on every GET from `services.json` so changes to
 * the installed-services list (e.g. `parachute vault create`) are visible
 * immediately without a re-expose.
 *
 * `--db` is the path to `hub.db`. JWKS is served live from the DB so key
 * rotation takes effect on the next request without re-running
 * `parachute expose`. Defaults to `~/.parachute/hub.db` (overridable via
 * `$PARACHUTE_HOME`).
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };
import { handleAccountSetupGet, handleAccountSetupPost } from "./account-setup.ts";
import { handleAccountVaultAdminTokenPost } from "./account-vault-admin-token.ts";
import { handleAccountVaultTokenPost } from "./account-vault-token.ts";
import {
  type AgentGrantsDeps,
  handleAgentGrants,
  handleOAuthGrantCallback,
} from "./admin-agent-grants.ts";
import { handleAgentToken } from "./admin-agent-token.ts";
import { handleApproveClient, handleDeleteClient, handleGetClient } from "./admin-clients.ts";
import {
  type ConnectionsDeps,
  handleConnections,
  handleConnectionsCatalog,
} from "./admin-connections.ts";
import { handleListGrants, handleRevokeGrant } from "./admin-grants.ts";
import {
  handleAdminLoginGet,
  handleAdminLoginPost,
  handleAdminLoginTotpPost,
  handleAdminLogoutPost,
} from "./admin-handlers.ts";
import { handleHostAdminToken } from "./admin-host-admin-token.ts";
import { handleModuleToken } from "./admin-module-token.ts";
import { handleVaultAdminToken } from "./admin-vault-admin-token.ts";
import { handleCreateVault, handleDeleteVault } from "./admin-vaults.ts";
import { handleApiAccount } from "./api-account-2fa.ts";
import {
  handleAccountChangePasswordGet,
  handleAccountChangePasswordPost,
  handleAccountHomeGet,
} from "./api-account.ts";
import { handleAdminLock } from "./api-admin-lock.ts";
import { handleHubUpgrade, handleHubUpgradeStatus } from "./api-hub-upgrade.ts";
import { handleApiHub } from "./api-hub.ts";
import { handleCreateInvite, handleListInvites, handleRevokeInvite } from "./api-invites.ts";
import { handleApiMe } from "./api-me.ts";
import { handleApiMintToken } from "./api-mint-token.ts";
import {
  getDefaultOperationsRegistry,
  handleInstall,
  handleLogs,
  handleOperationGet,
  handleRestart,
  handleStart,
  handleStop,
  handleUninstall,
  handleUpgrade,
  parseModulesPath,
} from "./api-modules-ops.ts";
import { handleApiModules, handleApiModulesChannel } from "./api-modules.ts";
import { handleApiReady } from "./api-ready.ts";
import { REVOCATION_LIST_MOUNT, handleRevocationList } from "./api-revocation-list.ts";
import { handleApiRevokeToken } from "./api-revoke-token.ts";
import { handleApiSettingsHubOrigin } from "./api-settings-hub-origin.ts";
import { handleApiSettingsRootRedirect } from "./api-settings-root-redirect.ts";
import { handleApiTokens } from "./api-tokens.ts";
import {
  handleCreateUser,
  handleDeleteUser,
  handleListUsers,
  handleListVaults,
  handleResetUserPassword,
  handleUpdateUserVaults,
} from "./api-users.ts";
import { handleListVaultCaps, handleSetVaultCap } from "./api-vault-caps.ts";
import { gateUiAudience, resolveUiMount } from "./audience-gate.ts";
import {
  CHROME_OPT_OUT_PREFIXES,
  buildChromeForRequest,
  injectChromeIntoResponse,
} from "./chrome-strip.ts";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "./config.ts";
import { applyCorsHeaders, corsPreflightResponse, isCorsAllowedRoute } from "./cors.ts";
import { ensureCsrfToken } from "./csrf.ts";
import { readExposeState } from "./expose-state.ts";
import { notifySurfacePushed } from "./git-notify.ts";
import { handleGitTransport } from "./git-transport.ts";
import { HUB_DEFAULT_PORT, HUB_SVC, clearHubPort, writeHubPort } from "./hub-control.ts";
import {
  classifyDbError,
  createDbHolder,
  defaultStatInode,
  probeDbLiveness,
  startDbPathLivenessTimer,
} from "./hub-db-liveness.ts";
import { hubDbPath, openHubDb } from "./hub-db.ts";
import { getHubOrigin, resolveRootRedirect } from "./hub-settings.ts";
import { type RenderHubOpts, renderHub } from "./hub.ts";
import { pemToJwk } from "./jwks.ts";
import {
  type ModuleManifest,
  readModuleManifest as defaultReadModuleManifest,
} from "./module-manifest.ts";
import { isLegacyNotesPath, logNotesRedirect, maybeRedirectNotes } from "./notes-redirect.ts";
import {
  authorizationServerMetadata,
  handleApproveClientPost,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleRevoke,
  handleToken,
  protectedResourceMetadata,
} from "./oauth-handlers.ts";
import { renderNotFoundPage } from "./oauth-ui.ts";
import { assertSameOriginForCookieMutation, buildHubBoundOrigins } from "./origin-check.ts";
import { clearPid, writePid } from "./process-state.ts";
import { toResponse as proxyErrorToResponse, renderProxyError } from "./proxy-error-ui.ts";
import { classifyUpstream } from "./proxy-state.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import {
  FIRST_PARTY_FALLBACKS,
  KNOWN_MODULES,
  effectivePublicExposure,
  findServiceByShort,
  shortNameForManifest,
} from "./service-spec.ts";
import { type ServiceEntry, readManifest, readManifestLenient } from "./services-manifest.ts";
import { findActiveSession } from "./sessions.ts";
import {
  type SetupWizardDeps,
  handleSetupAccountPost,
  handleSetupExposePost,
  handleSetupGet,
  handleSetupInstallPost,
  handleSetupVaultPost,
} from "./setup-wizard.ts";
import { getAllPublicKeys } from "./signing-keys.ts";
import type { Supervisor } from "./supervisor.ts";
import { handleTwoFactorGet, handleTwoFactorPost } from "./two-factor-handlers.ts";
import { getUserById, userCount } from "./users.ts";
import { sanitizePublicOrigin } from "./vault-hub-origin-env.ts";
import {
  WELL_KNOWN_DIR,
  buildWellKnown,
  isVaultEntry,
  vaultInstanceNameFor,
} from "./well-known.ts";
import { type WsBridgeData, createWsBridgeHandlers } from "./ws-bridge.ts";
import { type WsConnectionTracker, defaultWsConnectionTracker } from "./ws-connection-caps.ts";

interface Args {
  port: number;
  hostname: string;
  wellKnownDir: string;
  dbPath: string;
  issuer: string | undefined;
}

/**
 * Parse hub-server flags. Container hosts (Render, Docker) configure us
 * entirely via env vars — no flags. The `parachute expose` spawn path passes
 * everything as flags. Flags beat env, env beats defaults.
 *
 *   PORT                       — bind port (Render injects this)
 *   PARACHUTE_BIND_HOST        — bind hostname; default 127.0.0.1 to keep
 *                                the historical loopback posture safe.
 *                                Containers should set 0.0.0.0.
 *   PARACHUTE_HUB_ORIGIN       — canonical https://… origin used as the
 *                                OAuth issuer claim.
 *   RENDER_EXTERNAL_URL        — Render auto-injects the public https URL;
 *                                used as fallback issuer so the standalone
 *                                `bun src/hub-server.ts` boot path works
 *                                without operator config. Mirrors the
 *                                precedence in commands/serve.ts's
 *                                resolveStartupIssuer.
 *   FLY_APP_NAME               — Fly.io sets this to the app name; we compose
 *                                `https://${FLY_APP_NAME}.fly.dev` as a peer
 *                                of RENDER_EXTERNAL_URL for the self-host-on-Fly
 *                                path (patterns#100). Operators with custom
 *                                domains attached set PARACHUTE_HUB_ORIGIN
 *                                explicitly to override.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
  let port: number | undefined;
  let hostname: string | undefined;
  let wellKnownDir: string | undefined;
  let dbPath: string | undefined;
  let issuer: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const v = argv[++i];
      if (!v) throw new Error("--port requires a value");
      port = parsePort(v);
    } else if (a === "--hostname") {
      const v = argv[++i];
      if (!v) throw new Error("--hostname requires a value");
      hostname = v;
    } else if (a === "--well-known-dir") {
      const v = argv[++i];
      if (!v) throw new Error("--well-known-dir requires a value");
      wellKnownDir = resolve(v);
    } else if (a === "--db") {
      const v = argv[++i];
      if (!v) throw new Error("--db requires a value");
      dbPath = resolve(v);
    } else if (a === "--issuer") {
      const v = argv[++i];
      if (!v) throw new Error("--issuer requires a value");
      issuer = v.replace(/\/+$/, "");
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (port === undefined && env.PORT) port = parsePort(env.PORT);
  if (port === undefined) port = HUB_DEFAULT_PORT;
  if (hostname === undefined) hostname = env.PARACHUTE_BIND_HOST || "127.0.0.1";
  if (wellKnownDir === undefined) wellKnownDir = WELL_KNOWN_DIR;
  if (issuer === undefined) {
    const fromEnv = env.PARACHUTE_HUB_ORIGIN ?? env.RENDER_EXTERNAL_URL ?? flyDefaultOrigin(env);
    if (fromEnv) issuer = fromEnv.replace(/\/+$/, "") || undefined;
  }
  return { port, hostname, wellKnownDir, dbPath: dbPath ?? hubDbPath(), issuer };
}

/**
 * Compose the default Fly.io public origin from FLY_APP_NAME. Mirrors what
 * `RENDER_EXTERNAL_URL` provides on Render — without an operator-set
 * PARACHUTE_HUB_ORIGIN, we need *some* fallback so OAuth issuance + same-
 * origin checks work out of the box. Fly doesn't auto-set a public-URL env
 * var the way Render does, but every Fly app on the free shared TLS tier
 * is reachable at `<app>.fly.dev` — composing it from FLY_APP_NAME is the
 * canonical default.
 *
 * Operators on Fly with a custom domain attached should set
 * PARACHUTE_HUB_ORIGIN explicitly via `fly secrets set` — that wins over
 * this fallback (precedence in `parseArgs` above).
 */
function flyDefaultOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const app = env.FLY_APP_NAME;
  // Mirror detectAutoExposeMode's slash-rejection — Fly slugs don't contain
  // `/`, so anything with one is either spoofed or malformed. The composed
  // URL is the OAuth issuer claim, so consistency in validation matters.
  if (typeof app !== "string" || app.length === 0 || app.includes("/")) {
    return undefined;
  }
  return `https://${app}.fly.dev`;
}

function parsePort(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`port must be 1..65535, got "${v}"`);
  }
  return n;
}

/**
 * Resolve which vault ServiceEntry should handle a given request pathname.
 *
 * Vault paths look like `/vault/<name>` or `/vault/<name>/<rest>`. A request
 * matches a vault entry if the pathname equals one of its mount paths exactly
 * or starts with `<mount>/`. When several mounts could match (one vault has
 * `/vault` and another has `/vault/foo` — pathological but representable),
 * the longer mount wins so the more specific install handles it.
 *
 * Returns `undefined` when no vault is mounted at this pathname; the caller
 * 404s. The lookup is per-request because services.json mutates whenever
 * `parachute vault create` runs and we don't want the user to re-expose just
 * to make a freshly-created vault routable on the tailnet (#144).
 */
export function findVaultUpstream(
  services: readonly ServiceEntry[],
  pathname: string,
): { port: number; mount: string; entry: ServiceEntry } | undefined {
  let best: { port: number; mount: string; entry: ServiceEntry } | undefined;
  for (const s of services) {
    if (!isVaultEntry(s)) continue;
    for (const path of s.paths) {
      // Normalize trailing slashes before comparison (#197). A services.json
      // entry written with `paths: ["/vault/default/"]` would otherwise only
      // match the exact pathname `/vault/default/` and never any sub-path,
      // because `pathname.startsWith("/vault/default//")` is always false.
      // The "|| '/'" branch keeps a bare-root mount "/" stable rather than
      // collapsing it to an empty string.
      const norm = path.replace(/\/+$/, "") || "/";
      if (pathname === norm || pathname.startsWith(`${norm}/`)) {
        if (!best || norm.length > best.mount.length) {
          best = { port: s.port, mount: norm, entry: s };
        }
      }
    }
  }
  return best;
}

/**
 * True iff at least one vault module is registered in services.json. Drives
 * the wizard-resume redirect on `/` and `/hub.html` (Issue 2 of the
 * first-boot-path hardening bundle): an env-seeded admin with no vault
 * still needs the wizard, so `/` should funnel them there rather than
 * render the empty discovery portal.
 *
 * Reads services.json on every check (cheap — single ~KB parse) so a
 * vault provisioned seconds ago un-gates the discovery page without a
 * hub restart. Returns `false` on a malformed services.json — safer to
 * surface the wizard than to 500 the operator's first page load.
 */
function hasVaultInstalled(manifestPath: string): boolean {
  try {
    // Lenient — see hub#406.
    const services = readManifestLenient(manifestPath).services;
    return services.some((s) => isVaultEntry(s));
  } catch {
    return false;
  }
}

/**
 * Snapshot of every installed module's `.parachute/module.json` + its
 * user-facing mount path, for the Connections engine (2026-06-09 modular-UI
 * architecture, P5). Read at request time so a freshly-installed module's
 * declared events/actions surface without a hub restart. A malformed manifest
 * on one module is skipped (logged), never 500s the whole catalog — same
 * posture as `/api/modules`.
 *
 * `mount` is the first non-`.parachute` services.json path (the proxied
 * user-facing prefix, e.g. `/agent`), which the engine joins with a sink
 * action's `endpoint` to build the hub-proxied webhook.
 */
async function collectInstalledModules(
  manifestPath: string,
  readManifestFn: (installDir: string) => Promise<ModuleManifest | null>,
): Promise<import("./admin-connections.ts").InstalledModuleInfo[]> {
  // Lenient — see hub#406.
  const services = readManifestLenient(manifestPath).services;
  const out: import("./admin-connections.ts").InstalledModuleInfo[] = [];
  await Promise.all(
    services.map(async (entry) => {
      if (!entry.installDir) return;
      const short = shortNameForManifest(entry.name) ?? entry.name;
      const userPath = (entry.paths ?? []).find(
        (p) => p !== "/.parachute" && !p.startsWith("/.parachute/"),
      );
      try {
        const manifest = await readManifestFn(entry.installDir);
        if (!manifest) return;
        out.push({ short, manifest, mount: userPath ?? null });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`connections: skipping module ${short}: ${msg}`);
      }
    }),
  );
  return out;
}

/**
 * Resolve a module's loopback origin by SHORT name from services.json — the
 * H4 credential-delivery seam (the Connections engine POSTs minted
 * credentials + removal payloads direct to the daemon, not through the hub
 * proxy). Short derivation mirrors `collectInstalledModules`:
 * `shortNameForManifest(name) ?? name`, so third-party modules (whose row
 * name IS their short) resolve too. Read per-request — a module installed
 * seconds ago is deliverable without a hub restart.
 */
function makeResolveModuleOrigin(manifestPath: string): (short: string) => string | null {
  return (short) => {
    const services = readManifestLenient(manifestPath).services;
    const entry = services.find((s) => (shortNameForManifest(s.name) ?? s.name) === short);
    return entry ? `http://127.0.0.1:${entry.port}` : null;
  };
}

/**
 * The trust layer a request arrived through. Hub binds `127.0.0.1:1939`, so
 * every request reaches it via one of three trusted forwarders (or directly
 * over loopback). The forwarder injects characteristic headers that we use to
 * classify; nothing else can reach the listener, so spoofing isn't a concern.
 *
 *   "loopback" — direct localhost call (CLI, on-box service, dev shell).
 *   "tailnet"  — `tailscale serve` forwarding an authed tailnet user.
 *   "public"   — `tailscale funnel` (public-over-tailnet, unauthed) OR a
 *                cloudflared tunnel forwarding from the public internet.
 *
 * Used to gate `publicExposure: "loopback"` services on the generic
 * `/<svc>/*` dispatch (the hub's only layer-gate). Hub-owned paths (`/`,
 * `/admin/*`, `/api/*`, `/hub/*`, `/oauth/*`, `/.well-known/*`, `/vault/*`,
 * `/vaults`) reach all layers and rely on app-level auth (admin session
 * cookie + 2FA, OAuth, per-service tokens) — they are NOT layer-blocked.
 */
export type RequestLayer = "loopback" | "tailnet" | "public";

/**
 * Classify the trust layer for an incoming request by inspecting proxy
 * headers. Order matters: cloudflared headers come first because cloudflared
 * could in principle be deployed alongside tailscale on the same node.
 *
 * Header reference (verified against tailscale serve.go on 2026-05-08):
 *   - `Tailscale-User-Login` is set ONLY by `tailscale serve` for an authed
 *     tailnet user. Tagged-source nodes don't get it. Funnel never sets it.
 *   - `Tailscale-Funnel-Request: ?1` is set ONLY by Tailscale Funnel.
 *     Mutually exclusive with `Tailscale-User-Login` (the serve.go path
 *     returns early when funneled).
 *   - `CF-Ray` and `CF-Connecting-IP` are set by Cloudflare's edge for
 *     anything proxied through a cloudflared tunnel.
 *
 * Spoofing isn't a concern for the proxy-injected layers: the trusted
 * forwarders (tailscale serve/funnel, cloudflared) set these headers and a
 * peer can't forge them past the forwarder. Tailscale specifically strips the
 * same headers from incoming requests before re-injecting them, so even a
 * malicious tailnet peer can't impersonate a different user.
 *
 * Header-absence is NOT a loopback signal (item E / hub#526). The old default
 * returned "loopback" — the most-trusted layer — for any request with no proxy
 * headers, on the premise (true only on a loopback bind) that "external
 * requests can't reach the listener." Containers / Render legitimately bind
 * `0.0.0.0`, where a network peer can reach the listener directly with no proxy
 * headers and would be misclassified `loopback`, bypassing the
 * `publicExposure:"loopback"` 404-cloak on `proxyToService` / `proxyToVault`.
 *
 * Fix: derive loopback from the actual PEER ADDRESS (`peerAddr`, resolved by
 * the caller from `server.requestIP(req)` — `requestIP` lives on the Bun
 * Server, not the Request; see rate-limit.ts:282-285). A header-absent request
 * is `loopback` ONLY when its peer is `127.0.0.1` / `::1` (the on-box CLI
 * caller, which must stay loopback). A header-absent NON-loopback peer is the
 * untrusted direct-network case and is classified `public` (least-trusted) so
 * the cloak fires. When `peerAddr` is unknown (null/undefined — no Server
 * threaded, e.g. a unit test calling `layerOf(req)` directly), we fail CLOSED
 * to `public` rather than open to `loopback`.
 *
 * Caddy/nginx-direct (hub#704): a SAME-BOX reverse proxy dials loopback (peer
 * is 127.0.0.1) but, unlike cloudflared/tailscale, sets NO cf/tailscale header
 * — so a header-only-or-peer-only classifier would call every public request
 * through it "loopback" (most-trusted). The discriminator is the standard
 * reverse-proxy forwarding headers (X-Forwarded-For / X-Forwarded-Host /
 * Forwarded): a loopback peer that carries one is a proxied PUBLIC request →
 * `public`; a header-less loopback peer (direct on-box caller — CLI, probes,
 * the init bootstrap-token loopback probe) stays `loopback`. See the inline
 * comment in the function for the full rationale + spoof analysis.
 */
export function layerOf(req: Request, peerAddr?: string | null): RequestLayer {
  const h = req.headers;
  if (h.get("cf-ray") !== null || h.get("cf-connecting-ip") !== null) return "public";
  // Match the structured-header value (`?1`) rather than mere presence:
  // serve.go only ever emits `?1`, so insisting on the canonical value keeps
  // the classifier's intent obvious to a future reader (don't loosen this to
  // `!== null` — Tailscale's contract is the value, not the header name).
  // CF-Ray / CF-Connecting-IP are open-string identifiers with no canonical
  // value to compare against, hence the presence-check above.
  if (h.get("tailscale-funnel-request") === "?1") return "public";
  if (h.get("tailscale-user-login") !== null) return "tailnet";
  // Caddy/nginx-direct deploy (hub#704): a same-box reverse proxy terminates
  // TLS and `reverse_proxy 127.0.0.1:1939` — so it dials loopback (peer is
  // 127.0.0.1) and, unlike cloudflared/tailscale, stamps NO cf/tailscale
  // header. Without this branch every PUBLIC request through such a proxy
  // would classify "loopback" (the MOST-trusted layer): the GET /admin/setup
  // bootstrap-token JSON probe would hand the token to any public visitor, and
  // the publicExposure:"loopback" 404-cloak would stop hiding loopback-only
  // services/vaults from the network.
  //
  // The discriminator is the standard reverse-proxy forwarding headers. A
  // same-box proxy carrying a PUBLIC request sets X-Forwarded-For /
  // X-Forwarded-Host / Forwarded; a direct on-box caller (the CLI, health
  // probes, the init bootstrap-token loopback probe `curl 127.0.0.1/admin/setup`,
  // the hub's own loopback self-requests) sets none of them — the hub never
  // injects X-Forwarded-* on the INBOUND request it classifies (it only stamps
  // X-Forwarded-Host/Proto on OUTBOUND proxy requests to modules). So a
  // loopback peer that ALSO carries a forwarding header is a proxied public
  // request → "public"; a header-less loopback peer stays "loopback".
  //
  // No spoof vector: a NON-loopback peer is already "public" regardless of
  // headers (the branch below), so adding these headers can only DOWNGRADE a
  // loopback caller (the on-box operator hurting only their own request) —
  // never upgrade a network peer to "loopback".
  //
  // Presence check (`!== null`), NOT a trim: an empty/whitespace forwarding
  // header still means "a proxy is in front" → err to public. Downgrading on
  // ambiguity is the safe direction for a trust classifier; a future ".trim()
  // tidy-up" that let an empty XFF fall back to loopback would re-open the leak.
  if (
    isLoopbackPeer(peerAddr) &&
    (h.get("x-forwarded-for") !== null ||
      h.get("x-forwarded-host") !== null ||
      h.get("forwarded") !== null)
  ) {
    return "public";
  }
  // No proxy headers — classify by peer address, failing closed when unknown.
  return isLoopbackPeer(peerAddr) ? "loopback" : "public";
}

/**
 * True when `peerAddr` (a `server.requestIP(req)?.address`) is a loopback
 * address. Handles the IPv4-mapped IPv6 form (`::ffff:127.0.0.1`) Bun can emit
 * on a dual-stack listener. A null/undefined/unparseable address is NOT
 * loopback — `layerOf` fails closed to `public` in that case.
 */
function isLoopbackPeer(peerAddr: string | null | undefined): boolean {
  if (!peerAddr) return false;
  const addr = peerAddr.trim().toLowerCase();
  return (
    addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.")
  );
}

/**
 * The two substrate trust headers the hub stamps on every forwarded request
 * (H2, surface-runtime-primitives design §10):
 *
 *   X-Parachute-Layer     — the `layerOf` classification ("loopback" |
 *                           "tailnet" | "public"), fail-closed to "public"
 *                           when the peer address is unknown.
 *   X-Parachute-Client-IP — the resolved client IP (CF-Connecting-IP →
 *                           X-Forwarded-For first hop → peer address; same
 *                           precedence as rate-limit.ts `clientIpFromRequest`,
 *                           with the peer address as the direct-caller floor).
 *
 * Backends (surface-host's `ctx.layer` / `ctx.clientIp`, any module reading
 * trust signals) consume THESE, never raw forwarder headers — the hub is the
 * only component that can see the actual peer socket, so it's the only place
 * the classification can be made fail-closed.
 */
export const PARACHUTE_LAYER_HEADER = "x-parachute-layer";
export const PARACHUTE_CLIENT_IP_HEADER = "x-parachute-client-ip";

/**
 * Resolve the client IP for the X-Parachute-Client-IP stamp. Precedence:
 *
 *   1. `CF-Connecting-IP` — cloudflared stamps the actual client IP on every
 *      forwarded request (authoritative on cloudflare-fronted hubs).
 *   2. `X-Forwarded-For` first hop — tailscale serve/funnel and generic
 *      reverse proxies set it; the leftmost entry is the original client.
 *   3. The peer address itself — the direct caller (loopback CLI, or a
 *      direct network peer on a 0.0.0.0 bind).
 *
 * Returns null when nothing resolves (no forwarder headers AND no peer
 * address — e.g. a unit test calling the fetch fn without a Server). The
 * caller omits the header in that case; backends treat absence as null.
 *
 * Known limitation (same as the rate-limiter's keying): a DIRECT caller can
 * spoof the forwarded-IP headers and misattribute its own address. It cannot
 * spoof the LAYER (layerOf classifies direct non-loopback peers as "public"
 * regardless of injected headers), so the trust signal stays sound — only
 * the attribution string is best-effort for direct callers.
 */
export function resolveClientIp(req: Request, peerAddr: string | null): string | null {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const peer = peerAddr?.trim();
  return peer ? peer : null;
}

/**
 * Strip any inbound occurrences of the substrate trust headers, then stamp
 * the hub's own classification. The strip is load-bearing: a public client
 * sending `X-Parachute-Layer: loopback` (or a forged client IP) must never
 * ride that injection past the proxy into a module that keys trust off it.
 * Mutates `headers` in place (the proxy's outgoing header bag).
 */
export function stampSubstrateTrustHeaders(
  headers: Headers,
  req: Request,
  peerAddr: string | null,
): void {
  headers.delete(PARACHUTE_LAYER_HEADER);
  headers.delete(PARACHUTE_CLIENT_IP_HEADER);
  headers.set(PARACHUTE_LAYER_HEADER, layerOf(req, peerAddr));
  const clientIp = resolveClientIp(req, peerAddr);
  if (clientIp) headers.set(PARACHUTE_CLIENT_IP_HEADER, clientIp);
}

/**
 * Shared bucket for connections whose client IP cannot be derived at all
 * (no forwarder headers AND no peer address). Fail-closed: they all contend
 * for one per-IP allotment rather than each minting a fresh bucket — the
 * same posture as rate-limit.ts's UNKNOWN_IP_SENTINEL.
 */
export const WS_CAP_SHARED_BUCKET = "unknown";

/**
 * Derive the connection-cap bucket key for a WS upgrade (hub#649).
 *
 * STRICTER than {@link resolveClientIp} on purpose. The H2 attribution stamp
 * tolerates a direct caller misattributing itself (documented limitation —
 * the LAYER stays truthful, only the attribution string is best-effort). A
 * cap key cannot afford that tolerance: if a direct peer's forged
 * X-Forwarded-For were believed, rotating the header would mint a fresh
 * bucket per connection and the per-IP cap would never trip. So forwarded
 * IP headers are believed ONLY when the peer is loopback — the hub's actual
 * forwarder topology (cloudflared, tailscale serve/funnel) runs on-box and
 * dials 127.0.0.1; nothing else legitimately presents those headers from
 * loopback, and a remote attacker can't BE loopback.
 *
 *   - loopback peer:  CF-Connecting-IP → X-Forwarded-For first hop → the
 *     loopback address itself (direct local callers share one bucket —
 *     owner-operated, and the cap is configurable).
 *   - non-loopback peer: the peer address, regardless of injected headers
 *     (spoofed XFF on an untrusted layer lands in the spoofer's own bucket).
 *   - no peer derivable: {@link WS_CAP_SHARED_BUCKET} (fail closed).
 *
 * Known limitation, container deploys (Render / Fly): the platform edge
 * dials from a private non-loopback address, so all public clients share
 * the edge peer's bucket there — the per-IP cap degrades to a coarse shared
 * cap and the global cap is the operative bound. Raise
 * PARACHUTE_WS_MAX_PER_IP on such deploys; a trusted-proxy allowlist can
 * refine this when a cloud WS surface actually ships.
 */
export function wsCapBucketKey(req: Request, peerAddr: string | null): string {
  const peer = peerAddr?.trim() || null;
  if (peer && isLoopbackPeer(peer)) {
    const cf = req.headers.get("cf-connecting-ip")?.trim();
    if (cf) return cf;
    const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
    return peer;
  }
  return peer ?? WS_CAP_SHARED_BUCKET;
}

/**
 * Forward a request to a loopback service on `127.0.0.1:<port>`. By default
 * the incoming pathname + query are preserved verbatim; pass `targetPath` to
 * rewrite the path (e.g. when the caller has stripped a mount prefix because
 * the backend serves bare routes). Query string is always preserved from the
 * incoming URL.
 *
 * Note: this is **not** equivalent to the tailscale convention. `tailscale
 * serve <mount>=<target>` strips the mount before forwarding, so
 * `serviceProxyTarget` in `commands/expose.ts` works by making mount and
 * target byte-equal. The hub's fetch-based proxy does no stripping unless the
 * caller asks; per-service preferences vary (scribe wants bare paths, notes
 * / agent / vault want the prefix), so the decision lives one layer up in
 * `proxyToService` / `proxyToVault`.
 *
 * Returns a boot-readiness-classified response when the loopback fetch fails
 * — port valid, target unreachable (service crashed, port shifted, mid-
 * restart, OR module is still inside its boot window). The response is
 * classified by `classifyUpstream` into:
 *
 *   - **transient** (still booting): 503 + Retry-After. HTML page polls
 *     /api/ready up to 5 attempts on a 2s cadence; JSON includes
 *     retry_after_ms + max_attempts.
 *   - **persistent** (crashed / never started): 502, no auto-retry. HTML
 *     surfaces a /admin/modules link; JSON includes admin_url.
 *
 * `serviceLabel` is the services.json entry name (`parachute-vault`,
 * `scribe`, …) folded into the response body for operator clarity.
 * `short` is the canonical short (`vault`/`scribe`/`notes`) — used as
 * the supervisor map key + pidfile directory key for classification.
 *
 * `peerAddr` is the resolved peer address (`server.requestIP`), threaded so
 * the substrate trust headers (below) classify the layer the same way the
 * `publicExposure` cloak does — fail-closed to `public` when unknown.
 *
 * Hop-by-hop notes: HTTP/2 trailers don't traverse fetch-based proxies
 * cleanly; no on-box service uses them today. WebSocket upgrades CANNOT
 * traverse this fetch-based path either — they're handled BEFORE dispatch by
 * the Bun-native upgrade bridge (H1: `maybeUpgradeWebSocket` +
 * `src/ws-bridge.ts`) for modules that declare the capability; an upgrade
 * request reaching this function belongs to a non-declaring mount and the
 * upstream sees a plain GET.
 */
async function proxyRequest(
  req: Request,
  port: number,
  serviceLabel: string,
  short: string,
  supervisor: Supervisor | undefined,
  peerAddr: string | null,
  targetPath?: string,
): Promise<Response> {
  const url = new URL(req.url);
  const path = targetPath ?? url.pathname;
  const upstream = `http://127.0.0.1:${port}${path}${url.search}`;
  const headers = new Headers(req.headers);
  // Capture the public hostname BEFORE deleting Host so we can forward it
  // as X-Forwarded-Host (hub#358). Without this, supervised modules like
  // vault see no X-Forwarded-Host header and fall back to their internal
  // loopback URL when constructing OAuth metadata — publishing
  // `http://127.0.0.1:1940/...` as the issuer instead of the public origin.
  const publicHost = req.headers.get("host");
  // Host comes from the requester (tailnet FQDN); the loopback target wants
  // its own. Bun's fetch fills it in when omitted.
  headers.delete("host");
  // Force upstreams to reply with uncompressed bodies. The chrome-strip
  // injector (workstream G) buffers + TextDecoders the HTML response to
  // inject the persistent chrome; without this, a gzip- or br-compressed
  // upstream reply gets UTF-8-decoded as raw compressed bytes (garbage) —
  // the body becomes unrenderable while Content-Encoding still says "gzip",
  // so the browser fails silently.
  //
  // We set "identity" (RFC 9110 §12.5.3 — explicitly no encoding) rather
  // than deleting Accept-Encoding because Bun's fetch implementation
  // auto-injects "gzip, deflate, br, zstd" when the header is absent. The
  // explicit "identity" overrides that default.
  //
  // Trade-off: on a single-host owner-operated deploy the loopback bandwidth
  // is negligible. If a future deployment shape adds long-haul links between
  // hub and modules, prefer either (a) re-enable compression + decode in the
  // chrome injector, or (b) flip per-route based on Accept header.
  headers.set("accept-encoding", "identity");
  // Forward the public origin so downstream services build their public-
  // facing URLs (OAuth metadata, redirect URIs) against the same host the
  // client used. We DON'T overwrite X-Forwarded-Host if already set —
  // some platforms (Render) set it at the edge.
  if (publicHost && !headers.has("x-forwarded-host")) {
    headers.set("x-forwarded-host", publicHost);
  }
  // Same for protocol — if the edge set X-Forwarded-Proto we preserve it,
  // otherwise we set it from isHttpsRequest's signal (direct HTTPS to hub
  // is unusual on Render, but covers local TLS-terminating proxies too).
  if (!headers.has("x-forwarded-proto")) {
    headers.set("x-forwarded-proto", isHttpsRequest(req) ? "https" : "http");
  }
  // Substrate trust headers (H2, surface-runtime design §10): stamped on
  // EVERY forwarded request so module backends read trust signals from the
  // substrate instead of re-deriving them from raw forwarder headers (the
  // "header-absence = local trust" anti-pattern the design rejects).
  stampSubstrateTrustHeaders(headers, req, peerAddr);

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half";
  }
  try {
    return await fetch(upstream, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Classify the failure (transient boot-window vs persistent crash) and
    // render either an HTML page or a JSON error per the request's Accept.
    // See `proxy-state.ts` for the classification logic + `proxy-error-ui.ts`
    // for the two response shapes (closes hub#443).
    const classifyOpts: Parameters<typeof classifyUpstream>[1] = {};
    if (supervisor !== undefined) classifyOpts.supervisor = supervisor;
    const state = classifyUpstream(short, classifyOpts);
    const rendered = renderProxyError(req, {
      short,
      serviceLabel,
      state,
      upstreamError: msg,
    });
    return proxyErrorToResponse(rendered);
  }
}

/**
 * Reverse-proxy a `/vault/<name>/*` request onto the vault backend.
 * `manifestPath` is the services.json path from `HubFetchDeps`. Read on every
 * proxied request so a vault created seconds ago is reachable without a
 * re-expose — same dynamism as the well-known doc (#135).
 *
 * Returns `undefined` when no vault claims this pathname so the caller can
 * fall through to the SPA shell fallback for unknown vault names (the seam
 * #173 introduced).
 */
async function proxyToVault(
  req: Request,
  manifestPath: string,
  supervisor: Supervisor | undefined,
  peerAddr: string | null,
): Promise<Response | undefined> {
  // Lenient — see hub#406. One bad services.json row no longer takes
  // down vault routing the way it used to take down /admin/setup and
  // /api/modules (the symptom Aaron hit 2026-05-26).
  const services = readManifestLenient(manifestPath).services;
  const url = new URL(req.url);
  const match = findVaultUpstream(services, url.pathname);
  if (!match) return undefined;
  // Layer-gate on `publicExposure: "loopback"` — hide the entry from non-
  // loopback callers as if it doesn't exist. "allowed" / "auth-required"
  // pass through; the service does its own auth. `peerAddr` (item E / #526)
  // is the loopback discriminator: a header-absent NON-loopback peer is NOT
  // loopback, so the cloak fires on a 0.0.0.0 bind.
  if (
    effectivePublicExposure(match.entry) === "loopback" &&
    layerOf(req, peerAddr) !== "loopback"
  ) {
    return new Response("not found", { status: 404 });
  }
  // Bare `/vault/<name>` POST → point at `/vault/<name>/mcp` (#525). Operators
  // paste the bare vault URL (no `/mcp` suffix) into MCP clients; OAuth completes
  // against the bare path (so the client looks "connected") but the JSON-RPC POST
  // then hits a path vault has no MCP handler for and 405s — a confusing
  // "connected but erroring" half-state. We catch the bare-path POST here, BEFORE
  // proxying, and 308-redirect to the canonical `<mount>/mcp`. 308 (vs 307)
  // signals the redirect is permanent/cacheable, and like 307 it preserves the
  // method + body, so a spec-compliant MCP client re-POSTs the JSON-RPC payload
  // to the right endpoint and connects cleanly. Clients that DON'T follow
  // redirects still get an actionable signal: the Location header + JSON body name
  // the correct URL (vs the old opaque 405). Only the EXACT bare mount is caught —
  // any sub-path (`<mount>/mcp`, `<mount>/api/...`, the Notes PWA) proxies through
  // untouched, and only POST (the MCP transport verb) is redirected so a stray
  // browser GET to the bare path keeps its existing proxy behavior.
  if (req.method === "POST" && url.pathname === match.mount) {
    const mcpUrl = `${match.mount}/mcp`;
    const body = {
      error: "missing_mcp_suffix",
      message: `This is a Parachute vault path, not an MCP endpoint. Use ${mcpUrl} as your MCP server URL.`,
      mcp_url: mcpUrl,
    };
    return new Response(JSON.stringify(body), {
      status: 308,
      headers: {
        location: mcpUrl,
        "content-type": "application/json",
        // 308 is permanently cacheable by default; without no-store a client
        // (or an intermediary) could cache the redirect and keep bouncing the
        // bare path to `/mcp` even after a remount changes the routing. Same
        // guard as the force-change-password redirect below.
        "cache-control": "no-store",
      },
    });
  }
  // Symmetry with proxyToService (#196): honor `stripPrefix` with FIRST_-
  // PARTY_FALLBACKS as a fallback source. No first-party vault fallback
  // declares stripPrefix today (vault expects the full `/vault/<name>/*`
  // path), so this is a no-op in practice — but reading the same shape in
  // both proxies keeps the dispatch surface consistent for future readers.
  const stripPrefix = stripPrefixFor(match.entry);
  const targetPath = stripPrefix ? url.pathname.slice(match.mount.length) || "/" : undefined;
  // Vault's short is the literal "vault" — fixed by KNOWN_MODULES. Multiple
  // vault instances share the same supervisor key under hub's current
  // single-vault-per-hub model; if multi-vault-per-hub ever ships, the
  // classifier will need a per-instance key.
  return proxyRequest(req, match.port, "vault", "vault", supervisor, peerAddr, targetPath);
}

/**
 * Reverse-proxy `/vault/admin` + `/vault/admin/*` to the vault MODULE's
 * daemon — the daemon-level multi-vault admin surface (B-route, 2026-06-09
 * hub-module-boundary migration), NOT a per-instance path.
 *
 * Resolution is via `findServiceByShort(services, "vault")` (the canonical
 * self-registered `parachute-vault` row — same shape as the agentEntry
 * lookup in the Connections deps), deliberately NOT `findVaultUpstream`:
 * vault must NOT self-register `/vault/admin` in `paths[]`, because every
 * consumer that derives instance names from paths (`vaultInstanceNameFor`,
 * the well-known vaults[] fan-out, `findExistingVault`, the mint
 * allowlists, the users vault-picker) would fabricate a phantom vault named
 * "admin". The mount is hub-owned and gated on the B2h `admin` name
 * reservation, so no real instance can ever claim it.
 *
 * Applies the SAME `publicExposure: "loopback"` 404-cloak as `proxyToVault`
 * (the per-vault proxy's only layer-gate; "allowed"/"auth-required" pass
 * through and the daemon self-gates). Vault's row declares no `stripPrefix`
 * — the FULL path forwards, so the daemon's own `/vault/admin` routing
 * branch (vault wave, B3) serves it.
 *
 * Returns `undefined` when no vault module is installed (caller 404s).
 * NOTE: legacy per-instance rows named `parachute-vault-<name>` don't
 * resolve through `findServiceByShort` (it only knows the canonical
 * manifest name) — on such an install this surface 404s until vault's boot
 * selfRegister rewrites the canonical row, which is the documented
 * old-install degradation, not a routing hole.
 */
async function proxyToVaultAdmin(
  req: Request,
  manifestPath: string,
  supervisor: Supervisor | undefined,
  peerAddr: string | null,
): Promise<Response | undefined> {
  // Lenient — see hub#406 (same posture as proxyToVault).
  const services = readManifestLenient(manifestPath).services;
  const entry = findServiceByShort(services, "vault");
  if (!entry) return undefined;
  if (effectivePublicExposure(entry) === "loopback" && layerOf(req, peerAddr) !== "loopback") {
    return new Response("not found", { status: 404 });
  }
  return proxyRequest(req, entry.port, "vault", "vault", supervisor, peerAddr);
}

/**
 * Resolve which (non-vault) ServiceEntry should handle a given request.
 * Generic longest-prefix match across every service's `paths[]`. Vault
 * entries are filtered out — they're routed by `findVaultUpstream` /
 * `proxyToVault`, which encode the vault-specific SPA-fallback seam.
 *
 * Returns `undefined` when no service claims the pathname; the caller 404s.
 */
export function findServiceUpstream(
  services: readonly ServiceEntry[],
  pathname: string,
): { port: number; mount: string; entry: ServiceEntry } | undefined {
  let best: { port: number; mount: string; entry: ServiceEntry } | undefined;
  for (const s of services) {
    if (isVaultEntry(s)) continue;
    for (const path of s.paths) {
      // Normalize trailing slashes before comparison (#197). A services.json
      // entry written with `paths: ["/notes/"]` would otherwise only match
      // the exact pathname `/notes/` and never `/notes/assets/index.js` —
      // `pathname.startsWith("/notes//")` is always false because URLs
      // don't have double slashes. Result: SPA shell loads but every asset
      // 404s (notes blank-screen on Aaron's box, 2026-05-08).
      // The "|| '/'" branch keeps a bare-root mount "/" stable rather than
      // collapsing it to an empty string.
      const norm = path.replace(/\/+$/, "") || "/";
      if (pathname === norm || pathname.startsWith(`${norm}/`)) {
        if (!best || norm.length > best.mount.length) {
          best = { port: s.port, mount: norm, entry: s };
        }
      }
    }
  }
  return best;
}

/**
 * Reverse-proxy a request onto whichever non-vault service registers a
 * matching `paths[]` prefix in services.json. Wired after every specific
 * handler in `hubFetch` so the exclusion list (`/`, `/admin/*`, `/oauth/*`,
 * `/.well-known/*`, `/hub/*`, `/vault/*`, `/api/*`) is enforced by ordering:
 * those specific handlers run first and never reach this dispatch.
 *
 * Read services.json on every request so a `parachute install <svc>` made
 * seconds ago is reachable without a hub restart — same dynamism as the
 * well-known doc and `proxyToVault`.
 *
 * Honors `entry.stripPrefix`: when `true` the matched mount prefix is
 * removed from the forwarded path so the backend sees a bare route
 * (`/scribe/health` becomes `/health`). Default (`false` / absent) forwards
 * the full path — matches what notes / agent / vault expect.
 *
 * Returns `undefined` when no service claims the pathname; caller 404s.
 */
async function proxyToService(
  req: Request,
  manifestPath: string,
  supervisor: Supervisor | undefined,
  peerAddr: string | null,
): Promise<Response | undefined> {
  // Lenient read on the hot-path — a single malformed services.json
  // entry (e.g. a module installed at a buggy version that wrote
  // `port: 0`) used to cascade into 500s for every route on this hub
  // because the strict throw bailed BEFORE we could dispatch to the
  // healthy entries. `readManifestLenient` skips + logs bad rows so
  // unrelated services keep working. The strict `readManifest` is
  // still used by write paths + admin surfaces that want errors
  // surfaced immediately. See hub#406.
  //
  // The default `log` is `console`, which under Render's container
  // routing surfaces in the Logs panel — operators see the warning
  // about the skipped entry.
  const services = readManifestLenient(manifestPath).services;
  const url = new URL(req.url);
  const match = findServiceUpstream(services, url.pathname);
  if (!match) return undefined;
  // Layer-gate on `publicExposure: "loopback"`. From the perspective of a
  // tailnet/public caller, a loopback-only service must be indistinguishable
  // from "not installed" — 404, not 403, so we don't leak the existence of
  // the route. "allowed" / "auth-required" pass through; the service does
  // its own auth. `peerAddr` (item E / #526) is the loopback discriminator.
  if (
    effectivePublicExposure(match.entry) === "loopback" &&
    layerOf(req, peerAddr) !== "loopback"
  ) {
    return new Response("not found", { status: 404 });
  }
  // Consult FIRST_PARTY_FALLBACKS / KNOWN_MODULES as a fallback for
  // `stripPrefix` (#196). Pre-hub#310, scribe's `stripPrefix: true` lived
  // only in hub's vendored fallback; post-#310 scribe (and post-D3 agent,
  // renamed from channel 2026-06-17)
  // self-register with `stripPrefix: true` on their rows, so the entry-based
  // path is authoritative. The registry consultation now matters only for
  // notes (the remaining FALLBACK short) and legacy rows written before the
  // module emitted the field (KNOWN_MODULES canonicalStripPrefix).
  // Explicit-on-entry still wins; absent → fallback → false (preserving the
  // keep-prefix default for unknown services).
  const stripPrefix = stripPrefixFor(match.entry);
  const targetPath = stripPrefix ? url.pathname.slice(match.mount.length) || "/" : undefined;
  // Resolve canonical short for classification — falls back to the
  // services.json name when the entry isn't a KNOWN_MODULES / FALLBACK
  // shape (third-party services have no canonical short; the classifier
  // will land in "persistent" by default which is the safer choice for
  // unknown lifecycle).
  const short = shortNameForManifest(match.entry.name) ?? match.entry.name;
  return proxyRequest(req, match.port, match.entry.name, short, supervisor, peerAddr, targetPath);
}

/**
 * Resolve effective `stripPrefix` for a service entry. Explicit on-entry
 * wins; otherwise consult `FIRST_PARTY_FALLBACKS` keyed by short name (for
 * notes — vault/scribe/runner retired their FALLBACK entries in hub#310,
 * agent (renamed from channel 2026-06-17) in boundary D3; all self-register
 * with the canonical `stripPrefix` declaration on their services.json row).
 * `KNOWN_MODULES[short]?.canonicalStripPrefix` is the next fallback — covers
 * the edge case where a self-registering module wrote its row before the
 * `stripPrefix` field was being emitted (e.g. pre-scribe#50 or pre-D3
 * agent services.json rows). Defaults to `false` — keep the prefix —
 * matching the pre-#196 dispatch behavior for unknown / third-party
 * services.
 *
 * For a self-registering KNOWN_MODULES short whose row is missing entirely
 * (uninstalled, never booted), the request never reaches this code path —
 * `findServiceUpstream` returns undefined upstream and the proxy 404s. The
 * "module not installed → not found" shape replaces the prior "fall through
 * to vendored fallback" lookup.
 */
function stripPrefixFor(entry: ServiceEntry): boolean {
  if (entry.stripPrefix !== undefined) return entry.stripPrefix;
  const short = shortNameForManifest(entry.name);
  const fb = short !== undefined ? FIRST_PARTY_FALLBACKS[short] : undefined;
  const km = short !== undefined ? KNOWN_MODULES[short] : undefined;
  return fb?.manifest.stripPrefix ?? km?.canonicalStripPrefix ?? false;
}

export interface HubFetchDeps {
  /**
   * Lazily opens (or returns a cached handle to) the hub DB. Optional so
   * tests can exercise routes that don't touch the DB (the well-known doc,
   * static assets) without standing up a fixture; runtime returns 503 for
   * DB-dependent routes when this is absent.
   */
  getDb?: () => Database;
  /**
   * React to a thrown SQLite error per the self-heal-or-die policy (#594).
   * Production wires the {@link DbHolder}'s `healOrExit` so a request that
   * hits the persistent-corruption class (disk I/O error / malformed image)
   * triggers ONE reopen attempt, then `process.exit(1)` if reopen fails — the
   * platform manager restarts the hub with a fresh handle. Returns the holder
   * verdict (`"healed"` / `"ignored"` / `"exited"`) so the handler can shape
   * the response. Absent in tests that don't exercise the DB-error path.
   */
  onDbError?: (err: unknown) => "ignored" | "healed" | "exited";
  /**
   * PROACTIVE db-path liveness probe (#610). Production wires the
   * {@link DbHolder}'s `probePath` so the `/health` db check `stat()`s the
   * configured db path and compares its inode to the open handle's — catching
   * the "operator wiped `~/.parachute` under a running hub" case that NEVER
   * throws on Linux (the unlinked-but-open ghost inode keeps `SELECT 1`
   * succeeding). Returns the path-liveness verdict; on a genuine wipe it ALSO
   * triggers the reopen-or-exit self-heal. Absent in tests that don't exercise
   * the proactive path — `/health` then falls back to the `SELECT 1` probe only.
   */
  probeDbPath?: () => "ok" | "gone" | "replaced" | "unknown";
  /**
   * Hub origin used as the OAuth `iss` claim and to build the authorization-
   * server metadata document. When omitted, OAuth endpoints fall back to the
   * request's own origin — fine for local dev, surprising under a reverse
   * proxy where the request origin is the loopback.
   */
  issuer?: string;
  /**
   * Path to the services manifest read on each `/.well-known/parachute.json`
   * GET. Tests point this at a tmpdir; production uses the default ecosystem
   * path. Read-on-each-request (cheap — single ~KB JSON parse) is what makes
   * the doc reflect `parachute vault create` etc. without re-running expose.
   */
  manifestPath?: string;
  /**
   * Directory holding the per-surface bare repos for the git-transport endpoint
   * (`/git/<name>/*` → `<gitRoot>/<name>.git`). Tests point this at a tmpdir;
   * production defaults to `<CONFIG_DIR>/hub/git`.
   */
  gitRoot?: string;
  /**
   * Path to `connections.json` (the Connections store, P5). Tests point this
   * at a tmpdir; production defaults to `<CONFIG_DIR>/connections.json`.
   */
  connectionsStorePath?: string;
  /**
   * Path to `agent-grants.json` (the agent-connector grant store, 4b-1). Tests
   * point this at a tmpdir; production defaults to `<CONFIG_DIR>/agent-grants.json`.
   */
  agentGrantsStorePath?: string;
  /**
   * Path to `agent-oauth-flows.json` (the in-flight agent-grant OAuth consents,
   * 4b-2). Tests point this at a tmpdir; production defaults to
   * `<CONFIG_DIR>/agent-oauth-flows.json`.
   */
  agentOAuthFlowsStorePath?: string;
  /**
   * Directory containing the built SPA bundle (`index.html` + `assets/`). When
   * absent, the hub auto-resolves to `<repo>/web/ui/dist/` — handy for the
   * default bun-linked checkout. Tests point this at a fixture (or omit it +
   * disable the mount). When the dir doesn't exist on disk, `/hub/*` routes
   * 503 with a "run `bun run build` in web/ui" hint.
   */
  spaDistDir?: string;
  /**
   * Override the per-module `.parachute/module.json` reader. Production reads
   * from disk via `module-manifest.readModuleManifest`; tests inject a fake
   * to drive `managementUrl` into the well-known doc without standing up
   * fixture installDirs.
   */
  readModuleManifest?: (installDir: string) => Promise<ModuleManifest | null>;
  /**
   * Hub's listening port. Threaded into the OAuth `hubBoundOrigins` set so
   * the same-origin defense accepts loopback access (`http://localhost:<port>`,
   * `http://127.0.0.1:<port>`) alongside the configured issuer. Closes #245
   * Case A (operator on `localhost:1939` getting "Cross-origin request
   * rejected" because Origin ≠ tailnet issuer).
   */
  loopbackPort?: number;
  /**
   * Test seam for reading `expose-state.json`'s `hubOrigin`. Production reads
   * the operator's `~/.parachute/expose-state.json` via `readExposeState`;
   * tests inject a fake to drive tailnet/funnel origins into the bound set
   * without standing up real exposes. Returns `undefined` when no state file
   * is present (pre-`parachute expose` state — fine, the issuer + loopback
   * still cover legitimate access).
   *
   * This single seam now feeds BOTH (a) the same-origin bound set via
   * `buildHubBoundOrigins`, and (b) the issuer resolution via `resolveIssuer`
   * (#531): on the reboot-persistent owner-operated path the launchd /
   * systemd unit carries no `PARACHUTE_HUB_ORIGIN`, so the hub boots with no
   * `configuredIssuer` and falls back to this exposed origin rather than
   * stamping `iss` from the per-request (loopback) origin — which exposed
   * resource servers (vault) reject until they restart.
   */
  loadExposeHubOrigin?: () => string | undefined;
  /**
   * Container-mode child supervisor. When present (under `parachute serve`),
   * `/api/modules/*` handlers drive install/restart/upgrade/uninstall through
   * it. Absent under the on-box CLI path (`parachute expose`) where
   * `commands/lifecycle.ts` owns the detached-pidfile lifecycle instead —
   * the module-mgmt API in that mode returns 503 with a hint to use the
   * CLI commands directly.
   */
  supervisor?: Supervisor;
  /**
   * WebSocket connection-cap accounting (hub#649). Production uses the
   * process-wide {@link defaultWsConnectionTracker} (caps from env at boot);
   * tests inject their own tracker so they neither consume nor depend on the
   * shared counters. Release pairing is structural — the acquire site stashes
   * the release closure on the upgraded socket's `data`, so a mismatched
   * tracker between fetch fn and bridge handlers is impossible.
   */
  wsConnectionTracker?: WsConnectionTracker;
}

/**
 * For each vault `ServiceEntry` with a known `installDir`, read its
 * `.parachute/module.json` and surface the optional `managementUrl`. Returns
 * a `name → managementUrl` map keyed by services.json entry name.
 *
 * Quiet on per-entry errors: a malformed module.json on one vault shouldn't
 * 500 the entire well-known doc — its row just renders without a "Manage"
 * link. The validator already throws structured errors from
 * `readModuleManifest`; logging them once here is the right floor.
 */
async function loadManagementUrls(
  services: readonly ServiceEntry[],
  read: (installDir: string) => Promise<ModuleManifest | null>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    services.map(async (s) => {
      if (!isVaultEntry(s) || !s.installDir) return;
      try {
        const m = await read(s.installDir);
        if (m?.managementUrl) out.set(s.name, m.managementUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`well-known: skipping managementUrl for ${s.name}: ${msg}`);
      }
    }),
  );
  return out;
}

/**
 * For each `ServiceEntry` with a known `installDir`, read its
 * `.parachute/module.json` and surface the optional `uiUrl` and
 * `displayName`. Returns two `name → value` maps keyed by services.json
 * entry name.
 *
 * Vaults are NOT skipped — as of patterns#96 (workstream C) vault declares
 * its own `uiUrl: "/admin/"` (multi-instance form). `buildWellKnown`
 * applies the per-instance mount-path prefix for vault rows so each
 * instance gets a discovery tile pointing at `/vault/<name>/admin/`. The
 * earlier "vaults browse via Notes — no tile" rule retired with PR 1 of
 * workstream C; operators administer per-vault tokens / config / MCP via
 * the vault admin SPA, which is a different audience from Notes' content
 * browse. See [`module-ui-declaration.md` §"Use vs admin"](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/module-ui-declaration.md#use-vs-admin--both-can-be-true).
 *
 * `loadManagementUrls` continues to handle vault's `managementUrl` for
 * the hub admin SPA's vault-list "Manage" link — a different surface
 * (admin SPA, not discovery), even when the target path happens to
 * collide (`/admin/` for both).
 *
 * Why read at request time and not from services.json: services own the
 * write side of services.json (`upsertService` replaces the whole entry
 * on every boot), so any install-time copy of `uiUrl` / `displayName`
 * would be clobbered the first time the service writes its own entry.
 * Reading from `installDir/module.json` at request time avoids the gap
 * and matches the established `managementUrl` precedent.
 *
 * Quiet on per-entry errors: a malformed module.json on one service
 * shouldn't 500 the entire well-known doc — its row just renders without
 * a Services tile. The validator already throws structured errors from
 * `readModuleManifest`; logging them once here is the right floor.
 */
async function loadServiceUiMetadata(
  services: readonly ServiceEntry[],
  read: (installDir: string) => Promise<ModuleManifest | null>,
): Promise<{ uiUrls: Map<string, string>; displayNames: Map<string, string> }> {
  const uiUrls = new Map<string, string>();
  const displayNames = new Map<string, string>();
  await Promise.all(
    services.map(async (s) => {
      if (!s.installDir) return;
      try {
        const m = await read(s.installDir);
        if (m?.uiUrl) uiUrls.set(s.name, m.uiUrl);
        if (m?.displayName) displayNames.set(s.name, m.displayName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`well-known: skipping uiUrl/displayName for ${s.name}: ${msg}`);
      }
    }),
  );
  return { uiUrls, displayNames };
}

/**
 * Resolve the SPA bundle dir. We anchor to this file's location so a
 * `bun src/hub-server.ts` from any cwd still finds `<repo>/web/ui/dist/`.
 * Tests / production override via `HubFetchDeps.spaDistDir`.
 */
function defaultSpaDistDir(): string {
  // import.meta.dir is the dir holding *this* file (`src/`); the SPA bundle
  // sits at `<repo>/web/ui/dist/`, two hops up + over.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "web", "ui", "dist");
}

/**
 * The admin SPA serves at a single mount: `/admin/*` (since hub#231).
 *
 * Routes:
 *   - `/admin/`             → Home (the admin-shell overview)
 *   - `/admin/vaults`       → legacy vault list; feature-detects a new-manifest
 *                             vault and forwards to `/vault/admin/` (B5)
 *   - `/admin/permissions`  → OAuth consent grant management
 *   - `/admin/tokens`       → token registry: mint / list / revoke
 *
 * Asset URLs are origin-absolute (`/admin/assets/...`) per the Vite build
 * base. main.tsx pins react-router's basename to `/admin`.
 *
 * Pre-rename mounts (the old `/vault` for the vault SPA, `/hub/*` for
 * permissions+tokens) are 301-redirected further up the dispatch so cached
 * operator URLs keep working. `/vault/<name>/*` (per-vault content proxy)
 * stays — that's user-facing vault data, not part of this admin SPA.
 */
type SpaMount = "/admin";

/**
 * Pick a content type for static assets the SPA build produces. Vite's
 * standard fingerprinted output is the realistic surface — js / css / svg /
 * png / woff2 / ico. We don't reach for a full mime db; mismatches show up
 * loud (a `.js` served as `text/html` is unmistakable) and the list is
 * trivially extensible if a future feature adds an asset type.
 */
function spaContentType(pathname: string): string {
  const ext = pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "application/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "ico":
      return "image/x-icon";
    case "woff2":
      return "font/woff2";
    case "woff":
      return "font/woff";
    case "json":
      return "application/json";
    case "map":
      return "application/json";
    case "txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Serve a single file under the SPA mount, falling back to `index.html`
 * for client-side-routed paths (anything that doesn't resolve to a real
 * file under `dist/`). Path-traversal is blocked twice: the asset-shape
 * filter rejects sub-paths containing "..", and the resolved absolute
 * path is checked to start with `dist/` before any read.
 *
 * `mount` is the prefix being served (`/admin`); we strip it from
 * `pathname` to land on the file path inside `dist/`.
 */
async function serveSpa(spaDistDir: string, pathname: string, mount: SpaMount): Promise<Response> {
  if (!existsSync(spaDistDir)) {
    return new Response(
      "hub SPA bundle not found — run `bun run build` in web/ui/ to produce dist/",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  // Strip the mount prefix; "/admin" → "", "/admin/" → "/", "/admin/x" → "/x".
  const sub = pathname === mount ? "" : pathname.slice(mount.length);
  const indexPath = join(spaDistDir, "index.html");

  // Empty / mount-root / any non-asset request → SPA shell. The router takes
  // it from there. First defense against traversal: bare paths and anything
  // containing ".." never enter the asset branch — they fall through to the
  // shell below.
  const looksLikeAsset = sub.length > 0 && /\.[a-z0-9]+$/i.test(sub) && !sub.includes("..");
  if (!looksLikeAsset) {
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const filePath = resolve(spaDistDir, `.${sub}`);
  // Second defense: even if a future tweak loosens looksLikeAsset, refuse
  // any resolved path that escapes dist/. Belt-and-braces.
  if (!filePath.startsWith(`${spaDistDir}/`)) {
    return new Response("not found", { status: 404 });
  }
  if (!existsSync(filePath)) {
    // Asset request that doesn't resolve to a real file → SPA shell.
    // (e.g. `/vault/foo` with a typo'd extension shouldn't 404 the page.)
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response(Bun.file(filePath), {
    headers: { "content-type": spaContentType(filePath) },
  });
}

/**
 * Routes that fall through the pre-admin lockout (503 → /admin/setup).
 *
 * Gated (operator-facing) when no admin row exists:
 *   - `/admin/*` (except `/admin/setup*`) — vault admin, permissions, tokens
 *   - `/api/*`                            — host-admin API surface
 *   - `/login`, `/logout`                 — pointless without an account
 *
 * Open through the gate (so the container is reachable and discoverable
 * the moment it boots, even before an admin is seeded):
 *   - `/health`                           — platform liveness check
 *   - `/.well-known/*`                    — public discovery + JWKS
 *   - `/admin/setup`, `/admin/setup/*`    — the first-boot wizard (hub#259)
 *                                            and its POST endpoints; the
 *                                            wizard is the *only* browser
 *                                            path to exit the lockout
 *   - `/` and `/hub.html`                 — static discovery page
 *   - `/oauth/*`                          — third-party OAuth surface; clients
 *                                            can register/refresh independent
 *                                            of admin onboarding
 *   - `/vault/*`, `/<service>/*`          — content proxies; service-level auth
 *                                            handles its own failure modes
 *
 * The function is called only when an admin row is missing; in the
 * normal-running case (any admin row exists) this gate is a no-op and the
 * regular dispatch continues.
 */
function shouldGateForSetup(pathname: string): boolean {
  // Invite redemption (`/account/setup/<token>`) is an un-authed onboarding
  // surface like the wizard — it must pass through the pre-admin lockout so a
  // recipient can claim an invite. (In practice invites can only be issued
  // after an admin exists, so the no-admin lockout rarely coincides; the
  // explicit pass-through keeps the surface's posture clear + matches the
  // wizard's `/admin/setup/*` exemption.)
  if (pathname === "/account/setup" || pathname.startsWith("/account/setup/")) return false;
  if (pathname === "/login" || pathname === "/logout") return true;
  // The wizard itself + its POST endpoints are the *only* way to exit
  // the pre-admin lockout from a browser — they must pass through. Any
  // path under `/admin/setup` (including `/admin/setup/account` and
  // `/admin/setup/vault`) is fair game for an un-authed operator on a
  // fresh hub.
  if (pathname === "/admin/setup" || pathname.startsWith("/admin/setup/")) return false;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return true;
  if (pathname.startsWith("/api/")) return true;
  return false;
}

// hub#259 replaced the static placeholder with a real three-step wizard.
// The handlers (account creation + vault provisioning) live in
// `src/setup-wizard.ts` so the dispatch in this file stays a one-liner per
// route. The env-var seed path (PARACHUTE_INITIAL_ADMIN_*) still works on
// first boot — see `src/commands/serve.ts` — and is surfaced as the
// "alt-path" disclosure on the wizard's welcome screen.

// Canonical 503 body for "getDb is unset, hub is unconfigured." Shape matches
// the OAuth error vocabulary used by /api/auth/* (`service_unavailable`) so a
// consumer never has to branch on content-type to extract a message. See
// hub#227 for the migration from plain-text bodies.
function dbNotConfigured(): Response {
  return Response.json(
    { error: "service_unavailable", error_description: "hub db not configured" },
    { status: 503 },
  );
}

/**
 * Read the exposed public origin off `expose-state.json` for the issuer
 * fallback, guarded to a non-loopback http(s) origin and malformed-safe.
 * Returns undefined when no exposure is recorded, the file is corrupt, or
 * the recorded origin is loopback / not an http(s) URL (a loopback value
 * here would re-pin the degraded request-origin mode — expose-state should
 * never carry one, but we defend anyway). This is the seam the launchd /
 * systemd reboot path leans on: those units carry no `PARACHUTE_HUB_ORIGIN`,
 * so without it the hub boots issuer-less and stamps `iss` from the
 * per-request origin, which exposed resource servers (vault) reject.
 *
 * The `readExpose()` call is itself wrapped in try/catch so ANY reader —
 * the default OR an injected one — that throws yields undefined rather than
 * propagating into the request path. The default reader self-wraps too, but
 * the seam must not depend on that: a future caller passing a non-swallowing
 * reader still can't 500 the hub. Origin sanitization is delegated to the
 * shared `sanitizePublicOrigin` helper (strips trailing slashes, validates
 * http(s), rejects loopback), kept identical with resolveStartupIssuer (#531).
 */
export function exposeIssuerOrigin(
  readExpose: () => string | undefined = defaultExposeHubOriginRead,
): string | undefined {
  let raw: string | undefined;
  try {
    raw = readExpose();
  } catch {
    return undefined;
  }
  return sanitizePublicOrigin(raw);
}

function defaultExposeHubOriginRead(): string | undefined {
  try {
    return readExposeState()?.hubOrigin;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the OAuth issuer URL for this request. Precedence, highest
 * first (hub#298, expose tier added #531):
 *
 *   1. `hub_settings.hub_origin` — operator-set canonical URL from the
 *      admin SPA. Wins when present.
 *   2. `configuredIssuer` — `--issuer` flag or `PARACHUTE_HUB_ORIGIN`
 *      env var captured at hub start. The deploy-time setting.
 *   3. `expose-state.json`'s `hubOrigin` — the canonical public origin a
 *      live tailscale/cloudflare exposure recorded. Load-bearing for the
 *      reboot-persistent owner-operated path: the launchd plist / systemd
 *      unit carries no `PARACHUTE_HUB_ORIGIN`, so a hub booted off it has
 *      no `configuredIssuer` and would otherwise stamp `iss` from the
 *      per-request origin — which exposed resource servers (vault) reject
 *      with `unexpected "iss" claim value` until they restart. Reading the
 *      exposed origin off disk closes that. Guarded non-loopback http(s)
 *      (see `exposeIssuerOrigin`).
 *   4. `new URL(req.url).origin` — the request's own origin. Local dev
 *      + Render-assigned subdomains land here when nothing's been
 *      configured.
 *
 * Per-request (not cached at hub start) so a PUT to
 * `/api/settings/hub-origin` takes effect on the next request without a
 * restart. Both the hub_settings read and the expose-state read are cheap
 * (a small SQLite query / a small JSON parse) relative to JWT signing on
 * the same request path — and the expose read is per-request so an operator
 * who runs `parachute expose` while the hub is up gets the new origin on the
 * next request without a restart.
 *
 * `db` is optional because the wellknown / discovery surfaces are
 * reachable on a hub with no DB configured (the dbNotConfigured 503
 * gate sits behind these in the dispatcher). In that case we skip the
 * settings layer and fall through to env/expose/request precedence.
 *
 * `readExpose` is injectable so tests exercise the expose tier without
 * touching the real `~/.parachute`.
 */
export function resolveIssuer(
  req: Request,
  db: Database | undefined,
  configuredIssuer: string | undefined,
  readExpose: () => string | undefined = defaultExposeHubOriginRead,
): string {
  if (db !== undefined) {
    const stored = getHubOrigin(db);
    if (stored) return stored;
  }
  if (configuredIssuer) return configuredIssuer;
  const exposed = exposeIssuerOrigin(readExpose);
  if (exposed) return exposed;
  // Reverse-proxy aware: Render / Tailscale Funnel / cloudflared terminate
  // TLS at the edge and forward plain HTTP to hub. Without X-Forwarded-Proto
  // honoring, `req.url.origin` is `http://...` and hub publishes mixed-content
  // URLs in OAuth discovery (`registration_endpoint`, `authorization_endpoint`,
  // etc.) — browsers block them when the page itself loaded over https://.
  // The `isHttpsRequest` helper is the canonical place where this trust
  // is established (also used for the Secure cookie attribute).
  //
  // We do NOT honor X-Forwarded-Host *for hub's own issuer derivation*.
  // (Note: hub DOES forward X-Forwarded-Host to upstream supervised
  // modules in `proxyRequest` — that's a separate concern, see #358.
  // Here we're deriving hub's own canonical origin from the incoming
  // request, not what to tell downstream services.) Render, Tailscale
  // Funnel, and cloudflared all preserve the Host header end-to-end,
  // so `req.url`'s host already reflects the public hostname.
  // Operators on a proxy that rewrites Host (some nginx / Caddy
  // configs) should set hub_origin via the admin SPA — that path
  // bypasses this fallback entirely.
  const url = new URL(req.url);
  if (isHttpsRequest(req)) {
    url.protocol = "https:";
  }
  return url.origin;
}

/**
 * Where did the resolved issuer come from? Drives the source-label
 * surfaced in the admin SPA so operators can tell which precedence
 * layer they're on without inspecting the DB or env. Mirrors the
 * precedence in `resolveIssuer` exactly — settings > env > expose >
 * request — so the attribution can't drift from the resolved value.
 */
export type IssuerSource = "settings" | "env" | "expose" | "request";

export function resolveIssuerSource(
  db: Database | undefined,
  configuredIssuer: string | undefined,
  readExpose: () => string | undefined = defaultExposeHubOriginRead,
): IssuerSource {
  if (db !== undefined && getHubOrigin(db)) return "settings";
  if (configuredIssuer) return "env";
  if (exposeIssuerOrigin(readExpose)) return "expose";
  return "request";
}

/**
 * Minimal structural type for the Bun `Server` handle the fetch callback
 * receives as its 2nd argument. We need `requestIP` (item E / #526) to
 * resolve the peer address for `layerOf`, and `upgrade` (H1) to hand a
 * gated WebSocket upgrade to the bridge. Typed structurally (rather than
 * importing Bun's full `Server`) so tests can pass a tiny fake and so the
 * signature stays robust to Bun type-shape churn. Optional in the callback
 * because a direct unit call to the returned fetch fn may omit it — in which
 * case `peerAddr` is null and `layerOf` fails closed to `public`, and a
 * WebSocket upgrade is refused (503 — no server to upgrade on).
 */
interface PeerIpResolver {
  requestIP(req: Request): { address: string } | null;
  /**
   * Bun `Server.upgrade` — present on the real server, optional on fakes.
   * Typed with the bridge's data payload (Bun's own signature takes
   * `data: unknown`; method bivariance keeps the real Server assignable).
   */
  upgrade?(req: Request, options: { data: WsBridgeData }): boolean;
}

/**
 * True when the request is a WebSocket upgrade. The `Upgrade` header is the
 * discriminator (RFC 6455 §4.1 requires it; Bun's `server.upgrade` re-checks
 * the full handshake — key, version, Connection token — so this only needs
 * to be a cheap router predicate, not a validator).
 */
export function isWebSocketUpgrade(req: Request): boolean {
  return (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/**
 * Hop-by-hop + WS-handshake headers never forwarded on the upstream connect:
 * the Bun WebSocket client re-mints its own handshake (key/version/
 * extensions), and forwarding the originals would corrupt it.
 */
const WS_HOP_BY_HOP_HEADERS = [
  "host",
  "connection",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
  // Subprotocol negotiation is NOT forwarded in v1 (see ws-bridge.ts header).
  "sec-websocket-protocol",
] as const;

/** The verdict of {@link maybeUpgradeWebSocket}. */
type WsUpgradeVerdict =
  | { kind: "upgraded" }
  | { kind: "response"; response: Response }
  | { kind: "pass" };

/**
 * H1 — the WebSocket upgrade bridge's routing + gating half (the frame
 * piping lives in `src/ws-bridge.ts`).
 *
 * For an `Upgrade: websocket` request:
 *
 *   1. Resolve the service mount (generic longest-prefix, then vault mounts —
 *      same resolution as the HTTP proxies). No mount → `pass` (normal
 *      dispatch 404s / handles it).
 *   2. Gate BEFORE upgrading — same posture as the HTTP path:
 *      `publicExposure: "loopback"` cloak (404, indistinguishable from
 *      not-installed) and the per-UI audience gate (H3).
 *   3. Capability check, DENY BY DEFAULT: the module must declare
 *      `websocket: true` on its services.json row OR its
 *      `.parachute/module.json`. No declaration → 426 (the route exists but
 *      doesn't speak WebSocket; the fetch-based proxy can't forward upgrades
 *      and the daemon never sees the request).
 *   4. Connection caps (hub#649): per-client-IP + total concurrent caps,
 *      checked-and-acquired in the same synchronous block as the upgrade
 *      (no await between check and commit). Over-cap → generic 429 (no
 *      count leakage; the hub log carries which cap + bucket), refused
 *      BEFORE `server.upgrade()` commits a socket or the bridge dials the
 *      upstream. Keying + trust model: {@link wsCapBucketKey}; defaults +
 *      env overrides: `ws-connection-caps.ts`. Release rides the bridge's
 *      close handler via `data.releaseCap`.
 *   5. `server.upgrade(req, { data })` with the upstream URL + headers
 *      (client headers minus hop-by-hop/handshake, plus the H2 substrate
 *      trust stamps). The ws-bridge handlers take over from there.
 */
async function maybeUpgradeWebSocket(
  req: Request,
  server: PeerIpResolver | undefined,
  deps: {
    manifestPath: string;
    peerAddr: string | null;
    readModuleManifestFn: (installDir: string) => Promise<ModuleManifest | null>;
    /** H3 — gate the upgrade on the mount's audience BEFORE upgrading. */
    gateAudience?: (pathname: string) => Promise<Response | null>;
    /** hub#649 — per-IP + total connection-cap accounting. */
    wsConnectionTracker: WsConnectionTracker;
  },
): Promise<WsUpgradeVerdict> {
  const services = readManifestLenient(deps.manifestPath).services;
  const url = new URL(req.url);
  const match =
    findServiceUpstream(services, url.pathname) ?? findVaultUpstream(services, url.pathname);
  if (!match) return { kind: "pass" };

  // Layer cloak first — a loopback-only module must look not-installed from
  // tailnet/public, for upgrades exactly as for HTTP.
  if (
    effectivePublicExposure(match.entry) === "loopback" &&
    layerOf(req, deps.peerAddr) !== "loopback"
  ) {
    return { kind: "response", response: new Response("not found", { status: 404 }) };
  }

  // Audience gate (H3) — runs BEFORE the upgrade so an unauthorized client
  // never gets a socket. Threaded from dispatch (needs db + issuer).
  if (deps.gateAudience) {
    const gated = await deps.gateAudience(url.pathname);
    if (gated) return { kind: "response", response: gated };
  }

  // Capability — deny by default. services.json row wins; module.json is the
  // canonical declaration source for modules that haven't re-registered yet.
  let declared = match.entry.websocket === true;
  if (!declared && match.entry.installDir) {
    try {
      const manifest = await deps.readModuleManifestFn(match.entry.installDir);
      declared = manifest?.websocket === true;
    } catch {
      declared = false; // malformed manifest → deny (fail closed)
    }
  }
  if (!declared) {
    return {
      kind: "response",
      response: new Response(
        JSON.stringify({
          error: "websocket_not_supported",
          error_description: `module "${match.entry.name}" does not declare WebSocket support`,
        }),
        { status: 426, headers: { "content-type": "application/json", upgrade: "websocket" } },
      ),
    };
  }

  if (!server?.upgrade) {
    return {
      kind: "response",
      response: new Response(
        JSON.stringify({
          error: "service_unavailable",
          error_description: "websocket upgrade unavailable on this server",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    };
  }

  // Upstream URL — same path semantics as the HTTP proxy (stripPrefix honored).
  const stripPrefix = stripPrefixFor(match.entry);
  const targetPath = stripPrefix ? url.pathname.slice(match.mount.length) || "/" : url.pathname;
  const upstreamUrl = `ws://127.0.0.1:${match.port}${targetPath}${url.search}`;

  // Upstream headers: the client's own (cookie / authorization ride through
  // so the daemon authenticates the connection) minus hop-by-hop + handshake
  // headers, plus the H2 substrate trust stamps.
  const headers = new Headers(req.headers);
  for (const h of WS_HOP_BY_HOP_HEADERS) headers.delete(h);
  stampSubstrateTrustHeaders(headers, req, deps.peerAddr);
  const upstreamHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    upstreamHeaders[key] = value;
  });

  // Connection caps (hub#649) — the LAST gate, synchronous with the upgrade
  // itself (everything between here and `server.upgrade` must stay
  // await-free so the check can't race the commit). Last on purpose: the
  // earlier refusals keep their precise statuses (the 404 cloak stays
  // indistinguishable from not-installed even under cap pressure), and the
  // counters only ever hold slots for connections that would actually
  // bridge.
  const capKey = wsCapBucketKey(req, deps.peerAddr);
  const acquired = deps.wsConnectionTracker.tryAcquire(capKey);
  if (!acquired.ok) {
    // Operator-facing pressure signal: which cap, which bucket, how full.
    // None of this reaches the client — the 429 body is deliberately
    // generic (no counts, no cap identity).
    console.warn(
      `[ws-caps] refused upgrade for ${url.pathname}: ${
        acquired.reason === "per_ip_cap" ? `per-IP cap (ip=${capKey})` : `total cap (ip=${capKey})`
      }; total=${deps.wsConnectionTracker.totalCount} ip_count=${deps.wsConnectionTracker.countFor(
        capKey,
      )}`,
    );
    return {
      kind: "response",
      response: new Response(
        JSON.stringify({
          error: "too_many_connections",
          error_description: "WebSocket connection limit reached; try again later",
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    };
  }

  const upgraded = server.upgrade(req, {
    data: { upstreamUrl, upstreamHeaders, releaseCap: acquired.release },
  });
  if (upgraded) return { kind: "upgraded" };
  // No socket was created, so the bridge's close handler will never fire —
  // release the slot inline (the closure latches, so this can't double-count
  // against a later close).
  acquired.release();
  return {
    kind: "response",
    response: new Response(
      JSON.stringify({
        error: "upgrade_failed",
        error_description: "WebSocket handshake was malformed or could not be completed",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    ),
  };
}

/**
 * Per-request force-change-password gate (P0-1 / hub#469).
 *
 * Before #469, `password_changed === false` only triggered a redirect at the
 * `/login` step. A signed-in user handed an admin-set temp password could then
 * navigate DIRECTLY to `/account/`, `/account/vault-token/<name>`, a vault-admin
 * deep-link, or any per-vault proxy URL and operate INDEFINITELY on the
 * un-rotated secret. Invites = temp-credential handoff at scale, so that gap
 * scales with every invited user. This makes the gate per-request.
 *
 * Returns a 302/403 Response when the request must be bounced; `null` when the
 * request may proceed (no session, password already rotated, or — for callers
 * that pre-check — an exempt path). Resolution is a single session→user lookup,
 * mirroring the per-route gates in `account-vault-{token,admin-token}.ts` so we
 * don't add a second DB read on those paths (they keep their own gate; this is
 * the broad net for everything else under `/account/*` + the vault proxy).
 *
 * EXEMPT (NOT gated — the rotation/exit path; callers must route these BEFORE
 * invoking this gate): `/account/change-password` (GET+POST) and `/logout`.
 * Everything else under `/account/*`, the per-vault `/vault/<name>/*` proxy,
 * and the session-backed `/oauth/authorize` consent path is gated. The decision
 * is deliberate: a pre-rotation user can ONLY rotate or sign out — no vault
 * reads, no token mints, no account home, and no OAuth authorize → auth code →
 * `/oauth/token` exchange for a vault-scoped access token.
 *
 * Browser GETs (Accept: text/html) get a 302 to `/account/change-password`;
 * non-GET and API-style requests get a 403 with the same JSON error shape the
 * per-route mints use, so a scripted client gets a clear machine-readable
 * refusal rather than an HTML redirect it can't follow.
 */
export function forceChangePasswordGate(db: Database, req: Request): Response | null {
  const session = findActiveSession(db, req);
  if (!session) return null; // unauthenticated → downstream handler decides (401/login)
  const user = getUserById(db, session.userId);
  if (!user || user.passwordChanged) return null; // rotated (or vanished) → proceed

  const wantsHtml = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml) {
    return new Response(null, {
      status: 302,
      headers: { location: "/account/change-password", "cache-control": "no-store" },
    });
  }
  return new Response(
    JSON.stringify({
      error: "force_change_password",
      error_description:
        "You must change your temporary password before using this surface. Visit /account/change-password.",
    }),
    {
      status: 403,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    },
  );
}

export function hubFetch(
  wellKnownDir: string,
  deps?: HubFetchDeps,
): (req: Request, server?: PeerIpResolver) => Response | Promise<Response> {
  const hubHtmlPath = join(wellKnownDir, "hub.html");
  const getDb = deps?.getDb;
  const configuredIssuer = deps?.issuer;
  const manifestPath = deps?.manifestPath ?? SERVICES_MANIFEST_PATH;
  const gitRoot = deps?.gitRoot ?? join(CONFIG_DIR, "hub", "git");
  const spaDistDir = deps?.spaDistDir ?? defaultSpaDistDir();
  const loopbackPort = deps?.loopbackPort;
  const loadExposeHubOrigin =
    deps?.loadExposeHubOrigin ??
    (() => {
      try {
        return readExposeState()?.hubOrigin;
      } catch {
        // Malformed expose-state.json shouldn't 500 hub on every same-origin
        // check — the issuer + loopback already cover legitimate access.
        return undefined;
      }
    });

  const oauthDeps = (req: Request) => {
    const issuer = resolveIssuer(req, getDb?.(), configuredIssuer, loadExposeHubOrigin);
    return {
      issuer,
      // Per-request resolution (closes #245): expose-state.json can change
      // mid-session (operator runs `parachute expose tailnet` while hub is
      // up), so we re-read the bound origins on each call rather than
      // capturing at hub start. Cheap — a single small JSON parse per OAuth
      // request, only on the cookie-POST paths that consult it.
      hubBoundOrigins: () =>
        buildHubBoundOrigins({
          issuer,
          loopbackPort,
          exposeHubOrigin: loadExposeHubOrigin(),
          // Trust the platform-injected public URL independently of the
          // configured issuer. On Render, an operator who set hub_origin
          // via the admin SPA (or via a stale db row) to a non-public URL
          // would otherwise reject legitimate browser POSTs that arrive
          // with the public Render URL as Origin. Same defense on Fly:
          // the public <app>.fly.dev URL is the canonical Origin for
          // browser POSTs and must be trusted even when the operator's
          // configured issuer points elsewhere. See origin-check.ts
          // jsdoc for the failure case this closes.
          platformOrigin: process.env.RENDER_EXTERNAL_URL ?? flyDefaultOrigin(process.env),
        }),
    };
  };

  return async (req, server) => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Resolve the peer address ONCE per request (item E / #526). Bun's
    // `requestIP` lives on the Server handle, not the Request. It's the
    // loopback discriminator for `layerOf` on the loopback-exposure cloak —
    // a header-absent non-loopback peer must NOT be treated as loopback.
    // `server` is absent when a unit test calls this fn directly; `peerAddr`
    // is then null and `layerOf` fails closed to `public`.
    const peerAddr = server?.requestIP(req)?.address ?? null;

    // Self-heal-or-die wrapper (#594). Any DB throw that escapes a route
    // handler lands here. A persistent-corruption error (disk I/O error /
    // malformed image — the state-dir-deleted-under-a-running-hub class)
    // triggers ONE reopen attempt via `onDbError`; if reopen fails the holder
    // exits the process so the platform manager restarts with a fresh handle.
    // The CALLER (this catch) shapes the HTTP response so the operator/CLI see
    // a structured cause instead of a bare bodyless 500 ("HTTP 500 with no
    // error detail"). A transient SQLITE_BUSY is classified non-fatal and just
    // surfaces a 503 the next request clears — it never kills the hub.
    try {
      // H1 — WebSocket upgrade bridge. Runs before normal dispatch: an
      // `Upgrade: websocket` request targeting a declared service mount is
      // gated (publicExposure cloak + audience gate) and, if it passes,
      // upgraded into the Bun-native bridge (src/ws-bridge.ts) instead of
      // the fetch-based proxy (which cannot forward upgrades). Upgrade
      // requests that match no service mount fall through to normal dispatch
      // unchanged — no hub-owned route speaks WebSocket.
      if (isWebSocketUpgrade(req)) {
        const verdict = await maybeUpgradeWebSocket(req, server, {
          manifestPath,
          peerAddr,
          readModuleManifestFn: deps?.readModuleManifest ?? defaultReadModuleManifest,
          wsConnectionTracker: deps?.wsConnectionTracker ?? defaultWsConnectionTracker,
          // H3 — the audience gate runs BEFORE the upgrade, same posture as
          // the HTTP dispatch below: a WS endpoint under a hub-users surface
          // never hands a socket to an anonymous caller, while `surface`
          // audiences pass through (the backed surface authenticates the
          // socket itself — e.g. the docs editor's collab WS rides this).
          // (The publicExposure cloak already ran inside
          // maybeUpgradeWebSocket before this hook.)
          gateAudience: async (wsPathname) => {
            const wsUiMatch = resolveUiMount(
              readManifestLenient(manifestPath).services,
              wsPathname,
            );
            if (!wsUiMatch) return null;
            return gateUiAudience(req, wsUiMatch.audience, wsUiMatch.ui, {
              db: getDb?.(),
              knownIssuers: () => oauthDeps(req).hubBoundOrigins(),
            });
          },
        });
        if (verdict.kind === "upgraded") {
          // Bun's contract after a successful `server.upgrade()` is to
          // return undefined from fetch — the socket now belongs to the
          // websocket handlers. The public signature stays Response-typed
          // for the many direct (non-WS) call sites; this cast is the one
          // deliberate exception, observed only by Bun's runtime.
          return undefined as unknown as Response;
        }
        if (verdict.kind === "response") return verdict.response;
        // kind === "pass" — fall through to normal dispatch.
      }
      return await dispatch();
    } catch (err) {
      const klass = classifyDbError(err);
      if (klass === "other") throw err; // not a DB-handle failure — let it propagate
      const verdict = deps?.onDbError?.(err) ?? "ignored";
      const detail = err instanceof Error ? err.message : String(err);
      // 503 (not bare 500): the fault is transient-from-the-client's-view —
      // either the handle was just reopened (`healed`) or it's a momentary
      // lock (`ignored`/transient); a retry is the right next move. `exited` is
      // only reachable in tests (production has exited the process). All carry
      // a structured body so the CLI's `asErrorBody` prints the real cause
      // instead of "HTTP 500 with no error detail" (#594 part 3).
      return new Response(
        JSON.stringify({
          error: "db_unavailable",
          error_description:
            verdict === "healed"
              ? `hub database handle was reopened after a fault (${detail}); retry the request.`
              : `hub database error (${klass}): ${detail}`,
        }),
        {
          status: 503,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        },
      );
    }

    async function dispatch(): Promise<Response> {
      // 301 back-compat for the pre-hub#231 admin-SPA mounts:
      //
      //   `/vault`, `/vault/new` → `/vault/admin/` (vault's own daemon-level
      //                        admin surface — B5, 2026-06-09 hub-module-
      //                        boundary migration. These pointed at
      //                        `/admin/vaults[/new]` until B5; with the
      //                        list+create UX module-owned, pointing DIRECTLY
      //                        at the target avoids a redirect → SPA-load →
      //                        client-side-forward chain)
      //   `/hub/vaults*`      → `/admin/vaults*` (this redirect predates #231;
      //                        /admin/vaults survives as the feature-detected
      //                        legacy list, so the target stays valid on both
      //                        old-vault and new-vault boxes)
      //   `/hub/permissions`  → `/admin/permissions`
      //   `/hub/tokens`       → `/admin/tokens`
      //   `/hub` (bare)       → `/admin/vaults`
      //
      // Permanent redirect so cached operator URLs keep working without
      // leaving dangling SPA routes. Query string preserved; fragment is
      // client-side and survives the redirect at the browser. Method-agnostic
      // — even a misrouted POST gets the redirect; none of these paths host a
      // POST endpoint to protect.
      //
      // `/vault/<name>/*` is INTENTIONALLY excluded — that's the per-vault
      // content proxy (Notes PWA, etc.), not the admin SPA. The exact-match
      // condition here also never touches `/vault/admin*` — the daemon-level
      // mount dispatched further down.
      if (pathname === "/vault" || pathname === "/vault/" || pathname === "/vault/new") {
        return new Response("", {
          status: 301,
          headers: { location: `/vault/admin/${url.search}` },
        });
      }
      if (pathname === "/hub/vaults" || pathname.startsWith("/hub/vaults/")) {
        const newPath = `/admin/vaults${pathname.slice("/hub/vaults".length)}`;
        return new Response("", {
          status: 301,
          headers: { location: `${newPath}${url.search}` },
        });
      }
      if (pathname === "/hub/permissions") {
        return new Response("", {
          status: 301,
          headers: { location: `/admin/permissions${url.search}` },
        });
      }
      if (pathname === "/hub/tokens") {
        return new Response("", {
          status: 301,
          headers: { location: `/admin/tokens${url.search}` },
        });
      }
      if (pathname === "/hub" || pathname === "/hub/") {
        return new Response("", {
          status: 301,
          headers: { location: `/admin/vaults${url.search}` },
        });
      }

      // Login surface rename: `/admin/login` and `/admin/logout` 301 to the
      // canonical `/login` and `/logout`. The names were "admin" only by
      // historical accident — the handlers serve every parachute auth flow
      // (operator, OAuth user-redirect, future SPA sign-in). Renaming makes
      // the surface name match its actual scope.
      if (pathname === "/admin/login") {
        return new Response("", {
          status: 301,
          headers: { location: `/login${url.search}` },
        });
      }
      if (pathname === "/admin/logout") {
        return new Response("", {
          status: 301,
          headers: { location: `/logout${url.search}` },
        });
      }

      // Notes-as-app migration Phase 2 (parachute-app design doc §16).
      // `/notes/*` 301-redirects to `/surface/notes/*` so legacy bookmarks land on
      // the apps-hosted Notes. Default-on; operators on notes-as-module-only
      // installs can opt out via `hub_settings.notes_redirect_disabled = true`
      // (see hub-settings.ts). The opt-out exists so a legacy operator
      // doesn't hit redirect → 404 in the deprecation window. Phase 3
      // (parachute-notes v0.5) retires this redirect entirely.
      //
      // Method-agnostic — same shape as the other back-compat 301s above.
      // The browser re-issues GET on the new URL per RFC 7231 (a POST won't
      // round-trip its body, but no /notes/* path hosts a POST endpoint
      // worth preserving — the Notes PWA is read-write against vault, not
      // against the hub mount itself).
      //
      // Lazy DB read: only consult `getDb` when the path actually matches a
      // legacy notes prefix — every non-notes request must NOT touch the DB
      // here (some tests + the /health route assert getDb is never called).
      if (isLegacyNotesPath(pathname)) {
        const notesRedirect = maybeRedirectNotes(pathname, url.search, getDb?.());
        if (notesRedirect !== undefined) {
          logNotesRedirect(pathname, notesRedirect);
          return new Response("", {
            status: 301,
            headers: { location: notesRedirect },
          });
        }
      }

      // `/channel/*` 301-redirects to `/agent/*` — back-compat for the
      // 2026-06-17 channel→agent module rename. Operator bookmarks, an
      // un-upgraded chat/config UI's deep links, and any externally-shared
      // `/channel/mcp/<name>` URL keep resolving for one release cycle while
      // the module's canonical mount moves to `/agent`. Method-agnostic, same
      // shape as the `/notes/*` redirect above (the agent's read-write surface
      // is its own daemon API, not the hub mount, so a re-issued GET is fine).
      // Matches `/channel` exactly and any `/channel/...` subpath, but NOT a
      // longer-prefix module like a hypothetical `/channelthing` — the guard is
      // exact-or-slash-delimited. Query string is preserved. (The generic
      // services-proxy fallthrough below would otherwise 404 a `/channel/*`
      // request once the module self-registers under `/agent`.)
      if (pathname === "/channel" || pathname.startsWith("/channel/")) {
        const dest = new URL(req.url);
        dest.pathname = `/agent${pathname.slice("/channel".length)}`;
        return new Response("", {
          status: 301,
          headers: { location: dest.pathname + dest.search },
        });
      }

      // CORS preflight for the public OAuth + discovery surface. Browsers
      // issue OPTIONS before any non-simple cross-origin request — third-party
      // SPAs hitting `/oauth/register` (RFC 7591 DCR), `/oauth/token`,
      // `/.well-known/oauth-authorization-server`, etc. Handling this above
      // the route table means an OPTIONS to e.g. `/oauth/register` doesn't
      // hit the method-not-allowed branch in the handler — the preflight is a
      // CORS-protocol artifact, not a "real" request to the endpoint. The
      // single `isCorsAllowedRoute` predicate is the source of truth for
      // which paths carry wildcard-CORS; see `src/cors.ts` for the rationale.
      // Out-of-scope paths (`/api/*`, `/admin/*`, `/login`, `/account/*`,
      // `/vault/*`, generic service proxy) fall through and OPTIONS reaches
      // whatever default the downstream handler enforces (typically 405).
      if (req.method === "OPTIONS" && isCorsAllowedRoute(pathname)) {
        return corsPreflightResponse(req);
      }

      // Platform health check (Render, Fly, Kubernetes, etc.). Plain JSON.
      // Always 200 while the process is up — the HTTP status reports process
      // liveness, not DB readiness, so a transient DB blip never turns into a
      // platform-side restart loop. The `db` field (#594) carries the cheap
      // `SELECT 1` verdict ("ok" / "error: <class>") so monitoring, `parachute
      // status`, and the #590/#591 adoption probe can distinguish "hub up" from
      // "hub up but its database is gone" (the dead-handle field repro: green
      // /health while every DB route 500s). The probe NEVER throws — a thrown
      // probe would make /health itself 500, defeating the point.
      if (pathname === "/health") {
        let db: "ok" | string = "unconfigured";
        if (getDb) {
          try {
            // PROACTIVE path check FIRST (#610): on Linux a wiped state dir
            // doesn't throw — the unlinked-but-open ghost inode keeps SELECT 1
            // succeeding, so `probeDbLiveness` alone would report `db:"ok"` on a
            // database that's gone from disk (the /health lie the issue calls
            // out). `probeDbPath` stat()s the path + compares inodes; on a
            // "replaced" verdict it self-heals in-place (reopen-or-exit, adopt
            // the new inode); on a "gone" verdict it exits the process directly
            // (#621 — a full wipe needs a clean platform-manager restart, not an
            // empty-db reopen). Either way we surface the fault so the #591
            // adoption probe + monitoring see it.
            const pathVerdict = deps?.probeDbPath?.();
            if (pathVerdict === "gone" || pathVerdict === "replaced") {
              // One-request anomaly on "replaced": probeDbPath already healed the
              // handle synchronously, but THIS request still reports the fault
              // (the next /health reads `db:"ok"`). Intentional — we surface that
              // a heal just occurred rather than masking it. Safe because #591's
              // adoption probe gates on HTTP 200 (`res.ok`), not the `db` string,
              // so a single transient error string can't cascade. ("gone" exits
              // the process, usually before this response is even sent.)
              db = `error: path-${pathVerdict}`;
            } else {
              db = probeDbLiveness(getDb());
            }
          } catch {
            // getDb() itself threw (e.g. openHubDb failed) — report it as an
            // error class without letting /health 500.
            db = "error: other";
          }
        }
        return new Response(
          JSON.stringify({ status: "ok", service: "parachute-hub", version: pkg.version, db }),
          {
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          },
        );
      }

      // Boot-readiness probe (hub#443). Used by the transient-state proxy
      // error page's inline poll script to detect when a still-booting
      // module has come up. Public + DB-free so it works during the pre-
      // admin lockout (the page that polls it is itself served pre-auth).
      if (pathname === "/api/ready") {
        const readyDeps: Parameters<typeof handleApiReady>[1] = {};
        if (deps?.supervisor !== undefined) readyDeps.supervisor = deps.supervisor;
        return handleApiReady(req, readyDeps);
      }

      // First-boot setup wizard (hub#259). Three steps server-rendered:
      //   GET  /admin/setup            — derive state, render the right step
      //   POST /admin/setup/account    — create the admin row, set session
      //   POST /admin/setup/vault      — provision the first vault
      //
      // The wizard owns the "should I 301 to /login now?" decision: setup is
      // complete only when admin AND a vault entry both exist. A re-visit
      // after partial setup picks up at the next step. See
      // src/setup-wizard.ts for the renderer + handler internals.
      if (pathname === "/admin/setup" || pathname.startsWith("/admin/setup/")) {
        if (!getDb) return dbNotConfigured();
        const wizardDeps: SetupWizardDeps = {
          db: getDb(),
          manifestPath,
          configDir: CONFIG_DIR,
          issuer: oauthDeps(req).issuer,
          registry: getDefaultOperationsRegistry(),
          // hub#576: a loopback peer (the on-box operator's own shell) is allowed
          // to read the actual bootstrap token from the GET /admin/setup JSON
          // probe. `layerOf` fails closed to non-loopback when peerAddr is
          // unknown, so a header-less caller never gets the token.
          requestIsLoopback: layerOf(req, peerAddr) === "loopback",
        };
        if (deps?.supervisor !== undefined) wizardDeps.supervisor = deps.supervisor;
        if (pathname === "/admin/setup") {
          if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
          return handleSetupGet(req, wizardDeps);
        }
        if (pathname === "/admin/setup/account") {
          if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
          return handleSetupAccountPost(req, wizardDeps);
        }
        if (pathname === "/admin/setup/vault") {
          if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
          return handleSetupVaultPost(req, wizardDeps);
        }
        if (pathname === "/admin/setup/expose") {
          if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
          return handleSetupExposePost(req, wizardDeps);
        }
        // hub#272 Item B: post-wizard direct module-install POSTs from
        // the done-screen "What's next?" tiles. Path shape is
        // `/admin/setup/install/<short>`; the handler rejects on
        // unknown shorts, on `vault` (the wizard's own step owns that),
        // and on missing session/CSRF — same gates as the vault POST.
        if (pathname.startsWith("/admin/setup/install/")) {
          if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
          const short = pathname.slice("/admin/setup/install/".length);
          return handleSetupInstallPost(req, short, wizardDeps);
        }
        return new Response("not found", { status: 404 });
      }

      // Fresh-hub redirect: when the wizard still has work to do, the
      // discovery page (`/`, `/hub.html`) funnels straight to it. Two
      // wizard-mode conditions trigger the redirect:
      //
      //   1. No admin row exists (the original fresh-deploy case). The
      //      static portal carries no usable signal — no installed
      //      services to discover, no admin to sign in as.
      //   2. Admin exists but no vault is installed (env-seed deploys
      //      where the operator baked admin into env vars but hasn't
      //      walked the wizard's vault step). Pre-fix, env-seeded
      //      operators bounced past the wizard entirely and had to
      //      hand-find /admin/modules + /admin/vaults; surface
      //      "let me finish the wizard" instead.
      //
      // The wizard's GET handler already picks the right step
      // (`deriveWizardState` resumes at vault step when admin exists +
      // no vault), so we just need the redirect to fire.
      //
      // 302 (not 301) so the redirect disappears the moment the wizard
      // finishes. Sits before the JSON-shaped 503 gate below because `/`
      // is an HTML surface — a JSON 503 there would render as raw text
      // in the operator's browser tab. The 503 gate handles API + admin
      // SPA + OAuth callers that branch on the structured body.
      if (getDb && (pathname === "/" || pathname === "/hub.html")) {
        const db = getDb();
        // Either condition triggers the wizard funnel:
        //   - no admin row (the fresh-deploy case)
        //   - admin row exists but no vault installed (env-seed case)
        // Short-circuit the manifest read when `noAdmin` is true; the
        // wizard's first step is admin creation regardless of vault state.
        const needsWizard = userCount(db) === 0 || !hasVaultInstalled(manifestPath);
        if (needsWizard) {
          return new Response(null, {
            status: 302,
            headers: { location: "/admin/setup" },
          });
        }
      }

      // Fresh-hub `/login` funnel (hub#644). `/login` is a browser-facing,
      // server-rendered HTML surface (the sign-in form) — but on a no-admin
      // box there is no account to sign in as, so the JSON-503 gate below
      // would render as raw `{"error":"setup_required",...}` text in the
      // visitor's tab. This is exactly the path a visitor takes when they
      // load an open module surface (e.g. /vault/admin/) and click its
      // "Sign in" banner, which links to `/login?next=<surface>`. Funnel the
      // GET to the wizard instead, mirroring the `/` + `/hub.html` redirect
      // above (same shape, same justification: never emit a JSON body on an
      // HTML surface). 302 (not 301) so it disappears the moment setup
      // completes and the real sign-in form takes over.
      //
      // Scoped to `userCount === 0` (the true no-admin state), NOT the
      // broader `needsWizard`: once an admin exists, that operator must be
      // able to reach the sign-in form even if no vault is installed yet
      // (env-seed deploys). Only GET is funneled — a POST to `/login`
      // pre-admin has no account to authenticate and falls through to the
      // JSON-503 gate, the right shape for a stray non-browser caller.
      //
      // The `?next=<surface>` param is intentionally dropped: there's no
      // account yet to return the visitor to, and the open surface they came
      // from likely can't function until setup completes. They land on the
      // wizard, not back on that surface.
      //
      // `cache-control: no-store` (the `/` + `/hub.html` funnel above omits
      // it) — this 302 reflects transient pre-setup state that flips the
      // moment an admin is created, so it must never be cached by a CDN or
      // bfcache and serve a stale "go finish setup" to a now-set-up hub.
      if (getDb && pathname === "/login" && req.method === "GET" && userCount(getDb()) === 0) {
        return new Response(null, {
          status: 302,
          headers: { location: "/admin/setup", "cache-control": "no-store" },
        });
      }

      // Pre-admin lockout. When the hub has booted with no admin row (the
      // fresh-container case before PARACHUTE_INITIAL_ADMIN_* is set or
      // /admin/setup is walked), every operator-facing surface that requires
      // identity is meaningless — auth flows can't validate, the SPA can't
      // mint a host-admin token, OAuth can't issue codes. Route those to a
      // 503 that points at /admin/setup. Health, well-known, /admin/setup
      // itself, OAuth third-party endpoints, and content proxies pass
      // through; the fresh-hub `/` and `/hub.html` redirect above handled
      // the discovery-page case.
      //
      // `shouldGateForSetup` runs first so non-gated paths (well-known, /,
      // /health, /admin/setup) never touch getDb — keeping the
      // existing OPTIONS-preflight contract that those routes are db-free.
      if (getDb && shouldGateForSetup(pathname) && userCount(getDb()) === 0) {
        return new Response(
          JSON.stringify({
            error: "setup_required",
            error_description:
              "no admin configured. Visit /admin/setup, or set PARACHUTE_INITIAL_ADMIN_USERNAME + PARACHUTE_INITIAL_ADMIN_PASSWORD and restart.",
            setup_url: "/admin/setup",
          }),
          {
            status: 503,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          },
        );
      }

      // Bare `/` → configurable target (default `/admin`, the admin-shell IA).
      // The home page and the admin SPA used to be two disconnected surfaces;
      // `/` funnels straight into the single coherent admin shell, whose
      // Home/Overview carries the discovery content (hub-native sections,
      // modules, user surfaces) that used to live here.
      //
      // The target is operator-configurable (resolveRootRedirect): a hub_settings
      // `root_redirect` row → `PARACHUTE_HUB_ROOT_REDIRECT` env → `/admin`
      // default. Lets an operator point their hub's root at a surface (e.g. a
      // team reading-room) instead of the admin shell, without redeploying. The
      // resolver re-validates every layer through the same-origin guard
      // (`isSafeRedirectPath`) so a stored/env value can NEVER produce an open
      // redirect — an unsafe value is ignored and falls back to `/admin`.
      //
      // Ordering matters: this sits AFTER the fresh-hub wizard funnel above
      // (so a brand-new operator still lands on `/admin/setup`, not a surface
      // that can't work yet) and AFTER the pre-admin lockout (so an admin-less
      // hub still 503s API callers correctly). 302 (not 301) — the target is
      // operator-mutable, so a permanent/cached redirect would strand visitors
      // on a stale destination after the operator flips it.
      //
      // The signed-out path is preserved when the target is `/admin`: a
      // signed-out visitor lands on `/admin`, where the SPA's AuthIndicator
      // shows a "Sign in" link that round-trips through `/login?next=/admin/...`
      // and back. We don't pin the redirect on session state — the shell
      // handles both auth states itself.
      //
      // `/hub.html` is INTENTIONALLY excluded: it still renders the discovery
      // page (used by the static `parachute expose --set-path=/` disk file and
      // any bookmark to the explicit `.html`). Only the bare `/` redirects.
      if (pathname === "/") {
        return new Response(null, {
          status: 302,
          headers: { location: resolveRootRedirect(getDb ? getDb() : null) },
        });
      }

      if (pathname === "/hub.html") {
        // When a DB is configured, render the discovery page dynamically so
        // the header carries a "Signed in as <name>" affordance for the
        // active session. Without a DB, fall back to the static disk file
        // (signed-out shape) — the disk file is what `parachute expose`
        // wrote out, used when the hub-server is running without state.
        if (getDb) {
          const db = getDb();
          const session = findActiveSession(db, req);
          let renderOpts: RenderHubOpts = {};
          const headers: Record<string, string> = {
            "content-type": "text/html; charset=utf-8",
          };
          if (session) {
            const user = getUserById(db, session.userId);
            if (user) {
              const csrf = ensureCsrfToken(req);
              renderOpts = {
                session: { displayName: user.username, csrfToken: csrf.token },
              };
              if (csrf.setCookie) headers["set-cookie"] = csrf.setCookie;
            }
          }
          return new Response(renderHub(renderOpts), { headers });
        }
        // No DB configured → fall back to static file (signed-out only).
        if (!existsSync(hubHtmlPath)) {
          return new Response("hub.html not found", { status: 404 });
        }
        return new Response(Bun.file(hubHtmlPath), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (pathname === "/.well-known/parachute.json") {
        // The well-known doc is a public service-discovery manifest (no
        // secrets, no PII), and Notes / future browser clients fetch it
        // cross-origin from their own loopback port. Wildcard CORS is the
        // shape it needs. Browsers send an OPTIONS preflight when the request
        // adds non-simple headers; answer it with 204 + the same allow-list.
        //
        // `cache-control: no-store` matters here: the discovery page (`/`)
        // fetches this doc and renders Service tiles from it; without
        // no-store, the browser's HTTP cache returns the stale services list
        // the next time the operator navigates back to `/` after installing
        // a module via the admin SPA. The doc is small and built per-request
        // anyway, so giving up cacheability has no real cost (hub#268 Item 1).
        const corsHeaders = {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "cache-control": "no-store",
        };
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }
        // Built dynamically from services.json on every request — that's what
        // makes `parachute vault create` show up here without re-running
        // expose. canonicalOrigin reuses the OAuth issuer fallback: prefer the
        // configured public origin (set by `--issuer https://<fqdn>`), else
        // the request's own origin (fine for direct loopback hits).
        try {
          // Lenient — see hub#406.
          const manifest = readManifestLenient(manifestPath);
          // Same precedence as the OAuth issuer (hub#298): hub_settings →
          // env → request origin. The well-known doc embeds this origin
          // in service URLs + the issuer metadata link, so it must follow
          // the same chain — otherwise a public-domain operator who set
          // `hub_origin` would still see the Render-assigned URL on
          // `/.well-known/parachute.json` while their JWTs carry the
          // canonical URL, and discovery clients would split-brain on
          // which one to trust.
          const canonicalOrigin = resolveIssuer(
            req,
            getDb?.(),
            configuredIssuer,
            loadExposeHubOrigin,
          );
          const readManifestFn = deps?.readModuleManifest ?? defaultReadModuleManifest;
          const [managementUrlByName, serviceUiMeta] = await Promise.all([
            loadManagementUrls(manifest.services, readManifestFn),
            loadServiceUiMetadata(manifest.services, readManifestFn),
          ]);
          const doc = buildWellKnown({
            services: manifest.services,
            canonicalOrigin,
            managementUrlFor: (entry) => managementUrlByName.get(entry.name),
            uiUrlFor: (entry) => serviceUiMeta.uiUrls.get(entry.name),
            displayNameFor: (entry) => serviceUiMeta.displayNames.get(entry.name),
          });
          return new Response(JSON.stringify(doc), {
            headers: { "content-type": "application/json", ...corsHeaders },
          });
        } catch (err) {
          // ServicesManifestError lands here too — corrupt JSON or schema
          // violation in services.json shouldn't crash the hub for everyone.
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(JSON.stringify({ error: `well-known build failed: ${msg}` }), {
            status: 500,
            headers: { "content-type": "application/json", ...corsHeaders },
          });
        }
      }

      if (pathname === REVOCATION_LIST_MOUNT) {
        // Revocation list (hub#212 Phase 1). Public — same CORS posture as
        // jwks.json since resource servers (vault/scribe/agent) fetch it
        // cross-origin on the 60s polling cadence wired in Phase 4.
        const corsHeaders = {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
        };
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }
        if (!getDb) {
          return new Response('{"error":"revocation list unavailable: db not configured"}', {
            status: 503,
            headers: { "content-type": "application/json", ...corsHeaders },
          });
        }
        const resp = handleRevocationList(req, { db: getDb() });
        // Layer the wildcard CORS over whatever cache-control the handler set.
        const merged = new Headers(resp.headers);
        for (const [k, v] of Object.entries(corsHeaders)) merged.set(k, v);
        return new Response(resp.body, { status: resp.status, headers: merged });
      }

      if (pathname === "/.well-known/jwks.json") {
        // JWKS is also a cross-origin fetch target (browser-side OAuth
        // libraries pull this to verify access tokens). Same wildcard CORS
        // shape as parachute.json — JWKS is public-by-design (only public
        // keys leave the server).
        const corsHeaders = {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
        };
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }
        if (!getDb) {
          return new Response('{"error":"jwks unavailable: db not configured"}', {
            status: 503,
            headers: { "content-type": "application/json", ...corsHeaders },
          });
        }
        try {
          const db = getDb();
          const keys = getAllPublicKeys(db).map((k) => pemToJwk(k.publicKeyPem, k.kid));
          return new Response(JSON.stringify({ keys }), {
            headers: { "content-type": "application/json", ...corsHeaders },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(JSON.stringify({ error: `jwks failed: ${msg}` }), {
            status: 500,
            headers: { "content-type": "application/json", ...corsHeaders },
          });
        }
      }

      if (pathname === "/.well-known/oauth-authorization-server") {
        // Public discovery doc — clients pull this cross-origin to find the
        // authorize/token endpoints. Same wildcard CORS shape as the JWKS
        // and the parachute manifest.
        const corsHeaders = {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
        };
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }
        const res = authorizationServerMetadata(oauthDeps(req));
        // Fold CORS into the existing JSON response.
        const merged = new Headers(res.headers);
        for (const [k, v] of Object.entries(corsHeaders)) merged.set(k, v);
        return new Response(res.body, { status: res.status, headers: merged });
      }

      if (pathname === "/.well-known/oauth-protected-resource") {
        // RFC 9728 — companion to oauth-authorization-server. MCP clients
        // (since 2025-06-18 spec) probe this to discover scopes + the
        // authorization server. Same wildcard CORS shape. Closes hub#393.
        const corsHeaders = {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
        };
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }
        const res = protectedResourceMetadata(oauthDeps(req));
        const merged = new Headers(res.headers);
        for (const [k, v] of Object.entries(corsHeaders)) merged.set(k, v);
        return new Response(res.body, { status: res.status, headers: merged });
      }

      // OAuth surface — every handler return is wrapped in `applyCorsHeaders`
      // so third-party SPAs can fetch these endpoints cross-origin (the entire
      // point of OAuth DCR: arbitrary SPAs register → authorize → exchange
      // tokens). Preflight OPTIONS already returned at the top of dispatch.
      // See `src/cors.ts` for the wildcard-origin rationale.
      if (pathname === "/oauth/authorize") {
        if (!getDb) return applyCorsHeaders(req, dbNotConfigured());
        // Per-request force-change-password gate (P0-1 / hub#469). CHOKE POINT 3:
        // a signed-in pre-rotation user must NOT be able to ride the consent flow
        // to an auth code → `/oauth/token` exchange → vault-scoped access token
        // without rotating the temp password. Gating `/oauth/authorize` (the
        // session-backed consent path) is sufficient — no code is issued without
        // it, so `/oauth/token` (back-channel code exchange, no session cookie)
        // is intentionally NOT gated (gating it would break the legitimate
        // exchange). An UNAUTHENTICATED authorize request returns null from the
        // gate and falls through to render the login form, unchanged.
        const oauthGate = forceChangePasswordGate(getDb(), req);
        if (oauthGate) return applyCorsHeaders(req, oauthGate);
        if (req.method === "GET") {
          // handleAuthorizeGet is sync (returns Response, not Promise<Response>).
          // handleAuthorizePost is async — keep the await on POST only.
          return applyCorsHeaders(req, handleAuthorizeGet(getDb(), req, oauthDeps(req)));
        }
        if (req.method === "POST") {
          return applyCorsHeaders(req, await handleAuthorizePost(getDb(), req, oauthDeps(req)));
        }
        return applyCorsHeaders(req, new Response("method not allowed", { status: 405 }));
      }

      // Inline approve form for the operator-driven pending-client flow (#208).
      // Receives `client_id` + `csrf_token` + `return_to` from the form rendered
      // by handleAuthorizeGet when the operator hits a pending client. Three
      // gates inside the handler: CSRF, active session, same-origin Origin.
      if (pathname === "/oauth/authorize/approve") {
        if (!getDb) return applyCorsHeaders(req, dbNotConfigured());
        if (req.method !== "POST") {
          return applyCorsHeaders(req, new Response("method not allowed", { status: 405 }));
        }
        return applyCorsHeaders(req, await handleApproveClientPost(getDb(), req, oauthDeps(req)));
      }

      if (pathname === "/oauth/token") {
        if (!getDb) return applyCorsHeaders(req, dbNotConfigured());
        if (req.method !== "POST") {
          return applyCorsHeaders(req, new Response("method not allowed", { status: 405 }));
        }
        return applyCorsHeaders(req, await handleToken(getDb(), req, oauthDeps(req)));
      }

      if (pathname === "/oauth/register") {
        if (!getDb) return applyCorsHeaders(req, dbNotConfigured());
        if (req.method !== "POST") {
          return applyCorsHeaders(req, new Response("method not allowed", { status: 405 }));
        }
        return applyCorsHeaders(req, await handleRegister(getDb(), req, oauthDeps(req)));
      }

      if (pathname === "/oauth/revoke") {
        if (!getDb) return applyCorsHeaders(req, dbNotConfigured());
        if (req.method !== "POST") {
          return applyCorsHeaders(req, new Response("method not allowed", { status: 405 }));
        }
        return applyCorsHeaders(req, await handleRevoke(getDb(), req, oauthDeps(req)));
      }

      // RFC 7592 client deregistration: DELETE /oauth/clients/<id> (hub#640).
      // Mounted at this TOP-LEVEL `/oauth/clients/` prefix — NOT under
      // `/api/oauth/clients/` — because that's the path parachute-surface's
      // remove-flow actually calls (`packages/surface-host/src/dcr.ts` fires a
      // best-effort DELETE on every Notes/Claude reconnect, carrying the
      // operator token as a Bearer). Without it the hub 404'd every such
      // DELETE and orphaned a `clients` row per reconnect. Operator-bearer-
      // gated (parachute:host:admin) inside handleDeleteClient; 204 on delete,
      // 404 if absent. CORS-wrapped + OPTIONS-preflighted like its OAuth
      // siblings (the top-of-dispatch isCorsAllowedRoute("/oauth/") preempts
      // the preflight). The GET/approve sub-paths stay on `/api/oauth/clients/`
      // (the SPA-facing admin surface) below.
      if (pathname.startsWith("/oauth/clients/")) {
        if (!getDb) return applyCorsHeaders(req, dbNotConfigured());
        const clientId = decodeURIComponent(pathname.slice("/oauth/clients/".length));
        if (!clientId || clientId.includes("/")) {
          return applyCorsHeaders(req, new Response("not found", { status: 404 }));
        }
        return applyCorsHeaders(
          req,
          await handleDeleteClient(req, clientId, {
            db: getDb(),
            issuer: oauthDeps(req).issuer,
            knownIssuers: oauthDeps(req).hubBoundOrigins(),
          }),
        );
      }

      // Agent-connector OAuth-client callback (Phase 4b-2). The operator's
      // browser is redirected here by a REMOTE issuer after consenting to a
      // `kind:mcp` grant. Standalone server-rendered route — NOT under /admin/*,
      // so the SPA catch-all never swallows it. GET, no Bearer: the single-use
      // `state` it carries is the CSRF defense (this is a cross-site redirect IN
      // from the remote issuer, so the same-origin belt does NOT apply). The
      // handler looks up the pending flow by `state`, exchanges the code at the
      // remote token endpoint, stores the grant material, and renders a tiny
      // HTML "connected" / error page (never a token).
      if (pathname === "/oauth/agent-grant/callback") {
        if (!getDb) return dbNotConfigured();
        if (req.method !== "GET") {
          return new Response("method not allowed", { status: 405 });
        }
        const resolveVaultOrigin = (vaultName: string): string | null => {
          const match = findVaultUpstream(
            readManifestLenient(manifestPath).services,
            `/vault/${vaultName}`,
          );
          return match ? `http://127.0.0.1:${match.port}` : null;
        };
        const agentGrantsDeps: AgentGrantsDeps = {
          db: getDb(),
          hubOrigin: oauthDeps(req).issuer,
          storePath: deps?.agentGrantsStorePath ?? join(CONFIG_DIR, "agent-grants.json"),
          flowsStorePath:
            deps?.agentOAuthFlowsStorePath ?? join(CONFIG_DIR, "agent-oauth-flows.json"),
          resolveVaultOrigin,
        };
        return handleOAuthGrantCallback(req, agentGrantsDeps);
      }

      if (pathname === "/vaults") {
        if (!getDb) return dbNotConfigured();
        return handleCreateVault(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
        });
      }

      // DELETE /vaults/<name> — destroy a vault with the full identity
      // cascade (B1, 2026-06-09 hub-module-boundary: lifecycle symmetry).
      // Bearer parachute:host:admin + {"confirm": "<name>"} body. See
      // admin-vaults.handleDeleteVault for the enumerated cascade.
      if (pathname.startsWith("/vaults/")) {
        if (!getDb) return dbNotConfigured();
        const name = decodeURIComponent(pathname.slice("/vaults/".length));
        const services = readManifestLenient(manifestPath).services;
        // Agent's row carries its MANIFEST name — resolve via
        // findServiceByShort (see the /admin/connections note below).
        const agentEntry = findServiceByShort(services, "agent");
        const agentOrigin = agentEntry ? `http://127.0.0.1:${agentEntry.port}` : null;
        const resolveVaultOrigin = (vaultName: string): string | null => {
          const match = findVaultUpstream(
            readManifestLenient(manifestPath).services,
            `/vault/${vaultName}`,
          );
          return match ? `http://127.0.0.1:${match.port}` : null;
        };
        const supervisor = deps?.supervisor;
        return handleDeleteVault(req, name, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          manifestPath,
          connectionsStorePath: deps?.connectionsStorePath ?? join(CONFIG_DIR, "connections.json"),
          agentOrigin,
          resolveVaultOrigin,
          resolveModuleOrigin: makeResolveModuleOrigin(manifestPath),
          // Daemon eviction — the same in-process supervisor the lifecycle
          // verbs drive (module-ops API); restarting vault evicts the open
          // store handle + re-runs selfRegister (services.json path rebuild).
          ...(supervisor
            ? {
                restartVaultModule: async () => {
                  await supervisor.restart("vault");
                },
              }
            : {}),
        });
      }

      // Note: the old `/hub/*` SPA mount has been retired. Known prefixes
      // (`/hub`, `/hub/vaults*`, `/hub/permissions`, `/hub/tokens`) are
      // 301-redirected at the top of dispatch. Any other `/hub/*` path falls
      // through to the catch-all 404 — there's no admin surface left there.

      if (pathname === "/admin/host-admin-token") {
        if (!getDb) return dbNotConfigured();
        return handleHostAdminToken(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
        });
      }

      // Back-compat: the agent module's admin-token mint moved from
      // `/admin/channel-token` to `/admin/agent-token` in the 2026-06-17
      // channel→agent rename. 301-redirect the old path so operator bookmarks
      // + any un-upgraded UI fallback keep working for one release cycle.
      if (pathname === "/admin/channel-token") {
        const dest = new URL(req.url);
        dest.pathname = "/admin/agent-token";
        return Response.redirect(dest.toString(), 301);
      }

      if (pathname === "/admin/agent-token") {
        if (!getDb) return dbNotConfigured();
        return handleAgentToken(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
        });
      }

      // Generic per-module config-UI bearer mint (2026-06-09 modular-UI
      // architecture, P3). `<short>:admin` for any single-audience module —
      // the admin scope each module-owned config UI needs to call its own
      // endpoints. Cookie-gated to the first-admin operator, exactly like
      // /admin/agent-token + /admin/vault-admin-token. Gated on
      // self-registration (services.json row + readable module.json) with the
      // bootstrap registries as a fallback (boundary C5) — a genuinely
      // third-party module mints here with zero hub code changes. Vault is
      // per-instance and routed to /admin/vault-admin-token/<name> instead.
      if (pathname.startsWith("/admin/module-token/")) {
        if (!getDb) return dbNotConfigured();
        const short = decodeURIComponent(pathname.slice("/admin/module-token/".length));
        return handleModuleToken(req, short, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          // Lenient + per-request — a module that self-registered since hub
          // boot is mintable without a restart (see hub#406 for lenient).
          readServices: () => readManifestLenient(manifestPath).services,
          ...(deps?.readModuleManifest ? { readModuleManifest: deps.readModuleManifest } : {}),
        });
      }

      // Note: the legacy `/admin/channels` bespoke vault-channel orchestration
      // endpoint (pre-Connections, hub#624 era) was retired in boundary D1 —
      // superseded by the general engine below. The agent module's own admin
      // page (renamed from channel 2026-06-17) drives `/admin/connections` +
      // `/admin/agent-token`.

      // Connections — the GENERAL module event→action engine (2026-06-09
      // modular-UI architecture, P5). `/api/connections/catalog` (GET) returns
      // the available events/actions read from each installed module's
      // `module.json`; `/admin/connections` (GET/POST) lists + provisions;
      // `/admin/connections/:id` (DELETE) tears down. Cookie-gated to the
      // first-admin operator. The provisioning engine derives the vault
      // trigger's webhook + scope from the SINK action's declaration —
      // nothing is agent-hardcoded.
      if (
        pathname === "/api/connections/catalog" ||
        pathname === "/admin/connections" ||
        pathname.startsWith("/admin/connections/")
      ) {
        if (!getDb) return dbNotConfigured();
        const services = readManifestLenient(manifestPath).services;
        // Agent's services.json row carries its MANIFEST name
        // (`parachute-agent`), not the bare short `agent` — resolve via
        // findServiceByShort so the lookup matches the on-disk row. (A bare
        // `s.name === "agent"` never matched, leaving agentOrigin null →
        // "agent not installed".) A legacy un-upgraded `parachute-channel` row
        // still resolves here via the LEGACY_MANIFEST_ALIASES fallback.
        const agentEntry = findServiceByShort(services, "agent");
        const agentOrigin = agentEntry ? `http://127.0.0.1:${agentEntry.port}` : null;
        const resolveVaultOrigin = (vaultName: string): string | null => {
          const match = findVaultUpstream(
            readManifestLenient(manifestPath).services,
            `/vault/${vaultName}`,
          );
          return match ? `http://127.0.0.1:${match.port}` : null;
        };
        const readManifestFn = deps?.readModuleManifest ?? defaultReadModuleManifest;
        const modules = await collectInstalledModules(manifestPath, readManifestFn);
        const connectionsDeps: ConnectionsDeps = {
          db: getDb(),
          hubOrigin: oauthDeps(req).issuer,
          modules,
          resolveVaultOrigin,
          resolveModuleOrigin: makeResolveModuleOrigin(manifestPath),
          agentOrigin,
          storePath: deps?.connectionsStorePath ?? join(CONFIG_DIR, "connections.json"),
        };
        if (pathname === "/api/connections/catalog") {
          return handleConnectionsCatalog(req, connectionsDeps);
        }
        // CSRF belt (hub#632, boundary C1): cookie-authed POST/DELETE must
        // carry a matching Origin. The seam's canonical consumer — the agent
        // module's admin page POSTing link-vault with `credentials: "include"` — is a
        // same-origin fetch() and passes; see origin-check.ts
        // `assertSameOriginForCookieMutation` for the belted-endpoint
        // enumeration.
        {
          const rejected = assertSameOriginForCookieMutation(req, oauthDeps(req).hubBoundOrigins());
          if (rejected) return rejected;
        }
        const subPath = pathname.slice("/admin/connections".length);
        return handleConnections(req, subPath, connectionsDeps);
      }

      // Agent-connector GRANTS — the approval-gated resource-grant subsystem
      // (Phase 4b-1, agent-connectors design 2026-06-17). Generalizes the
      // Connections engine from "event→action triggers" to "approval-gated
      // resource grants": an agent declares connections it WANTS beyond its
      // def-vault; the agent module registers each as a pending grant (PUT,
      // host-admin Bearer); the operator approves per-connection (POST
      // /approve, first-admin cookie); the hub mints (vault) / stores (service)
      // the secret; the agent module fetches it at spawn (GET /material,
      // host-admin Bearer). Two auth classes split by route inside the handler.
      if (pathname === "/admin/grants" || pathname.startsWith("/admin/grants/")) {
        if (!getDb) return dbNotConfigured();
        const resolveVaultOrigin = (vaultName: string): string | null => {
          const match = findVaultUpstream(
            readManifestLenient(manifestPath).services,
            `/vault/${vaultName}`,
          );
          return match ? `http://127.0.0.1:${match.port}` : null;
        };
        const agentGrantsDeps: AgentGrantsDeps = {
          db: getDb(),
          hubOrigin: oauthDeps(req).issuer,
          // hub#516 parity: validate the module's host-admin bearer `iss`
          // against the hub's known-origin set (PUT /admin/grants is the only
          // bearer-gated route here; the POST /approve|/revoke are cookie-authed).
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          storePath: deps?.agentGrantsStorePath ?? join(CONFIG_DIR, "agent-grants.json"),
          flowsStorePath:
            deps?.agentOAuthFlowsStorePath ?? join(CONFIG_DIR, "agent-oauth-flows.json"),
          resolveVaultOrigin,
        };
        // CSRF belt (same posture as /admin/connections, hub#632): a no-op for
        // the host-admin-Bearer PUT/GET (Bearer → not a browser CSRF), and the
        // real gate on the cookie-authed POST /approve + /revoke.
        {
          const rejected = assertSameOriginForCookieMutation(req, oauthDeps(req).hubBoundOrigins());
          if (rejected) return rejected;
        }
        const subPath = pathname.slice("/admin/grants".length);
        return handleAgentGrants(req, subPath, agentGrantsDeps);
      }

      if (pathname.startsWith("/admin/vault-admin-token/")) {
        if (!getDb) return dbNotConfigured();
        const vaultName = decodeURIComponent(pathname.slice("/admin/vault-admin-token/".length));
        // The vault name must correspond to an actual vault instance — same
        // shape the well-known doc derives. Source from services.json so a
        // freshly-created vault is mintable on the next request without a
        // restart.
        // Lenient — see hub#406.
        const manifest = readManifestLenient(manifestPath);
        const knownVaultNames = new Set<string>();
        for (const s of manifest.services) {
          if (!isVaultEntry(s)) continue;
          for (const path of s.paths) knownVaultNames.add(vaultInstanceNameFor(s.name, path));
        }
        return handleVaultAdminToken(req, vaultName, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownVaultNames,
        });
      }

      if (pathname === "/api/me") {
        if (!getDb) return dbNotConfigured();
        return handleApiMe(req, { db: getDb() });
      }

      // Admin screen-lock management (optional idle PIN lock for the admin
      // UI). Session-cookie-gated to the first admin; these manage the lock
      // itself so they are NOT behind the lock gate. The lock GATE lives in
      // the four `/admin/*-token` mint handlers (admin-lock.ts:requireUnlocked)
      // — it does NOT touch `/oauth/*`, so the OAuth issuer is unaffected.
      if (pathname === "/api/admin-lock" || pathname.startsWith("/api/admin-lock/")) {
        if (!getDb) return dbNotConfigured();
        // CSRF belt (same posture as /admin/connections): these are
        // cookie-authed JSON mutations. The handler ALSO checks a double-
        // submit `__csrf` token; the Origin belt is defense-in-depth on the
        // POST paths (GET status is read-shaped and skips it).
        {
          const rejected = assertSameOriginForCookieMutation(req, oauthDeps(req).hubBoundOrigins());
          if (rejected) return rejected;
        }
        const subpath = pathname.slice("/api/admin-lock".length);
        return handleAdminLock(req, subpath, { db: getDb() });
      }

      // JSON self-service account surfaces for the admin SPA "My account" page
      // (hub#85): password change + 2FA enroll/confirm/disable. Self-only
      // (acts on `session.userId`, never a client-supplied id) — ANY signed-in
      // user, not just the first admin. Same cookie + CSRF + same-origin
      // posture as /api/admin-lock above (NOT the host-admin Bearer posture —
      // a user managing their own credentials needs no admin scope). The
      // server-rendered /account/2fa + /account/change-password pages stay for
      // the no-JS / friend-facing path; these are the JSON twins.
      if (pathname.startsWith("/api/account/")) {
        if (!getDb) return dbNotConfigured();
        {
          const rejected = assertSameOriginForCookieMutation(req, oauthDeps(req).hubBoundOrigins());
          if (rejected) return rejected;
        }
        const subpath = pathname.slice("/api/account".length);
        return handleApiAccount(req, subpath, { db: getDb() });
      }

      // SPA-driven hub self-upgrade (design 2026-06-01 §5.3 / D4). Dedicated
      // endpoint — the hub is NOT a supervised module (no /api/modules/hub/*),
      // so it gets its own route. Checked BEFORE the `/api/hub` exact match
      // below (and the `/api/modules/*` switch) so the more-specific path wins.
      // Does NOT require a supervisor: the hub upgrades itself via a detached
      // helper, not the supervisor. Host-admin gated inside the handler (reuses
      // the same validateAccessToken + scope check the module-ops API uses); the
      // channel param is a closed enum (rc|latest) — no injection surface.
      if (pathname === "/api/hub/upgrade") {
        if (!getDb) return dbNotConfigured();
        return handleHubUpgrade(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          configDir: CONFIG_DIR,
        });
      }
      if (pathname === "/api/hub/upgrade/status") {
        if (!getDb) return dbNotConfigured();
        return handleHubUpgradeStatus(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          configDir: CONFIG_DIR,
        });
      }

      // Hub version + uptime + install-source — drives the admin SPA's
      // version badge (hub#348). Bearer-gated on `parachute:host:admin`
      // (same as the rest of the operator-only admin surface).
      if (pathname === "/api/hub") {
        if (!getDb) return dbNotConfigured();
        return handleApiHub(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
        });
      }

      if (pathname === "/api/modules") {
        if (!getDb) return dbNotConfigured();
        const od = oauthDeps(req);
        const modulesDeps: Parameters<typeof handleApiModules>[1] = {
          db: getDb(),
          issuer: od.issuer,
          // hub#516: validate the host-admin bearer's `iss` against the SET of
          // origins the hub answers on (loopback ∪ expose-state ∪ env/platform ∪
          // per-request issuer), so `parachute status` works on an exposed box
          // where the operator token carries the public origin but the loopback
          // request resolves the loopback issuer.
          knownIssuers: od.hubBoundOrigins(),
          manifestPath: deps?.manifestPath ?? SERVICES_MANIFEST_PATH,
        };
        if (deps?.supervisor !== undefined) modulesDeps.supervisor = deps.supervisor;
        // hub#342: thread the test-injectable module-manifest reader
        // through so `management_url` resolution can be exercised in
        // unit tests without writing real install dirs.
        if (deps?.readModuleManifest !== undefined)
          modulesDeps.readModuleManifest = deps.readModuleManifest;
        return handleApiModules(req, modulesDeps);
      }

      // Channel toggle (hub#275) — pre-empts the /api/modules/:short/*
      // routes below so `/api/modules/channel` doesn't accidentally match
      // `parseModulesPath` (which would reject it as a non-curated short
      // anyway, but precedence makes the intent explicit).
      if (pathname === "/api/modules/channel") {
        if (!getDb) return dbNotConfigured();
        return handleApiModulesChannel(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
        });
      }

      // Canonical hub URL (hub#298). Admin SPA reads + writes the
      // operator-set issuer override. The handler computes the resolved
      // issuer + source here so it can surface them in the GET payload
      // without re-walking the precedence chain inside the handler.
      if (pathname === "/api/settings/hub-origin") {
        if (!getDb) return dbNotConfigured();
        const db = getDb();
        return handleApiSettingsHubOrigin(req, {
          db,
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          resolvedIssuer: resolveIssuer(req, db, configuredIssuer, loadExposeHubOrigin),
          resolvedSource: resolveIssuerSource(db, configuredIssuer, loadExposeHubOrigin),
        });
      }

      // Bare-`/` redirect target (configurable; default `/admin`). Admin SPA /
      // CLI reads + writes the operator-set landing page. Same Bearer/scope
      // posture as hub-origin; the open-redirect guard lives in the handler +
      // resolver.
      if (pathname === "/api/settings/root-redirect") {
        if (!getDb) return dbNotConfigured();
        return handleApiSettingsRootRedirect(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
        });
      }

      // Module operation poll surface — pre-empts the /api/modules/:short/*
      // routes below so `/api/modules/operations/<uuid>` doesn't accidentally
      // match a parseModulesPath("/operations") and fall through.
      if (pathname.startsWith("/api/modules/operations/")) {
        if (!getDb) return dbNotConfigured();
        if (!deps?.supervisor) {
          return new Response(
            JSON.stringify({
              error: "supervisor_unavailable",
              error_description:
                "module operations require `parachute serve` (supervisor mode); on-box CLI uses `parachute install/upgrade/restart`",
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        }
        const opId = decodeURIComponent(pathname.slice("/api/modules/operations/".length));
        if (!opId || opId.includes("/")) return new Response("not found", { status: 404 });
        const od = oauthDeps(req);
        return handleOperationGet(req, opId, {
          db: getDb(),
          issuer: od.issuer,
          // hub#516: see the `/api/modules` deps note — the CLI polls async ops
          // on loopback with the operator token (public `iss`).
          knownIssuers: od.hubBoundOrigins(),
          manifestPath: deps?.manifestPath ?? SERVICES_MANIFEST_PATH,
          configDir: CONFIG_DIR,
          supervisor: deps.supervisor,
        });
      }

      // NOTE: the hub-hosted generic per-module config proxy
      // (`/api/modules/<short>/config[/schema]`) + its SPA form were RETIRED in
      // the 2026-06-09 modular-UI architecture P3. Config is module-owned +
      // hub-framed now: the Modules page "Configure" action opens the module's
      // OWN config UI (`configUiUrl`), which mints its admin Bearer from the
      // cookie-gated `/admin/module-token/<short>` (or `/admin/agent-token`).

      // Per-module action endpoints: /api/modules/:short/{install,restart,upgrade,uninstall}.
      if (pathname.startsWith("/api/modules/")) {
        if (!getDb) return dbNotConfigured();
        if (!deps?.supervisor) {
          return new Response(
            JSON.stringify({
              error: "supervisor_unavailable",
              error_description:
                "module operations require `parachute serve` (supervisor mode); on-box CLI uses `parachute install/upgrade/restart`",
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        }
        const match = parseModulesPath(pathname);
        if (!match) return new Response("not found", { status: 404 });
        const od = oauthDeps(req);
        const opsDeps = {
          db: getDb(),
          issuer: od.issuer,
          // hub#516: the CLI drives start/stop/restart/install/upgrade/uninstall
          // on loopback with the operator token, whose `iss` is the hub's public
          // origin after `expose`. Validate against the hub's known-origin set.
          knownIssuers: od.hubBoundOrigins(),
          manifestPath: deps?.manifestPath ?? SERVICES_MANIFEST_PATH,
          configDir: CONFIG_DIR,
          supervisor: deps.supervisor,
        };
        switch (match.rest) {
          case "install":
            return handleInstall(req, match.short, opsDeps);
          case "start":
            return handleStart(req, match.short, opsDeps);
          case "stop":
            return handleStop(req, match.short, opsDeps);
          case "restart":
            return handleRestart(req, match.short, opsDeps);
          case "logs":
            return handleLogs(req, match.short, opsDeps);
          case "upgrade":
            return handleUpgrade(req, match.short, opsDeps);
          case "uninstall":
            return handleUninstall(req, match.short, opsDeps);
          default:
            return new Response("not found", { status: 404 });
        }
      }

      if (pathname === "/api/auth/mint-token") {
        if (!getDb) return dbNotConfigured();
        // Derive the set of registered vault names so the handler can reject a
        // `vault:<typo>:admin` mint (item D / hub#450) — same source + shape the
        // session-cookie `/admin/vault-admin-token/<name>` path uses. Lenient
        // read so a malformed manifest doesn't 500 the mint endpoint.
        const mintManifest = readManifestLenient(manifestPath);
        const mintKnownVaultNames = new Set<string>();
        for (const s of mintManifest.services) {
          if (!isVaultEntry(s)) continue;
          for (const path of s.paths) mintKnownVaultNames.add(vaultInstanceNameFor(s.name, path));
        }
        return handleApiMintToken(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          knownVaultNames: mintKnownVaultNames,
        });
      }

      if (pathname === "/api/auth/revoke-token") {
        if (!getDb) return dbNotConfigured();
        return handleApiRevokeToken(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
        });
      }

      if (pathname === "/api/auth/tokens") {
        if (!getDb) return dbNotConfigured();
        return handleApiTokens(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
        });
      }

      if (pathname === "/api/grants") {
        if (!getDb) return dbNotConfigured();
        return handleListGrants(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
        });
      }

      if (pathname.startsWith("/api/grants/")) {
        if (!getDb) return dbNotConfigured();
        const clientId = decodeURIComponent(pathname.slice("/api/grants/".length));
        if (!clientId || clientId.includes("/")) {
          return new Response("not found", { status: 404 });
        }
        return handleRevokeGrant(req, clientId, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
        });
      }

      // OAuth client lookup + approval. Both bearer-gated under host:admin.
      // Two paths: `/api/oauth/clients/<id>` (GET, details) and
      // `/api/oauth/clients/<id>/approve` (POST, flip to approved). The
      // SPA approve-client deep link reads details from the first and
      // submits approval to the second — keeps the surface easy to test
      // and audit without overloading a single verb.
      if (pathname.startsWith("/api/oauth/clients/")) {
        if (!getDb) return dbNotConfigured();
        const tail = pathname.slice("/api/oauth/clients/".length);
        if (!tail) return new Response("not found", { status: 404 });
        const approveSuffix = "/approve";
        if (tail.endsWith(approveSuffix)) {
          const clientId = decodeURIComponent(tail.slice(0, -approveSuffix.length));
          if (!clientId || clientId.includes("/")) {
            return new Response("not found", { status: 404 });
          }
          return handleApproveClient(req, clientId, {
            db: getDb(),
            issuer: oauthDeps(req).issuer,
            knownIssuers: oauthDeps(req).hubBoundOrigins(),
          });
        }
        const clientId = decodeURIComponent(tail);
        if (!clientId || clientId.includes("/")) {
          return new Response("not found", { status: 404 });
        }
        return handleGetClient(req, clientId, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
        });
      }

      // Multi-user Phase 1 admin endpoints (hub#252, design 2026-05-20).
      // `/api/users` collection (GET list / POST create) and
      // `/api/users/vaults` for the assigned-vault picker. Per-id route
      // `/api/users/:id` (DELETE only — Phase 1 doesn't ship edit) is
      // handled by the `startsWith("/api/users/")` branch below, with the
      // `/api/users/vaults` sub-path pre-empted *before* the catch-all so
      // a literal `vaults` segment can't be mistaken for a user id.
      if (pathname === "/api/users") {
        if (!getDb) return dbNotConfigured();
        const usersDeps = {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          manifestPath,
        };
        if (req.method === "GET") return handleListUsers(req, usersDeps);
        if (req.method === "POST") return handleCreateUser(req, usersDeps);
        return new Response("method not allowed", { status: 405 });
      }
      if (pathname === "/api/users/vaults") {
        if (!getDb) return dbNotConfigured();
        return handleListVaults(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          manifestPath,
        });
      }
      // Phase 2 PR 1 — `/api/users/:id/reset-password` (admin-initiated
      // password reset for non-admin users). Routed BEFORE the per-id DELETE
      // catch-all so the trailing `/reset-password` segment isn't mistaken
      // for part of a user id. Same `host:admin` Bearer gate as the other
      // /api/users surfaces.
      {
        const resetMatch = pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/);
        if (resetMatch) {
          if (!getDb) return dbNotConfigured();
          const id = decodeURIComponent(resetMatch[1] ?? "");
          if (!id) {
            return new Response("not found", { status: 404 });
          }
          return handleResetUserPassword(req, id, {
            db: getDb(),
            issuer: oauthDeps(req).issuer,
            knownIssuers: oauthDeps(req).hubBoundOrigins(),
            manifestPath,
          });
        }
      }
      // Phase 2 PR 2 — `/api/users/:id/vaults` (replace a user's vault
      // assignments). Routed before the per-id DELETE catch-all so the
      // trailing `/vaults` segment isn't mistaken for part of a user id.
      {
        const vaultsMatch = pathname.match(/^\/api\/users\/([^/]+)\/vaults$/);
        if (vaultsMatch) {
          if (!getDb) return dbNotConfigured();
          const id = decodeURIComponent(vaultsMatch[1] ?? "");
          if (!id) {
            return new Response("not found", { status: 404 });
          }
          return handleUpdateUserVaults(req, id, {
            db: getDb(),
            issuer: oauthDeps(req).issuer,
            knownIssuers: oauthDeps(req).hubBoundOrigins(),
            manifestPath,
          });
        }
      }
      if (pathname.startsWith("/api/users/")) {
        if (!getDb) return dbNotConfigured();
        const id = decodeURIComponent(pathname.slice("/api/users/".length));
        if (!id || id.includes("/")) {
          return new Response("not found", { status: 404 });
        }
        return handleDeleteUser(req, id, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          manifestPath,
        });
      }

      // One-time invite links (design §7). host:admin-gated, same gate flavor
      // as /api/users. POST creates (returns the single-emit token + URL), GET
      // lists (status-annotated), DELETE /:id revokes by sha256 hash.
      if (pathname === "/api/invites") {
        if (!getDb) return dbNotConfigured();
        const invitesDeps = {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          manifestPath,
        };
        if (req.method === "GET") return handleListInvites(req, invitesDeps);
        if (req.method === "POST") return handleCreateInvite(req, invitesDeps);
        return new Response("method not allowed", { status: 405 });
      }
      if (pathname.startsWith("/api/invites/")) {
        if (!getDb) return dbNotConfigured();
        const id = decodeURIComponent(pathname.slice("/api/invites/".length));
        if (!id || id.includes("/")) {
          return new Response("not found", { status: 404 });
        }
        return handleRevokeInvite(req, id, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          manifestPath,
        });
      }

      // Per-vault storage caps (B5 admin visibility / D-slice). GET lists every
      // vault from services.json joined with its persisted cap; PUT /:name
      // sets/updates a cap. host:admin-gated, same gate flavor as /api/users.
      if (pathname === "/api/vault-caps") {
        if (!getDb) return dbNotConfigured();
        return handleListVaultCaps(req, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          manifestPath,
        });
      }
      if (pathname.startsWith("/api/vault-caps/")) {
        if (!getDb) return dbNotConfigured();
        const name = decodeURIComponent(pathname.slice("/api/vault-caps/".length));
        if (!name || name.includes("/")) {
          return new Response("not found", { status: 404 });
        }
        return handleSetVaultCap(req, name, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
          knownIssuers: oauthDeps(req).hubBoundOrigins(),
          manifestPath,
        });
      }

      // Canonical login/logout. The handlers themselves are unchanged from
      // when they lived at /admin/login + /admin/logout; the rename surfaced
      // via #231-followup so the URL reflects the surface's actual scope
      // (entry point for ALL parachute auth — not admin-only). The
      // /admin/login and /admin/logout paths 301 to here, dispatched at the
      // top of this fn alongside the other back-compat redirects.
      if (pathname === "/login") {
        if (!getDb) return dbNotConfigured();
        if (req.method === "GET") return handleAdminLoginGet(getDb(), req);
        if (req.method === "POST") return handleAdminLoginPost(getDb(), req);
        return new Response("method not allowed", { status: 405 });
      }

      // /login/2fa — second-factor step (hub#473). POST-only: reached only
      // after a correct password POST for a 2FA-enrolled user handed back a
      // pending-login cookie + rendered the challenge page. A bare GET (e.g.
      // browser back button) has no form to render usefully, so 405 → the
      // operator restarts at /login.
      if (pathname === "/login/2fa") {
        if (!getDb) return dbNotConfigured();
        if (req.method === "POST") return handleAdminLoginTotpPost(getDb(), req);
        return new Response("method not allowed", { status: 405 });
      }

      if (pathname === "/logout") {
        if (!getDb) return dbNotConfigured();
        if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
        return handleAdminLogoutPost(getDb(), req);
      }

      // Invite redemption — `/account/setup/<token>` (design §7). Un-authed
      // onboarding surface (the invitee has no session yet); routed BEFORE the
      // per-request force-change choke point and the `/account/` matches below.
      // GET renders the claim form; POST redeems → creates account + own vault,
      // mints a session, 302 → /account/. The handler validates the invite
      // (sha256 lookup, expiry/used/revoked), CSRF, and rate-limits on the
      // /login IP bucket. The invite alone is the authorization — no host:admin.
      if (pathname.startsWith("/account/setup/")) {
        if (!getDb) return dbNotConfigured();
        const rawToken = decodeURIComponent(pathname.slice("/account/setup/".length));
        if (!rawToken || rawToken.includes("/")) {
          return new Response("not found", { status: 404 });
        }
        const db = getDb();
        const hubOrigin = resolveIssuer(req, db, configuredIssuer, loadExposeHubOrigin);
        const setupDeps = { db, hubOrigin, manifestPath };
        if (req.method === "GET") return handleAccountSetupGet(req, rawToken, setupDeps);
        if (req.method === "POST") return handleAccountSetupPost(req, rawToken, setupDeps);
        return new Response("method not allowed", { status: 405 });
      }

      // Multi-user Phase 1 PR 3 — user self-service change-password surface
      // (hub#252, design §sign-in flow change). Both GET (render form) and
      // POST (apply change) require a session cookie. The handler itself
      // does the session check + 302 to /login when missing — same posture
      // as the rest of /account/* will use as Phase 2 broadens this prefix.
      //
      // This route is intentionally NOT gated by `password_changed === false`
      // — that's only the *redirect* path from /login. A signed-in user with
      // `password_changed: true` can still navigate here to rotate their
      // password (design §"Direct navigation").
      if (pathname === "/account/change-password") {
        if (!getDb) return dbNotConfigured();
        // `now` deliberately omitted — handlers fall through to `new Date()` in
        // production; the seam exists only so tests can advance the rate-limiter
        // clock deterministically.
        const accountDeps = { db: getDb() };
        if (req.method === "GET") return handleAccountChangePasswordGet(req, accountDeps);
        if (req.method === "POST") return handleAccountChangePasswordPost(req, accountDeps);
        return new Response("method not allowed", { status: 405 });
      }

      // Per-request force-change-password gate (P0-1 / hub#469). CHOKE POINT 1:
      // every `/account/*` route BELOW this line is gated. `/logout` and
      // `/account/change-password` (the rotation/exit path) ran above and already
      // returned, so they're never reached here — they stay reachable
      // pre-rotation by construction. A signed-in user with
      // `password_changed === false` is bounced (302 → change-password for
      // browsers, 403 JSON for API clients) before any account surface
      // (2fa, vault-token, vault-admin-token, account home) resolves. DRY: one
      // gate for the whole `/account/*` family rather than per-route. The
      // per-route mints in `account-vault-{token,admin-token}.ts` keep their own
      // gate as defence-in-depth (they're also reachable in tests directly).
      //
      // The bare `/account` (no trailing slash) is matched explicitly too —
      // otherwise it would slip past `startsWith("/account/")` to its 301 →
      // `/account/` below, and a pre-rotation user wouldn't be gated until the
      // second hop. Exact-match `/account` (not `startsWith("/account")`) so
      // unrelated paths like `/accounts-something` aren't caught.
      if (getDb && (pathname === "/account" || pathname.startsWith("/account/"))) {
        const gate = forceChangePasswordGate(getDb(), req);
        if (gate) return gate;
      }

      // /account/2fa — user self-service TOTP 2FA enroll / disenroll (hub#473).
      // Both GET (render state) and POST (start/confirm/disable) require an
      // active session; the handler does the session check + 302 to /login when
      // missing, same posture as /account/change-password.
      if (pathname === "/account/2fa") {
        if (!getDb) return dbNotConfigured();
        const twoFactorDeps = { db: getDb() };
        if (req.method === "GET") return handleTwoFactorGet(req, twoFactorDeps);
        if (req.method === "POST") return handleTwoFactorPost(req, twoFactorDeps);
        return new Response("method not allowed", { status: 405 });
      }

      // /account/vault-admin-token/<name> — friend-facing vault ADMIN deep-link.
      // POST-only, session-gated, assignment-capped to the `admin` verb: an
      // assigned non-admin user mints a `vault:<name>:admin` bootstrap token and
      // 303-redirects into the vault's own admin SPA (`#token=<jwt>`), where they
      // can rotate vault tokens AND configure Git backup / mirror. The non-admin
      // sibling of `/admin/vault-admin-token/<name>` (which is first-admin-gated
      // and returns JSON for the hub SPA). The handler enforces session →
      // assignment-grants-admin → CSRF → force-change-password (item F / #469)
      // before minting. Must precede `/account/vault-token/` (it isn't a prefix
      // of it, but keep the more-specific admin path first for clarity) and the
      // `/account/` match below. See `account-vault-admin-token.ts`.
      if (pathname.startsWith("/account/vault-admin-token/")) {
        if (!getDb) return dbNotConfigured();
        if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
        const vaultName = decodeURIComponent(pathname.slice("/account/vault-admin-token/".length));
        const db = getDb();
        const hubOrigin = resolveIssuer(req, db, configuredIssuer, loadExposeHubOrigin);
        // Resolve the vault's declared `managementUrl` at request time (same
        // source the well-known doc reads — `installDir/.parachute/module.json`)
        // so the deep-link lands on the vault admin SPA's real entry point. Quiet
        // on a malformed/absent manifest: the handler defaults to `/admin/`
        // (vault's canonical value), the same target the admin sibling uses.
        const readManifestFn = deps?.readModuleManifest ?? defaultReadModuleManifest;
        const manifest = readManifestLenient(manifestPath);
        let managementUrl: string | undefined;
        for (const s of manifest.services) {
          if (!isVaultEntry(s) || !s.installDir) continue;
          const instanceNames = new Set(s.paths.map((p) => vaultInstanceNameFor(s.name, p)));
          if (!instanceNames.has(vaultName)) continue;
          try {
            const m = await readManifestFn(s.installDir);
            if (m?.managementUrl) managementUrl = m.managementUrl;
          } catch {
            // Leave undefined → handler defaults to /admin/.
          }
          break;
        }
        return handleAccountVaultAdminTokenPost(req, vaultName, {
          db,
          hubOrigin,
          ...(managementUrl !== undefined ? { managementUrl } : {}),
        });
      }

      // /account/vault-token/<name> — friend-facing scoped vault token mint.
      // POST-only, session-gated, assignment-capped: a non-admin friend mints a
      // `vault:<name>:read|write` bearer for a vault they're ASSIGNED to, for
      // scripts / headless clients that can't do browser OAuth. The handler
      // enforces session → assignment → scope-cap (never `:admin`, never a
      // vault outside the assignment, never a broader verb than the role
      // grants) + CSRF + per-user rate limit. Must precede the `/account/`
      // match below (more specific prefix). See `account-vault-token.ts`.
      if (pathname.startsWith("/account/vault-token/")) {
        if (!getDb) return dbNotConfigured();
        if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
        const vaultName = decodeURIComponent(pathname.slice("/account/vault-token/".length));
        const db = getDb();
        const hubOrigin = resolveIssuer(req, db, configuredIssuer, loadExposeHubOrigin);
        return handleAccountVaultTokenPost(req, vaultName, { db, hubOrigin });
      }

      // /account/ — friend-facing user home (multi-user Phase 1 follow-up).
      // Companion to the first-admin gate on `/admin/host-admin-token`: a
      // signed-in non-admin (friend) lands here instead of bouncing against
      // a 403 wall on the admin SPA. Admin users also land here when they
      // hit `/account/` directly, with a "you're the administrator → /admin/"
      // exit ramp. Bare `/account` 301-redirects to `/account/` so links
      // without the trailing slash work.
      if (pathname === "/account" || pathname === "/account/") {
        if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
        if (pathname === "/account") {
          return new Response(null, { status: 301, headers: { location: "/account/" } });
        }
        if (!getDb) return dbNotConfigured();
        const db = getDb();
        const hubOrigin = resolveIssuer(req, db, configuredIssuer, loadExposeHubOrigin);
        // Resolve each assigned vault's loopback port from services.json so the
        // home can fetch per-vault usage. Read at request time (same dynamism as
        // proxyToVault) — a vault created seconds ago surfaces a stat without a
        // restart. Returns null for an unknown name → that tile skips the stat.
        const resolveVaultPort = (vaultName: string): number | null => {
          const services = readManifestLenient(manifestPath).services;
          const match = findVaultUpstream(services, `/vault/${vaultName}`);
          return match ? match.port : null;
        };
        return handleAccountHomeGet(req, { db, hubOrigin, resolveVaultPort });
      }

      // Legacy `/admin/config` (server-rendered module-config portal, #46)
      // retired post-SPA-rework. 301 → /admin/vaults so any bookmark or stale
      // post-login redirect lands somewhere useful (post-B5 that's the
      // feature-detected vaults surface — legacy list on an old-vault box,
      // forward to /vault/admin/ on a new one). The route stays here in
      // dispatch order (above the /admin/* SPA catch-all) so the redirect
      // wins over a SPA shell render.
      if (pathname === "/admin/config" || pathname.startsWith("/admin/config/")) {
        return new Response(null, {
          status: 301,
          headers: { location: "/admin/vaults" },
        });
      }

      // /vault/admin + /vault/admin/* — the vault MODULE's daemon-level
      // admin surface (B-route, 2026-06-09 hub-module-boundary). MUST run
      // BEFORE the per-vault proxy dispatch below: this is a module-level
      // mount, not an instance path. "admin" is a reserved vault name (B2h)
      // so no instance can claim it, and `findVaultUpstream` never sees it —
      // no consumer fabricates a phantom vault named "admin". Exact-segment
      // match only: a vault instance named e.g. "adminx" still routes
      // per-instance through the branch below.
      if (pathname === "/vault/admin" || pathname.startsWith("/vault/admin/")) {
        // Same per-request force-change-password gate as the per-vault proxy
        // (P0-1 / hub#469) — a pre-rotation signed-in user can't reach the
        // multi-vault admin surface on an un-rotated temp password either.
        if (getDb) {
          const gate = forceChangePasswordGate(getDb(), req);
          if (gate) return gate;
        }
        const proxied = await proxyToVaultAdmin(req, manifestPath, deps?.supervisor, peerAddr);
        if (proxied) return decorateWithChrome(proxied, req, pathname, getDb);
        return new Response("not found", { status: 404 });
      }

      // /vault/<name>/* — per-vault content proxy. Stays as user-facing
      // surface (the Notes PWA loads through here, etc.). The bare `/vault`
      // and `/vault/new` paths were SPA routes pre-#231; they 301-redirect at
      // the top of dispatch now (to `/vault/admin/` since B5). Multi-segment requests like
      // `/vault/<unknown>/health` are vault-API shapes targeting a
      // non-existent vault and 404 directly — there's no SPA-shell fallback
      // here anymore (the SPA moved to /admin), so we can't accidentally
      // mask a backend 404 with HTML.
      if (pathname.startsWith("/vault/")) {
        // Per-request force-change-password gate (P0-1 / hub#469). CHOKE POINT 2:
        // a pre-rotation signed-in user can't reach a per-vault user surface
        // (Notes PWA, MCP, vault API) on the un-rotated temp password — they're
        // bounced to change-password (browser) / 403 (API). Same posture as the
        // `/account/*` gate above. An UNAUTHENTICATED proxy request (no hub
        // session — the common Notes/MCP case carrying its own bearer) passes the
        // gate untouched (`forceChangePasswordGate` returns null with no session)
        // and is handled by the vault's own auth downstream.
        if (getDb) {
          const gate = forceChangePasswordGate(getDb(), req);
          if (gate) return gate;
        }
        const proxied = await proxyToVault(req, manifestPath, deps?.supervisor, peerAddr);
        if (proxied) return decorateWithChrome(proxied, req, pathname, getDb);
        return new Response("not found", { status: 404 });
      }

      // /admin/* SPA mount. All non-SPA admin handlers (host-admin-token,
      // vault-admin-token, login, logout, config, api/auth/*, api/grants,
      // grants/*) ran above and either matched or returned. Anything that
      // makes it here under /admin/* is a SPA route or asset request; the
      // SPA's own router renders the page and handles 404 client-side for
      // unknown sub-paths.
      if (pathname === "/admin" || pathname === "/admin/") {
        // Unprefixed /admin → SPA shell at its index route. The SPA's
        // basename is /admin, so the router lands on / and renders Home
        // (the admin-shell overview).
        if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
        return serveSpa(spaDistDir, pathname, "/admin");
      }
      if (pathname.startsWith("/admin/")) {
        if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
        return serveSpa(spaDistDir, pathname, "/admin");
      }

      // /git/<name>/* — hub-authenticated git smart-HTTP transport (Surface
      // Git Transport, Phase 0a). Placed BEFORE the generic services.json
      // proxy so a `/git/` route is never shadowed by a module mount. The
      // endpoint is AUTH-gated, not LAYER-gated: it's reachable from any
      // exposure layer because the hub JWT (validated against the multi-origin
      // iss-set) is the gate. It NEVER builds or executes the pushed tree — the
      // hub only receives + stores bytes (the RCE-bearing build is surface-host's
      // sandboxed job, Phase 0b). See src/git-transport.ts.
      if (pathname.startsWith("/git/")) {
        if (!getDb) return new Response("not found", { status: 404 });
        const db = getDb();
        const issuer = oauthDeps(req).issuer;
        return handleGitTransport(req, {
          db,
          gitRoot,
          knownIssuers: () => oauthDeps(req).hubBoundOrigins(),
          peerAddr,
          // Deploy hand-off (Phase 0b §5 step 5): on a successful push, notify
          // the surface module over HTTP + a hub JWT so it pulls + builds +
          // serves. NEVER a shell-out that builds the pushed tree — the hub
          // only sends the authenticated signal (git-notify.ts). Fire-and-
          // forget; a notify failure is logged, never surfaced to the pusher.
          onPushed: async (name) => {
            await notifySurfacePushed(name, {
              db,
              issuer: issuer ?? `http://127.0.0.1:${loopbackPort ?? 1939}`,
              resolveModuleOrigin: makeResolveModuleOrigin(manifestPath),
              cloneBaseOrigin: `http://127.0.0.1:${loopbackPort ?? 1939}`,
            });
          },
        });
      }

      // Generic services.json-driven dispatch for non-vault modules. Reaches
      // here only after every hub-owned prefix above has had its turn — so
      // `/`, `/admin/*`, `/oauth/*`, `/.well-known/*`, `/hub/*`, `/vault/*`,
      // `/api/*` are excluded by ordering, not by an explicit denylist (#182).
      //
      // H3 — per-UI audience gate. When the path falls under a declared UI
      // sub-unit (a `uis{}` entry on the matched service row — surface-hosted
      // UI mounts like /surface/<name>/*), the sub-unit's audience is
      // enforced BEFORE forwarding: 'public' passes, 'surface' passes (the
      // backed surface authenticates every request itself), 'hub-users'
      // requires a session or a scope-satisfying Bearer, 'operator' requires
      // the first admin. Module API paths outside any uis entry are NOT
      // gated here — modules keep their own auth. Ordering nuance: when the
      // row's publicExposure cloak would fire (loopback-only, non-loopback
      // layer), the gate is SKIPPED so the 404 cloak stays indistinguishable
      // from not-installed (a 401 here would leak the route's existence) —
      // which also means a 'surface'/'public' mount on a loopback-only row
      // stays unreachable from tailnet/funnel: exposure is orthogonal to
      // audience.
      const uiMatch = resolveUiMount(readManifestLenient(manifestPath).services, pathname);
      if (uiMatch) {
        const cloaked =
          effectivePublicExposure(uiMatch.entry) === "loopback" &&
          layerOf(req, peerAddr) !== "loopback";
        if (!cloaked) {
          const denied = await gateUiAudience(req, uiMatch.audience, uiMatch.ui, {
            db: getDb?.(),
            knownIssuers: () => oauthDeps(req).hubBoundOrigins(),
          });
          if (denied) return denied;
        }
      }
      const proxied = await proxyToService(req, manifestPath, deps?.supervisor, peerAddr);
      if (proxied) {
        // H5 — chrome-strip rides the gate: where the audience resolved
        // `public`, the identity chrome is disabled for that mount (public
        // readers aren't hub users). `surface` follows the same precedent —
        // a backed surface's visitors are mostly capability-link invitees,
        // NOT hub users, so the "Signed in as…" chrome would be wrong for
        // them (and the surface owns its whole page anyway). Reuses the
        // per-path opt-out mechanism the /surface/notes/ precedent
        // established, generalized to the declared audience.
        return decorateWithChrome(
          proxied,
          req,
          pathname,
          getDb,
          uiMatch !== undefined && (uiMatch.audience === "public" || uiMatch.audience === "surface")
            ? [uiMatch.mount]
            : undefined,
        );
      }

      // Branded fall-through 404 (closes hub#392) — the operator who mistyped
      // a URL sees a clear "not found" page with a path back home, not the
      // browser's default empty-body chrome. Only HTML clients get the
      // rendered page; non-HTML callers (curl, API probes) still see the
      // shorter "not found" text so log noise stays low.
      const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
      if (wantsHtml) {
        return new Response(renderNotFoundPage(pathname), {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    } // end dispatch()
  };
}

/**
 * Inject the persistent chrome strip (workstream G) into a proxied response.
 *
 * Skips the rewrite when the response is non-200, non-HTML, on an opt-out
 * path (e.g. `/surface/notes/*`), or larger than `MAX_INJECT_SIZE_BYTES`.
 * `injectChromeIntoResponse` is the no-side-effects implementation; this
 * wrapper threads in the session-aware chrome HTML and a `set-cookie`
 * append when a fresh CSRF cookie was minted.
 *
 * `extraOptOutPrefixes` (H5) generalizes the static opt-out list: the
 * dispatch passes the matched UI mount when the audience gate resolved
 * `public` or `surface` — public readers (and a backed surface's
 * capability-link invitees) aren't hub users, so the identity chrome
 * ("Signed in as…", Sign in link) must not ride their pages. Same
 * mechanism as the hardcoded `/surface/notes/` precedent, now driven by
 * the sub-unit's declared audience instead of a hub-side path list.
 *
 * When `getDb` isn't wired (hubFetch instantiated without state — tests,
 * cold-start hub minus DB), we still inject — the signed-out variant.
 */
async function decorateWithChrome(
  res: Response,
  req: Request,
  pathname: string,
  getDb: HubFetchDeps["getDb"],
  extraOptOutPrefixes?: readonly string[],
): Promise<Response> {
  // Build chrome HTML lazily — `buildChromeForRequest` already opens the DB
  // for the session lookup; calling it on a response that won't be rewritten
  // (e.g. JSON 200, or a 502 from `proxyRequest`) is needless work. We
  // could inline the same content-type / status / opt-out check here, but
  // `injectChromeIntoResponse` does it canonically — so build the chrome
  // and let the helper short-circuit on the cheap headers-only paths.
  //
  // The expensive part is buffering the body; `injectChromeIntoResponse`
  // short-circuits before that on non-HTML / non-200 / oversize-declared
  // responses. Building chrome is a synchronous string concat (~2 KB out)
  // plus at most one DB query — cheap.
  const db = getDb?.();
  const { chromeHtml, setCookie } = buildChromeForRequest(req, {
    findActiveSession: db ? (r) => findActiveSession(db, r) : () => null,
    getUsername: db ? (userId) => getUserById(db, userId)?.username ?? null : () => null,
  });
  const out = await injectChromeIntoResponse(res, {
    chromeHtml,
    pathname,
    ...(extraOptOutPrefixes !== undefined && extraOptOutPrefixes.length > 0
      ? { optOutPrefixes: [...CHROME_OPT_OUT_PREFIXES, ...extraOptOutPrefixes] }
      : {}),
  });
  // Append set-cookie if a CSRF was minted AND the chrome was actually
  // injected (we know that by checking out !== res — pass-through preserves
  // identity). Otherwise the cookie is wasted on a 502/JSON/asset response
  // that didn't get a sign-out form.
  if (setCookie && out !== res) {
    const headers = new Headers(out.headers);
    headers.append("set-cookie", setCookie);
    return withProxySecurityHeaders(
      new Response(out.body, {
        status: out.status,
        statusText: out.statusText,
        headers,
      }),
    );
  }
  // hub#643: every exit runs through the security-header step, which self-
  // gates on content-type — so a non-HTML pass-through (`out === res`, e.g. a
  // 502 proxy error or a JSON/asset body) is returned unchanged, preserving
  // the pre-existing behavior for those responses.
  return withProxySecurityHeaders(out);
}

/**
 * hub#643 (Tier-1): stamp non-script security headers on proxied `text/html`
 * pages — the per-vault `/vault/<name>/*` proxy and the generic
 * services-mount `/<mount>/*` proxy both flow through `decorateWithChrome`,
 * so this is the single chokepoint that covers a module / surface page.
 *
 *   - `X-Content-Type-Options: nosniff` — stops content-type sniffing.
 *   - `Content-Security-Policy: frame-ancestors 'self'; object-src 'none';
 *     base-uri 'self'` — clickjacking (external framing) + plugin + base-tag
 *     hardening.
 *
 * Deliberately NO `script-src`: a strict script-src would white-screen
 * self-built GitHub-hosted surfaces (the primary surface story) and
 * inline-script module pages. The opt-in strict script-src CSP is Tier-2,
 * explicitly deferred (hub#643 stays open).
 *
 * Header-only: we never buffer the body. Only `text/html` responses are
 * decorated, so JSON / `.js` / CSS / image assets proxied through the same
 * path are left untouched. Existing headers are preserved (a fresh Headers
 * copy is mutated); we set (not append) so a re-decorated response can't
 * accumulate duplicates.
 */
function withProxySecurityHeaders(res: Response): Response {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) return res;
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-security-policy",
    "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
  );
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

if (import.meta.main) {
  const { port, hostname, wellKnownDir, dbPath, issuer } = parseArgs(process.argv.slice(2));
  // Self-heal-or-die DB holder (#594), opened lazily so a route that doesn't
  // touch the DB still works before first open. Once opened, the holder owns
  // reopen-once-or-exit on a persistent SQLite fault.
  let holder: ReturnType<typeof createDbHolder> | undefined;
  let livenessTimer: ReturnType<typeof startDbPathLivenessTimer> | undefined;
  const ensureHolder = (): ReturnType<typeof createDbHolder> => {
    if (!holder) {
      const db = openHubDb(dbPath);
      // Snapshot the inode the handle is bound to NOW, so the proactive probe
      // (#610) can later notice the path has gone / been replaced. Best-effort
      // — a failed snapshot leaves the proactive probe at "unknown" (it never
      // self-heals without a baseline), while the reactive path still covers
      // thrown faults.
      let initialInode: ReturnType<typeof defaultStatInode> | undefined;
      try {
        initialInode = defaultStatInode(dbPath);
      } catch {
        initialInode = undefined;
      }
      holder = createDbHolder(db, {
        reopen: () => openHubDb(dbPath),
        dbPath,
        statInode: defaultStatInode,
        initialInode,
      });
      // Start the bounded proactive-liveness watchdog (#610) once the handle is
      // open. It stat()s the db path on a low-frequency timer and self-heals
      // (reopen-or-exit) the moment the on-disk DB is wiped — closing the
      // ghost-fd gap the reactive path can't see (no thrown error on Linux).
      livenessTimer = startDbPathLivenessTimer(holder);
    }
    return holder;
  };
  const getDb = () => ensureHolder().get();
  const onDbError = (err: unknown): "ignored" | "healed" | "exited" =>
    holder ? holder.healOrExit(err) : "ignored";
  Bun.serve({
    port,
    hostname,
    // Hold idle connections open for 255 seconds (Bun's max) instead of
    // the 10-second default. When the hub sits behind a reverse-proxy edge
    // that pools keep-alive connections (Render, Cloudflare, fly proxy,
    // etc.), the edge's idle timeout is longer than our default — so the
    // proxy reaches into the pool, sends a request on a connection we
    // just closed, and returns 502 (Bad Gateway) to the client. The bug
    // is invisible to us (no log, no restart, deployStatus=live) and
    // manifests as a 5–15% "random" 502 rate under steady probing.
    // Canonical fix on Node is `keepAliveTimeout > edge.idle_timeout`;
    // Bun's equivalent is this. 255s comfortably exceeds Render's edge
    // pool TTL (community-observed ~120s). Closes hub#399.
    idleTimeout: 255,
    fetch: hubFetch(wellKnownDir, {
      getDb,
      onDbError,
      probeDbPath: () => holder?.probePath() ?? "unknown",
      issuer,
      loopbackPort: port,
    }),
    // H1 — the WebSocket upgrade bridge's frame-piping handlers. Connections
    // land here only after `maybeUpgradeWebSocket` gated + upgraded them.
    websocket: createWsBridgeHandlers(),
  });
  // Register PID + port from the running hub itself so any startup path
  // (spawn-via-`ensureHubRunning` or a direct `bun src/hub-server.ts` from
  // a developer or supervisor) lands the same lifecycle files at
  // ~/.parachute/hub/run/. Manual starts used to be invisible — `parachute
  // expose` then spawned another hub that collided on 1939 (#148).
  writePid(HUB_SVC, process.pid);
  writeHubPort(port);
  const cleanup = () => {
    livenessTimer?.stop();
    clearPid(HUB_SVC);
    clearHubPort();
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);
  console.log(
    `parachute-hub listening on http://${hostname}:${port} (dir=${wellKnownDir}, db=${dbPath}${
      issuer ? `, issuer=${issuer}` : ""
    })`,
  );
}
