import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifecycleOpts } from "../commands/lifecycle.ts";
import { restart as lifecycleRestart } from "../commands/lifecycle.ts";
import type { UpgradeRunner } from "../commands/upgrade.ts";
import { compareVersions, defaultRunner, detectChannel, upgrade } from "../commands/upgrade.ts";
import type { HubUnitDeps, HubUnitManagerOpResult } from "../hub-unit.ts";
import { defaultHubUnitDeps } from "../hub-unit.ts";
import type { MigrateOfferResult } from "../migrate-offer.ts";
import { upsertService } from "../services-manifest.ts";

interface RunCall {
  cmd: string[];
  cwd?: string;
  kind: "run" | "capture";
}

interface MockRunner {
  runner: UpgradeRunner;
  calls: RunCall[];
}

/**
 * Build a runner stub that scripts responses by command-prefix match. The
 * matcher walks the responses array in order; the first entry whose `match`
 * function returns true wins. Unmatched commands return code 0 / empty
 * stdout, which keeps the happy path quiet.
 */
function makeRunner(
  responses: Array<{
    match: (cmd: readonly string[]) => boolean;
    code?: number;
    stdout?: string;
  }> = [],
): MockRunner {
  const calls: RunCall[] = [];
  const find = (cmd: readonly string[]) => responses.find((r) => r.match(cmd));
  return {
    calls,
    runner: {
      async run(cmd, opts) {
        calls.push({ cmd: [...cmd], cwd: opts?.cwd, kind: "run" });
        return find(cmd)?.code ?? 0;
      },
      async capture(cmd, opts) {
        calls.push({ cmd: [...cmd], cwd: opts?.cwd, kind: "capture" });
        const r = find(cmd);
        return { code: r?.code ?? 0, stdout: r?.stdout ?? "" };
      },
    },
  };
}

interface Harness {
  configDir: string;
  manifestPath: string;
  installRoot: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-upgrade-"));
  return {
    configDir: dir,
    manifestPath: join(dir, "services.json"),
    installRoot: join(dir, "installs"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writePackageJson(dir: string, body: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(body, null, 2));
}

function seedVault(manifestPath: string, installDir: string, version = "0.4.0"): void {
  upsertService(
    {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
      version,
      installDir,
    },
    manifestPath,
  );
}

/**
 * Phase 5b: `upgrade hub` always restarts the hub UNIT via the platform manager
 * (`restartHubUnit`) — the detached restart arm is retired. Hub-upgrade tests
 * that aren't asserting the restart mechanism itself inject this benign seam so
 * the manager op succeeds without a real systemd/launchd on the test host.
 */
const okHubUnitSupervisor = {
  restartHubUnit: (): HubUnitManagerOpResult => ({ outcome: "ok" as const, messages: [] }),
};

describe("parachute upgrade", () => {
  test("errors cleanly when targeting a service that's not installed", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const m = makeRunner();
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner: m.runner,
        findGlobalInstall: () => null,
        restartFn: async () => 0,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/No services installed/);
    } finally {
      h.cleanup();
    }
  });

