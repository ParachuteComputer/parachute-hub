import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cli.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: "/tmp/parachute-hub-nonexistent-home",
      PARACHUTE_HOME: "/tmp/parachute-hub-nonexistent-home",
      ...env,
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("cli", () => {
  test("--version prints version from package.json", async () => {
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("--help lists commands", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/parachute install/);
    expect(stdout).toMatch(/parachute status/);
    expect(stdout).toMatch(/parachute auth/);
    expect(stdout).toMatch(/parachute vault/);
    expect(stdout).toMatch(/expose tailnet/);
    expect(stdout).toMatch(/expose public/);
  });

  test("expose with unknown layer exits 1", async () => {
    const { code, stderr } = await runCli(["expose", "wat"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown layer/);
    expect(stderr).toMatch(/expose public/);
  });

  test("no args prints help", async () => {
    const { code, stdout } = await runCli([]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Usage:/);
  });

  test("install with no service name exits 1", async () => {
    const { code, stderr } = await runCli(["install"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/usage: parachute install/);
  });

  test("install --channel without a value exits 1 (hub#337)", async () => {
    const { code, stderr } = await runCli(["install", "vault", "--channel"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--channel requires a value/);
  });

  test("install --channel with an invalid value exits 1 (hub#337)", async () => {
    const { code, stderr } = await runCli(["install", "vault", "--channel", "banana"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--channel must be "rc" or "latest"/);
    expect(stderr).toMatch(/banana/);
  });

  test("unknown command exits 1", async () => {
    const { code, stderr } = await runCli(["wat"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown command/);
  });
});

describe("cli per-subcommand help", () => {
  test("install --help shows install usage", async () => {
    const { code, stdout } = await runCli(["install", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/parachute install/);
    expect(stdout).toMatch(/bun add -g/);
  });

  test("install -h also works", async () => {
    const { code, stdout } = await runCli(["install", "-h"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/parachute install/);
  });

  test("status --help shows status usage", async () => {
    const { code, stdout } = await runCli(["status", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/parachute status/);
    expect(stdout).toMatch(/Exit codes/);
  });

  test("expose --help shows both layers and Funnel notes", async () => {
    const { code, stdout } = await runCli(["expose", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/expose tailnet/);
    expect(stdout).toMatch(/expose public/);
    expect(stdout).toMatch(/Funnel/);
    expect(stdout).toMatch(/443/);
    expect(stdout).toMatch(/--cloudflare/);
    expect(stdout).toMatch(/--domain/);
  });

  test("expose public --cloudflare without --domain exits 1 with usage hint", async () => {
    const { code, stderr } = await runCli(["expose", "public", "--cloudflare"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--domain <hostname> is required/);
    expect(stderr).toMatch(/dash\.cloudflare\.com/);
  });

  test("expose cloudflare is an alias for expose public --cloudflare (Fix 5)", async () => {
    // No --domain, non-TTY → same hard error as `expose public --cloudflare`.
    // That it reaches the cloudflare-domain check (not "unknown layer") proves
    // the alias rewrote the layer to public + forced the cloudflare flag.
    const { code, stderr } = await runCli(["expose", "cloudflare"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--domain <hostname> is required/);
    expect(stderr).not.toMatch(/unknown layer/);
  });

  test("expose cloudflare --domain X routes to the cloudflare path (not 'unknown layer')", async () => {
    // cloudflared isn't installed under PATH="", so the cloudflare path prints
    // its own not-installed hint — distinct from the layer-validation error.
    const proc = Bun.spawn(
      [process.execPath, CLI, "expose", "cloudflare", "--domain", "vault.example.com"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: "",
          HOME: "/tmp/parachute-hub-nonexistent-home",
          PARACHUTE_HOME: "/tmp/parachute-hub-nonexistent-home",
        },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(1);
    expect(stderr).not.toMatch(/unknown layer/);
    // Reached the cloudflare path (cloudflared detection), proving the alias.
    expect(stdout).toMatch(/cloudflared is not installed/);
  });

  test("expose tailnet --cloudflare is rejected (cloudflare is public-only)", async () => {
    const { code, stderr } = await runCli([
      "expose",
      "tailnet",
      "--cloudflare",
      "--domain",
      "vault.example.com",
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--cloudflare only applies to `public`/);
  });

  test("expose public --tailnet --cloudflare rejected as mutually exclusive", async () => {
    const { code, stderr } = await runCli([
      "expose",
      "public",
      "--tailnet",
      "--cloudflare",
      "--domain",
      "vault.example.com",
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/mutually exclusive/);
  });

  test("expose tailnet --tailnet rejected (tailnet flag scoped to public layer)", async () => {
    const { code, stderr } = await runCli(["expose", "tailnet", "--tailnet"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--tailnet pins the public layer/);
  });

  test("expose --help mentions --tailnet, --skip-provider-check, --tunnel-name", async () => {
    const { code, stdout } = await runCli(["expose", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/--tailnet\b/);
    expect(stdout).toMatch(/--skip-provider-check\b/);
    expect(stdout).toMatch(/--tunnel-name\b/);
  });

  test("expose public --skip-provider-check pins to Tailscale-Funnel default (skips auto-pick)", async () => {
    // With PATH="" tailscale isn't on PATH, so exposePublic prints its own
    // install hint. That's distinct from the auto-pick "no exposure provider
    // is set up" output — proving the skip flag bypassed auto-pick and went
    // straight to the Funnel path. If we regressed and skip-flag tumbled
    // into auto-pick, we'd see the auto-pick neither-ready report instead.
    const proc = Bun.spawn([process.execPath, CLI, "expose", "public", "--skip-provider-check"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: "",
        HOME: "/tmp/parachute-hub-nonexistent-home",
        PARACHUTE_HOME: "/tmp/parachute-hub-nonexistent-home",
      },
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/tailscale is not installed or not on PATH/);
    expect(stdout).not.toMatch(/no exposure provider is set up/);
    expect(stdout).not.toMatch(/Auto-detected/);
  });

  test("expose with missing --domain value exits 1", async () => {
    const { code, stderr } = await runCli(["expose", "public", "--cloudflare", "--domain"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--domain requires a hostname argument/);
  });

  test("expose tailnet --help shows full expose help", async () => {
    const { code, stdout } = await runCli(["expose", "tailnet", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/expose tailnet/);
  });

  test("vault with no args forwards --help to parachute-vault", async () => {
    // Clear PATH so the dispatcher reliably hits the ENOENT branch — that
    // proves the CLI is forwarding rather than printing local help. Spawn
    // bun by absolute path so the outer shell-out isn't affected by PATH=''.
    const proc = Bun.spawn([process.execPath, CLI, "vault"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: "",
        HOME: "/tmp/parachute-hub-nonexistent-home",
        PARACHUTE_HOME: "/tmp/parachute-hub-nonexistent-home",
      },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(127);
    expect(stderr).toMatch(/parachute-vault not found on PATH/);
    expect(stderr).toMatch(/parachute install vault/);
  });

  test("vault tokens create forwards verbatim to parachute-vault", async () => {
    // The guided interactive wrapper was removed with the pvt_* DROP (vault
    // #412 / hub#466) — `vault tokens create` now always forwards transparently
    // to parachute-vault (which exits 1 with migration guidance on a real box).
    // Clearing PATH forces ENOENT — same probe as the `vault no-args` test.
    // If we ever re-introduced a hub-side prompt, this subprocess would hang on
    // stdin instead of exiting 127.
    const proc = Bun.spawn([process.execPath, CLI, "vault", "tokens", "create"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: "",
        HOME: "/tmp/parachute-hub-nonexistent-home",
        PARACHUTE_HOME: "/tmp/parachute-hub-nonexistent-home",
      },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(127);
    expect(stderr).toMatch(/parachute-vault not found on PATH/);
  });
});

describe("cli lazy-import isolation (feedback #9)", () => {
  // Regression for the eager-import fragility: `cli.ts` used to import every
  // command module at top-level, so a module that THREW at eval-time (the 0.6.2
  // `migrate-cutover.ts` ReferenceError) aborted the entire CLI load — even
  // `parachute --help` — because top-level import evaluation runs before
  // `run()`'s try/catch is reached. Per-arm lazy `await import()` isolates a
  // broken module to its own command.
  //
  // We exercise the REAL dispatcher: copy the live `src/` tree (plus the repo
  // `package.json`, which `cli.ts` imports as `../package.json`) into a sandbox
  // *inside the repo* so workspace `node_modules` resolution still works, then
  // corrupt one command module so it throws at module-eval. `node_modules` is
  // NOT copied — Bun walks up to the repo's. The corruption never touches the
  // real source tree, so concurrent suites are unaffected.
  let sandbox: string;
  let sandboxCli: string;

  beforeAll(() => {
    // The sandbox lives INSIDE the repo (`<repo>/.tmp-cli-iso-*`) on purpose: it
    // copies `src/` + `package.json` but NOT `node_modules`. The sandboxed CLI
    // still resolves workspace packages (`@openparachute/depcheck`, etc.) by Bun
    // walking up the directory tree to the **repo-root** `node_modules` — the same
    // walk a nested file uses. So this suite REQUIRES `node_modules` installed at
    // the repo root. CI must `bun install` before running it; a fresh worktree
    // without an install will see `Cannot find module '@openparachute/...'`
    // failures that are worktree-resolution artifacts, NOT a regression in the
    // code under test. (A temp dir under `os.tmpdir()` would break this walk and
    // also break `cli.ts`'s `../package.json` import, hence the in-repo sandbox.)
    sandbox = mkdtempSync(join(REPO_ROOT, ".tmp-cli-iso-"));
    cpSync(join(REPO_ROOT, "src"), join(sandbox, "src"), { recursive: true });
    cpSync(join(REPO_ROOT, "package.json"), join(sandbox, "package.json"));
    sandboxCli = join(sandbox, "src", "cli.ts");
    // Append an unconditional throw so the module fails at eval. `migrate-cutover`
    // is the canonical real-world case (the 0.6.2 bug) AND it's reachable by both
    // eager paths the fix addresses: the direct `cli.ts` import and the transitive
    // `cli.ts → lifecycle.ts → migrate-offer.ts → migrate-cutover.ts` chain.
    appendFileSync(
      join(sandbox, "src", "commands", "migrate-cutover.ts"),
      '\nthrow new ReferenceError("boom: migrate-cutover failed at module eval");\n',
    );
  });

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  async function runSandbox(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn([process.execPath, sandboxCli, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: "/tmp/parachute-hub-nonexistent-home",
        PARACHUTE_HOME: "/tmp/parachute-hub-nonexistent-home",
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  test("a command module that throws at eval does NOT abort --help", async () => {
    const { code, stdout } = await runSandbox(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/parachute install/);
  });

  test("an unrelated command still dispatches when one module is broken", async () => {
    // `status` doesn't touch migrate-cutover at all — it must still run to
    // completion (exit 0) rather than dying at top-level import.
    const { code } = await runSandbox(["status"]);
    expect(code).toBe(0);
  });

  test("lifecycle commands survive the broken transitive path", async () => {
    // `stop` pulls in `migrate-offer.ts` (for the §7.5 detect-and-offer), which
    // used to EAGERLY import the broken `migrate-cutover.ts`. With the import now
    // `import type` + lazy, `stop --help` must not crash.
    const { code, stdout } = await runSandbox(["stop", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/parachute stop/);
  });

  test("the broken command itself exits 1 with a 'failed to load' message", async () => {
    const { code, stderr } = await runSandbox(["migrate", "--to-supervised"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/parachute migrate: failed to load/);
    expect(stderr).toMatch(/boom: migrate-cutover failed at module eval/);
  });
});

// hub#534: `migrate --teardown` must surface teardownHubUnit's outcome — pre-fix
// it ignored `removed` + `messages` and always exited 0, so a non-removal looked
// like success. We exercise the REAL CLI arm via the in-repo sandbox (same shape
// as the lazy-import suite above) so the arm's exit-code mapping runs end-to-end
// without shelling out to real launchctl/systemctl: the sandboxed
// `teardownHubUnit` is replaced with a stub keyed off an env var.
describe("cli migrate --teardown exit-code policy (hub#534)", () => {
  let sandbox: string;
  let sandboxCli: string;

  beforeAll(() => {
    sandbox = mkdtempSync(join(REPO_ROOT, ".tmp-cli-teardown-"));
    cpSync(join(REPO_ROOT, "src"), join(sandbox, "src"), { recursive: true });
    cpSync(join(REPO_ROOT, "package.json"), join(sandbox, "package.json"));
    sandboxCli = join(sandbox, "src", "cli.ts");
    // Replace migrate-cutover.ts entirely with a minimal stub exporting only the
    // `teardownHubUnit` the CLI arm calls. Its result is driven by
    // `TEARDOWN_FAKE` so one rewrite covers all three outcomes. It logs the same
    // human-facing lines the real function would (so the stdout assertions match
    // real behavior), and the CLI owns the exit code.
    writeFileSync(
      join(sandbox, "src", "commands", "migrate-cutover.ts"),
      [
        "export function teardownHubUnit() {",
        '  const mode = process.env.TEARDOWN_FAKE ?? "removed";',
        '  if (mode === "removed") {',
        '    console.log("Removed systemd unit parachute-hub.service — the hub no longer starts on boot.");',
        "    return { removed: true, messages: [] };",
        "  }",
        '  if (mode === "failure") {',
        '    console.log("Hub-unit teardown did not complete:");',
        '    console.log("  systemctl disable failed: permission denied");',
        '    return { removed: false, messages: ["systemctl disable failed: permission denied"] };',
        "  }",
        '  console.log("No hub unit was installed — nothing to tear down.");',
        "  return { removed: false, messages: [] };",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  async function runTeardown(
    fake: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn([process.execPath, sandboxCli, "migrate", "--teardown"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: "/tmp/parachute-hub-nonexistent-home",
        PARACHUTE_HOME: "/tmp/parachute-hub-nonexistent-home",
        TEARDOWN_FAKE: fake,
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  test("removed → exit 0 with the removal message", async () => {
    const { code, stdout } = await runTeardown("removed");
    expect(code).toBe(0);
    expect(stdout).toMatch(/Removed systemd unit/);
  });

  test("nothing installed → informational exit 0", async () => {
    const { code, stdout } = await runTeardown("nothing");
    expect(code).toBe(0);
    expect(stdout).toMatch(/nothing to tear down/);
  });

  test("removal failure (messages present) → exit 1, reason on stderr", async () => {
    const { code, stdout, stderr } = await runTeardown("failure");
    expect(code).toBe(1);
    // The function logged the failure header to stdout; the CLI re-surfaces the
    // detail on stderr so a script's `2>` capture sees the reason.
    expect(stdout).toMatch(/did not complete/);
    expect(stderr).toMatch(/permission denied/);
  });
});

describe("cli friendly errors", () => {
  test("malformed services.json prints friendly error not stack trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-bad-"));
    try {
      writeFileSync(join(dir, "services.json"), "this is not json{");
      const { code, stderr } = await runCli(["status"], { PARACHUTE_HOME: dir });
      expect(code).toBe(1);
      expect(stderr).toMatch(/services\.json is malformed/);
      expect(stderr).not.toMatch(/at process\./);
      expect(stderr).not.toMatch(/Error:.*at \//);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
