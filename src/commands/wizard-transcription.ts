/**
 * Transcription step for the CLI setup wizard (`parachute setup-wizard` /
 * `parachute init`).
 *
 * ## Why this file shrank from 320 lines to ~110
 *
 * It used to offer scribe's model — none / a cloud provider + API key / a local
 * engine, with a RAM gate and a platform gate — then shell
 * `parachute install scribe --scribe-provider …`. Scribe is retired (hub#809),
 * so every non-`none` choice dead-ended in "✗ scribe install returned 1". A
 * question that cannot be answered successfully is worse than no question.
 *
 * Transcription lives in the vault now: `parachute-vault transcription install`
 * picks a whisper.cpp engine and a model sized to this host's RAM, downloads
 * them, and VERIFIES it can actually transcribe before reporting success. So
 * the RAM gate, the platform gate, the provider choice and the API-key prompt
 * all belong to the vault — and the branch collapses to one yes/no.
 *
 * The wizard still ASKS, because doing this at install time is the difference
 * between a box that transcribes voice notes and one where the operator finds
 * out months later that it never did. It just asks a question something can
 * answer.
 *
 * Keeps the arc's "never ask without doing" rule: yes really installs, and a
 * failure says so plainly instead of leaving a half-configured box. Never
 * fatal — a Parachute that can't transcribe is still a working Parachute, and
 * failing setup over an optional extra is a worse outcome than a warning.
 */

/** Outcome of one subprocess. Exit code only — stdio is inherited / streamed. */
export type WizardCommandRunner = (cmd: readonly string[]) => Promise<number>;

export interface TranscriptionStepOpts {
  /** `~/.parachute` (or the PARACHUTE_HOME override). */
  configDir: string;
  /** Log shim — production prints to stdout; tests capture into an array. */
  log: (line: string) => void;
  /** Prompt seam — production uses readline; tests inject a scripted queue. */
  prompt?: (question: string) => Promise<string>;
  /**
   * Pre-supply the answer non-interactively (mirrors the wizard's other
   * run-from-flag escapes).
   *
   * The historical spellings are all still accepted so an existing
   * `--transcribe=…` in someone's script keeps working: `none` means skip, and
   * `local` / `groq` / `openai` all now mean "set up local transcription",
   * because that is the only thing left for them to mean. Silently redirecting
   * a cloud choice is defensible precisely because the alternative is the
   * error this rewrite exists to delete.
   */
  transcribeMode?: "none" | "local" | "groq" | "openai";
  /** Command runner seam. Tests inject a recorder so nothing installs. */
  runCommand?: WizardCommandRunner;
}

/**
 * Default readline prompt. A non-TTY returns the empty answer rather than
 * throwing: this step is optional and must NEVER block setup on a headless box
 * (the same posture the previous version took, and worth keeping).
 */
async function defaultPrompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  process.stdout.write(question);
  for await (const line of console) return line;
  return "";
}

async function defaultRunCommand(cmd: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...cmd], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

/** Resolve the answer from a flag, else ask. Interactive blank ⇒ yes; headless ⇒ skip. */
async function resolveWanted(
  opts: TranscriptionStepOpts,
  prompt: (q: string) => Promise<string>,
): Promise<boolean> {
  if (opts.transcribeMode !== undefined) return opts.transcribeMode !== "none";
  // Headless with no flag ⇒ SKIP, preserving the previous contract. A blank
  // answer here means "nobody is there", not "yes" — and unprompted, a yes
  // downloads several hundred megabytes onto a box whose operator never saw
  // the question. An interactive blank is a different thing: a person read the
  // prompt and pressed enter.
  if (!process.stdin.isTTY && opts.prompt === undefined) return false;
  const answer = (await prompt("  Set up transcription now? [Y/n]: ")).trim().toLowerCase();
  // Interactive blank defaults to YES: the operator is walking a setup wizard,
  // the work is a download plus a verification, and skipping fails silently —
  // audio uploads and nothing ever transcribes it.
  return answer !== "n" && answer !== "no";
}

export async function walkTranscriptionStep(opts: TranscriptionStepOpts): Promise<number> {
  const log = opts.log;
  const prompt = opts.prompt ?? defaultPrompt;
  const runCommand = opts.runCommand ?? defaultRunCommand;

  log("");
  log("Step — Transcription");
  log("  Turn voice notes and audio attachments into text, on this machine.");
  log("  The audio never leaves the box.");

  if (!(await resolveWanted(opts, prompt))) {
    log("");
    log("  Skipped. Set it up any time with `parachute-vault transcription install`.");
    return 0;
  }

  log("");
  log("  Downloading a speech model sized to this machine, then verifying it…");
  // `--yes` because the wizard already asked. Without it the vault command
  // asks again — and under `curl … | bash` stdin is the pipe, so that second
  // prompt would hang rather than default.
  const code = await runCommand(["parachute-vault", "transcription", "install", "--yes"]);

  if (code === 0) {
    log("  ✓ Transcription ready.");
    return 0;
  }

  // Deliberately returns 0. A non-zero here would fail `parachute init` over
  // something the operator can retry with one command.
  log(`  ✗ Transcription setup returned ${code} — everything else is fine.`);
  log("    Retry any time:        parachute-vault transcription install");
  log("    See what's missing:    parachute-vault transcription status");
  return 0;
}
