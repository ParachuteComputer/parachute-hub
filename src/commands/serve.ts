/**
 * `parachute serve` — long-running hub HTTP server, foregrounded.
 *
 * The on-box CLI flow (`parachute expose`) spawns hub-server detached and
 * tracks it via pidfile. Container hosts (Docker, Render) need the inverse
 * shape: the hub process IS PID 1 of the container, lives in the
 * foreground, and exits with the container.
 *
 * This subcommand wires that path:
 *
 *   - Reads `PORT` (default 1939) and `PARACHUTE_HUB_ORIGIN` (the canonical
 *     public origin Render exposes via custom domain) from env.
 *   - Auto-writes `hub.html` into `~/.parachute/well-known/` so `/` serves a
 *     real discovery page on a fresh disk without the operator having to
 *     run `parachute expose` first.
 *   - Seeds an initial admin from `PARACHUTE_INITIAL_ADMIN_USERNAME` +
 *     `PARACHUTE_INITIAL_ADMIN_PASSWORD` on first boot when no admin
 *     exists, so the wizard isn't a hard precondition.
 *   - Starts the hub-server fetch loop bound to `0.0.0.0` (container hosts
 *     need to accept the platform's HTTP forwarder, not just localhost).
 *
 * Stays out of pidfile/log-rotation logic — those are for the detached
 * `parachute start hub` flow. A container supervisor (Docker, systemd,
 * Render) owns process lifecycle; this command only owns the fetch loop.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateBootstrapToken } from "../bootstrap-token.ts";
// NOTE: CONFIG_DIR/WELL_KNOWN_DIR/SERVICES_MANIFEST_PATH are evaluated at
// import time from process.env.PARACHUTE_HOME. The `env` parameter on
// `serve()` cannot reroute them — set PARACHUTE_HOME before importing for
// path isolation.
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { writeHubFile } from "../hub.ts";
import { Supervisor } from "../supervisor.ts";
import { createUser, userCount } from "../users.ts";
import { WELL_KNOWN_DIR } from "../well-known.ts";
import { bootSupervisedModules } from "./serve-boot.ts";

export interface ServeOpts {
  /** Override PORT (test-only). Real callers thread env via process.env. */
  port?: number;
  /** Override PARACHUTE_HUB_ORIGIN (test-only). */
  issuer?: string;
  /** Override the env source (test-only). */
  env?: NodeJS.ProcessEnv;
  /** Logger seam (test-only). */
  log?: (line: string) => void;
  /**
   * Inject a pre-built Supervisor (test-only). Production constructs
   * one internally with default options; tests pass in a Supervisor
   * with stubbed spawn/sleep/now so the boot path doesn't try to
   * `Bun.spawn` real children.
   */
  supervisor?: Supervisor;
  /** Skip the services.json boot pass (test-only). */
  skipModuleBoot?: boolean;
}

export interface ServeResult {
  port: number;
  issuer?: string;
  /**
   * "seeded" — initial admin created from env vars.
   * "exists" — admin row already present, env vars ignored.
   * "needs-setup" — no admin and no env-var seed; wizard mode (the
   * setup-placeholder redirect in hub-server.ts takes over).
   */
  adminBootstrap: "seeded" | "exists" | "needs-setup";
  /** The supervisor instance — exposed so callers (tests) can introspect / drive it. */
  supervisor: Supervisor;
}

const DEFAULT_PORT = 1939;

/**
 * Build the startup banner line.
 *
 * `0.0.0.0` is a bind-host meta-address — the kernel uses it to mean "listen
 * on all interfaces," but Chrome and other browsers refuse to navigate to it
 * (and any cross-resource fetch that mixes `0.0.0.0` with `localhost` trips
 * cross-origin checks). Operators who paste the banner URL into a browser
 * need the loopback form. When the operator has explicitly chosen a
 * hostname via `PARACHUTE_BIND_HOST` (e.g. `127.0.0.1`, a LAN IP), we
 * honour their choice and print it directly — they know what they wired.
 */
export function formatListeningBanner(args: {
  hostname: string;
  port: number;
  configDir: string;
  dbPath: string;
  issuer?: string;
  adminBootstrap: string;
}): string {
  const { hostname, port, configDir, dbPath, issuer, adminBootstrap } = args;
  const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
  const boundNote = hostname === "0.0.0.0" ? ` (bound on all interfaces: 0.0.0.0:${port})` : "";
  return `parachute serve: listening on http://${displayHost}:${port}${boundNote} (PARACHUTE_HOME=${configDir}, db=${dbPath}, issuer=${issuer ?? "<request-origin>"}, admin=${adminBootstrap})`;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`PORT must be 1..65535, got "${raw}"`);
  }
  return n;
}

