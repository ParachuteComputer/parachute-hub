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
import { selfHealScribeAuth } from "../auto-wire.ts";
import { generateBootstrapToken } from "../bootstrap-token.ts";
// NOTE: CONFIG_DIR/WELL_KNOWN_DIR/SERVICES_MANIFEST_PATH are evaluated at
// import time from process.env.PARACHUTE_HOME. The `env` parameter on
// `serve()` cannot reroute them — set PARACHUTE_HOME before importing for
// path isolation.
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { readExposeState } from "../expose-state.ts";
import { createDbHolder, defaultStatInode, startDbPathLivenessTimer } from "../hub-db-liveness.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { writeHubFile } from "../hub.ts";
import { createWsBridgeHandlers } from "../ws-bridge.ts";
import { enrichedPath } from "../spawn-path.ts";
import { Supervisor } from "../supervisor.ts";
import { createUser, userCount } from "../users.ts";
import { sanitizePublicOrigin } from "../vault-hub-origin-env.ts";
import { WELL_KNOWN_DIR } from "../well-known.ts";
import { bootSupervisedModules } from "./serve-boot.ts";

/**
 * Build the `Bun.serve` options for the hub listener. Extracted (pure) so the
 * load-bearing wiring — crucially the `websocket` bridge handler — is unit-
 * testable and can't silently drift from the other `Bun.serve` in
 * `hub-server.ts`. That drift is exactly how the in-page-terminal WS upgrade
 * started 500ing: the bridge was wired into hub-server.ts's serve but NOT this
 * production `parachute serve` path, so `server.upgrade()` (in `hubFetch`'s
 * `maybeUpgradeWebSocket`) threw "set the websocket object in Bun.serve({})".
 */
export function hubServeOptions(args: {
  port: number;
  hostname: string;
  fetch: ReturnType<typeof hubFetch>;
}) {
  return {
    port: args.port,
    hostname: args.hostname,
    // Hold idle keep-alive connections for Bun's maximum 255s so reverse-proxy
    // edges (Render, Cloudflare, fly.io) don't race us reusing pooled
    // connections (hub#399).
    idleTimeout: 255,
    fetch: args.fetch,
    // The WebSocket upgrade bridge. `maybeUpgradeWebSocket` (in `hubFetch`) calls
    // `server.upgrade()`, which THROWS unless the server declares this handler —
    // so it MUST be present on every Bun.serve that runs `hubFetch`.
    websocket: createWsBridgeHandlers(),
  };
}

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

/**
 * Map a `Bun.serve` bind failure to a clear "another supervisor is running"
 * message when it's a port-in-use error, or `null` for any other error (so the
 * caller re-throws the original). Keeps a duplicate-supervisor start from
 * surfacing as a raw `EADDRINUSE` stack — the operator's actionable next step
 * is "stop the other instance," not a backtrace. See hub#536. Exported for
 * testing (the bind itself isn't seam-injectable).
 */
