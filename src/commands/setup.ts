import { createInterface } from "node:readline/promises";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import {
  FIRST_PARTY_FALLBACKS,
  KNOWN_MODULES,
  type ServiceSpec,
  composeServiceSpec,
  focusForShort,
  isRetiredShort,
  knownServices,
} from "../service-spec.ts";
import type { ServiceEntry } from "../services-manifest.ts";
import { findService } from "../services-manifest.ts";
import { type InstallOpts, install } from "./install.ts";
/**
 * Whether an interactive prompt is possible. Lived in
 * `scribe-provider-interactive.ts` until scribe's retirement (hub#809) deleted
 * that module; it's a generic prompt seam with nothing scribe-specific about
 * it, so it moves here — its only remaining consumer.
 */
export type InteractiveAvailability =
  | { kind: "available"; prompt: (question: string) => Promise<string> }
  | { kind: "not-tty" };

/**
 * `parachute setup` — unified, prompt-up-front walk-through that orchestrates
 * the existing per-service install flows behind a single command.
 *
 * Shape (closes #45):
 *   1. Detect what's already in services.json.
 *   2. Multi-select prompt: which uninstalled services to install (default
 *      all). Already-installed services aren't offered — re-running setup is
 *      idempotent.
 *   3. Per-service follow-ups asked **before** any install runs, so the
 *      operator answers everything in one sitting instead of stopping mid-
 *      stream:
 *        - vault   → vault name (default: "default")
 *        - scribe  → transcription provider + (cloud-only) API key
 *        - notes   → nothing extra
 *   4. Iterate `install(short, opts)` per pick with the pre-collected
 *      answers threaded through. Reuses every existing seam: bun add, init,
 *      port assignment, services.json seed, auto-wire, footer.
 *   5. Final summary banner with running URLs + a "try Claude Code" hint.
 *
 * Errors in one service don't roll back earlier ones — partial setup beats
 * losing already-working installs. The caller sees a non-zero exit code if
 * any step failed; the rest of the work still landed.
 *
 * Existing `parachute install <svc>` keeps working — setup is additive.
 */

export interface SetupOpts {
  manifestPath?: string;
  configDir?: string;
  log?: (line: string) => void;
  /** Test seam: drives every prompt. Defaults to a real readline against the TTY. */
  availability?: InteractiveAvailability;
  /** Test seam: replaces the per-service `install()` call. */
  installFn?: (input: string, installOpts: InstallOpts) => Promise<number>;
  /** Test seam: extra opts merged into every `install()` call (runner, port probe, …). */
  baseInstallOpts?: Partial<InstallOpts>;
  /** Forwarded to install(): npm dist-tag for `bun add -g <pkg>@<tag>`. */
  tag?: string;
  /** Forwarded to install(): skip auto-start. */
  noStart?: boolean;
}

/**
 * Survey row. Pre-install we know manifestName + the optional
 * `urlForEntry` quirk (vault wants `/mcp`, scribe wants the bare port); the
 * full ServiceSpec only exists post-install for KNOWN_MODULES shorts
 * (vault / scribe / … — hub#310). The survey uses just these two
 * fields, so a minimal shape avoids the spec round-trip pre-install.
 */
interface ServiceChoice {
  short: string;
  installed: boolean;
  manifestName: string;
  /** Per-service URL composer used in the final-summary banner. Optional. */
  urlForEntry?: (entry: ServiceEntry) => string | undefined;
  /** Full spec when available (FIRST_PARTY_FALLBACKS shorts: notes). */
  spec?: ServiceSpec;
}

interface VaultAnswer {
  vaultName: string;
}

