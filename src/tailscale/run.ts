import { ensureExecutable, rethrowIfMissing } from "@openparachute/depcheck";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: readonly string[]) => Promise<CommandResult>;

export async function defaultRunner(cmd: readonly string[]): Promise<CommandResult> {
  // Pre-flight the binary so a missing `tailscale` surfaces the friendly
  // install UX (`@openparachute/depcheck`) instead of a raw spawn throw —
  // closes the no-hint gap where `parachute expose tailnet` on a box without
  // tailscale died with `Executable not found in $PATH: "tailscale"`.
  // `cmd[0]` is always present for a real call; guard for the empty edge.
  const binary = cmd[0];
  if (binary) ensureExecutable(binary);
  // Inherit env so `tailscale` sees PATH (and HOME for state dir). Bun.spawn
  // defaults to empty env — see api-modules-ops.ts:defaultRun for rationale.
  try {
    const proc = Bun.spawn([...cmd], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (err) {
    // Belt-and-suspenders: a spawn that slips past the pre-flight (binary
    // removed between which() and spawn, or a race) still surfaces the
    // friendly MissingDependencyError rather than the raw spawn throw.
    if (binary) rethrowIfMissing(err, binary);
    throw err;
  }
}

export class TailscaleError extends Error {
  override name = "TailscaleError";
  constructor(
    message: string,
    public readonly cmd: readonly string[],
    public readonly result: CommandResult,
  ) {
    super(message);
  }
}
