/**
 * `parachute uninstall <service>` — remove a module from this box.
 *
 * ## Why this exists
 *
 * Retirement told operators to run a command that didn't exist. Both retired
 * modules' notes end with "remove the row with `parachute uninstall <name>`",
 * and the CLI answered `unknown command "uninstall"`. The operation itself was
 * real the whole time — `POST /api/modules/:short/uninstall`, driven by the
 * admin UI — it simply had no terminal surface, so anyone following the advice
 * on a headless box hit a dead end with no second suggestion.
 *
 * That's the shape of the gap this closes: a retired module is precisely the
 * one an operator wants gone, and retirement is precisely when the *web* UI is
 * least likely to be the tool they reach for.
 *
 * ## A thin caller, deliberately
 *
 * This does NOT reimplement removal. It drives the same hub endpoint the admin
 * UI does, via {@link driveModuleOp}, so stop-child → drop-row → `bun remove -g`
 * → refresh-well-known stays one implementation with one set of idempotency
 * guarantees. A CLI-local copy would drift, and the failure mode of drift here
 * is a half-removed module: no row, but still supervised, or removed from disk
 * while `/.well-known` still advertises it.
 *
 * The cost is that uninstall requires a RUNNING hub. That's a real constraint
 * and it's surfaced explicitly rather than papered over with a filesystem
 * fallback — a fallback would be a second implementation wearing a disguise,
 * and it would run exactly when the supervisor can't be told to let go of the
 * child it's still restarting.
 */

import type { Database } from "bun:sqlite";
import { specFor } from "../api-modules-ops.ts";
import { configDir as defaultConfigDir } from "../config.ts";
import { readHubPort } from "../hub-control.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { HUB_UNIT_DEFAULT_PORT } from "../hub-unit.ts";
import {
  type DriveModuleOpDeps,
  type ModuleOp,
  ModuleOpHttpError,
  type ModuleOpResult,
  NoOperatorTokenError,
  OperatorTokenExpiredError,
  driveModuleOp as driveModuleOpImpl,
} from "../module-ops-client.ts";
import { isKnownModuleShort, knownServices } from "../service-spec.ts";

export interface UninstallOpts {
  /** Skip the confirmation prompt. Required when stdin isn't a TTY. */
  yes?: boolean;
  /** Seams (tests inject; production omits). */
  driveModuleOp?: (short: string, op: ModuleOp, deps: DriveModuleOpDeps) => Promise<ModuleOpResult>;
  openDb?: (configDir: string) => Database;
  configDir?: string;
  baseUrl?: string;
  /** Confirmation seam — returns true to proceed. */
  confirm?: (question: string) => Promise<boolean>;
  log?: (line: string) => void;
  isTTY?: boolean;
}

/**
 * Ask before destroying. Uses readline over `Bun.stdin` rather than the global
 * `confirm()`, which BLOCKS Bun's event loop — fine in a REPL, deadlock-prone
 * in a command that also awaits HTTP.
 */
async function defaultConfirm(question: string): Promise<boolean> {
  process.stdout.write(question);
  for await (const line of console) {
    return /^y(es)?$/i.test(line.trim());
  }
  return false;
}

/**
 * Names to suggest. Deliberately KNOWN, not discoverable/installable: retired
 * modules are valid uninstall targets, so omitting them here would tell an
 * operator that `scribe` is unknown one line after the retirement note told
 * them to uninstall it.
 */
function removableList(): string {
  return knownServices().join(" | ");
}

/** The issuer the operator token validates against — mirrors status.ts. */
function operatorTokenIssuer(configDir: string): string {
  return `http://127.0.0.1:${readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT}`;
}

export async function uninstall(
  service: string | undefined,
  opts: UninstallOpts = {},
): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));

  if (!service) {
    console.error("parachute uninstall: which service?\n");
    console.error(`  parachute uninstall <${removableList()}>`);
    return 1;
  }

  // Retired modules must stay uninstallable — that's the whole point. So this
  // validates against KNOWN, not INSTALLABLE; `isInstallableShort` would reject
  // exactly the modules an operator most needs to remove.
  if (!isKnownModuleShort(service)) {
    console.error(`parachute uninstall: unknown service "${service}".`);
    console.error(`Known services: ${removableList()}`);
    return 1;
  }

  const spec = specFor(service);
  const configDir = opts.configDir ?? defaultConfigDir();
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);

  if (!opts.yes) {
    if (!isTTY) {
      // Never prompt into a pipe: the read returns EOF immediately, which a
      // naive default would read as a "yes" and silently uninstall in a script.
      console.error(
        `parachute uninstall: refusing to uninstall ${service} without a confirmation.
stdin is not a terminal — pass --yes to confirm non-interactively.`,
      );
      return 1;
    }
    const ok = await (opts.confirm ?? defaultConfirm)(
      `Uninstall ${service}? This stops it, removes its services.json row,\n` +
        `and runs \`bun remove -g ${spec.package}\`. Vault data is NOT touched. [y/N] `,
    );
    if (!ok) {
      log("Nothing changed.");
      return 1;
    }
  }

  const drive = opts.driveModuleOp ?? driveModuleOpImpl;
  const openDb = opts.openDb ?? ((dir: string) => openHubDb(hubDbPath(dir)));
  const db = openDb(configDir);
  try {
    const result = await drive(service, "uninstall", {
      db,
      issuer: operatorTokenIssuer(configDir),
      configDir,
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    });
    // Print the server's own per-step log rather than a summary of our own —
    // it's the record of what actually happened, including the "already gone"
    // steps that make the op idempotent.
    const steps = (result.body as { log?: unknown } | undefined)?.log;
    if (Array.isArray(steps)) for (const s of steps) log(`  ${String(s)}`);
    log(`✓ ${service} uninstalled.`);
    return 0;
  } catch (err) {
    if (err instanceof NoOperatorTokenError) {
      console.error(
        "parachute uninstall: no operator token on this box.\n" +
          "Run `parachute auth rotate-operator` (or `parachute auth set-password` first, on a fresh box).",
      );
      return 1;
    }
    if (err instanceof OperatorTokenExpiredError) {
      console.error(`parachute uninstall: ${err.message}`);
      return 1;
    }
    if (err instanceof ModuleOpHttpError) {
      console.error(`parachute uninstall: hub returned ${err.status} — ${err.message}`);
      return 1;
    }
    // The common one: hub isn't running, so the loopback POST connection-refuses.
    // Say that plainly, because "fetch failed" reads as a network bug rather
    // than "start the thing that owns this operation".
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `parachute uninstall: couldn't reach the hub — ${detail}
Uninstall is driven by the running hub (it has to stop the supervised child first).
Start it with \`parachute start\` and try again.`,
    );
    return 1;
  } finally {
    db.close();
  }
}