/**
 * Derive the canonical issuer URL hub uses for JWT iss claims + propagation
 * to supervised modules' PARACHUTE_HUB_ORIGIN env.
 *
 * Precedence (highest first):
 *   1. Explicit `--issuer` flag (test override too)
 *   2. `PARACHUTE_HUB_ORIGIN` env (operator-set, typical custom-domain case)
 *   3. Platform-injected public URL:
 *      - Render: `RENDER_EXTERNAL_URL` (auto-injected on web services)
 *      - Fly.io: `FLY_APP_NAME` → `https://<app>.fly.dev` (patterns#100)
 *      This is the load-bearing tier for container deploys where the
 *      operator can't know the URL at deploy time. Without this, supervised
 *      modules' iss-validation breaks on hub-minted tokens (iss-mismatch
 *      every time).
 *   4. None (returns undefined). Hub falls back to per-request derivation
 *      via `resolveIssuer` in hub-server.ts — works for `/.well-known`
 *      discovery but supervised modules with cached iss expectations
 *      won't have a static value to validate against, so OAuth flows
 *      through hub-mint → vault-validate will fail with iss-mismatch.
 *      This is the "no canonical origin known" degraded mode.
 *
 * Future platforms (Railway's `RAILWAY_PUBLIC_DOMAIN`, etc.) can extend
 * tier 3 as needed.
 *
 * Trailing slashes are stripped for canonical-form comparison; empty
 * strings collapse to undefined.
 */
export function resolveStartupIssuer(
  opts: { issuer?: string },
  env: NodeJS.ProcessEnv,
): string | undefined {
  const flyOrigin = flyDefaultOriginFromEnv(env);
  return (
    (opts.issuer ?? env.PARACHUTE_HUB_ORIGIN ?? env.RENDER_EXTERNAL_URL ?? flyOrigin)?.replace(
      /\/+$/,
      "",
    ) || undefined
  );
}

/**
 * Compose `https://${FLY_APP_NAME}.fly.dev` when FLY_APP_NAME is a plausible
 * Fly app slug. Mirrors the validation in detectAutoExposeMode (no slashes —
 * Fly slugs don't contain them). Kept local to this file (vs imported from
 * hub-server.ts) because serve.ts boots before hub-server.ts is loaded and
 * we want to avoid a cross-module dependency cycle at startup.
 */
function flyDefaultOriginFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const app = env.FLY_APP_NAME;
  if (typeof app !== "string" || app.length === 0 || app.includes("/")) {
    return undefined;
  }
  return `https://${app}.fly.dev`;
}

/**
 * Seed the initial admin from env vars when no admin exists. Returns the
 * bootstrap state so the caller can log it for operator visibility.
 *
 * Boot-time idempotent: if an admin already exists, we leave it alone —
 * `PARACHUTE_INITIAL_ADMIN_*` is a first-boot seed, not a reset switch.
 * That keeps a container restart with the env vars still set from
 * clobbering an admin who has since rotated their password.
 */
export async function seedInitialAdminIfNeeded(
  db: ReturnType<typeof openHubDb>,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void = () => {},
): Promise<"seeded" | "exists" | "needs-setup"> {
  if (userCount(db) > 0) return "exists";
  const username = env.PARACHUTE_INITIAL_ADMIN_USERNAME?.trim();
  const password = env.PARACHUTE_INITIAL_ADMIN_PASSWORD;
  if (!username || !password) return "needs-setup";
  // Env-seeded admins chose their password via the env var; skip the
  // multi-user-Phase-1 force-change-password redirect by landing
  // `password_changed=true`. Same treatment as the wizard's first admin.
  // `assignedVault` stays null — admin posture (no per-vault restriction).
  await createUser(db, username, password, { passwordChanged: true });
  log(`parachute serve: seeded initial admin "${username}" from PARACHUTE_INITIAL_ADMIN_*`);
  return "seeded";
}

/**
 * Format the multi-line wizard-mode banner the operator must see in
 * startup logs to claim the freshly-deployed hub. The token MUST be
 * surfaced visibly enough that an operator scrolling Render's log tab
 * spots it on the first scan — that's the design tension behind the
 * line-spacing and the `[wizard]` prefix on every line.
 *
 * Threaded out as a pure function so tests can lock the shape; the
 * banner is the security-critical interface (an operator who misses
 * the token can't proceed; an attacker who reads it before the
 * operator wins the race).
 */
export function formatBootstrapTokenBanner(token: string, hubUrl?: string): string {
  const rule = "═".repeat(64);
  // Substitute the actual hub URL when known (PARACHUTE_HUB_ORIGIN). Operators
  // staring at the banner in Render Logs shouldn't have to figure out their
  // own URL — show the literal placeholder only when the issuer isn't set.
  const url = hubUrl && hubUrl.length > 0 ? hubUrl.replace(/\/+$/, "") : "<hub-url>";
  return [
    "[wizard]",
    `[wizard] ${rule}`,
    "[wizard]   PARACHUTE BOOTSTRAP TOKEN",
    `[wizard] ${rule}`,
    "[wizard]",
    `[wizard]   ${token}`,
    "[wizard]",
    `[wizard]   → Visit ${url}/admin/setup and paste this token to create`,
    "[wizard]     your admin account.",
    "[wizard]   → Expires when admin is created OR when hub restarts.",
    "[wizard]",
    `[wizard] ${rule}`,
    "[wizard]",
  ].join("\n");
}

