import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { dirname, join } from "node:path";
import { parseEnvFile, upsertEnvLine, writeEnvFile } from "./env-file.ts";

/**
 * Reads / merges scribe's transcription provider into
 * `<configDir>/scribe/config.json` and writes the corresponding API key (when
 * the chosen provider needs one) into `<configDir>/scribe/.env`.
 *
 * Both files are merged in place so we never clobber unrelated keys — auto-wire
 * already owns `auth.required_token` in the same config, and operators
 * sometimes hand-edit other top-level blocks.
 */

/**
 * Transcription providers scribe ships with today (per `parachute-scribe`
 * 0.x README). Source-of-truth is intentionally hand-maintained on the CLI
 * side: the install prompt needs a curated, ordered list with platform
 * caveats for each option, which scribe's runtime registry doesn't surface.
 *
 * Drift caught by the test that asserts the keys here match scribe's
 * `availableProviders().transcription`.
 */
export const SCRIBE_PROVIDERS = [
  {
    key: "parakeet-mlx",
    label: "parakeet-mlx",
    blurb: "local, Apple Silicon, fastest — requires `parakeet-mlx` binary on PATH",
    apiKeyEnv: undefined,
  },
  {
    key: "onnx-asr",
    label: "onnx-asr",
    blurb: "local, cross-platform (Sherpa-ONNX)",
    apiKeyEnv: undefined,
  },
  {
    key: "whisper",
    label: "whisper",
    blurb:
      "local, any platform — requires `whisper-ctranslate2` (`pip install whisper-ctranslate2`)",
    apiKeyEnv: undefined,
  },
  {
    key: "groq",
    label: "groq",
    blurb: "cloud, generous free tier, very fast",
    apiKeyEnv: "GROQ_API_KEY",
  },
  {
    key: "openai",
    label: "openai",
    blurb: "cloud, paid, reference Whisper API",
    apiKeyEnv: "OPENAI_API_KEY",
  },
] as const;

export type ScribeProviderKey = (typeof SCRIBE_PROVIDERS)[number]["key"];

/** Default provider scribe falls back to when the config doesn't pick one. */
export const SCRIBE_DEFAULT_PROVIDER: ScribeProviderKey = "parakeet-mlx";

/**
 * Resolve the "local" choice to the CORRECT platform backend. The setup
 * wizard (browser + CLI) lets the operator pick "local" without knowing the
 * engine name; this picks the one that actually runs here.
 *
 *   - macOS  → `parakeet-mlx` (Apple Silicon MLX)
 *   - Linux  → `onnx-asr`     (cross-platform Sherpa-ONNX)
 *   - other  → `null`         (no local backend — steer to cloud)
 *
 * Mirrors scribe's own `platformLocalProvider` (parachute-scribe
 * src/install-backend.ts) so hub and scribe can't drift on the mapping.
 * Fixes the long-standing bug where the wizard mapped `local` UNCONDITIONALLY
 * to `parakeet-mlx`, which silently fails on every Linux box (the common
 * DigitalOcean / VPS deploy).
 */
export function platformLocalProvider(
  platform: NodeJS.Platform,
): "parakeet-mlx" | "onnx-asr" | null {
  if (platform === "darwin") return "parakeet-mlx";
  if (platform === "linux") return "onnx-asr";
  return null;
}

/**
 * Minimum available RAM (MiB) below which a local ASR model would be
 * OOM-killed. Mirrors scribe's `MIN_RAM_MIB` (parachute-scribe
 * src/install-backend.ts) — the 1 GB DigitalOcean droplet is the box this
 * guards against; a local Parakeet/ONNX model needs ~2 GB to load.
 */
export const MIN_RAM_MIB = 2048;

/**
 * Available RAM in MiB, or `null` when it can't be determined.
 *
 * Linux: reads `MemAvailable` from `/proc/meminfo` (the honest figure — free
 * plus reclaimable cache), matching scribe's probe so the two layers agree on
 * the same droplet. Falls back to `MemFree` on very old kernels that predate
 * MemAvailable.
 *
 * Non-Linux: falls back to `os.totalmem()` (there's no MemAvailable analogue;
 * total is a coarse upper bound but enough to keep a tiny VM from offering
 * local). macOS dev boxes comfortably clear the floor, so the coarseness is
 * harmless there.
 *
 * Sync by design: the wizard's provider-decision path is synchronous, and the
 * `/proc/meminfo` read is a tiny file. Tests inject `availableRamMib` directly
 * to exercise the gate without touching the real host.
 */
export function readAvailableRamMib(platform: NodeJS.Platform = process.platform): number | null {
  if (platform === "linux") {
    try {
      const text = readFileSync("/proc/meminfo", "utf8");
      const avail = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
      const free = /^MemFree:\s+(\d+)\s*kB/m.exec(text);
      const kb = avail ? Number(avail[1]) : free ? Number(free[1]) : null;
      if (kb === null || !Number.isFinite(kb)) return null;
      return Math.floor(kb / 1024);
    } catch {
      return null;
    }
  }
  // Non-Linux: total physical memory as a coarse fallback.
  try {
    const bytes = totalmem();
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return Math.floor(bytes / (1024 * 1024));
  } catch {
    return null;
  }
}

