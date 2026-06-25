/**
 * Transcription step for the CLI setup wizard (`parachute setup-wizard` /
 * `parachute init`).
 *
 * Until now the CLI wizard NEVER asked about transcription — it walked
 * Account → Vault → Expose and stopped, while the browser wizard's vault step
 * folds a full scribe sub-form (none / cloud + key / local). That divergence
 * is the "asks different questions in its CLI vs browser forms" root cause from
 * the onboarding-streamline arc. This module brings the CLI to parity.
 *
 * Crucially it follows the arc's "never ask without doing" rule: when the
 * operator picks a provider we ACTUALLY set it up, or honestly say we couldn't
 * and point at the alternative — we never record a dead provider string.
 *
 *   - **none**  → write nothing; say transcription is off + how to turn it on.
 *   - **cloud** (groq / openai) → write provider + key (scribe-config.ts), then
 *     install + start scribe via the hub's own `parachute install scribe`
 *     one-shot. The very-first scribe boot reads the provider we just wrote.
 *   - **local** → RAM/platform-gate FIRST (decideLocalProvider). If the box
 *     can't run a local model (no backend for the platform, or < 2 GB RAM) we
 *     do NOT write `local` — we explain why + steer to the cloud one-shot. If
 *     it can, we install scribe, then run scribe's own runnable install routine
 *     (`parachute-scribe install-backend --provider <onnx-asr|parakeet-mlx>`,
 *     scribe PR #79) which apt/pip-installs the engine + warm-pulls the model
 *     and exits non-zero on hard failure. On success we record the resolved
 *     platform provider; on failure we say so + point at cloud, recording
 *     nothing.
 *
 * Everything that touches the host (subprocess spawn, RAM probe, the prompt)
 * goes through an injected seam so tests exercise every branch WITHOUT
 * installing anything or shelling out.
 */

import { createInterface } from "node:readline/promises";
import {
  type ScribeProviderKey,
  apiKeyEnvFor,
  clearScribeProvider,
  decideLocalProvider,
  readAvailableRamMib,
} from "../scribe-config.ts";

/** Outcome of one subprocess. Exit code only — stdio is inherited / streamed. */
export type WizardCommandRunner = (cmd: readonly string[]) => Promise<number>;

export interface TranscriptionStepOpts {
  /** `~/.parachute` (or the PARACHUTE_HOME override). Where scribe config lives. */
  configDir: string;
  /** Log shim — production prints to stdout; tests capture into an array. */
  log: (line: string) => void;
  /** Prompt seam — production uses readline; tests inject a scripted queue. */
  prompt?: (question: string) => Promise<string>;
  /**
   * Pre-supply the choice non-interactively (mirrors the wizard's other
   * run-from-flag escapes). `none` | `local` | a cloud provider name.
   */
  transcribeMode?: "none" | "local" | "groq" | "openai";
  /** Pre-supplied cloud API key (for `groq` / `openai`). */
  transcribeApiKey?: string;
  /**
   * Command runner seam. Production spawns the real binary inheriting stdio;
   * tests inject a recorder so nothing installs. Receives a full argv —
   * `["parachute", "install", "scribe", ...]` or
   * `["parachute-scribe", "install-backend", "--provider", "onnx-asr"]`.
   */
  runCommand?: WizardCommandRunner;
  /** Platform override (test seam). Defaults to the real host platform. */
  platform?: NodeJS.Platform;
  /** Available-RAM override in MiB (test seam). Defaults to the real probe. */
  availableRamMib?: number | null;
}

/** Default readline prompt (matches wizard.ts's defaultPrompt). */
async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Default command runner: spawn the binary, inherit stdio so the operator sees
 * apt/pip progress in real time, resolve to the exit code. Never throws — a
 * spawn failure (binary not on PATH) surfaces as a non-zero code, which the
 * caller treats as "couldn't install."
 */