  test("errors cleanly on unknown service, lists hub in the known set", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath, join(h.installRoot, "vault"));
      const logs: string[] = [];
      const m = makeRunner();
      const code = await upgrade("nope", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner: m.runner,
        findGlobalInstall: () => null,
        restartFn: async () => 0,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      const joined = logs.join("\n");
      expect(joined).toMatch(/unknown service/);
      expect(joined).toMatch(/\bhub\b/);
    } finally {
      h.cleanup();
    }
  });

  test("bun-linked happy path: pulls, reinstalls deps, restarts", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir);

      const m = makeRunner([
        {
          match: (c) => c[0] === "git" && c[1] === "rev-parse" && c[2] === "--is-inside-work-tree",
          code: 0,
        },
        {
          match: (c) => c[0] === "git" && c[1] === "status" && c[2] === "--porcelain",
          code: 0,
          stdout: "",
        },
        // First HEAD read (before pull) — old SHA
        // Sequence: capture matchers fire in order; we use a stateful counter
      ]);

      // Stateful HEAD: first capture returns "abc", second returns "def"
      let headCalls = 0;
      const runner: UpgradeRunner = {
        async run(cmd, opts) {
          m.calls.push({ cmd: [...cmd], cwd: opts?.cwd, kind: "run" });
          if (cmd[0] === "git" && cmd[1] === "pull") return 0;
          if (cmd[0] === "bun" && cmd[1] === "install") return 0;
          return 0;
        },
        async capture(cmd, opts) {
          m.calls.push({ cmd: [...cmd], cwd: opts?.cwd, kind: "capture" });
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 0, stdout: "true" };
          }
          if (cmd[1] === "status") return { code: 0, stdout: "" };
          if (cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
            headCalls++;
            return { code: 0, stdout: headCalls === 1 ? "aaaaaaa" : "bbbbbbb" };
          }
          if (cmd[1] === "diff") {
            return { code: 0, stdout: "package.json\nsrc/foo.ts" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartedShort: string | undefined;
      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async (svc) => {
          restartedShort = svc;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(restartedShort).toBe("vault");
      const joined = logs.join("\n");
      expect(joined).toMatch(/bun-linked checkout/);
      expect(joined).toMatch(/git pull --ff-only/);
      expect(joined).toMatch(/bun install --frozen-lockfile/);
      expect(joined).toMatch(/aaaaaa.*→.*bbbbbb/);
      expect(joined).toMatch(/restarting/);
    } finally {
      h.cleanup();
    }
  });

  test("bun-linked, HEAD unchanged: no-op skip-restart", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir);

      const runner: UpgradeRunner = {
        async run() {
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 0, stdout: "true" };
          }
          if (cmd[1] === "status") return { code: 0, stdout: "" };
          if (cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
            return { code: 0, stdout: "abcdef0" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartCalled = false;
      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async () => {
          restartCalled = true;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(restartCalled).toBe(false);
      expect(logs.join("\n")).toMatch(/already up to date/);
    } finally {
      h.cleanup();
    }
  });

  test("bun-linked refuses on dirty working tree", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir);

      const runner: UpgradeRunner = {
        async run() {
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 0, stdout: "true" };
          }
          if (cmd[1] === "status") {
            return { code: 0, stdout: " M src/foo.ts\n" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartCalled = false;
      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async () => {
          restartCalled = true;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(restartCalled).toBe(false);
      expect(logs.join("\n")).toMatch(/dirty working tree/);
    } finally {
      h.cleanup();
    }
  });

  // hub#301 Phase C/D (#330): `kind` retired and the bun-linked
  // `kind === "frontend"` build branch retires with it. Notes-daemon's
  // `prepublishOnly` builds dist at publish time so consumers don't need a
  // post-install rebuild; this test pins the new behavior — even a
  // historical frontend module (with a `build` script in package.json)
  // does NOT trigger `bun run build` during an upgrade.
  test("bun-linked: no bun run build invoked (kind branch retired in #330)", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "notes");
      writePackageJson(installDir, {
        name: "@openparachute/notes",
        version: "0.0.1",
        scripts: { build: "vite build" },
      });
      upsertService(
        {
          name: "parachute-notes",
          port: 1942,
          paths: ["/notes"],
          health: "/notes/health",
          version: "0.0.1",
          installDir,
        },
        h.manifestPath,
      );

      let headCalls = 0;
      const ranBuild = { value: false };
      const runner: UpgradeRunner = {
        async run(cmd) {
          if (cmd[0] === "bun" && cmd[1] === "run" && cmd[2] === "build") {
            ranBuild.value = true;
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 0, stdout: "true" };
          }
          if (cmd[1] === "status") return { code: 0, stdout: "" };
          if (cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
            headCalls++;
            return { code: 0, stdout: headCalls === 1 ? "111" : "222" };
          }
          if (cmd[1] === "diff") return { code: 0, stdout: "src/x.ts" };
          return { code: 0, stdout: "" };
        },
      };

      const code = await upgrade("notes", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async () => 0,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(ranBuild.value).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("npm-installed happy path: bun add -g, version bumps, restarts", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      // Initial version 0.4.0
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir, "0.4.0");

      const runner: UpgradeRunner = {
        async run(cmd) {
          // Simulate `bun add -g` rewriting the package.json with a new version
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(installDir, { name: "@openparachute/vault", version: "0.5.0" });
          }
          return 0;
        },
        async capture(cmd) {
          // Not a git checkout
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "fatal: not a git repository\n" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartedShort: string | undefined;
      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async (svc) => {
          restartedShort = svc;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(restartedShort).toBe("vault");
      const joined = logs.join("\n");
      expect(joined).toMatch(/npm-installed/);
      expect(joined).toMatch(/bun add -g @openparachute\/vault@latest/);
      expect(joined).toMatch(/0\.4\.0 → 0\.5\.0/);
    } finally {
      h.cleanup();
    }
  });

  test("git absent (ENOENT): no crash, isGitCheckout → false, npm path taken", async () => {
    // Real EC2 repro: a published-npm install on a minimal server with no
    // `git` binary. The production runner's Bun.spawn(["git", ...]) throws
    // synchronously with ENOENT; the upgrade flow must degrade to the npm
    // path rather than crashing with an uncaught "Executable not found".
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir, "0.4.0");

      const calls: RunCall[] = [];
      // Simulate the git-absent host: any spawn of `git` ENOENTs, surfaced
      // through the runner as a non-zero captured result (code 127). This is
      // exactly what the patched defaultRunner produces — we assert the
      // upgrade flow handles that result gracefully.
      const runner: UpgradeRunner = {
        async run(cmd, opts) {
          calls.push({ cmd: [...cmd], cwd: opts?.cwd, kind: "run" });
          if (cmd[0] === "git") return 127; // git-less host
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(installDir, { name: "@openparachute/vault", version: "0.5.0" });
          }
          return 0;
        },
        async capture(cmd, opts) {
          calls.push({ cmd: [...cmd], cwd: opts?.cwd, kind: "capture" });
          if (cmd[0] === "git") return { code: 127, stdout: "git: not found on this host\n" };
          return { code: 0, stdout: "" };
        },
      };

      let restartedShort: string | undefined;
      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async (svc) => {
          restartedShort = svc;
          return 0;
        },
        log: (l) => logs.push(l),
      });

      // No throw; the npm path ran end-to-end.
      expect(code).toBe(0);
      expect(restartedShort).toBe("vault");
      const joined = logs.join("\n");
      // isGitCheckout returned false → npm-installed branch, not bun-linked.
      expect(joined).toMatch(/npm-installed/);
      expect(joined).not.toMatch(/bun-linked/);
      expect(joined).toMatch(/bun add -g @openparachute\/vault@latest/);
      expect(joined).toMatch(/0\.4\.0 → 0\.5\.0/);
      // We probed git (and degraded) but never reached the git-mutating
      // commands (pull / status) that only run on the bun-linked branch.
      const gitRun = calls.filter((c) => c.kind === "run" && c.cmd[0] === "git");
      expect(gitRun).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("defaultRunner.capture: git-absent ENOENT yields code 127, no throw", async () => {
    // Drive the *production* runner against a binary that doesn't exist, to
    // prove the synchronous-spawn-throw is caught (not just the injectable
    // seam). Bun.spawn throws ENOENT synchronously for a missing binary.
    const missing = `parachute-no-such-binary-${process.pid}`;
    const captured = await defaultRunner.capture([missing, "--version"]);
    expect(captured.code).toBe(127);
    expect(captured.stdout).toContain("not found on this host");

    const ran = await defaultRunner.run([missing, "--version"]);
    expect(ran).toBe(127);
  });

  test("npm-installed: version unchanged → skip restart", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir, "0.4.0");

      // Don't change package.json on bun add -g — same version after.
      const runner: UpgradeRunner = {
        async run() {
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartCalled = false;
      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async () => {
          restartCalled = true;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(restartCalled).toBe(false);
      expect(logs.join("\n")).toMatch(/already at 0\.4\.0/);
    } finally {
      h.cleanup();
    }
  });

  test("npm-installed: --tag is forwarded to bun add -g", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir, "0.4.0");

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async () => 0,
        tag: "rc",
        log: () => {},
      });
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
    } finally {
      h.cleanup();
    }
  });

  test("hub as target: npm-installed path runs bun add -g @openparachute/hub@<tag> + restart", async () => {
    const h = makeHarness();
    try {
      // Hub is not in services.json — it's an internal service. The upgrade
      // command must still accept `hub` as a target, locate its global install,
      // run `bun add -g @openparachute/hub@latest`, and restart.
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.8" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.9" });
          }
          return 0;
        },
        async capture(cmd) {
          // Not a git checkout — drives the npm-install branch.
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "fatal: not a git repository\n" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartedShort: string | undefined;
      const logs: string[] = [];
      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async (svc) => {
          restartedShort = svc;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      // Phase 5b: the hub restarts via the platform manager (okHubUnitSupervisor),
      // not the detached restartFn — the unit-restart path has its own test.
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@latest"]);
      const joined = logs.join("\n");
      expect(joined).toMatch(/hub: npm-installed/);
      expect(joined).toMatch(/0\.5\.8 → 0\.5\.9/);
    } finally {
      h.cleanup();
    }
  });

  test("hub as target works even with empty services.json (closes #251)", async () => {
    // The dispatcher must be able to self-upgrade on a brand-new install where
    // services.json doesn't exist yet — that's the worst-case bootstrap path
    // and was the failure mode in #251.
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.8" });

      const runner: UpgradeRunner = {
        async run(cmd) {
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.9" });
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartedShort: string | undefined;
      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath, // file doesn't exist
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async (svc) => {
          restartedShort = svc;
          return 0;
        },
        log: () => {},
      });
      expect(code).toBe(0);
      // Phase 5b: the hub restarts via the platform manager (okHubUnitSupervisor),
      // not the detached restartFn — the unit-restart path has its own test.
    } finally {
      h.cleanup();
    }
  });

  test("hub as target: bun-linked checkout follows the linked path", async () => {
    const h = makeHarness();
    try {
      const checkoutDir = join(h.installRoot, "parachute-hub-checkout");
      writePackageJson(checkoutDir, { name: "@openparachute/hub", version: "0.5.9-rc.7" });

      let headCalls = 0;
      const runner: UpgradeRunner = {
        async run(cmd) {
          if (cmd[0] === "git" && cmd[1] === "pull") return 0;
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 0, stdout: "true" };
          }
          if (cmd[1] === "status") return { code: 0, stdout: "" };
          if (cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
            headCalls++;
            return { code: 0, stdout: headCalls === 1 ? "old" : "new" };
          }
          if (cmd[1] === "diff") return { code: 0, stdout: "src/foo.ts" };
          return { code: 0, stdout: "" };
        },
      };

      let restartedShort: string | undefined;
      const logs: string[] = [];
      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(checkoutDir, "package.json") : null,
        restartFn: async (svc) => {
          restartedShort = svc;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      // Phase 5b: the hub restarts via the platform manager (okHubUnitSupervisor),
      // not the detached restartFn — the unit-restart path has its own test.
      expect(logs.join("\n")).toMatch(/hub: bun-linked checkout/);
    } finally {
      h.cleanup();
    }
  });

  test("hub as target: --tag is forwarded to bun add -g for the hub package", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.8" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async () => 0,
        tag: "rc",
        log: () => {},
      });
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@rc"]);
    } finally {
      h.cleanup();
    }
  });

  test("sweep includes hub: hub upgraded alongside services.json entries", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      const vaultDir = join(h.installRoot, "vault");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.8" });
      writePackageJson(vaultDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, vaultDir);

      const runner: UpgradeRunner = {
        async run(cmd) {
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            const pkg = cmd[3] ?? "";
            if (pkg.startsWith("@openparachute/hub")) {
              writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.9" });
            }
            if (pkg.startsWith("@openparachute/vault")) {
              writePackageJson(vaultDir, { name: "@openparachute/vault", version: "0.5.0" });
            }
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const restartCalls: string[] = [];
      const code = await upgrade(undefined, {
        // Phase 5b: the hub restarts via the platform manager (restartHubUnit),
        // modules via restartFn. Record both into one order list so the hub-first
        // invariant is still asserted.
        supervisor: {
          restartHubUnit: (): HubUnitManagerOpResult => {
            restartCalls.push("hub");
            return { outcome: "ok", messages: [] };
          },
        },
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) => {
          if (pkg === "@openparachute/hub") return join(hubInstallDir, "package.json");
          if (pkg === "@openparachute/vault") return join(vaultDir, "package.json");
          return null;
        },
        restartFn: async (svc) => {
          restartCalls.push(svc);
          return 0;
        },
        log: () => {},
      });
      expect(code).toBe(0);
      // Hub goes first (manager restart) so its dispatcher upgrade isn't
      // preempted, then the module restarts route through lifecycle.
      expect(restartCalls).toEqual(["hub", "vault"]);
    } finally {
      h.cleanup();
    }
  });

  test("sweep (no svc): partial failure — later targets still run; first failure code wins", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      const vaultDir = join(h.installRoot, "vault");
      const notesDir = join(h.installRoot, "notes");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.8" });
      writePackageJson(vaultDir, { name: "@openparachute/vault", version: "0.4.0" });
      writePackageJson(notesDir, { name: "@openparachute/notes", version: "0.0.1" });
      seedVault(h.manifestPath, vaultDir);
      upsertService(
        {
          name: "parachute-notes",
          port: 1942,
          paths: ["/notes"],
          health: "/notes/health",
          version: "0.0.1",
          installDir: notesDir,
        },
        h.manifestPath,
      );

      // hub is npm-installed and succeeds (no version bump → skip restart).
      // vault is npm-installed (no git); bun add -g fails with 7
      // notes is npm-installed and succeeds with version bump
      const runner: UpgradeRunner = {
        async run(cmd, opts) {
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            const pkg = cmd[3] ?? "";
            if (pkg.startsWith("@openparachute/vault")) return 7;
            if (pkg.startsWith("@openparachute/notes")) {
              writePackageJson(notesDir, { name: "@openparachute/notes", version: "0.1.0" });
              return 0;
            }
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const restartCalls: string[] = [];
      const logs: string[] = [];
      const code = await upgrade(undefined, {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) => {
          if (pkg === "@openparachute/hub") return join(hubInstallDir, "package.json");
          if (pkg === "@openparachute/vault") return join(vaultDir, "package.json");
          if (pkg === "@openparachute/notes") return join(notesDir, "package.json");
          return null;
        },
        restartFn: async (svc) => {
          restartCalls.push(svc);
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(7);
      // Hub skipped restart (version unchanged), notes restarted after version bump.
      expect(restartCalls).toEqual(["notes"]);
      expect(logs.join("\n")).toMatch(/vault: bun add -g failed \(exit 7\)/);
    } finally {
      h.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // hub#332 — channel preservation + downgrade refusal
  // -------------------------------------------------------------------------

  test("detectChannel: rc suffixes → 'rc', everything else → 'latest'", () => {
    expect(detectChannel("0.5.13-rc.13")).toBe("rc");
    expect(detectChannel("0.5.13-rc.1")).toBe("rc");
    expect(detectChannel("0.5.13-rc")).toBe("rc"); // no .N suffix
    expect(detectChannel("0.5.10")).toBe("latest");
    expect(detectChannel("1.0.0")).toBe("latest");
    expect(detectChannel("0.5.13-beta.1")).toBe("latest"); // not rc
    expect(detectChannel("0.5.13-alpha")).toBe("latest");
  });

  test("compareVersions: stable > matching rc; later rc > earlier rc", () => {
    // Stable beats prerelease at equal triple (semver §11.4.3)
    expect(compareVersions("0.5.13", "0.5.13-rc.13")).toBeGreaterThan(0);
    expect(compareVersions("0.5.13-rc.13", "0.5.13")).toBeLessThan(0);
    // Aaron's reproducer: 0.5.10 < 0.5.13-rc.13 (lower triple beats prerelease tail)
    expect(compareVersions("0.5.10", "0.5.13-rc.13")).toBeLessThan(0);
    expect(compareVersions("0.5.13-rc.14", "0.5.13-rc.13")).toBeGreaterThan(0);
    expect(compareVersions("0.5.13-rc.13", "0.5.13-rc.13")).toBe(0);
    // Patch difference dominates prerelease tail
    expect(compareVersions("0.5.14", "0.5.13-rc.99")).toBeGreaterThan(0);
    // Garbage in → null
    expect(compareVersions("not-a-version", "0.5.10")).toBeNull();
  });

  test("auto-detects rc channel: installed 0.5.13-rc.13 → bun add -g @openparachute/hub@rc", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.13-rc.13" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(hubInstallDir, {
              name: "@openparachute/hub",
              version: "0.5.13-rc.14",
            });
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async () => 0,
        // No resolveChannelVersion → npm view stub returns empty → guard skipped
        log: () => {},
      });
      expect(code).toBe(0);
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@rc"]);
    } finally {
      h.cleanup();
    }
  });

  test("auto-detects stable channel: installed 0.5.10 → bun add -g @openparachute/hub@latest", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.10" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.11" });
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async () => 0,
        log: () => {},
      });
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@latest"]);
    } finally {
      h.cleanup();
    }
  });

  test("--channel rc overrides stable detection", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.10" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(hubInstallDir, {
              name: "@openparachute/hub",
              version: "0.5.13-rc.14",
            });
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async () => 0,
        channel: "rc",
        log: () => {},
      });
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@rc"]);
    } finally {
      h.cleanup();
    }
  });

  test("refuses downgrade: installed 0.5.13-rc.13, @rc resolves to 0.5.10 → abort", async () => {
    // Aaron's exact reproducer modulo the channel fix — once channel detection
    // lands, @rc is the right tag; if @rc itself somehow resolves backward we
    // still refuse.
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.13-rc.13" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const logs: string[] = [];
      let restartCalled = false;
      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async () => {
          restartCalled = true;
          return 0;
        },
        resolveChannelVersion: async (_pkg, _channel) => "0.5.10",
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(restartCalled).toBe(false);
      // bun add was never run
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toBeUndefined();
      const joined = logs.join("\n");
      expect(joined).toMatch(/refusing to downgrade/);
      expect(joined).toMatch(/installed 0\.5\.13-rc\.13/);
      expect(joined).toMatch(/0\.5\.10/);
      expect(joined).toMatch(/--allow-downgrade/);
    } finally {
      h.cleanup();
    }
  });

  test("--allow-downgrade bypasses the refusal", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.13-rc.13" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.10" });
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async () => 0,
        resolveChannelVersion: async () => "0.5.10",
        allowDowngrade: true,
        log: () => {},
      });
      expect(code).toBe(0);
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      // Channel was auto-detected as `rc` from the rc-suffixed installed version
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@rc"]);
    } finally {
      h.cleanup();
    }
  });

  test("Aaron's reproducer: installed 0.5.13-rc.13 → upgrades via @rc, version goes UP not down", async () => {
    // This is the exact bug from hub#332. Before the fix, `parachute upgrade
    // hub` ran `bun add -g @openparachute/hub@latest` which (because @latest
    // pointed at 0.5.10) silently downgraded an rc.13 install. With auto-
    // channel detection: rc.13 → @rc → 0.5.13-rc.14, version increases.
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.13-rc.13" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          if (
            cmd[0] === "bun" &&
            cmd[1] === "add" &&
            cmd[2] === "-g" &&
            cmd[3] === "@openparachute/hub@rc"
          ) {
            writePackageJson(hubInstallDir, {
              name: "@openparachute/hub",
              version: "0.5.13-rc.14",
            });
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const logs: string[] = [];
      let restartedShort: string | undefined;
      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async (svc) => {
          restartedShort = svc;
          return 0;
        },
        // @rc resolves to a HIGHER version than installed — no downgrade.
        resolveChannelVersion: async (_pkg, channel) =>
          channel === "rc" ? "0.5.13-rc.14" : "0.5.10",
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      // Phase 5b: the hub restarts via the platform manager (okHubUnitSupervisor),
      // not the detached restartFn — the unit-restart path has its own test.
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@rc"]);
      const joined = logs.join("\n");
      // Version went UP (rc.13 → rc.14), not DOWN as in the original report
      expect(joined).toMatch(/0\.5\.13-rc\.13 → 0\.5\.13-rc\.14/);
    } finally {
      h.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // hub#659 — rc channel resolves best-of @rc / @latest above installed.
  // The rc channel is a canary: it must stay ahead when a newer rc exists, but
  // CONVERGE to stable when a train shipped stable-direct (no rc cut) and the
  // box would otherwise strand below @latest with no visible path forward.
  // -------------------------------------------------------------------------

  test("rc channel, newer rc exists → takes @rc (canary stays ahead, #332 unchanged)", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.6.5-rc.8" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.6.5-rc.9" });
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const logs: string[] = [];
      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async () => 0,
        // A newer rc (rc.9) exists AND @latest moved (0.7.1) — the canary wins.
        resolveChannelVersion: async (_pkg, channel) => (channel === "rc" ? "0.6.5-rc.9" : "0.7.1"),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@rc"]);
      // No "converging to stable" line — we stayed on the canary.
      expect(logs.join("\n")).not.toMatch(/converging to stable/);
    } finally {
      h.cleanup();
    }
  });

  test("THE hub#659 pin: rc channel, NO newer rc but @latest is higher → converges to @latest with a loud line", async () => {
    // The live stranding case: friends.parachute.computer on 0.6.5-rc.8. The
    // @rc dist-tag never advanced (every train since shipped stable-direct), so
    // pre-fix `parachute upgrade hub` followed @rc and NO-OPPED — the box sat
    // below @latest (0.7.1) with no visible path. Post-fix: converge to the
    // concrete stable, pinned, with a loud log naming the channel + the version.
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.6.5-rc.8" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          // Honest registry simulation: `bun add -g @…@rc` resolves to the
          // installed rc.8 (no change → the pre-fix no-op); only the converged
          // stable pin rewrites the package.json. This is what makes the test
          // fail PRE-FIX — pre-fix the verb only ever asks for @rc and no-ops.
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            const spec = cmd[3] ?? "";
            if (spec.endsWith("@0.7.1") || spec.endsWith("@latest")) {
              writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.7.1" });
            }
            // spec ending in @rc → resolves to installed 0.6.5-rc.8, no rewrite.
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const logs: string[] = [];
      let restartedShort: string | undefined;
      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async (svc) => {
          restartedShort = svc;
          return 0;
        },
        // @rc stuck at the installed version (no newer rc); @latest moved ahead.
        resolveChannelVersion: async (_pkg, channel) => (channel === "rc" ? "0.6.5-rc.8" : "0.7.1"),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      // Converged: pinned to the CONCRETE stable version (not @latest dist-tag),
      // so a moving tag can't race the resolution.
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@0.7.1"]);
      // Phase 5b: hub restarts via the manager (okHubUnitSupervisor); the verb
      // still reaches the restart leg because the version changed.
      const joined = logs.join("\n");
      // The LOUD convergence line — names the rc channel, the installed version,
      // the stable target, and the "next rc" reassurance.
      expect(joined).toMatch(/the rc channel has nothing newer than 0\.6\.5-rc\.8/);
      expect(joined).toMatch(/converging to stable 0\.7\.1/);
      expect(joined).toMatch(/pick up the next rc/);
      // It actually moved (the no-op would NOT have).
      expect(joined).toMatch(/0\.6\.5-rc\.8 → 0\.7\.1/);
      void restartedShort; // hub restarts via the manager seam, not restartFn
    } finally {
      h.cleanup();
    }
  });

  test("rc channel, @rc and @latest both ≤ installed → up-to-date no-op (names both)", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.7.2-rc.1" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          // bun add -g @rc resolves to the same installed version → no rewrite.
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const logs: string[] = [];
      let restartCalled = false;
      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async () => {
          restartCalled = true;
          return 0;
        },
        // Nothing newer anywhere: @rc == installed, @latest below installed.
        resolveChannelVersion: async (_pkg, channel) => (channel === "rc" ? "0.7.2-rc.1" : "0.7.1"),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(restartCalled).toBe(false);
      // Stays on @rc (no convergence); the post-install no-op fires.
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@rc"]);
      const joined = logs.join("\n");
      expect(joined).toMatch(/@rc \(0\.7\.2-rc\.1\) and @latest \(0\.7\.1\) are both at or below/);
      expect(joined).toMatch(/already at 0\.7\.2-rc\.1/);
      expect(joined).not.toMatch(/converging to stable/);
    } finally {
      h.cleanup();
    }
  });

  test("latest channel is unchanged: stable install never reaches for @rc (hub#659 scoped to rc)", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.7.1" });

      const seenCmd: string[][] = [];
      let rcProbed = false;
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.7.2" });
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async () => 0,
        // Track whether the rc tag is ever probed — it must NOT be on the
        // stable channel (best-of resolution is scoped to rc).
        resolveChannelVersion: async (_pkg, channel) => {
          if (channel === "rc") rcProbed = true;
          return channel === "latest" ? "0.7.2" : "0.8.0-rc.1";
        },
        log: () => {},
      });
      expect(code).toBe(0);
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@latest"]);
      // The stable channel never reaches across to @rc.
      expect(rcProbed).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("rc channel converge still respects the downgrade guard (no @latest below installed sneaks through)", async () => {
    // Defensive: if @rc is stuck AND @latest is somehow BELOW installed (an
    // operator on a hand-pinned newer rc than the latest stable), we neither
    // converge nor downgrade — we stay on @rc and no-op.
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.8.0-rc.1" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const logs: string[] = [];
      const code = await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async () => 0,
        // @rc == installed (no newer rc); @latest is a PRIOR stable, below us.
        resolveChannelVersion: async (_pkg, channel) => (channel === "rc" ? "0.8.0-rc.1" : "0.7.1"),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      // Stayed on @rc — no convergence to a lower stable.
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@rc"]);
      expect(logs.join("\n")).not.toMatch(/converging to stable/);
      expect(logs.join("\n")).not.toMatch(/refusing to downgrade/);
    } finally {
      h.cleanup();
    }
  });

  test("--tag still overrides everything (back-compat for programmatic pin)", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.13-rc.13" });

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      await upgrade("hub", {
        supervisor: okHubUnitSupervisor,
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        restartFn: async () => 0,
        // Programmatic `tag` wins over auto-detection AND --channel.
        tag: "next",
        channel: "rc",
        log: () => {},
      });
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@next"]);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 4 dual-dispatch (design §5): when a hub UNIT is installed, `upgrade hub`
// rewrites the binary as usual then RESTARTS THE UNIT via the platform manager
// (`restartHubUnit`), NOT the detached `restartFn` (stopHub/ensureHubRunning).
// The manager tears down the old hub (children die) and starts the new binary,
// which re-boots every module. No-unit → the unchanged detached restart.
// ---------------------------------------------------------------------------

describe("Phase 4 upgrade-hub dual-dispatch", () => {
  test("upgrade hub unit-managed → binary rewrite + restartHubUnit (manager), NOT detached restartFn", async () => {
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.6.3-rc.1" });
      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            // Channel auto-detected as @rc from the installed -rc version.
            writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.6.3-rc.2" });
          }
          return 0;
        },
        async capture(cmd) {
          // Not a git checkout → npm-install branch.
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "fatal: not a git repository\n" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartFnCalled = false;
      let restartHubUnitCalls = 0;
      const logs: string[] = [];
      const code = await upgrade("hub", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        // The detached restart path must NOT be taken on the unit arm.
        restartFn: async () => {
          restartFnCalled = true;
          return 0;
        },
        // Avoid a real registry round-trip in the downgrade guard.
        resolveChannelVersion: async () => null,
        supervisor: {
          restartHubUnit: (_deps: HubUnitDeps): HubUnitManagerOpResult => {
            restartHubUnitCalls++;
            return { outcome: "ok", messages: [] };
          },
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      // The binary was rewritten via bun add -g @rc…
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/hub@rc"]);
      // …and the restart went through the platform manager, not the detached PID path.
      expect(restartHubUnitCalls).toBe(1);
      expect(restartFnCalled).toBe(false);
      expect(logs.join("\n")).toMatch(/restarted the hub unit/);
    } finally {
      h.cleanup();
    }
  });

  test("upgrade hub NO unit → restartHubUnit reports no-unit, surfaced as a failure", async () => {
    // Phase 5b: the detached restart arm is retired. `upgrade hub` always
    // restarts the hub UNIT via the platform manager; on a box with no unit the
    // manager op returns `no-unit` (after the binary rewrite), which the verb
    // surfaces as a non-zero exit with the manager's message — never a detached
    // spawn.
    const h = makeHarness();
    try {
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.8" });
      const runner: UpgradeRunner = {
        async run(cmd) {
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.5.9" });
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const logs: string[] = [];
      const code = await upgrade("hub", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/hub" ? join(hubInstallDir, "package.json") : null,
        resolveChannelVersion: async () => null,
        supervisor: {
          restartHubUnit: (_deps: HubUnitDeps): HubUnitManagerOpResult => ({
            outcome: "no-unit",
            messages: ["no hub unit installed — run `parachute migrate` to install it"],
          }),
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/no hub unit installed/);
    } finally {
      h.cleanup();
    }
  });

  test("sweep stays hub-first; hub restart uses the manager, module restarts route through lifecycle", async () => {
    const h = makeHarness();
    try {
      // Hub install dir + a vault module in services.json — sweep upgrades both.
      const hubInstallDir = join(h.installRoot, "hub");
      writePackageJson(hubInstallDir, { name: "@openparachute/hub", version: "0.6.3-rc.1" });
      const vaultInstallDir = join(h.installRoot, "vault");
      writePackageJson(vaultInstallDir, { name: "@openparachute/vault", version: "0.6.3-rc.1" });
      seedVault(h.manifestPath, vaultInstallDir, "0.6.3-rc.1");

      const runner: UpgradeRunner = {
        async run(cmd) {
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            const spec = cmd[3] ?? "";
            if (spec.startsWith("@openparachute/hub")) {
              writePackageJson(hubInstallDir, {
                name: "@openparachute/hub",
                version: "0.6.3-rc.2",
              });
            } else if (spec.startsWith("@openparachute/vault")) {
              writePackageJson(vaultInstallDir, {
                name: "@openparachute/vault",
                version: "0.6.3-rc.2",
              });
            }
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const restartOrder: string[] = [];
      let restartHubUnitCalls = 0;
      const code = await upgrade(undefined, {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) => {
          if (pkg === "@openparachute/hub") return join(hubInstallDir, "package.json");
          if (pkg === "@openparachute/vault") return join(vaultInstallDir, "package.json");
          return null;
        },
        // Module restarts (vault) go through lifecycle's restart with a
        // supervisor block; the stub records the order so we can assert hub-first.
        restartFn: async (svc) => {
          restartOrder.push(svc);
          return 0;
        },
        resolveChannelVersion: async () => null,
        supervisor: {
          restartHubUnit: (_deps: HubUnitDeps): HubUnitManagerOpResult => {
            restartHubUnitCalls++;
            restartOrder.push("hub-unit");
            return { outcome: "ok", messages: [] };
          },
        },
        log: () => {},
      });
      expect(code).toBe(0);
      // Hub-first: the hub unit restart precedes the vault module restart.
      expect(restartOrder[0]).toBe("hub-unit");
      expect(restartOrder).toContain("vault");
      expect(restartOrder.indexOf("hub-unit")).toBeLessThan(restartOrder.indexOf("vault"));
      expect(restartHubUnitCalls).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 5b nit: the module-target restart leg of `upgrade` must thread the SAME
// opts a bare `parachute restart <svc>` does — `supervisor: {}` (real
// `isHubUnitInstalled` probe, NOT a forced `unitInstalled: true`) +
// `migrateOffer: { enabled: true }`. On a NO-UNIT box that means the module
// restart surfaces the actionable "run `parachute migrate --to-supervised`"
// error / fires the auto-offer, NOT a bare connection-refused from
// `driveModuleOp`. The other upgrade tests stub `restartFn: async () => 0`, so
// the supervised arm was never exercised here — this closes that gap by driving
// the REAL `lifecycle.restart`.
// ---------------------------------------------------------------------------

describe("Phase 5b: upgrade module-restart on a no-unit box", () => {
  test("module restart threads supervisor:{} + migrateOffer (no forced unitInstalled), surfaces actionable migrate error — NOT a bare connection-refused", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir, "0.4.0");

      const runner: UpgradeRunner = {
        async run(cmd) {
          // `bun add -g` rewrites the package.json with a new version → the
          // module restart leg (`restartTarget`) is reached.
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(installDir, { name: "@openparachute/vault", version: "0.5.0" });
          }
          return 0;
        },
        async capture(cmd) {
          // Not a git checkout → npm-install branch.
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "fatal: not a git repository\n" };
          }
          return { code: 0, stdout: "" };
        },
      };

      // A NO-UNIT box: force `isHubUnitInstalled` → false deterministically
      // (regardless of the test host) by stubbing the unit-file existence probe.
      const noUnitDeps: HubUnitDeps = { ...defaultHubUnitDeps, exists: () => false };

      // The supervised arm's loopback module-ops call MUST NOT run on a no-unit
      // box. If the regressed code forced `unitInstalled: true`, the verb would
      // skip the probe and hit this — surfacing a bare connection-refused.
      let driveModuleOpCalled = false;
      const refuse = async (): Promise<never> => {
        driveModuleOpCalled = true;
        throw new Error("connect ECONNREFUSED 127.0.0.1:1939");
      };

      // Capture the opts `restartTarget` hands `lifecycle.restart`, then delegate
      // to the REAL `lifecycle.restart` so the no-unit handling actually runs.
      // The offer is overridden to a deterministic `declined` so the outcome
      // doesn't depend on the host's stdin-TTY / prior-detached state.
      let seenOpts: LifecycleOpts | undefined;
      let offerCalls = 0;
      const restartFn = async (svc: string, opts: LifecycleOpts): Promise<number> => {
        seenOpts = opts;
        return await lifecycleRestart(svc, {
          ...opts,
          supervisor: {
            ...opts.supervisor,
            hubUnitDeps: noUnitDeps,
            driveModuleOp: refuse,
          },
          migrateOffer: {
            enabled: opts.migrateOffer?.enabled ?? false,
            offer: async (): Promise<MigrateOfferResult> => {
              offerCalls++;
              return { outcome: "declined" };
            },
          },
        });
      };

      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn,
        // Upgrade-side supervisor seam: feeds `r.hubUnitDeps`, which
        // `restartTarget` threads into `lifecycle.restart`'s supervisor block.
        supervisor: { hubUnitDeps: noUnitDeps },
        log: (l) => logs.push(l),
      });

      // The package rewrite + restart attempt happened (non-zero because the box
      // is un-migrated and the offer was declined — a clean, actionable failure).
      expect(code).toBe(1);

      // The contract fix: `restartTarget` passes `supervisor` WITHOUT forcing
      // `unitInstalled: true`, plus an ENABLED migrate offer — exactly what a
      // bare `parachute restart <svc>` threads.
      expect(seenOpts).toBeDefined();
      expect(seenOpts?.supervisor).toBeDefined();
      expect(seenOpts?.supervisor?.unitInstalled).toBeUndefined();
      expect(seenOpts?.migrateOffer?.enabled).toBe(true);

      // The no-unit handling ran: the auto-offer fired (real probe → no unit),
      // and the supervised loopback call was NEVER reached (no connection-refused).
      expect(offerCalls).toBe(1);
      expect(driveModuleOpCalled).toBe(false);
      expect(logs.join("\n")).not.toMatch(/ECONNREFUSED|connection refused/i);
    } finally {
      h.cleanup();
    }
  });
});
