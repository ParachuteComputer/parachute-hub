import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { HUB_SVC } from "../hub-control.ts";
import {
  type HubUnitDeps,
  type HubUnitState,
  defaultHubUnitDeps,
  queryHubUnitState,
} from "../hub-unit.ts";
import { type AliveFn, defaultAlive, processState } from "../process-state.ts";
import { knownServices, shortNameForManifest } from "../service-spec.ts";
import { readManifestLenient } from "../services-manifest.ts";

/**
 * `parachute migrate` — sweep known-cruft entries at the ecosystem root
 * (`~/.parachute/`) into a dated archive directory so pre-restructure cruft
 * doesn't confuse beta installs.
 *
 * Allowlist-of-what-to-archive (the original 2026-05-27 redesign closed
 * the prior blocklist-with-safelist shape, hub#440). The risk with the
 * older shape: anything new appearing at the ecosystem root (a future
 * module's dir, `hub.db`, a user's own dotfile, etc.) would get swept by
 * default unless someone remembered to add it to the safelist. Aaron
 * caught a near-miss where `hub.db` was missing from the safelist; that
 * was the trigger for flipping the model.
 *
 * The new model:
 *
 *   - `KNOWN_CRUFT` is the *actual archive criterion* — only entries that
 *     match a rule there get archived.
 *   - `KNOWN_ARCHIVABLE_DIRS` covers directories we explicitly sweep (the
 *     `lens` legacy dir from the Notes→Lens→Notes rename round-trip).
 *   - Everything else — including new modules' dirs, future state files,
 *     and the user's own stray files — gets a `[unknown — skipping]`
 *     annotation and is left in place. The user can remove unknowns
 *     manually if they want.
 *
 * Archive, never delete: moved under `.archive-<YYYY-MM-DD>/` so anything
 * swept is recoverable. Dotfiles at root are still left alone (the user's
 * own `.env`, `.DS_Store`, prior `.archive-*` dirs).
 *
 * Cut-2 safety procedures (also 2026-05-27):
 *
 *   - Refuses to sweep while any service in `services.json` (plus the hub)
 *     is currently running — moving a path a daemon owns would corrupt
 *     state.
 *   - SQLite-shaped files (`*.db`, `*.db-wal`, `*.db-shm`) get a `[live-db]`
 *     risk label and trigger an extra confirmation noting wal/shm
 *     consistency.
 *   - The printed plan annotates each item `[safe]` / `[live-db]` /
 *     `[unknown — skipping]`, sorts skipped items last.
 *   - Non-TTY invocations refuse without `--yes` so a pipe from CI can't
 *     accidentally archive a real install.
 *   - `--list` shows what would happen without prompting (friendlier
 *     phrasing of `--dry-run`).
 */

export const ARCHIVE_PREFIX = ".archive-";

/**
 * Top-level names we leave in place. Service dirs derive from
 * `knownServices()`; `hub` is added explicitly since it's an internal-only
 * lifecycle dir not in SERVICE_SPECS. Stays in step with the rest of the
 * hub's view of what belongs at the root, so `migrateNotice` and
 * `parachute install`'s post-install hint don't false-positive on the
 * latest legitimate root entries.
 *
 * Note: under the allowlist model the safelist is now informational —
 * archiving only ever happens for entries that match an explicit rule
 * (`KNOWN_CRUFT` / `KNOWN_ARCHIVABLE_DIRS`). The safelist is still
 * retained so `migrateNotice`'s count of "things at the root that aren't
 * recognized" stays meaningful, and so safelisted entries don't show up
 * as `[unknown — skipping]` noise in the plan.
 */
export function safelistEntries(): Set<string> {
  return new Set<string>([
    ...knownServices(),
    "hub",
    "services.json",
    "expose-state.json",
    "cloudflared-state.json",
    "hub.db",
    "hub.db-wal",
    "hub.db-shm",
    "well-known",
    "cloudflared",
  ]);
}

/**
 * Allowlist of known-archivable directories. Distinct from `KNOWN_CRUFT`
 * (which matches by name/prefix predicate) — directories listed here are
 * always treated as `safe` to archive.
 *
 * `lens` is the only entry: a legacy directory left over from the brief
 * Notes→Lens→Notes rename round-trip (2026-04-19 → 2026-04-22). Users who
 * installed during that window have `~/.parachute/lens/` dirs that should
 * be archived now that the rename is finished. Safe to drop from this
 * list once enough operator cycles have passed to be confident no
 * install is still on the Lens-era code path.
 */