const defaultRunCommand: WizardCommandRunner = async (cmd) => {
  try {
    const proc = Bun.spawn([...cmd], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    return await proc.exited;
  } catch {
    return 127; // ENOENT / spawn failure → "command not found"
  }
};

/**
 * Walk the transcription step. Returns 0 always — a transcription that
 * couldn't be set up is reported honestly but does NOT fail the wizard (the
 * operator can finish setup and add it later; it's not a blocking step).
 */
export async function walkTranscriptionStep(opts: TranscriptionStepOpts): Promise<number> {
  const log = opts.log;
  const prompt = opts.prompt ?? defaultPrompt;
  const runCommand = opts.runCommand ?? defaultRunCommand;
  const platform = opts.platform ?? process.platform;

  log("");
  log("Step — Transcription (scribe)");
  log("  Parachute can transcribe voice notes + audio attachments. Pick a");
  log("  transcription engine, or skip and add one later.");

  // Resolve the choice (flag or prompt).
  const choice = await resolveChoice(opts, prompt, log);
  if (choice === "none") {
    log("");
    log("  Transcription off. Turn it on later with `parachute install scribe`.");
    return 0;
  }

  if (choice === "local") {
    return await handleLocal(opts, prompt, runCommand, platform, log);
  }

  // Cloud provider (groq / openai).
  return await handleCloud(opts, choice, prompt, runCommand, log);
}

type ResolvedChoice = "none" | "local" | "groq" | "openai";

async function resolveChoice(
  opts: TranscriptionStepOpts,
  prompt: (q: string) => Promise<string>,
  log: (l: string) => void,
): Promise<ResolvedChoice> {
  if (opts.transcribeMode !== undefined) return opts.transcribeMode;
  log("");
  log("  1) None — skip transcription (default)");
  log("  2) Local — run the engine on this box (no API key, needs ~2 GB RAM)");
  log("  3) Cloud — Groq or OpenAI (fast, needs an API key, ~$0.04/hr of audio)");
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = (await prompt("  Pick [1]: ")).trim().toLowerCase();
    if (raw === "" || raw === "1" || raw === "none" || raw === "n") return "none";
    if (raw === "2" || raw === "local" || raw === "l") return "local";
    if (raw === "3" || raw === "cloud" || raw === "c") {
      // Sub-pick which cloud provider.
      for (let inner = 0; inner < 5; inner++) {
        const which = (await prompt("  Cloud provider — [g]roq (default) or [o]penai: "))
          .trim()
          .toLowerCase();
        if (which === "" || which === "g" || which === "groq") return "groq";
        if (which === "o" || which === "openai") return "openai";
        log(`  Sorry — expected groq or openai (got "${which}"). Try again.`);
      }
      log("  Too many invalid entries; skipping transcription.");
      return "none";
    }
    if (raw === "groq" || raw === "g") return "groq";
    if (raw === "openai" || raw === "o") return "openai";
    log(`  Sorry — expected 1, 2, or 3 (got "${raw}"). Try again.`);
  }
  log("  Too many invalid entries; skipping transcription.");
  return "none";
}

async function handleCloud(
  opts: TranscriptionStepOpts,
  provider: "groq" | "openai",
  prompt: (q: string) => Promise<string>,
  runCommand: WizardCommandRunner,
  log: (l: string) => void,
): Promise<number> {
  const envKey = apiKeyEnvFor(provider as ScribeProviderKey);
  let apiKey = opts.transcribeApiKey;
  if (apiKey === undefined && envKey) {
    apiKey = (await prompt(`  Paste your ${envKey} (or blank to set later): `)).trim();
  }

  // Install + start scribe via the EXISTING one-shot path, handing it the
  // chosen provider + key. `parachute install scribe --scribe-provider <p>
  // [--scribe-key <k>]` writes the provider into scribe's config + the key into
  // scribe/.env and starts the module — the same wiring the bare CLI install
  // does. Passing the provider also suppresses install's own interactive
  // provider prompt (it's already an explicit choice).
  const cmd = ["parachute", "install", "scribe", "--scribe-provider", provider];
  if (envKey && apiKey && apiKey.length > 0) {
    cmd.push("--scribe-key", apiKey);
  }
  log("");
  log(`  Installing scribe with the ${provider} cloud provider…`);
  const code = await runCommand(cmd);
  if (code !== 0) {
    log(`  ✗ scribe install returned ${code}. Retry: \`${cmd.join(" ")}\`.`);
    return 0;
  }
  if (envKey && !(apiKey && apiKey.length > 0)) {
    log(
      `  ✓ Recorded ${provider}. Add ${envKey} later: \`echo '${envKey}=<value>' >> ${opts.configDir}/scribe/.env\` then \`parachute restart scribe\`.`,
    );
  } else {
    log(`  ✓ Scribe installed and running with the ${provider} cloud provider.`);
  }
  return 0;
}

