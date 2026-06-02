import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

/**
 * Per-service state lives under `<configDir>/<svc>/...`. `svc` is the
 * short name (`vault`, `notes`, `scribe`, `channel`) so paths stay tidy —
 * `~/.parachute/vault/run/vault.pid` rather than `parachute-vault/run/…`.
 *
 * The single source of truth for whether a service is running is
 * `pid file present` + `process.kill(pid, 0)` succeeds. A stale PID file
 * (process died without cleanup) reads as stopped; writers of the PID
 * file own removing it on clean shutdown.
 *
 * Phase 5b retired the detached module/hub spawners that *wrote* per-service
 * pidfiles. The pidfile READERS (`readPid` / `processState`) are deliberately
 * kept (design §7.5) so the migrate detector (`hasPriorDetachedInstall`) can
 * still see a prior detached install for one release. `writePid` / `clearPid`
 * remain too — `serve` (hub-server.ts) writes its own `hub` pidfile so
 * `parachute stop hub` / `migrate` can find a serve-mode hub.
 */

export function serviceDir(svc: string, configDir: string = CONFIG_DIR): string {
  return join(configDir, svc);
}

export function runDir(svc: string, configDir: string = CONFIG_DIR): string {
  return join(serviceDir(svc, configDir), "run");
}

export function logsDir(svc: string, configDir: string = CONFIG_DIR): string {
  return join(serviceDir(svc, configDir), "logs");
}

export function pidPath(svc: string, configDir: string = CONFIG_DIR): string {
  return join(runDir(svc, configDir), `${svc}.pid`);
}

export function logPath(svc: string, configDir: string = CONFIG_DIR): string {
  return join(logsDir(svc, configDir), `${svc}.log`);
}

export function readPid(svc: string, configDir: string = CONFIG_DIR): number | undefined {
  const p = pidPath(svc, configDir);
  if (!existsSync(p)) return undefined;
  const raw = readFileSync(p, "utf8").trim();
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function writePid(svc: string, pid: number, configDir: string = CONFIG_DIR): void {
  const p = pidPath(svc, configDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${pid}\n`);
}

export function clearPid(svc: string, configDir: string = CONFIG_DIR): void {
  const p = pidPath(svc, configDir);
  if (existsSync(p)) rmSync(p, { force: true });
}

export function ensureLogPath(svc: string, configDir: string = CONFIG_DIR): string {
  const p = logPath(svc, configDir);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

export type AliveFn = (pid: number) => boolean;

export const defaultAlive: AliveFn = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Three-state, kept for legacy detection only.
 *
 * Phase 5b retired the detached spawners that wrote per-service pidfiles, so in
 * the steady (supervised) state no module has a pidfile and module run-state
 * comes from the supervisor (`supervisor.list()`), not from here. This reader
 * survives so the `migrate` detector (`hasPriorDetachedInstall`) can still
 * recognize a pre-cutover box, and so `serve` / `parachute stop hub` can find a
 * serve-mode hub's own `hub` pidfile.
 *
 * - `running` — PID file present, `kill(pid, 0)` succeeds.
 * - `stopped` — PID file present, process gone (stale pidfile, or cleanly shut down).
 * - `unknown` — no PID file. In a supervised install this is the normal case
 *   for modules (no pidfile is written); the "externally-managed / legacy
 *   launchd-era" reading is now purely about detecting a *prior detached*
 *   install, not a live signal. Don't claim stopped.
 */
export interface ProcessState {
  status: "running" | "stopped" | "unknown";
  pid?: number;
  /** mtime of the PID file — a stand-in for "process start time". */
  startedAt?: Date;
}

export function processState(
  svc: string,
  configDir: string = CONFIG_DIR,
  alive: AliveFn = defaultAlive,
): ProcessState {
  const pid = readPid(svc, configDir);
  if (pid === undefined) return { status: "unknown" };
  if (!alive(pid)) return { status: "stopped", pid };
  const p = pidPath(svc, configDir);
  const startedAt = existsSync(p) ? statSync(p).mtime : undefined;
  return { status: "running", pid, startedAt };
}

/** Human-friendly uptime like "2h 13m" / "4d 6h" / "45s". */
export function formatUptime(startedAt: Date, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - startedAt.getTime());
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