/**
 * Run the hub fetch loop in the foreground. Resolves when `Bun.serve` is
 * bound; the returned `stop()` shuts the server down for tests.
 *
 * The CLI dispatcher calls this without awaiting completion — `Bun.serve`
 * runs the listener and the runtime keeps the process alive until a
 * signal. Tests pass `port: 0` so the kernel picks an ephemeral port.
 */
export async function serve(opts: ServeOpts = {}): Promise<{
  result: ServeResult;
  stop: () => Promise<void>;
}> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line) => console.log(line));

  const envPort = parsePort(env.PORT);
  const port = opts.port ?? envPort ?? DEFAULT_PORT;
  const issuer = resolveStartupIssuer(opts, env);
  // Containers default to 0.0.0.0 so the platform's HTTP forwarder can
  // reach us; the `--hostname` flag / PARACHUTE_BIND_HOST is the escape
  // hatch for setups that want loopback-only inside a sidecar.
  const hostname = env.PARACHUTE_BIND_HOST || "0.0.0.0";

  // Ensure the well-known dir exists, and seed a static hub.html so `/`
  // serves something coherent on a fresh disk (the dynamic path through
  // `hubFetch` takes over once a DB row exists; the disk file is the
  // signed-out fallback).
  if (!existsSync(WELL_KNOWN_DIR)) mkdirSync(WELL_KNOWN_DIR, { recursive: true });
  const hubHtmlPath = join(WELL_KNOWN_DIR, "hub.html");
  if (!existsSync(hubHtmlPath)) writeHubFile(hubHtmlPath);

  const dbPath = hubDbPath();
  const db = openHubDb(dbPath);
  const adminBootstrap = await seedInitialAdminIfNeeded(db, env, log);

  if (adminBootstrap === "needs-setup") {
    log(
      "parachute serve: no admin account configured. Visit /admin/setup once the hub is reachable, or seed via PARACHUTE_INITIAL_ADMIN_USERNAME + PARACHUTE_INITIAL_ADMIN_PASSWORD env vars for scripted deploys.",
    );
    // Mint a bootstrap token + log it. The wizard's account POST will
    // require this token, so an attacker who beats the operator to the
    // freshly-provisioned URL still can't claim the admin row without
    // shell access to the platform's startup logs.
    const token = generateBootstrapToken();
    log(formatBootstrapTokenBanner(token, issuer));
  }

  const supervisor = opts.supervisor ?? new Supervisor();

  // Boot already-installed modules from services.json. In a container,
  // this is the path that re-spawns vault / notes / scribe after a
  // restart — the persistent disk preserved both the install (in
  // `$BUN_INSTALL/install/global/node_modules`) and the row that says
  // "this module is registered + active." Idempotent: the supervisor
  // skips modules that are already running.
  if (!opts.skipModuleBoot) {
    try {
      const booted = await bootSupervisedModules(supervisor, {
        manifestPath: SERVICES_MANIFEST_PATH,
        configDir: CONFIG_DIR,
        ...(issuer !== undefined ? { hubOrigin: issuer } : {}),
        log,
      });
      const startedCount = booted.filter((b) => b.status === "started").length;
      if (startedCount > 0) {
        log(`parachute serve: supervisor booted ${startedCount} module(s) from services.json.`);
      }
    } catch (err) {
      // A malformed services.json or a single module-spec read failure
      // shouldn't keep the hub HTTP server from coming up — the
      // operator can still hit /admin/modules to remediate.
      log(
        `parachute serve: module boot failed (${err instanceof Error ? err.message : String(err)}). The hub HTTP server is still starting; visit /admin/modules to remediate.`,
      );
    }
  }

  const server = Bun.serve({
    port,
    hostname,
    // Hold idle keep-alive connections for Bun's maximum 255s so reverse-
    // proxy edges (Render, Cloudflare, fly.io) don't race us when reusing
    // pooled connections. See `src/hub-server.ts` for the full rationale —
    // this is the active code path for `bun src/cli.ts serve` (the Docker
    // CMD), so the fix has to land here too. Closes hub#399.
    idleTimeout: 255,
    fetch: hubFetch(WELL_KNOWN_DIR, {
      getDb: () => db,
      issuer,
      loopbackPort: port,
      supervisor,
    }),
  });

  log(
    formatListeningBanner({
      hostname,
      port,
      configDir: CONFIG_DIR,
      dbPath,
      issuer,
      adminBootstrap,
    }),
  );

  return {
    result: {
      port,
      ...(issuer !== undefined ? { issuer } : {}),
      adminBootstrap,
      supervisor,
    },
    stop: async () => {
      // Stop supervised children first so they get a clean SIGTERM
      // before the HTTP server (which they may depend on for hub-issued
      // tokens) goes away.
      for (const state of supervisor.list()) {
        await supervisor.stop(state.short);
      }
      await server.stop();
      db.close();
    },
  };
}