export const KNOWN_ARCHIVABLE_DIRS: ReadonlySet<string> = new Set<string>(["lens"]);

/**
 * Known-cruft rules. Each rule names a label (the friendly description in
 * the plan) and a predicate that matches by name or prefix. Under the
 * 2026-05-27 redesign this is the *primary* archive criterion: an entry
 * at the ecosystem root that doesn't match here (or `KNOWN_ARCHIVABLE_DIRS`)
 * is treated as unknown and left in place.
 */
const KNOWN_CRUFT: Array<{ match: (name: string) => boolean; label: string }> = [
  {
    match: (n) => n === "daily.db" || n.startsWith("daily.db-"),
    label: "legacy parachute-daily state",
  },
  { match: (n) => n === "server.yaml", label: "legacy server config" },
  { match: (n) => n === "channel.log" || n === "channel.err", label: "legacy channel logs" },
  { match: (n) => n === "channel.start.sh", label: "legacy channel launcher" },
  { match: (n) => n === "logs", label: "vestigial top-level logs dir" },
  {
    match: (n) => n === "tokens.db" || n.startsWith("tokens.db-"),
    label: "legacy top-level tokens db",
  },
];

function cruftLabel(name: string): string | undefined {
  for (const rule of KNOWN_CRUFT) if (rule.match(name)) return rule.label;
  return undefined;
}

/**
 * SQLite shape — `.db` plus its WAL/SHM companions. Files with this shape
 * carry the `live-db` risk label and pull a second confirmation in the
 * interactive path because the three files are only consistent as a set.
 */
function isSqliteShape(name: string): boolean {
  return /\.db(?:-wal|-shm)?$/.test(name);
}

export type RiskLabel = "safe" | "live-db" | "unknown";

export interface PlanItem {
  name: string;
  absPath: string;
  kind: "file" | "dir";
  bytes: number;
  /** Friendly description (e.g. "legacy parachute-daily state"). */
  annotation?: string;
  risk: RiskLabel;
  /** True iff this item will actually be moved into the archive. */
  archive: boolean;
}

/**
 * Kept as an alias for back-compat with callers / older tests that import
 * `ArchiveItem`. Same shape as `PlanItem`.
 */
export type ArchiveItem = PlanItem;

export interface ArchivePlan {
  archiveDirName: string;
  archiveDir: string;
  /** Every entry encountered at the root (archivable + skipped). */
  items: PlanItem[];
  /** Total bytes across `archive: true` items only. */
  totalBytes: number;
  /** True iff at least one `archive: true` item is a SQLite-shape file. */
  hasLiveDb: boolean;
}

function sizeOf(path: string): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += sizeOf(join(path, entry.name));
  }
  return total;
}

function archiveDirName(now: Date): string {
  return `${ARCHIVE_PREFIX}${now.toISOString().slice(0, 10)}`;
}

/**
 * Classify a single root entry against the allowlist + known-cruft rules.
 * `safelist` is the recognized-and-leave-alone set; nothing on it ever
 * reaches the plan at all (filtered out upstream).
 */
function classify(name: string): { risk: RiskLabel; annotation?: string; archive: boolean } {
  const cruft = cruftLabel(name);
  if (cruft) {
    const risk: RiskLabel = isSqliteShape(name) ? "live-db" : "safe";
    return { risk, annotation: cruft, archive: true };
  }
  if (KNOWN_ARCHIVABLE_DIRS.has(name)) {
    return { risk: "safe", annotation: "legacy directory", archive: true };
  }
  return { risk: "unknown", archive: false };
}

/**
 * Inspect the ecosystem root and build a plan. Pure-ish: reads filesystem
 * but never mutates. Returns zero-length items when nothing is at the root
 * beyond the safelist.
 *
 * Rule: skip anything starting with "." (dotfiles are the user's — `.env`,
 * `.DS_Store`, prior `.archive-*` dirs, etc.) and anything in the safelist.
 * Everything else goes into the plan with a classification; only items
 * with `archive: true` are actually swept.
 *
 * Sort order: archivable items first (alphabetical), then skipped items
 * last — keeps the "what will happen" reading at the top of the plan
 * printout.
 */
