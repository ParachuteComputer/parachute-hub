/**
 * `parachute vault tokens create` (no narrowing flags, in a TTY) — guided
 * token creation. Same command with any of `--scope` / `--read` /
 * `--permission`, or running under a non-TTY, bypasses this module and passes
 * through to `parachute-vault tokens create` unchanged.
 *
 * Two prompts:
 *
 *   1. Scope — read / write / admin / cancel. Default is `read` on Enter:
 *      the two-factor reasoning is (a) a read-only token is the least
 *      dangerous thing to mint by mistake, and (b) most callers of this
 *      command interactively are plumbing in a new read-only consumer
 *      (hooks, dashboards, n8n triggers). Users who actually want admin can
 *      type "3" in ~1 second.
 *
 *   2. Label — free-form string, blank skips the prompt entirely (vault's
 *      own `--label` default of "default" then applies). Skipped outright
 *      if the user already supplied `--label …` on the command line.
 *
 * The resolved flags are appended to the original argv and forwarded to
 * `parachute-vault tokens create` via an inherit-stdio subprocess so the
 * generated token and its usage block print directly to the user's terminal.
 *
 * Shape mirrors `expose-interactive.ts`: every side-effectful edge is an
 * injectable seam so the full prompt tree is testable without spawning.
 */

import { createInterface } from "node:readline/promises";

export type InteractiveRunner = (cmd: readonly string[]) => Promise<number>;

const defaultInteractiveRunner: InteractiveRunner = async (cmd) => {
  // Inherit env so the child (parachute-vault subprocess) sees PATH, HOME,
  // PARACHUTE_HOME, etc. Bun.spawn defaults to empty env — see
  // api-modules-ops.ts:defaultRun.
  const proc = Bun.spawn([...cmd], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });
  return await proc.exited;
};

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export interface VaultTokensCreateInteractiveOpts {
  /**
   * Original argv after `vault tokens create`. Flags the user already
   * supplied (`--vault <name>`, `--expires <dur>`, `--label <x>`) are
   * forwarded verbatim to `parachute-vault`; only the scope dimension is
   * resolved interactively.
   */
  args: readonly string[];
  prompt?: (question: string) => Promise<string>;
  interactiveRunner?: InteractiveRunner;
  log?: (line: string) => void;
}

interface Resolved {
  args: readonly string[];
  prompt: (question: string) => Promise<string>;
  interactiveRunner: InteractiveRunner;
  log: (line: string) => void;
}

function resolve(opts: VaultTokensCreateInteractiveOpts): Resolved {
  return {
    args: opts.args,
    prompt: opts.prompt ?? defaultPrompt,
    interactiveRunner: opts.interactiveRunner ?? defaultInteractiveRunner,
    log: opts.log ?? ((line) => console.log(line)),
  };
}

type ScopeChoice = "read" | "write" | "admin" | "cancel";

async function promptScope(r: Resolved): Promise<ScopeChoice> {
  r.log("Scope for this token?");
  r.log("  [1] read   — query-only (safer default)");
  r.log("  [2] write  — read + create/update");
  r.log("  [3] admin  — full access (token + config management)");
  r.log("  [4] cancel");
  while (true) {
    const raw = (await r.prompt("Choice [1]: ")).trim().toLowerCase();
    if (raw === "" || raw === "1" || raw === "read") return "read";
    if (raw === "2" || raw === "write") return "write";
    if (raw === "3" || raw === "admin") return "admin";
    if (raw === "4" || raw === "cancel" || raw === "q") return "cancel";
    r.log(`(didn't understand "${raw}" — please pick 1, 2, 3, or 4)`);
  }
}

async function promptLabel(r: Resolved): Promise<string | undefined> {
  r.log("");
  const raw = (await r.prompt('Label for this token (e.g. "n8n-sync", blank to skip): ')).trim();
  return raw === "" ? undefined : raw;
}

/**
 * Map the scope choice to the CLI flag sequence vault expects. We pass the
 * canonical form for each level so anyone inspecting the spawned argv can
 * see exactly what got minted — `--read` reads clearer than `--scope
 * vault:read` for the common case, and `vault:write`/`vault:admin` are the
 * canonical OAuth-style scope names for the other two.
 */
function scopeFlagsFor(choice: "read" | "write" | "admin"): string[] {
  if (choice === "read") return ["--read"];
  if (choice === "write") return ["--scope", "vault:write"];
  return ["--scope", "vault:admin"];
}

export async function runVaultTokensCreateInteractive(
  opts: VaultTokensCreateInteractiveOpts,
): Promise<number> {
  const r = resolve(opts);

  const scope = await promptScope(r);
  if (scope === "cancel") {
    r.log("Cancelled — no token created.");
    return 0;
  }

  const hasLabelFlag = r.args.includes("--label");
  const label = hasLabelFlag ? undefined : await promptLabel(r);

  const forwarded: string[] = [
    "parachute-vault",
    "tokens",
    "create",
    ...r.args,
    ...scopeFlagsFor(scope),
  ];
  if (label !== undefined) forwarded.push("--label", label);

  r.log("");
  return await r.interactiveRunner(forwarded);
}