export function hubPortConflictMessage(err: unknown, port: number): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (/EADDRINUSE|address already in use|in use/i.test(msg)) {
    return `parachute serve: hub port ${port} is already in use — another hub/supervisor is running. Refusing to start a duplicate supervisor (it would fight the live one over module ports). Stop the other instance first, then retry.`;
  }
  return null;
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
 *   4. `expose-state.json`'s `hubOrigin` — the canonical public origin a
 *      live tailscale/cloudflare exposure recorded (e.g.
 *      `https://parachute.taildf9ce2.ts.net`). This is the load-bearing
 *      tier for the **owner-operated reboot-persistent path**: the launchd
 *      plist / systemd unit that keeps `parachute serve` alive carries no
 *      `PARACHUTE_HUB_ORIGIN` env, so on every reboot the hub would
 *      otherwise boot issuer-less (tier 5), stamp `iss` from the per-request
 *      origin, and inject nothing into children — vault then defaults to
 *      loopback and rejects hub-minted tokens with `unexpected "iss" claim
 *      value` until it restarts. Reading the exposed origin off disk makes
 *      `iss` deterministic across reboots with zero operator action. Guarded
 *      to a non-loopback `http(s)` origin (a loopback value here would
 *      re-pin the degraded mode; expose-state should never carry one, but we
 *      defend anyway).
 *   5. None (returns undefined). Hub falls back to per-request derivation
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
 *
 * `readExpose` is injectable so tests exercise the expose-state tier
 * without touching the real `~/.parachute`. The default reads
 * `expose-state.json` and swallows a malformed-file throw (a corrupt state
 * file must never crash startup — fall through to the request-origin mode);
 * the `readExpose()` call is additionally try/catch-wrapped here so even an
 * injected non-swallowing reader can't crash startup.
 *
 * KNOWN ASTERISK (tracked in #532): this resolves the issuer at boot, so a
 * child module spawned during a *pre-expose* boot — hub started before the
 * first-ever `parachute expose` — gets no `PARACHUTE_HUB_ORIGIN` injected
 * until it's restarted after the exposure exists. Once an exposure is
 * recorded, every subsequent reboot picks it up here automatically. The
 * remaining gap (rebuild the live spawn-env on `supervisor.restart` so the
 * first exposure propagates to already-running children without a manual
 * restart) is the deferred #532 follow-up; not implemented in this PR.
 */
export function resolveStartupIssuer(
  opts: { issuer?: string },
  env: NodeJS.ProcessEnv,
  readExpose: () => string | undefined = defaultReadExposeHubOrigin,
): string | undefined {
  const flyOrigin = flyDefaultOriginFromEnv(env);
  const explicit = (
    opts.issuer ??
    env.PARACHUTE_HUB_ORIGIN ??
    env.RENDER_EXTERNAL_URL ??
    flyOrigin
  )?.replace(/\/+$/, "");
  if (explicit) return explicit;
  // No flag / env / platform origin set — fall back to the exposed origin
  // recorded on disk. `sanitizePublicOrigin` applies the same non-loopback
  // http(s) guard as the hub-server chokepoint (#531) so a stray loopback
  // value never pins the degraded request-origin mode.
  let raw: string | undefined;
  try {
    raw = readExpose();
  } catch {
    return undefined;
  }
  return sanitizePublicOrigin(raw);
}

/**
 * Read `expose-state.json`'s `hubOrigin` for the startup-issuer fallback,
 * swallowing a malformed-file throw. Kept separate so it can be passed as
 * the default `readExpose` arg and stubbed in tests.
 */
function defaultReadExposeHubOrigin(): string | undefined {
  try {
    return readExposeState()?.hubOrigin;
  } catch {
    return undefined;
  }
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
 * Injectable seams for {@link armServeDbWatchdog} (test-only). Generic on the
 * timer handle `H` so the scheduler seams never name `setInterval` in type
 * position — mirrors `DbLivenessTimerDeps<H>` in hub-db-liveness.ts, which
 * keeps the public interface portable to a types-less tsc environment.
 */
export interface ServeDbWatchdogDeps<H = unknown> {
  log?: (line: string) => void;
  /** Open a db handle (default {@link openHubDb}). Tests inject a fake that creates a fixture. */
  openDb?: (path: string) => ReturnType<typeof openHubDb>;
  /** Path stat for the inode snapshot + proactive probe (default {@link defaultStatInode}). */
  statInode?: typeof defaultStatInode;
  /** Injectable scheduler threaded to the liveness timer (default `setInterval`). */
  setIntervalFn?: (cb: () => void, ms: number) => H;
  /** Injectable clear threaded to the liveness timer (default `clearInterval`). */
  clearIntervalFn?: (handle: H) => void;
  /** Process-exit fn threaded into the holder's reopen-or-exit (default `process.exit`). */
  exit?: (code: number) => void;
}

/**
 * Build the self-heal DB holder (#594) + start the proactive ghost-fd watchdog
 * (#610) for the `parachute serve` path, returning both so the caller wires
 * `getDb`/`onDbError`/`probeDbPath` and stops the timer on shutdown.
 *
 * Extracted + exported so the wiring is unit-testable WITHOUT binding a real
 * port (#619): a serve()-level test would have to `Bun.serve` and risk the
 * hub#535 launchd-bootout hazard, so this pure helper carries the load-bearing
 * invariants instead — (1) the db is OPENED before the inode is snapshotted, so
 * a fresh-install first boot gets a defined baseline (an ENOENT snapshot would
 * silently disable the proactive probe for the whole process lifetime), and
 * (2) the liveness timer is actually started. Both were absent on this path
 * before #619 — the watchdog was wired only into `createHubServer`.
 */
export function armServeDbWatchdog<H = unknown>(
  dbPath: string,
  deps: ServeDbWatchdogDeps<H> = {},
): {
  dbHolder: ReturnType<typeof createDbHolder>;
  livenessTimer: ReturnType<typeof startDbPathLivenessTimer>;
} {
  const openDb = deps.openDb ?? openHubDb;
  const statInode = deps.statInode ?? defaultStatInode;
  // Open FIRST — `openHubDb` mkdir's + creates the file when absent, so the
  // stat below sees a real inode on a fresh-install first boot. Reversing this
  // would leave `initialInode` undefined (ENOENT) and the probe at "unknown"
  // for the process lifetime. Mirrors `createHubServer`'s ordering.
  const db = openDb(dbPath);
  let initialInode: ReturnType<typeof defaultStatInode> | undefined;
  try {
    initialInode = statInode(dbPath);
  } catch {
    initialInode = undefined;
  }
  const dbHolder = createDbHolder(db, {
    reopen: () => openDb(dbPath),
    dbPath,
    statInode,
    initialInode,
    ...(deps.log !== undefined ? { log: deps.log } : {}),
    ...(deps.exit !== undefined ? { exit: deps.exit } : {}),
  });
  // The active `parachute serve` path (systemd / launchd / container ExecStart)
  // MUST start the watchdog here, not only in `createHubServer` — else a
  // `rm -rf ~/.parachute` under a running unit leaves a ghost fd that keeps
  // SELECT 1 succeeding with no thrown error, the reactive path never fires,
  // and the hub never self-recovers (#619).
  const livenessTimer = startDbPathLivenessTimer<H>(dbHolder, {
    ...(deps.setIntervalFn !== undefined ? { setIntervalFn: deps.setIntervalFn } : {}),
    ...(deps.clearIntervalFn !== undefined ? { clearIntervalFn: deps.clearIntervalFn } : {}),
  });
  return { dbHolder, livenessTimer };
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

  // PATH enrichment (hub launchd-PATH regression): the launchd/systemd hub unit
  // bakes a minimal PATH. Enrich the hub's OWN process PATH so its `Bun.which`
  // probes (cloudflared / tailscale detection, etc.) see operator-tool dirs
  // (`$HOME/.local/bin`, brew bin) too — and so any child that inherits raw
  // `process.env` (not the explicit per-child env) starts from the enriched
  // PATH. The per-child spawn env is enriched independently in
  // `buildModuleSpawnRequest` / `spawnSupervised`. See `spawn-path.ts`. Only
  // mutate the live process env, never a test-injected `opts.env`.
  if (!opts.env) process.env.PATH = enrichedPath(process.env);

  const envPort = parsePort(env.PORT);
  const port = opts.port ?? envPort ?? DEFAULT_PORT;
  const issuer = resolveStartupIssuer(opts, env);
  // Containers default to 0.0.0.0 so the platform's HTTP forwarder can
  // reach us; the `--hostname` flag / PARACHUTE_BIND_HOST is the escape
  // hatch for setups that want loopback-only inside a sidecar.
  const hostname = env.PARACHUTE_BIND_HOST || "0.0.0.0";

  // Ensure the well-known dir exists, and (re)write the static hub.html so `/`
  // serves something coherent on a fresh disk (the dynamic path through
  // `hubFetch` takes over once a DB row exists; the disk file is the
  // signed-out fallback).
  //
  // Regenerate on EVERY serve start, not just when the file is absent (#171):
  // hub.html is a served artifact built from current code, and code ships via
  // `git pull` + `parachute restart hub`. Guarding on `!existsSync` left the
  // stale post-upgrade file on disk until an unrelated `parachute expose`
  // re-ran — so operators saw old hub.html after an upgrade. The write is a
  // cheap, deterministic, atomic (tmp+rename) render of static signed-out
  // HTML with no expose-state or DB dependency, so it's safe to call every
  // start.
  if (!existsSync(WELL_KNOWN_DIR)) mkdirSync(WELL_KNOWN_DIR, { recursive: true });
  const hubHtmlPath = join(WELL_KNOWN_DIR, "hub.html");
  writeHubFile(hubHtmlPath);

  const dbPath = hubDbPath();
  // Self-heal-or-die DB holder (#594) + proactive ghost-fd watchdog (#610/#619).
  const { dbHolder, livenessTimer } = armServeDbWatchdog(dbPath, { log });
  const adminBootstrap = await seedInitialAdminIfNeeded(dbHolder.get(), env, log);

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

  // Claim the hub port FIRST — before booting a single supervised module. If
  // another hub/supervisor already owns it, `Bun.serve` throws here and we
  // exit immediately. The prior order (boot modules, *then* bind) let a
  // duplicate `serve` spawn + port-race the live hub's children over their
  // module ports before it ever hit the hub-port conflict — the
  // dual-supervisor crash loop in hub#536. Binding first makes a duplicate
  // fail fast and cleanly, leaving the live hub's children untouched.
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve(
      hubServeOptions({
        port,
        hostname,
        fetch: hubFetch(WELL_KNOWN_DIR, {
          getDb: () => dbHolder.get(),
          onDbError: (err) => dbHolder.healOrExit(err),
          // #610: /health's db check probes the path so monitoring + the #591
          // adoption probe see a wipe instead of the ghost-fd lie.
          probeDbPath: () => dbHolder.probePath(),
          issuer,
          loopbackPort: port,
          supervisor,
        }),
      }),
    );
  } catch (err) {
    const conflict = hubPortConflictMessage(err, port);
    if (conflict) throw new Error(conflict);
    throw err;
  }

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

  // Self-heal scribe's auth token from vault's .env (item H) BEFORE booting
  // modules, so scribe's first boot below reads the synced config. Closes the
  // "scribe installed pre-auto-wire boots auth-OPEN over loopback" gap: every
  // `serve` start re-syncs scribe's `auth.required_token` to vault's
  // SCRIBE_AUTH_TOKEN. Fully idempotent — no-op when there's nothing to sync or
  // the two already match; logs only when it heals. Mirrors the issuer
  // self-heal pattern in vault-hub-origin-env.ts. Skipped in tests via
  // `opts.skipModuleBoot` (which also gates the boot it feeds).
  if (!opts.skipModuleBoot) {
    try {
      selfHealScribeAuth({ configDir: CONFIG_DIR, log });
    } catch (err) {
      // A self-heal failure must never block the hub from starting — scribe
      // just keeps whatever auth state it had. Log and move on.
      log(
        `parachute serve: scribe auth self-heal failed (${err instanceof Error ? err.message : String(err)}); continuing.`,
      );
    }
  }

  // Boot already-installed modules from services.json — now that we own the
  // hub port (above), we're guaranteed to be the sole supervisor. In a
  // container, this is the path that re-spawns vault / notes / scribe after a
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
      livenessTimer.stop();
      await server.stop();
      dbHolder.get().close();
    },
  };
}