// Reject leading and trailing hyphens. The previous form `[a-z0-9][a-z0-9-]*`
// permitted `my-vault-` which round-trips poorly through path segments and
// some shells. Single-char names (`a`, `7`) stay legal.
const VAULT_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function defaultAvailability(): InteractiveAvailability {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return { kind: "not-tty" };
  return {
    kind: "available",
    prompt: async (question: string) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * Survey ALL known first-party shortnames (vault / notes / scribe / agent /
 * surface / app) regardless of tier — `installed` is true when the service
 * has a row in services.json. The fresh-install OFFER is narrowed downstream
 * by `isOfferable` (drops already-installed + `deprecated`-tier shorts —
 * notes); agent (`experimental`) is flagged exploratory in its blurb
 * but stays offered. Surveying everything keeps `installed` detection complete
 * (the "already installed" banner still lists a deprecated module an operator
 * has on disk). A legacy `parachute-runner` row is NOT surveyed (runner left
 * the registries 2026-07-01 — see the KNOWN_MODULES note in service-spec.ts);
 * like any unknown row it neither blocks setup nor appears in the offer.
 *
 * The full ServiceSpec is only available pre-install for FIRST_PARTY_FALLBACKS
 * shorts (notes / app — both carry a vendored manifest). KNOWN_MODULES shorts
 * (vault / scribe / agent / surface) ship `.parachute/module.json`
 * and self-register; pre-install we know manifestName + the urlForEntry quirk
 * from `KNOWN_MODULES[short].extras`, which is all the survey/summary needs.
 */
function surveyServices(manifestPath: string): ServiceChoice[] {
  return knownServices().map((short) => {
    const fb = FIRST_PARTY_FALLBACKS[short];
    if (fb) {
      const spec = composeServiceSpec({
        packageName: fb.package,
        manifest: fb.manifest,
        extras: fb.extras,
      });
      const choice: ServiceChoice = {
        short,
        manifestName: spec.manifestName,
        spec,
        installed: !!findService(spec.manifestName, manifestPath),
      };
      if (spec.urlForEntry) choice.urlForEntry = spec.urlForEntry;
      return choice;
    }
    const km = KNOWN_MODULES[short];
    if (!km) throw new Error(`setup: unexpected first-party shortname ${short}`);
    const choice: ServiceChoice = {
      short,
      manifestName: km.manifestName,
      installed: !!findService(km.manifestName, manifestPath),
    };
    if (km.extras?.urlForEntry) choice.urlForEntry = km.extras.urlForEntry;
    return choice;
  });
}

/**
 * A surveyed service is OFFERED on a fresh setup iff it is not already
 * installed, is not RETIRED, and its discovery tier is not `deprecated`.
 *
 * Retired (hub#788 — notes, scribe) is the stronger of the two exclusions and
 * the one that actually matters now: a retired module stays resolvable and
 * manageable for an existing install but must never appear in a list of things
 * to add. The `deprecated` tier remains for a module that's on its way out but
 * still installable. `agent` (`experimental`) is still offered.
 */
export function isOfferable(choice: { short: string; installed: boolean }): boolean {
  if (choice.installed) return false;
  if (isRetiredShort(choice.short)) return false;
  // No `declared` arg: the survey fires PRE-install, before any module.json is
  // on disk to read a self-declared `focus` from — so the static default map is
  // the only signal available + the right one here.
  return focusForShort(choice.short) !== "deprecated";
}

const BLURBS: Record<string, string> = {
  vault: "knowledge graph (MCP) — your owner-authenticated note + tag store",
  surface: "host for custom Parachute surfaces (SDK + build-on-push)",
  // hub-parity P5 (2026-07-11): `app` is now the NEW super-surface front
  // door (@openparachute/app) — a real FIRST_PARTY_FALLBACKS
  // entry, not a legacy survey row. It is UNRELATED to the pre-2026-05-27
  // `app` package that renamed to `surface` (that blurb lives under the
  // `surface` key above); the two just happen to share the short name
  // across a rename.
  app: "the super-surface front door — one app to sign in, browse your vault, and manage your hub/cloud",
  // notes is `deprecated` (not offered on a fresh setup) — this blurb only
  // renders if a legacy install surfaces it in the survey.
  notes: "Notes PWA — web/mobile UI on top of vault (notes-daemon; superseded by `surface`)",
};

function blurbFor(choice: ServiceChoice): string {
  return BLURBS[choice.short] ?? choice.manifestName;
}

/**
 * Parse the user's pick string into a list of indices into `offered`.
 * Accepts:
 *   - empty / whitespace        → every offered service (the "Enter for all" path)
 *   - "all"                     → every offered service
 *   - "1,3" or "1 3" or "1, 3"  → those specific 1-based indices
 *   - "vault,scribe"            → those specific shortnames (matched against `offered`)
 *
 * Unknown tokens raise an error string the caller surfaces — no silent
 * dropouts.
 */
export function parseServicePicks(
  raw: string,
  offered: ServiceChoice[],
): { picks: ServiceChoice[] } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "all") {
    return { picks: [...offered] };
  }
  const tokens = trimmed
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const picks: ServiceChoice[] = [];
  const seen = new Set<string>();
  for (const tok of tokens) {
    let match: ServiceChoice | undefined;
    if (/^\d+$/.test(tok)) {
      const idx = Number.parseInt(tok, 10) - 1;
      if (idx < 0 || idx >= offered.length) {
        return { error: `out-of-range index "${tok}" (offered 1..${offered.length})` };
      }
      match = offered[idx];
    } else {
      match = offered.find((c) => c.short === tok.toLowerCase());
      if (!match) return { error: `unknown service "${tok}"` };
    }
    if (match && !seen.has(match.short)) {
      picks.push(match);
      seen.add(match.short);
    }
  }
  return { picks };
}