async function handleLocal(
  opts: TranscriptionStepOpts,
  prompt: (q: string) => Promise<string>,
  runCommand: WizardCommandRunner,
  platform: NodeJS.Platform,
  log: (l: string) => void,
): Promise<number> {
  const ramMib =
    opts.availableRamMib !== undefined ? opts.availableRamMib : readAvailableRamMib(platform);
  const decision = decideLocalProvider(platform, ramMib);

  if (!decision.ok) {
    // Can't install local here — say EXACTLY why + point at the cloud one-shot.
    // Do NOT record a dead `local` provider string.
    log("");
    log(`  ✗ Local transcription isn't possible on this box: ${decision.reason}`);
    log("");
    log("  One-shot cloud alternative — get a free Groq key at https://console.groq.com,");
    log("  then run:");
    log("    parachute install scribe --scribe-provider groq --scribe-key gsk_…");
    log("  (or re-run this wizard and choose Cloud).");
    return 0;
  }

  const provider = decision.provider as "parakeet-mlx" | "onnx-asr";
  log("");
  log(`  This box can run ${provider} locally.`);

  // Confirm before the (slow, apt/pip) install unless pre-supplied.
  if (opts.transcribeMode === undefined) {
    const ok = (await prompt(`  Install ${provider} now? [Y/n]: `)).trim().toLowerCase();
    if (ok === "n" || ok === "no") {
      log(
        "  Skipped. Install later with `parachute-scribe install-backend` or re-run this wizard.",
      );
      return 0;
    }
  }

  // Install the scribe module first, recording the resolved provider so install
  // doesn't prompt for one. (We UNDO this record below if the engine install
  // fails — so a failure never leaves a dead provider string.)
  log("");
  log("  Installing the scribe module…");
  const moduleCode = await runCommand([
    "parachute",
    "install",
    "scribe",
    "--scribe-provider",
    provider,
  ]);
  if (moduleCode !== 0) {
    clearScribeProvider(opts.configDir);
    log(`  ✗ scribe module install returned ${moduleCode} — not recording a local provider.`);
    return 0;
  }

  // Run scribe's OWN runnable install routine (scribe PR #79). It apt/pip-
  // installs the engine, warm-pulls the model, and exits non-zero on hard
  // failure (no engine on PATH, too little RAM on its own re-check, etc.).
  log("");
  log(`  Installing the ${provider} engine via scribe (this can take a few minutes)…`);
  const code = await runCommand(["parachute-scribe", "install-backend", "--provider", provider]);
  if (code !== 0) {
    // HONEST skip — undo the provisional provider record; do NOT leave a dead
    // provider string scribe can't honor.
    clearScribeProvider(opts.configDir);
    log("");
    log(`  ✗ ${provider} install failed (exit ${code}); not recording it as the provider.`);
    log(
      "    Cloud alternative: `parachute install scribe --scribe-provider groq --scribe-key gsk_…`",
    );
    return 0;
  }

  // Engine installed + verified by scribe — keep the provider recorded (the
  // install step already wrote it) and restart so the running scribe picks it up.
  log("");
  log(`  ✓ ${provider} installed and recorded as the transcription provider.`);
  await runCommand(["parachute", "restart", "scribe"]);
  return 0;
}
