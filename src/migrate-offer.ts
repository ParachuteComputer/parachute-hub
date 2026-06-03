/**
 * §7.5 auto-detect-and-offer — the safety net that keeps a box that landed the
 * cutover code (via `bun add -g @openparachute/hub@<new>` / auto-upgrade) WITHOUT
 * running `parachute migrate --to-supervised` from silently going dead.
 *
 * Design `parachute.computer/design/2026-06-01-hub-as-supervisor-unification.md`
 * §7.5: the first time a lifecycle verb (start/stop/restart) runs and finds
 *   (a) NO hub unit installed, AND
 *   (b) evidence of a prior detached install (pidfiles / services.json),
 * it OFFERS to run the cutover (interactive prompt) or, in a non-interactive
 * context, PRINTS the exact command. It does NOT silently auto-migrate —
 * archiving / stopping services is destructive-adjacent, so this is
 * detect-and-offer only.
 *
 * This is the bridge's companion: Phase 5a keeps the detached spawners intact
 * (un-migrated boxes still work), and keeps the pidfile READERS so this detector
 * can see the old state. Phase 5b retires the spawners; the readers stay one
 * release longer precisely so this detector keeps working.
 *
 * EVERYTHING is behind injectable seams so tests drive the offer without a real
 * prompt, a real cutover, or touching the operator's `~/.parachute`.
 */

import { existsSync } from "node:fs";
// `migrate-cutover.ts` is imported as a TYPE only (erased at compile time, no
// module evaluation) and loaded LAZILY at the call site below. This breaks the
// transitive eager-load chain `cli.ts` → `lifecycle.ts` → `migrate-offer.ts` →
// `migrate-cutover.ts`: a broken `migrate-cutover` (e.g. the 0.6.2 eval-time
// ReferenceError) must not crash the start/stop/restart/logs lifecycle commands
// that pull in this module purely for the §7.5 detect-and-offer machinery. The
// cutover is only ever evaluated when an operator interactively accepts the
// offer, so deferring its import to that moment keeps the whole chain robust.
import type { CutoverOpts, CutoverResult } from "./commands/migrate-cutover.ts";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "./config.ts";
import { HUB_SVC } from "./hub-control.ts";
import { type HubUnitDeps, defaultHubUnitDeps, isHubUnitInstalled } from "./hub-unit.ts";
import { readPid } from "./process-state.ts";
import { shortNameForManifest } from "./service-spec.ts";
import { readManifestLenient } from "./services-manifest.ts";

/**
 * Detect evidence of a prior DETACHED install — the §7.5 (b) condition. True
 * when EITHER:
 *   - a hub pidfile exists (`~/.parachute/hub/run/hub.pid`) — the clearest
 *     detached-era fingerprint, written only by the detached `ensureHubRunning`
 *     spawn; OR
 *   - any services.json module has a pidfile (a module was `parachute start`-ed
 *     the detached way).
 *
 * services.json EXISTING alone is NOT enough — a freshly `init`-ed supervised
 * box also has a services.json. The discriminant is a PIDFILE, which only the
 * detached path writes (the supervised path tracks children in-process, no
 * pidfile). So this detects "a box that ran the detached daemons," not merely
 * "a box that has been configured."
 *
 * Pure read; never mutates. Uses `readPid` (a reader the bridge keeps).
 */
export function hasPriorDetachedInstall(
  configDir: string = CONFIG_DIR,
  manifestPath: string = SERVICES_MANIFEST_PATH,
): boolean {
  // Hub pidfile — the detached-era fingerprint.
  if (readPid(HUB_SVC, configDir) !== undefined) return true;
  // Any module pidfile.
  if (!existsSync(manifestPath)) return false;
  let services: ReturnType<typeof readManifestLenient>["services"];
  try {
    services = readManifestLenient(manifestPath).services;
  } catch {
    return false;
  }
  for (const entry of services) {
    const short = shortNameForManifest(entry.name) ?? entry.name;
    if (readPid(short, configDir) !== undefined) return true;
  }
  return false;
}

/**
 * The interactive-prompt seam (mirrors `migrate.ts`'s `defaultPrompt`). Tests
 * inject a stub; production reads a line from stdin.
 */
export type OfferPrompt = (question: string) => Promise<string>;