/**
 * Decide whether a LOCAL transcription provider is offerable / acceptable on
 * this host, and if not, why + what to steer to. Both wizard surfaces (browser
 * POST handler + CLI) consult this BEFORE recording a `local` choice so we
 * never write a dead provider string that scribe can't run.
 *
 * `ok: false` carries a `reason` (shown inline) and a `steerTo` cloud provider
 * the caller should redirect to.
 */
export interface LocalProviderDecision {
  ok: boolean;
  /** The resolved platform backend when `ok` (parakeet-mlx / onnx-asr). */
  provider?: "parakeet-mlx" | "onnx-asr";
  /** Human-readable reason when `ok` is false (no local backend / too little RAM). */
  reason?: string;
  /** Cloud provider to redirect to when local is unavailable. */
  steerTo?: "groq";
}

export function decideLocalProvider(
  platform: NodeJS.Platform,
  availableRamMib: number | null,
): LocalProviderDecision {
  const provider = platformLocalProvider(platform);
  if (provider === null) {
    return {
      ok: false,
      reason: `No local transcription backend runs on "${platform}". Use a cloud provider instead.`,
      steerTo: "groq",
    };
  }
  if (availableRamMib !== null && availableRamMib < MIN_RAM_MIB) {
    return {
      ok: false,
      reason: `This box has ${availableRamMib} MiB available RAM, below the ${MIN_RAM_MIB} MiB a local ASR model needs (it would be OOM-killed). Use a cloud provider instead — groq is fast (~$0.04/hr of audio).`,
      steerTo: "groq",
    };
  }
  return { ok: true, provider };
}

export function isKnownScribeProvider(value: string): value is ScribeProviderKey {
  return SCRIBE_PROVIDERS.some((p) => p.key === value);
}

export function apiKeyEnvFor(provider: ScribeProviderKey): string | undefined {
  return SCRIBE_PROVIDERS.find((p) => p.key === provider)?.apiKeyEnv;
}

export function scribeConfigPath(configDir: string): string {
  return join(configDir, "scribe", "config.json");
}

export function scribeEnvPath(configDir: string): string {
  return join(configDir, "scribe", ".env");
}

export interface ScribeProviderState {
  provider: string | undefined;
  /** True when the file exists; false on a fresh install. */
  configExists: boolean;
}

export function readScribeProviderState(configDir: string): ScribeProviderState {
  const path = scribeConfigPath(configDir);
  if (!existsSync(path)) return { provider: undefined, configExists: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const provider =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.transcribe
        ? typeof parsed.transcribe.provider === "string"
          ? parsed.transcribe.provider
          : undefined
        : undefined;
    return { provider, configExists: true };
  } catch {
    // Malformed JSON — treat as empty so the writer can repair it. The auth
    // block belongs to auto-wire; if it's broken, downstream auto-wire will
    // overwrite when it next runs anyway.
    return { provider: undefined, configExists: true };
  }
}

/**
 * Merge `transcribe.provider = <provider>` into the scribe config.json,
 * preserving any other top-level keys (notably `auth.required_token` written
 * by auto-wire).
 */
export function writeScribeProvider(configDir: string, provider: ScribeProviderKey): void {
  const path = scribeConfigPath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed → overwrite, same convention as auto-wire's writeScribeConfig.
    }
  }
  const existingTranscribe =
    typeof current.transcribe === "object" &&
    current.transcribe !== null &&
    !Array.isArray(current.transcribe)
      ? (current.transcribe as Record<string, unknown>)
      : {};
  const next = {
    ...current,
    transcribe: { ...existingTranscribe, provider },
  };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Remove `transcribe.provider` from scribe's config.json (preserving every
 * other key). Used by the wizard's local-install path to UNDO a provisional
 * provider record when the engine install fails — so we never leave a dead
 * provider string scribe can't honor. A no-op when the file or the
 * `transcribe` block is absent.
 */
export function clearScribeProvider(configDir: string): void {
  const path = scribeConfigPath(configDir);
  if (!existsSync(path)) return;
  let current: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    current = parsed as Record<string, unknown>;
  } catch {
    return; // malformed → leave it; auto-wire repairs on next run
  }
  const transcribe = current.transcribe;
  if (typeof transcribe !== "object" || transcribe === null || Array.isArray(transcribe)) {
    return;
  }
  // Drop `provider` from the transcribe block (destructure-omit, no `delete`).
  const { provider: _dropped, ...block } = transcribe as Record<string, unknown>;
  const { transcribe: _omit, ...rest } = current;
  const next: Record<string, unknown> =
    Object.keys(block).length === 0 ? rest : { ...rest, transcribe: block };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Idempotent upsert of a single `KEY=value` into `<configDir>/scribe/.env`.
 * Used for the API-key prompt result. Other lines (auto-wire keys, manual
 * operator edits) are preserved.
 */
export function writeScribeApiKey(configDir: string, envKey: string, value: string): void {
  const path = scribeEnvPath(configDir);
  const parsed = parseEnvFile(path);
  const lines = upsertEnvLine(parsed.lines, envKey, value);
  writeEnvFile(path, lines);
}
