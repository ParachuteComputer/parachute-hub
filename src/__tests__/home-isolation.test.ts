/**
 * The suite must not be able to see, let alone touch, the operator's live
 * `~/.parachute` (hub#840).
 *
 * This is a guard on the harness itself, not on a feature. It exists because
 * the leak it covers is invisible in the place people look: CI runners have no
 * `~/.parachute`, so the suite has always been green while quietly reading the
 * live manifest 116 times per run on a developer box — and creating
 * `operator.token` and `well-known/parachute.json` in it. #840 records a test
 * run registering a dead `parachute-app` row at port 1942 into the real
 * manifest, which is live supervisor state.
 *
 * The isolation is a `bunfig.toml` `[test] preload`; these assertions are what
 * notices if that wiring is dropped, renamed, or defeated.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH, configDir } from "../config.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const realConfigDir = join(homedir(), ".parachute");

describe("test-run home isolation (hub#840)", () => {
  test("PARACHUTE_HOME is set, and points inside the temp dir", () => {
    const home = process.env.PARACHUTE_HOME;
    expect(home).toBeTruthy();
    // `resolve` both sides: macOS hands out /var/folders/... paths that are a
    // symlink to /private/var/folders/..., and tmpdir() picks one spelling.
    expect(resolve(home as string).startsWith(resolve(tmpdir()))).toBe(true);
  });

  test("the sandbox is a REAL directory — a bad path would send writes anywhere", () => {
    expect(existsSync(process.env.PARACHUTE_HOME as string)).toBe(true);
  });

  test("CONFIG_DIR resolved to the sandbox, not the operator's ~/.parachute", () => {
    // The load-bearing one. CONFIG_DIR is frozen at import time, so this can
    // only be true if the override landed BEFORE the first `config.ts` import
    // — i.e. from a preload, not a beforeEach.
    expect(CONFIG_DIR).toBe(process.env.PARACHUTE_HOME as string);
    expect(resolve(CONFIG_DIR)).not.toBe(resolve(realConfigDir));
  });

  test("SERVICES_MANIFEST_PATH — the actual leak — is not the live manifest", () => {
    // Every `deps.manifestPath ?? SERVICES_MANIFEST_PATH` fallback in the
    // server resolves through this constant.
    expect(SERVICES_MANIFEST_PATH).toBe(
      join(process.env.PARACHUTE_HOME as string, "services.json"),
    );
    expect(resolve(SERVICES_MANIFEST_PATH)).not.toBe(resolve(join(realConfigDir, "services.json")));
  });

  test("inherited hub token is blanked", () => {
    expect(process.env.PARACHUTE_HUB_TOKEN).toBe("");
  });

  test("the mechanism still works: configDir honours PARACHUTE_HOME", () => {
    // Control. If this ever failed, the assertions above would be vacuous —
    // they'd be describing a variable nothing reads.
    expect(configDir({ PARACHUTE_HOME: "/tmp/some-other-root" })).toBe("/tmp/some-other-root");
    expect(configDir({})).toBe(realConfigDir);
  });

  test("the preload overrides an inherited live-looking home in a child suite", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "hub-home-isolation-"));
    try {
      const inherited = join(sandbox, ".parachute");
      const probe = join(sandbox, "probe.test.ts");
      await Bun.write(
        probe,
        [
          `import { test } from "bun:test";`,
          `import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from ${JSON.stringify(resolve(REPO_ROOT, "src/config.ts"))};`,
          `test("default config constants", () => {`,
          `  console.log("CONFIG_DIR=" + CONFIG_DIR);`,
          `  console.log("MANIFEST=" + SERVICES_MANIFEST_PATH);`,
          `  console.log("HUB_TOKEN=" + process.env.PARACHUTE_HUB_TOKEN);`,
          "});",
        ].join("\n"),
      );

      const proc = Bun.spawn(["bun", "test", probe], {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: sandbox,
          PARACHUTE_HOME: inherited,
          PARACHUTE_HUB_TOKEN: "live-looking-token",
        },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const output = stdout + stderr;

      expect(exitCode).toBe(0);
      expect(output).toContain("CONFIG_DIR=");
      expect(output).toContain("HUB_TOKEN=\n");
      expect(output).not.toContain("HUB_TOKEN=live-looking-token");
      expect(output).not.toContain(`CONFIG_DIR=${inherited}`);
      expect(output).not.toContain(`MANIFEST=${join(inherited, "services.json")}`);
      expect(existsSync(inherited)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("a test process without the preload refuses the real fallback", async () => {
    const probe = [
      "delete process.env.PARACHUTE_HOME;",
      'process.env.NODE_ENV = "test";',
      `const { CONFIG_DIR } = await import(${JSON.stringify(resolve(REPO_ROOT, "src/config.ts"))});`,
      "console.log(CONFIG_DIR);",
    ].join("\n");
    const proc = Bun.spawn(["bun", "-e", probe], {
      cwd: tmpdir(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PARACHUTE_HOME: undefined, HOME: homedir(), NODE_ENV: "test" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toContain("refusing to resolve test state inside the live install");
  });
});
