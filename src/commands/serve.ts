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

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`PORT must be 1..65535, got "${raw}"`);
  }
  return n;
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
  const issuer = (opts.issuer ?? env.PARACHUTE_HUB_ORIGIN)?.replace(/\/+$/, "") || undefined;
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
      "parachute serve: no admin account configured. Set PARACHUTE_INITIAL_ADMIN_USERNAME + PARACHUTE_INITIAL_ADMIN_PASSWORD, or visit /admin/setup once the hub is reachable.",
    );
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
    fetch: hubFetch(WELL_KNOWN_DIR, {
      getDb: () => db,
      issuer,
      loopbackPort: port,
      supervisor,
    }),
  });

  log(
    `parachute serve: listening on http://${hostname}:${port} (PARACHUTE_HOME=${CONFIG_DIR}, db=${dbPath}, issuer=${issuer ?? "<request-origin>"}, admin=${adminBootstrap})`,
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