export function planArchive(configDir: string, now: Date): ArchivePlan {
  const dirName = archiveDirName(now);
  const archiveDir = join(configDir, dirName);
  const plan: ArchivePlan = {
    archiveDirName: dirName,
    archiveDir,
    items: [],
    totalBytes: 0,
    hasLiveDb: false,
  };
  if (!existsSync(configDir)) return plan;

  const safelist = safelistEntries();
  const entries = readdirSync(configDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const collected: PlanItem[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (safelist.has(entry.name)) continue;
    const abs = join(configDir, entry.name);
    const cls = classify(entry.name);
    // Dirent.isDirectory() follows symlinks on macOS/Linux — so a link
    // pointing at an external tree would get sized via sizeOf() (bogus
    // byte count, and potentially a slow walk through /mnt/... or similar).
    // Classify the link itself as a zero-byte "file"; renameSync moves the
    // link, not the target, which is the behavior we want.
    if (entry.isSymbolicLink()) {
      const item: PlanItem = {
        name: entry.name,
        absPath: abs,
        kind: "file",
        bytes: 0,
        risk: cls.risk,
        archive: cls.archive,
      };
      if (cls.annotation !== undefined) item.annotation = cls.annotation;
      collected.push(item);
      continue;
    }
    const bytes = cls.archive ? sizeOf(abs) : 0;
    const item: PlanItem = {
      name: entry.name,
      absPath: abs,
      kind: entry.isDirectory() ? "dir" : "file",
      bytes,
      risk: cls.risk,
      archive: cls.archive,
    };
    if (cls.annotation !== undefined) item.annotation = cls.annotation;
    collected.push(item);
    if (cls.archive) plan.totalBytes += bytes;
  }
  // Sort: archivable first (alpha), then skipped (alpha). Stable across runs.
  collected.sort((a, b) => {
    if (a.archive !== b.archive) return a.archive ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  plan.items = collected;
  plan.hasLiveDb = collected.some((i) => i.archive && i.risk === "live-db");
  return plan;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function riskTag(item: PlanItem): string {
  if (!item.archive) return "[unknown — skipping]";
  if (item.risk === "live-db") return "[live-db]";
  return "[safe]";
}

function formatPlan(plan: ArchivePlan): string[] {
  const lines: string[] = [];
  const archivable = plan.items.filter((i) => i.archive);
  const skipped = plan.items.filter((i) => !i.archive);
  lines.push(
    `Will archive: ${archivable.length} item${archivable.length === 1 ? "" : "s"} (${formatBytes(plan.totalBytes)}) → ${plan.archiveDirName}/`,
  );
  for (const item of archivable) {
    const kindMark = item.kind === "dir" ? "/" : "";
    const note = item.annotation ? `  — ${item.annotation}` : "";
    lines.push(`  ${riskTag(item)} ${item.name}${kindMark}  (${formatBytes(item.bytes)})${note}`);
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push(
      `Leaving alone: ${skipped.length} unknown entr${skipped.length === 1 ? "y" : "ies"} at the root.`,
    );
    lines.push("  (I don't recognize these — they may be from a module hub doesn't know about,");
    lines.push("   or from your own setup. If they're safe to remove, you can do it manually.)");
    for (const item of skipped) {
      const kindMark = item.kind === "dir" ? "/" : "";
      lines.push(`  ${riskTag(item)} ${item.name}${kindMark}`);
    }
  }
  return lines;
}

/**
 * Pick a destination name inside the archive dir. If a prior sweep the same
 * day already archived the same name, suffix with `.dup-<epoch-ms>` so we
 * never clobber. Rare in practice.
 */
function resolveDest(archiveDir: string, name: string, now: Date): string {
  const target = join(archiveDir, name);
  if (!existsSync(target)) return target;
  return join(archiveDir, `${name}.dup-${now.getTime()}`);
}

export async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

/**
 * Hub-unit-state query seam for the archive guard (§7.3). Production uses the
 * real `queryHubUnitState` over `defaultHubUnitDeps`; tests inject a stub so the
 * unit-managed-hub-detected-as-running path is exercised without a live
 * systemctl/launchctl. Returns the platform manager's view of the hub unit.
 */
export type HubUnitStateQuery = (deps: HubUnitDeps) => { state: HubUnitState };

/**
 * The §7.3 archive-guard fix: a hub unit is "running, leave it alone" when the
 * platform manager reports it `active` or `activating`. `failed` / `inactive` /
 * `no-unit` / `no-manager` / `unknown` are NOT treated as running — those mean
 * the unit isn't actively holding state at this moment.
 *
 * Deliberately conservative on `unknown`: an unparseable manager response is
 * NOT a license to archive (that would re-introduce the silent fail-open), but
 * it's also not a clear "running" signal — so we fall through to the pidfile
 * check (which catches a detached-era hub) rather than blanket-refusing on a
 * transient manager hiccup. `active`/`activating` is the unambiguous unit-up
 * signal that the pidfile-only guard missed.
 */
function hubUnitReportsRunning(state: HubUnitState): boolean {
  return state === "active" || state === "activating";
}

/**
 * Probe whether any managed service (or the hub) is currently running.
 * Returns the list of short names that are live; an empty list means the
 * sweep is safe to proceed.
 *
 * Reads services.json leniently so a malformed entry doesn't block the
 * pre-flight (better to surface "running: vault" + a corrupt-entry warning
 * elsewhere than to refuse migration on an unrelated parsing problem).
 *
 * §7.3 archive-guard fix: the hub liveness check is BOTH the pidfile
 * (`processState(HUB_SVC)`, the detached-era signal) AND the platform manager
 * (`queryHubUnitState`, the unit-era signal). A unit-managed hub writes NO
 * pidfile, so `processState(HUB_SVC)` reports it not-running and the
 * refuse-while-running guard would silently FAIL OPEN — `migrate` could archive
 * `~/.parachute` out from under a live unit-managed hub. Querying the manager
 * too closes that hole: an `active`/`activating` hub unit is correctly detected
 * as running and the guard holds.
 */
export function listRunningServices(
  configDir: string,
  manifestPath: string,
  alive: AliveFn,
  hubUnitState: HubUnitStateQuery = queryHubUnitState,
  hubUnitDeps: HubUnitDeps = defaultHubUnitDeps,
): string[] {
  const running: string[] = [];
  // Detached-era signal: the hub pidfile.
  const hubState = processState(HUB_SVC, configDir, alive);
  let hubRunning = hubState.status === "running";
  // Unit-era signal (§7.3): the platform manager. A unit-managed hub has no
  // pidfile, so without this it would fail open. Never throws — `queryHubUnitState`
  // degrades to `unknown` on a manager hiccup; we only escalate to "running" on
  // an unambiguous active/activating.
  if (!hubRunning) {
    try {
      const unit = hubUnitState(hubUnitDeps);
      if (hubUnitReportsRunning(unit.state)) hubRunning = true;
    } catch {
      // A manager-query failure must not crash the guard — fall through. The
      // pidfile check already ran; treat an unqueryable manager as "no extra
      // signal," neither forcing-running nor opening the gate.
    }
  }
  if (hubRunning) running.push(HUB_SVC);
  let manifest: ReturnType<typeof readManifestLenient>;
  try {
    manifest = readManifestLenient(manifestPath);
  } catch {
    return running;
  }
  for (const entry of manifest.services) {
    const short = shortNameForManifest(entry.name) ?? entry.name;
    if (running.includes(short)) continue;
    const state = processState(short, configDir, alive);
    if (state.status === "running") running.push(short);
  }
  return running;
}

export interface MigrateOpts {
  configDir?: string;
  manifestPath?: string;
  now?: () => Date;
  log?: (line: string) => void;
  prompt?: (question: string) => Promise<string>;
  dryRun?: boolean;
  yes?: boolean;
  /** `--list` — synonym for `--dry-run` with a more discoverable flag name. */
  list?: boolean;
  /** Test seam: process-liveness check used by `listRunningServices`. */
  alive?: AliveFn;
  /**
   * Test seam: override the TTY check. Production reads
   * `process.stdin.isTTY`; tests pass `true`/`false` to drive the
   * non-interactive guard without manipulating real fds.
   */
  isTty?: boolean;
  /**
   * Test seam: the §7.3 platform-manager hub-unit-state query used by the
   * archive guard. Production uses `queryHubUnitState`; tests inject a stub to
   * exercise the unit-managed-hub-detected-as-running path without a live
   * systemctl/launchctl.
   */
  hubUnitState?: HubUnitStateQuery;
  /** Test seam: the hub-unit deps passed to `hubUnitState` (default production). */
  hubUnitDeps?: HubUnitDeps;
}

export async function migrate(opts: MigrateOpts = {}): Promise<number> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const now = (opts.now ?? (() => new Date()))();
  const log = opts.log ?? ((line) => console.log(line));
  const prompt = opts.prompt ?? defaultPrompt;
  const dryRun = (opts.dryRun ?? false) || (opts.list ?? false);
  const yes = opts.yes ?? false;
  const alive = opts.alive ?? defaultAlive;
  const isTty = opts.isTty ?? Boolean(process.stdin.isTTY);
  const hubUnitState = opts.hubUnitState ?? queryHubUnitState;
  const hubUnitDeps = opts.hubUnitDeps ?? defaultHubUnitDeps;

  // Refuse-while-running: archiving a path a live daemon owns can corrupt
  // its state. Print the runners and bail before we read the directory.
  // `--list` and `--dry-run` are read-only and skip this guard; the
  // operator may explicitly want to see what would move while things are
  // up.
  if (!dryRun) {
    const running = listRunningServices(configDir, manifestPath, alive, hubUnitState, hubUnitDeps);
    if (running.length > 0) {
      log("parachute migrate: services are currently running — refusing to sweep:");
      for (const short of running) log(`  - ${short}`);
      log("");
      log("Stop them first, then re-run:");
      log("  parachute stop");
      log("");
      log("Or preview the plan without changing anything:");
      log("  parachute migrate --list");
      return 1;
    }
  }

  const plan = planArchive(configDir, now);
  const archivable = plan.items.filter((i) => i.archive);
  if (plan.items.length === 0) {
    log(`Nothing to archive. ${configDir} is already clean.`);
    return 0;
  }

  for (const line of formatPlan(plan)) log(line);

  if (archivable.length === 0) {
    // Only unknowns at the root; nothing to do.
    log("");
    log("Nothing recognized to archive.");
    return 0;
  }

  if (dryRun) {
    log("");
    log(opts.list ? "(--list — no changes made)" : "(dry-run — no changes made)");
    return 0;
  }

  // Non-TTY without `--yes` is a hard refuse. A pipe from CI or a launchd
  // wrapper that lost its terminal shouldn't be able to silently archive
  // user state — prefer an actionable error.
  if (!isTty && !yes) {
    log("");
    log("parachute migrate: refusing to sweep without a TTY.");
    log("Run interactively, or pass `--yes` if you're certain. To preview:");
    log("  parachute migrate --list");
    return 1;
  }

  if (!yes) {
    const answer = (await prompt("Proceed? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      log("Aborted.");
      return 1;
    }
    // Extra confirmation when a SQLite-shape file is in the plan. The
    // wal/shm companions are only consistent with their .db when the
    // owning process is stopped (we already refused-while-running above,
    // so they are), but operators sometimes have ad-hoc backup tooling
    // that watches these — extra y/N is a cheap insurance against
    // surprise.
    if (plan.hasLiveDb) {
      log("");
      log("⚠ The plan includes SQLite-shape files (`*.db`, `*.db-wal`, `*.db-shm`).");
      log("  These three are only consistent as a set — the archive moves them together,");
      log("  but if anything outside Parachute is reading them (backup tooling, etc.),");
      log("  that consumer will see a missing file after the sweep.");
      const dbAnswer = (await prompt("Archive the live-db files too? [y/N] ")).trim().toLowerCase();
      if (dbAnswer !== "y" && dbAnswer !== "yes") {
        log("Aborted.");
        return 1;
      }
    }
  }

  mkdirSync(plan.archiveDir, { recursive: true });
  for (const item of archivable) {
    const dest = resolveDest(plan.archiveDir, item.name, now);
    renameSync(item.absPath, dest);
  }
  log(
    `✓ Archived ${archivable.length} item${archivable.length === 1 ? "" : "s"} to ${plan.archiveDirName}/`,
  );
  return 0;
}

/**
 * One-line notice for contexts where migrate is *not* what the user
 * asked for (e.g., after `parachute install`). Returns undefined when
 * there's nothing archivable so callers can branch on truthy/falsy.
 *
 * Counts only `archive: true` items — unknowns at the root don't trip
 * the notice (they're not actually candidates for sweeping; the user
 * sees them only when they explicitly run `parachute migrate`).
 */
export function migrateNotice(configDir: string, now: Date): string | undefined {
  const plan = planArchive(configDir, now);
  const archivable = plan.items.filter((i) => i.archive);
  if (archivable.length === 0) return undefined;
  return `parachute migrate: ${archivable.length} archivable entr${archivable.length === 1 ? "y" : "ies"} at ecosystem root — run 'parachute migrate' to archive.`;
}
