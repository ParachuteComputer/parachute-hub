export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: readonly string[]) => Promise<CommandResult>;

export async function defaultRunner(cmd: readonly string[]): Promise<CommandResult> {
  // Inherit env so `tailscale` sees PATH (and HOME for state dir). Bun.spawn
  // defaults to empty env — see api-modules-ops.ts:defaultRun for rationale.
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
