import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_DIR } from "../config.ts";
import { knownServices } from "../service-spec.ts";

/**
 * `parachute migrate` — sweep unrecognized entries at the ecosystem root
 * (`~/.parachute/`) into a dated archive directory so pre-restructure cruft
 * doesn't confuse beta installs.
 *
 * Archive, never delete: moved under `.archive-<YYYY-MM-DD>/` so anything
 * swept is recoverable. Dotfiles and the recognized top-level entries
 * (service dirs, services.json, expose-state.json, well-known/) are left
 * alone. Content *inside* service dirs is owned by that service's own
 * migration.
 */

export const ARCHIVE_PREFIX = ".archive-";

/**
 * Top-level names we keep in place. Service dirs derive from
 * `knownServices()` so adding a service doesn't require touching migrate;
 * `hub` is added explicitly since it's an internal-only lifecycle dir not
 * in SERVICE_SPECS.
 *
 * `lens` is kept across the Notes→Lens→Notes rename round-trip
 * (Apr 19 → Apr 22): users who installed during the brief Lens window
 * have `~/.parachute/lens/` dirs that shouldn't get swept into
 * `.archive-*` on upgrade. Safe to remove once launch users have all
 * had a chance to re-install under the restored name.
 */
export function safelistEntries(): Set<string> {
  return new Set<string>([
    ...knownServices(),
    "lens",
    "hub",
    "hub.db",
    // SQLite WAL-mode companion files. Created automatically when hub
    // opens the DB in WAL mode and removed on clean close. Catching them
    // by exact name covers the steady-state shape; a future SQLite mode
    // change would surface them again here.
    "hub.db-wal",
    "hub.db-shm",
    "services.json",
    "expose-state.json",
    "well-known",
  ]);
}

/**
 * Friendly labels for entries we've seen in the wild. Matched by exact name
 * or (for sqlite companion files) by prefix. Purely cosmetic — drives the
 * annotation column in the plan printout.
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

function annotationFor(name: string): string | undefined {
  for (const rule of KNOWN_CRUFT) if (rule.match(name)) return rule.label;
  return undefined;
}

export interface ArchiveItem {
  name: string;
  absPath: string;
  kind: "file" | "dir";
  bytes: number;
  annotation?: string;
}

export interface ArchivePlan {
  archiveDirName: string;
  archiveDir: string;
  items: ArchiveItem[];
  totalBytes: number;
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
 * Inspect the ecosystem root and build a plan. Pure-ish: reads filesystem
 * but never mutates. Returns zero-length items when nothing is archivable.
 *
 * Rule: skip anything starting with "." (dotfiles are the user's — `.env`,
 * `.DS_Store`, prior `.archive-*` dirs, etc.) and anything in the safelist.
 */
export function planArchive(configDir: string, now: Date): ArchivePlan {
  const dirName = archiveDirName(now);
  const archiveDir = join(configDir, dirName);
  const plan: ArchivePlan = {
    archiveDirName: dirName,
    archiveDir,
    items: [],
    totalBytes: 0,
  };
  if (!existsSync(configDir)) return plan;

  const safelist = safelistEntries();
  const entries = readdirSync(configDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (safelist.has(entry.name)) continue;
    const abs = join(configDir, entry.name);
    // Dirent.isDirectory() follows symlinks on macOS/Linux — so a link
    // pointing at an external tree would get sized via sizeOf() (bogus
    // byte count, and potentially a slow walk through /mnt/... or similar).
    // Classify the link itself as a zero-byte "file"; renameSync moves the
    // link, not the target, which is the behavior we want.
    if (entry.isSymbolicLink()) {
      plan.items.push({
        name: entry.name,
        absPath: abs,
        kind: "file",
        bytes: 0,
        annotation: annotationFor(entry.name),
      });
      continue;
    }
    const bytes = sizeOf(abs);
    plan.items.push({
      name: entry.name,
      absPath: abs,
      kind: entry.isDirectory() ? "dir" : "file",
      bytes,
      annotation: annotationFor(entry.name),
    });
    plan.totalBytes += bytes;
  }
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

function formatPlan(plan: ArchivePlan): string[] {
  const lines: string[] = [];
  lines.push(
    `Will archive: ${plan.items.length} item${plan.items.length === 1 ? "" : "s"} (${formatBytes(plan.totalBytes)}) → ${plan.archiveDirName}/`,
  );
  for (const item of plan.items) {
    const kindMark = item.kind === "dir" ? "/" : "";
    const note = item.annotation ? `  — ${item.annotation}` : "";
    lines.push(`  ${item.name}${kindMark}  (${formatBytes(item.bytes)})${note}`);
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

export interface MigrateOpts {
  configDir?: string;
  now?: () => Date;
  log?: (line: string) => void;
  prompt?: (question: string) => Promise<string>;
  dryRun?: boolean;
  yes?: boolean;
}

export async function migrate(opts: MigrateOpts = {}): Promise<number> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const now = (opts.now ?? (() => new Date()))();
  const log = opts.log ?? ((line) => console.log(line));
  const prompt = opts.prompt ?? defaultPrompt;
  const dryRun = opts.dryRun ?? false;
  const yes = opts.yes ?? false;

  const plan = planArchive(configDir, now);
  if (plan.items.length === 0) {
    log(`Nothing to archive. ${configDir} is already clean.`);
    return 0;
  }

  for (const line of formatPlan(plan)) log(line);

  if (dryRun) {
    log("(dry-run — no changes made)");
    return 0;
  }

  if (!yes) {
    const answer = (await prompt("Proceed? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      log("Aborted.");
      return 1;
    }
  }

  mkdirSync(plan.archiveDir, { recursive: true });
  for (const item of plan.items) {
    const dest = resolveDest(plan.archiveDir, item.name, now);
    renameSync(item.absPath, dest);
  }
  log(
    `✓ Archived ${plan.items.length} item${plan.items.length === 1 ? "" : "s"} to ${plan.archiveDirName}/`,
  );
  return 0;
}

/**
 * One-line notice for contexts where migrate is *not* what the user
 * asked for (e.g., after `parachute install`). Returns undefined when
 * there's nothing archivable so callers can branch on truthy/falsy.
 */
export function migrateNotice(configDir: string, now: Date): string | undefined {
  const plan = planArchive(configDir, now);
  if (plan.items.length === 0) return undefined;
  return `parachute migrate: ${plan.items.length} unrecognized entr${plan.items.length === 1 ? "y" : "ies"} at ecosystem root — run 'parachute migrate' to archive.`;
}