export async function defaultOfferPrompt(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

export interface MigrateOfferOpts {
  configDir?: string;
  manifestPath?: string;
  log?: (line: string) => void;
  /** Injectable: is a hub unit installed? (default real probe). */
  isHubUnitInstalled?: (deps: HubUnitDeps) => boolean;
  hubUnitDeps?: HubUnitDeps;
  /** Injectable: prior-detached-install detector (default `hasPriorDetachedInstall`). */
  hasPriorDetached?: (configDir: string, manifestPath: string) => boolean;
  /** Injectable: the cutover itself (default `cutoverToSupervised`). */
  cutover?: (opts: CutoverOpts) => Promise<CutoverResult>;
  /** Injectable interactive prompt (default reads stdin). */
  prompt?: OfferPrompt;
  /**
   * TTY override. Production reads `process.stdin.isTTY`; tests pass true/false
   * to drive the interactive-vs-print branch without manipulating real fds.
   */
  isTty?: boolean;
}

export type MigrateOfferOutcome =
  /** No offer was made (a unit is installed, or no prior-detached evidence). */
  | "no-offer"
  /** Interactive: the operator declined the offer. */
  | "declined"
  /** Non-interactive: we printed the exact command (didn't run it). */
  | "printed"
  /** Interactive: the operator accepted and the cutover succeeded. */
  | "migrated"
  /** Interactive: the operator accepted but the cutover failed (recoverable). */
  | "migrate-failed";

export interface MigrateOfferResult {
  outcome: MigrateOfferOutcome;
  /** The cutover result, when one ran. */
  cutover?: CutoverResult;
}

/**
 * §7.5 detect-and-offer. Call this from a lifecycle verb's detached arm (before
 * doing the detached work). Returns a structured outcome:
 *
 *   - `no-offer` — a hub unit IS installed (the supervised box; nothing to
 *     offer), or there's no prior-detached evidence (a clean box). The caller
 *     proceeds with whatever it was going to do.
 *   - interactive (TTY) — prompt; on yes, RUN the cutover and return `migrated`
 *     / `migrate-failed`; on no, return `declined`.
 *   - non-interactive (no TTY) — PRINT the exact command and return `printed`.
 *     NEVER auto-run in a non-TTY context (a cron/CI pipe must not stop services
 *     unprompted).
 *
 * It NEVER silently migrates: the only path that runs the cutover is an explicit
 * interactive "yes."
 */
export async function offerMigrateToSupervised(
  opts: MigrateOfferOpts = {},
): Promise<MigrateOfferResult> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const log = opts.log ?? ((line) => console.log(line));
  const unitInstalledFn = opts.isHubUnitInstalled ?? isHubUnitInstalled;
  const hubUnitDeps = opts.hubUnitDeps ?? defaultHubUnitDeps;
  const hasPriorDetached = opts.hasPriorDetached ?? hasPriorDetachedInstall;
  const prompt = opts.prompt ?? defaultOfferPrompt;
  const isTty = opts.isTty ?? Boolean(process.stdin.isTTY);

  // (a) no hub unit installed — only offer on the detached box.
  if (unitInstalledFn(hubUnitDeps)) return { outcome: "no-offer" };
  // (b) prior-detached evidence — don't pester a clean box.
  if (!hasPriorDetached(configDir, manifestPath)) return { outcome: "no-offer" };

  log("");
  log("This box is running the legacy detached model (independent daemons, no");
  log("process manager). The current Parachute hub runs supervised — `parachute");
  log("serve` under launchd/systemd, with reboot survival + UI module management.");

  if (!isTty) {
    // Non-interactive: print the exact command, never run it.
    log("");
    log("To migrate, run:");
    log("  parachute migrate --to-supervised");
    log("");
    return { outcome: "printed" };
  }

  // Interactive: offer to run it now.
  const answer = (await prompt("Migrate to the supervised model now? [y/N] ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    log("Skipped. Run `parachute migrate --to-supervised` when you're ready.");
    return { outcome: "declined" };
  }

  // Resolve the cutover lazily: only import `migrate-cutover.ts` now that the
  // operator has accepted, so the offer's mere availability never drags the
  // cutover module into the lifecycle-command load graph (see the `import type`
  // note at the top). Tests inject `opts.cutover` and never hit the import.
  const cutover =
    opts.cutover ?? (await import("./commands/migrate-cutover.ts")).cutoverToSupervised;
  const result = await cutover({ configDir, manifestPath, log });
  for (const line of result.messages) log(line);
  const ok = result.outcome === "migrated" || result.outcome === "already-migrated";
  return { outcome: ok ? "migrated" : "migrate-failed", cutover: result };
}