async function askVaultName(
  prompt: (q: string) => Promise<string>,
  log: (line: string) => void,
): Promise<VaultAnswer> {
  for (;;) {
    const raw = (await prompt("vault — name (default: default): ")).trim();
    const candidate = raw.length === 0 ? "default" : raw;
    if (VAULT_NAME_RE.test(candidate)) return { vaultName: candidate };
    log(
      `  invalid name "${candidate}" — must start with [a-z0-9] and contain only [a-z0-9-]. Try again.`,
    );
  }
}

function summarizeUrls(
  manifestPath: string,
  picks: ServiceChoice[],
  log: (line: string) => void,
): void {
  log("");
  log("Setup complete.");
  log("");
  for (const choice of picks) {
    const entry = findService(choice.manifestName, manifestPath);
    if (!entry) {
      log(`  ⚠ ${choice.manifestName} not in services.json — re-run install if expected`);
      continue;
    }
    const url = choice.urlForEntry?.(entry);
    log(`  ✓ ${entry.name}${url ? ` — ${url}` : ""}`);
  }
  log("");
  log(
    "Discovery: ~/.parachute/services.json (CLI) and the hub's /.well-known/parachute.json (HTTP).",
  );
  log("");
  log("Next: open Claude Code and try");
  log('  claude "Hello, can you help me set up my Parachute vault?"');
}

export async function setup(opts: SetupOpts = {}): Promise<number> {
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const log = opts.log ?? ((line) => console.log(line));
  const availability = opts.availability ?? defaultAvailability();
  const installFn = opts.installFn ?? install;

  log("Welcome to Parachute setup.");
  log("");
  log("This walks you through installing the Parachute services and configuring");
  log("them for first use. Existing installs are detected and skipped.");
  log("");

  const survey = surveyServices(manifestPath);
  const installed = survey.filter((s) => s.installed);
  const offered = survey.filter(isOfferable);

  if (installed.length > 0) {
    log("Already installed:");
    for (const s of installed) log(`  ✓ ${s.short}`);
    log("");
  }

  if (offered.length === 0) {
    log("All known services are already installed. Nothing to do.");
    return 0;
  }

  if (availability.kind !== "available") {
    log(
      "Non-interactive shell — `parachute setup` needs a TTY. Run interactively, or use `parachute install <svc>` directly.",
    );
    return 1;
  }
  const prompt = availability.prompt;

  log("Available to install:");
  for (let i = 0; i < offered.length; i++) {
    const c = offered[i];
    if (!c) continue;
    log(`  [${i + 1}] ${c.short.padEnd(8)} — ${blurbFor(c)}`);
  }
  log("");

  let picks: ServiceChoice[] | undefined;
  while (!picks) {
    const raw = await prompt("Which to install? (numbers/names, comma-separated; Enter for all): ");
    const result = parseServicePicks(raw, offered);
    if ("error" in result) {
      log(`  ${result.error}`);
      continue;
    }
    if (result.picks.length === 0) {
      log("  no services picked — try again");
      continue;
    }
    picks = result.picks;
  }

  // Pre-collect per-service answers so the operator sits through one batch
  // of questions instead of mid-stream interruptions.
  const vaultPick = picks.find((p) => p.short === "vault");

  let vaultAnswer: VaultAnswer | undefined;
  if (vaultPick) {
    log("");
    vaultAnswer = await askVaultName(prompt, log);
  }

  log("");
  log("Configuring…");
  log("");

  let firstFailure = 0;
  for (const choice of picks) {
    log(`— ${choice.short} —`);
    const installOpts: InstallOpts = { manifestPath, configDir, log, ...opts.baseInstallOpts };
    if (opts.tag !== undefined) installOpts.tag = opts.tag;
    if (opts.noStart) installOpts.noStart = true;
    if (choice.short === "vault" && vaultAnswer) {
      installOpts.vaultName = vaultAnswer.vaultName;
    }
    const code = await installFn(choice.short, installOpts);
    if (code !== 0 && firstFailure === 0) firstFailure = code;
    log("");
  }

  if (firstFailure !== 0) {
    log(`⚠ One or more installs returned a non-zero exit code (${firstFailure}).`);
    log("  Re-run `parachute install <svc>` for the failing service to retry.");
    return firstFailure;
  }

  summarizeUrls(manifestPath, picks, log);
  return 0;
}
