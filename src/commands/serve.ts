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
// NOTE: CONFIG_DIR/WELL_KNOWN_DIR are evaluated at import time from process.env.PARACHUTE_HOME.
// The `env` parameter on `serve()` cannot reroute them — set PARACHUTE_HOME before importing for path isolation.
import { CONFIG_DIR } from "../config.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { writeHubFile } from "../hub.ts";
import { createUser, userCount } from "../users.ts";
import { WELL_KNOWN_DIR } from "../well-known.ts";

export interface ServeOpts {
  /** Override PORT (test-only). Real callers thread env via process.env. */
  port?: number;
  /** Override PARACHUTE_HUB_ORIGIN (test-only). */
  issuer?: string;
  /** Override the env source (test-only). */
  env?: NodeJS.ProcessEnv;
  /** Logger seam (test-only). */
  log?: (line: string) => void;
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
  await createUser(db, username, password);
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

  const server = Bun.serve({
    port,
    hostname,
    fetch: hubFetch(WELL_KNOWN_DIR, {
      getDb: () => db,
      issuer,
      loopbackPort: port,
    }),
  });

  log(
    `parachute serve: listening on http://${hostname}:${port} (PARACHUTE_HOME=${CONFIG_DIR}, db=${dbPath}, issuer=${issuer ?? "<request-origin>"}, admin=${adminBootstrap})`,
  );

  return {
    result: { port, ...(issuer !== undefined ? { issuer } : {}), adminBootstrap },
    stop: async () => {
      await server.stop();
      db.close();
    },
  };
}
