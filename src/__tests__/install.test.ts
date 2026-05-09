import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "../commands/install.ts";
import { findService, upsertService } from "../services-manifest.ts";

function makeTempPath(): { path: string; configDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-install-"));
  return {
    path: join(dir, "services.json"),
    configDir: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("install", () => {
  test("rejects third-party package with no module.json (hard error)", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("mystery", {
        runner: async () => 0,
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/does not ship \.parachute\/module\.json/);
    } finally {
      cleanup();
    }
  });

  test("runs bun add -g then init; seeds manifest when service didn't write one", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls[0]).toEqual(["bun", "add", "-g", "@openparachute/vault"]);
      expect(calls[1]).toEqual(["parachute-vault", "init"]);
      expect(logs.join("\n")).toMatch(/Seeded services\.json entry for parachute-vault/);
      const seeded = findService("parachute-vault", path);
      expect(seeded?.port).toBe(1940);
      expect(seeded?.version).toBe("0.0.0-linked");
    } finally {
      cleanup();
    }
  });

  test("confirms registration when manifest entry exists after init (no seeding)", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          if (cmd[0] === "parachute-vault") {
            upsertService(
              {
                name: "parachute-vault",
                port: 1940,
                paths: ["/"],
                health: "/health",
                version: "0.2.4",
              },
              path,
            );
          }
          return 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/registered on port 1940/);
      expect(logs.join("\n")).not.toMatch(/Seeded/);
      const entry = findService("parachute-vault", path);
      expect(entry?.version).toBe("0.2.4");
    } finally {
      cleanup();
    }
  });

  test("propagates non-zero exit from bun add when package not present at global prefix", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 42;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        findGlobalInstall: () => null,
        log: () => {},
      });
      expect(code).toBe(42);
      expect(calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("tolerates bun add exit 1 when the package is actually installed (bun 1.2.x lockfile quirk)", async () => {
    // Repro: `bun add -g @openparachute/vault` on bun 1.2.19 can print
    // "InvalidPackageResolution" + "Failed to install 1 package" and exit 1,
    // while the package *is* installed (see "installed @openparachute/vault…
    // with binaries" in the same output). If we bail on the exit code, init
    // + seed never runs and `parachute status` shows nothing even though
    // the binary is on PATH — day-one breakage for anyone on bun 1.2.x.
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          // `bun add -g` exits 1; `parachute-vault init` succeeds.
          return cmd[0] === "bun" ? 1 : 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/vault"
            ? "/fake/bun/global/node_modules/@openparachute/vault/package.json"
            : null,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      // Warning mentions the found path and the bun 1.2.x quirk.
      expect(logs.join("\n")).toMatch(
        /bun add reported exit 1 but @openparachute\/vault is installed at/,
      );
      expect(logs.join("\n")).toMatch(/bun 1\.2\.x lockfile quirk/);
      // Crucially: init still ran, and the service got seeded.
      expect(calls).toEqual([
        ["bun", "add", "-g", "@openparachute/vault"],
        ["parachute-vault", "init"],
      ]);
      const seeded = findService("parachute-vault", path);
      expect(seeded?.port).toBe(1940);
    } finally {
      cleanup();
    }
  });

  test("notes tolerance path: bun add exit 1 + package present → seedEntry still fires", async () => {
    // Mirror of the vault tolerance test for notes (#44). notes has no
    // spec.init, so the only path to a services.json entry on a fresh
    // install is the seedEntry block. Verifies that gate is reached even
    // when bun's exit code says "failed."
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("notes", {
        runner: async (cmd) => (cmd[0] === "bun" ? 1 : 0),
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        findGlobalInstall: (pkg) =>
          pkg === "@openparachute/notes"
            ? "/fake/bun/global/node_modules/@openparachute/notes/package.json"
            : null,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      const seeded = findService("parachute-notes", path);
      expect(seeded?.port).toBe(1942);
      expect(logs.join("\n")).toMatch(/Seeded services\.json entry for parachute-notes/);
      expect(logs.join("\n")).toMatch(/bun 1\.2\.x lockfile quirk/);
    } finally {
      cleanup();
    }
  });

  test("non-tolerance bun add failure logs the prefixes that were probed", async () => {
    // Defensive logging from #44: when findGlobalInstall returns null we want
    // operators on non-standard bun layouts to see WHERE we looked, so they
    // can spot a BUN_INSTALL or homebrew-prefix mismatch. The prefixes line
    // is the actionable signal.
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async () => 1,
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        findGlobalInstall: () => null,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/probed bun globals at:/);
    } finally {
      cleanup();
    }
  });

  test("final registration check warns when the entry is missing at install exit", async () => {
    // Unknown / third-party services with no spec are rejected upfront, but
    // a registered service whose spec lacks both `init` AND `seedEntry` could
    // exit install with no manifest entry. We can't trigger that with the
    // real ServiceSpec catalog, so simulate it by removing the entry mid-
    // flight via a runner side-effect.
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          // vault's init "succeeds" but never writes services.json. seedEntry
          // fires (vault has one) → entry present. Then we sabotage by
          // emptying the manifest before the final check, simulating an
          // external clobber that the verify-step is designed to catch.
          if (cmd[0] === "parachute-vault") {
            // no-op (init didn't write)
          }
          return 0;
        },
        manifestPath: path,
        // After install runs through to auto-start, the startService stub
        // gets called. We use it as the very last hook before the final
        // check to wipe the manifest.
        startService: async () => {
          // Wipe services.json so the final findService comes back empty.
          const { writeFileSync } = await import("node:fs");
          writeFileSync(path, JSON.stringify({ services: [] }, null, 2));
          return 0;
        },
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/parachute-vault is not in services\.json after install/);
    } finally {
      cleanup();
    }
  });

  test("CLI overrides a non-canonical port written by init when canonical is free", async () => {
    // Pre-#53 the CLI deferred to whatever port the service's init wrote
    // (e.g. 5173, Vite's dev default for notes). With hub-as-port-authority
    // the canonical slot wins when free: services.json is updated to the
    // canonical port (post-hub#206 the install path no longer touches .env;
    // services.json is the single source of truth at boot per the 4-tier
    // resolvePort ladder in scribe/agent).
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("notes", {
        runner: async (cmd) => {
          if (cmd[0] === "bun") {
            upsertService(
              {
                name: "parachute-notes",
                port: 5173,
                paths: ["/notes"],
                health: "/notes/health",
                version: "0.0.1",
              },
              path,
            );
          }
          return 0;
        },
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/Updated services\.json port to 1942/);
      expect(logs.join("\n")).toMatch(/registered on port 1942/);
      expect(logs.join("\n")).not.toMatch(/outside the canonical Parachute range/);
      const entry = findService("parachute-notes", path);
      expect(entry?.port).toBe(1942);
    } finally {
      cleanup();
    }
  });

  test("warns when canonical range is exhausted and assignment falls outside", async () => {
    // Defensive: if every canonical slot 1939–1949 is occupied (probe says
    // so), assignPort falls outside the range and surfaces a warning so
    // operators can free a slot or accept the conflict risk.
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        // Every canonical slot is taken.
        portProbe: async () => true,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      const joined = logs.join("\n");
      expect(joined).toMatch(/canonical range.*1939–1949.*is full/);
      expect(joined).toMatch(/outside the canonical Parachute range/);
      const entry = findService("parachute-vault", path);
      expect(entry?.port).toBeGreaterThan(1949);
    } finally {
      cleanup();
    }
  });

  test("`install lens` aliases to notes with a rename notice", async () => {
    // Transition alias for the brief Notes→Lens rename (Apr 19) that was
    // reverted on launch eve (Apr 22). Accepted for one release cycle so
    // anyone who ran `parachute install lens` during the ~3-day window
    // keeps working; removed after launch users have re-installed.
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("lens", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/"lens" has been renamed to "notes"; installing notes\./);
      // Downstream bun-add must use the new package name, not the old.
      expect(calls[0]).toEqual(["bun", "add", "-g", "@openparachute/notes"]);
      const seeded = findService("parachute-notes", path);
      expect(seeded?.port).toBe(1942);
    } finally {
      cleanup();
    }
  });

  test("does not warn when manifest port is in the canonical range", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      await install("vault", {
        runner: async (cmd) => {
          if (cmd[0] === "parachute-vault") {
            upsertService(
              {
                name: "parachute-vault",
                port: 1940,
                paths: ["/vault/default"],
                health: "/vault/default/health",
                version: "0.2.4",
              },
              path,
            );
          }
          return 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(logs.join("\n")).not.toMatch(/outside the canonical/);
    } finally {
      cleanup();
    }
  });

  test("skips init when spec has none (scribe)", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["bun", "add", "-g", "@openparachute/scribe"]);
      // scribe has no init, so seedEntry fires — no authoritative entry to defer to.
      const seeded = findService("parachute-scribe", path);
      expect(seeded?.port).toBe(1943);
      expect(logs.join("\n")).toMatch(/Seeded services\.json entry for parachute-scribe/);
    } finally {
      cleanup();
    }
  });

  test("skips `bun add -g` when the package is already bun-linked", async () => {
    // The scribe motivator: package isn't published to npm yet, so `bun add -g`
    // 404s. If bun link already points the global node_modules at a local
    // checkout, detect that and proceed to init + seeding.
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: (pkg) => pkg === "@openparachute/scribe",
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/already linked globally/);
      const seeded = findService("parachute-scribe", path);
      expect(seeded?.port).toBe(1943);
      expect(seeded?.paths).toEqual(["/scribe"]);
    } finally {
      cleanup();
    }
  });

  test("--tag composes `<package>@<tag>` for the bun add call", async () => {
    // RC testers pin a pre-release channel via dist-tag (e.g. `--tag rc`).
    // The composed name shows up in logs so the operator knows which channel
    // they're on — no surprise upgrades when the tag rolls forward.
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
        tag: "rc",
      });
      expect(code).toBe(0);
      expect(calls[0]).toEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
      expect(logs.join("\n")).toMatch(/Installing @openparachute\/vault@rc/);
    } finally {
      cleanup();
    }
  });

  test("--tag accepts an exact version string", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
        tag: "0.3.0-rc.1",
      });
      expect(code).toBe(0);
      expect(calls[0]).toEqual(["bun", "add", "-g", "@openparachute/vault@0.3.0-rc.1"]);
    } finally {
      cleanup();
    }
  });

  test("--tag is moot when the package is already bun-linked", async () => {
    // The link short-circuit beats the tag — local checkout wins, no fetch.
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => true,
        portProbe: async () => false,
        log: (l) => logs.push(l),
        tag: "rc",
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/already linked globally/);
    } finally {
      cleanup();
    }
  });

  test("error log on non-zero bun add includes the tagged spec", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async () => 1,
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        findGlobalInstall: () => null,
        log: (l) => logs.push(l),
        tag: "rc",
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/bun add -g @openparachute\/vault@rc failed/);
    } finally {
      cleanup();
    }
  });

  test("linked vault still runs init and defers to init's manifest write", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          if (cmd[0] === "parachute-vault") {
            upsertService(
              {
                name: "parachute-vault",
                port: 1940,
                paths: ["/vault/default"],
                health: "/vault/default/health",
                version: "0.3.0",
              },
              path,
            );
          }
          return 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => true,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toEqual([["parachute-vault", "init"]]);
      expect(logs.join("\n")).not.toMatch(/Seeded/);
      expect(findService("parachute-vault", path)?.version).toBe("0.3.0");
    } finally {
      cleanup();
    }
  });

  // Auto-wire: when `parachute install` lands a service that completes the
  // vault↔scribe pair, generate a shared secret and persist to both sides.
  // Covered in detail by auto-wire.test.ts; these tests assert the install
  // command actually invokes the helper at the right moment.
  test("installing scribe with vault already present auto-wires the shared secret", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      // Pretend vault was installed previously — entry already in services.json.
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        path,
      );
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
        randomToken: () => "test-token-value",
      });
      expect(code).toBe(0);

      const envPath = join(configDir, "vault", ".env");
      const scribeCfgPath = join(configDir, "scribe", "config.json");
      expect(existsSync(envPath)).toBe(true);
      expect(existsSync(scribeCfgPath)).toBe(true);

      const envText = readFileSync(envPath, "utf8");
      expect(envText).toContain("SCRIBE_AUTH_TOKEN=test-token-value");
      const cfg = JSON.parse(readFileSync(scribeCfgPath, "utf8"));
      expect(cfg.auth.required_token).toBe("test-token-value");

      expect(logs.join("\n")).toMatch(/Auto-wired shared secret \+ SCRIBE_URL/);
    } finally {
      cleanup();
    }
  });

  test("installing scribe without vault does NOT auto-wire (nothing to wire against)", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
        randomToken: () => "should-not-fire",
      });
      expect(code).toBe(0);
      // No vault/.env, no scribe/config.json written by auto-wire.
      expect(existsSync(join(configDir, "vault", ".env"))).toBe(false);
      expect(existsSync(join(configDir, "scribe", "config.json"))).toBe(false);
      expect(logs.join("\n")).not.toMatch(/Auto-wired shared secret/);
    } finally {
      cleanup();
    }
  });

  test("installing vault with scribe already present auto-wires (either-order)", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      upsertService(
        {
          name: "parachute-scribe",
          port: 1943,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.1.0",
        },
        path,
      );
      const code = await install("vault", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
        randomToken: () => "install-vault-side-token",
      });
      expect(code).toBe(0);
      const envText = readFileSync(join(configDir, "vault", ".env"), "utf8");
      expect(envText).toContain("SCRIBE_AUTH_TOKEN=install-vault-side-token");
    } finally {
      cleanup();
    }
  });

  test("repeat install preserves an existing SCRIBE_AUTH_TOKEN (idempotent)", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        path,
      );
      // First install: mints a token.
      await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
        randomToken: () => "first-token",
      });
      // Second install: must preserve the first token — churning it would
      // break an already-running vault worker that's holding the old one.
      await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
        randomToken: () => "should-not-replace",
      });
      const envText = readFileSync(join(configDir, "vault", ".env"), "utf8");
      expect(envText).toContain("SCRIBE_AUTH_TOKEN=first-token");
      expect(envText).not.toContain("should-not-replace");
    } finally {
      cleanup();
    }
  });

  test("installing notes doesn't trigger auto-wire even if vault + scribe are present", async () => {
    // Defense: auto-wire should only fire from the scribe or vault install
    // path. A parallel install of a different service shouldn't touch the
    // shared-secret files.
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        path,
      );
      upsertService(
        {
          name: "parachute-scribe",
          port: 1943,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.1.0",
        },
        path,
      );
      await install("notes", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
        randomToken: () => "should-not-fire",
      });
      expect(existsSync(join(configDir, "vault", ".env"))).toBe(false);
      expect(existsSync(join(configDir, "scribe", "config.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  // Auto-start: launch-day demo had Aaron running `parachute install scribe`
  // and then having to remember `parachute start scribe` separately. After
  // 0.2.5, install ends with the daemon running.
  test("auto-starts the service after a successful install", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const startCalls: string[] = [];
      const code = await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        startService: async (short) => {
          startCalls.push(short);
          return 0;
        },
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(startCalls).toEqual(["scribe"]);
    } finally {
      cleanup();
    }
  });

  test("--no-start suppresses the auto-start", async () => {
    // Piped / CI installs that own their own process model want the install
    // to land but not spawn anything.
    const { path, cleanup } = makeTempPath();
    try {
      const startCalls: string[] = [];
      const code = await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        startService: async (short) => {
          startCalls.push(short);
          return 0;
        },
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
        noStart: true,
      });
      expect(code).toBe(0);
      expect(startCalls).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("auto-start uses the resolved (post-alias) short name", async () => {
    // `install lens` aliases to notes — the start call must target notes,
    // not the alias the user typed.
    const { path, cleanup } = makeTempPath();
    try {
      const startCalls: string[] = [];
      const code = await install("lens", {
        runner: async () => 0,
        manifestPath: path,
        startService: async (short) => {
          startCalls.push(short);
          return 0;
        },
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(startCalls).toEqual(["notes"]);
    } finally {
      cleanup();
    }
  });

  test("logs a hint when auto-start fails but doesn't fail the install itself", async () => {
    // The install completed; a flaky daemon launch shouldn't roll it back.
    // User gets a clear pointer to retry manually.
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        startService: async () => 1,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/scribe didn't start cleanly.*parachute start scribe/);
    } finally {
      cleanup();
    }
  });

  test("scribe install emits the post-install footer with provider hints", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      const joined = logs.join("\n");
      expect(joined).toMatch(/Scribe is listening on http:\/\/127\.0\.0\.1:1943/);
      expect(joined).toMatch(/parakeet-mlx/);
      expect(joined).toMatch(/groq.*openai/);
    } finally {
      cleanup();
    }
  });

  test("notes install emits the post-install footer pointing at the Notes UI", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("notes", {
        runner: async () => 0,
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      const joined = logs.join("\n");
      expect(joined).toMatch(/Open your Notes UI at http:\/\/localhost:1942\/notes/);
      expect(joined).toMatch(/http:\/\/127\.0\.0\.1:1940\/vault\/default/);
    } finally {
      cleanup();
    }
  });

  test("vault install does not emit a CLI-side footer (vault prints its own)", async () => {
    // PR #166 has parachute-vault init print a richer footer with the API
    // token; the CLI shouldn't double up. spec.postInstallFooter is left
    // undefined for vault on purpose.
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      await install("vault", {
        runner: async () => 0,
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      const joined = logs.join("\n");
      expect(joined).not.toMatch(/Open your Notes UI/);
      expect(joined).not.toMatch(/Scribe is listening/);
    } finally {
      cleanup();
    }
  });

  test("scribe install with --scribe-provider/--scribe-key writes config + .env non-interactively", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      const code = await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
        scribeProvider: "groq",
        scribeKey: "gsk_test_value",
        scribeAvailability: { kind: "not-tty" },
      });
      expect(code).toBe(0);
      const cfg = JSON.parse(readFileSync(join(configDir, "scribe", "config.json"), "utf8"));
      expect(cfg.transcribe).toEqual({ provider: "groq" });
      const envText = readFileSync(join(configDir, "scribe", ".env"), "utf8");
      expect(envText).toContain("GROQ_API_KEY=gsk_test_value");
    } finally {
      cleanup();
    }
  });

  test("scribe install drives interactive prompt via the availability seam", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      const answers = ["openai", "sk-from-prompt"];
      let i = 0;
      const code = await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
        scribeAvailability: {
          kind: "available",
          prompt: async () => answers[i++] ?? "",
        },
      });
      expect(code).toBe(0);
      const cfg = JSON.parse(readFileSync(join(configDir, "scribe", "config.json"), "utf8"));
      expect(cfg.transcribe).toEqual({ provider: "openai" });
      const envText = readFileSync(join(configDir, "scribe", ".env"), "utf8");
      expect(envText).toContain("OPENAI_API_KEY=sk-from-prompt");
    } finally {
      cleanup();
    }
  });

  test("scribe install in non-TTY without flags leaves config untouched", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      const code = await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
        scribeAvailability: { kind: "not-tty" },
      });
      expect(code).toBe(0);
      // Auto-wire didn't run (no vault), so config.json is never created.
      expect(existsSync(join(configDir, "scribe", "config.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("non-scribe service install does not invoke the provider setup", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      const code = await install("vault", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
        // If the installer were to call setupScribeProvider here, the absent
        // availability seam would default to detecting a real TTY and (in
        // a real test runner with no TTY) skip silently. We just assert no
        // scribe config materialized.
      });
      expect(code).toBe(0);
      expect(existsSync(join(configDir, "scribe", "config.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  // Hub-as-port-authority (#53), services.json-is-authoritative (#206).
  // Install picks the service's port up front and reflects it in
  // services.json. Pre-#206 it also wrote `PORT=<port>` into the service's
  // `.env`; post-#206 it doesn't — services.json is the single source of
  // truth at boot per the 4-tier resolvePort ladder in scribe#41 / agent#146
  // / agent#148, so the duplicate `.env` PORT was at best dead weight and
  // at worst a source of drift on re-install.
  test("install reflects canonical port in services.json without writing PORT to .env (hub#206)", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const code = await install("vault", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
      });
      expect(code).toBe(0);
      // services.json is authoritative — that's where the port lives.
      const entry = findService("parachute-vault", path);
      expect(entry?.port).toBe(1940);
      // .env should NOT have a PORT line. The directory may not even
      // exist (nothing in this test path writes to the service's config
      // dir); if it does, the file shouldn't carry PORT.
      const envPath = join(configDir, "vault", ".env");
      if (existsSync(envPath)) {
        expect(readFileSync(envPath, "utf8")).not.toMatch(/^PORT=/m);
      }
    } finally {
      cleanup();
    }
  });

  test("install does NOT preserve a pre-existing PORT in .env across re-installs (hub#206)", async () => {
    // Pre-#206 a stale `.env` PORT survived a re-install: an operator
    // who edited services.json to fix a duplicate would get re-stamped
    // by the .env on the next `parachute install`. Post-#206 services.json
    // is authoritative; the install path leaves `.env` alone but
    // services.json reflects the freshly-assigned port. The stale `.env`
    // PORT is harmless because the boot-time resolvePort ladder reads
    // services.json before falling through to the bare PORT env tier.
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const envPath = join(configDir, "vault", ".env");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(configDir, "vault"), { recursive: true });
      // Pre-existing .env with an operator-edited (now-stale) PORT.
      const before = "PORT=1947\nOTHER=keepme\n";
      writeFileSync(envPath, before);

      await install("vault", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
      });

      // services.json gets the freshly-assigned canonical port (1940),
      // NOT the stale 1947 from .env.
      const entry = findService("parachute-vault", path);
      expect(entry?.port).toBe(1940);
      // .env is bit-for-bit untouched: the stale PORT stays, OTHER stays,
      // and we did NOT rewrite the file with a new PORT line.
      expect(readFileSync(envPath, "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });

  test("install falls back inside the canonical range when the slot is occupied (hub#206 — no .env write)", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      // Pretend something else is on 1940.
      upsertService(
        {
          name: "squatter-on-vault-port",
          port: 1940,
          paths: ["/squatter"],
          health: "/squatter/health",
          version: "0.0.0",
        },
        path,
      );
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      // First reservation slot is 1944.
      const entry = findService("parachute-vault", path);
      expect(entry?.port).toBe(1944);
      expect(logs.join("\n")).toMatch(/canonical port 1940 is in use/);
      // .env is not touched.
      const envPath = join(configDir, "vault", ".env");
      if (existsSync(envPath)) {
        expect(readFileSync(envPath, "utf8")).not.toMatch(/^PORT=/m);
      }
    } finally {
      cleanup();
    }
  });

  test("third-party npm package with valid module.json installs", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("@acme/widget", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
        readManifest: async () => ({
          name: "widget",
          manifestName: "@acme/widget",
          kind: "api",
          port: 1950,
          paths: ["/widget"],
          health: "/healthz",
        }),
        findGlobalInstall: () => "/fake/prefix/@acme/widget/package.json",
      });
      expect(code).toBe(0);
      expect(calls[0]).toEqual(["bun", "add", "-g", "@acme/widget"]);
      // hub#85: third-party rows are keyed by `manifest.name` (canonical
      // short — what `parachute start <svc>` accepts), not `manifestName`.
      const seeded = findService("widget", path);
      expect(seeded?.name).toBe("widget");
      expect(seeded?.port).toBe(1950);
      expect(findService("@acme/widget", path)).toBeUndefined();
      expect(logs.join("\n")).toMatch(/Seeded services\.json entry for widget/);
      expect(logs.join("\n")).toMatch(/widget registered on port 1950/);
    } finally {
      cleanup();
    }
  });

  test("third-party npm package without module.json hard-errors", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("@acme/widget", {
        runner: async () => 0,
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
        readManifest: async () => null,
        findGlobalInstall: () => "/fake/prefix/@acme/widget/package.json",
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/does not ship \.parachute\/module\.json/);
      expect(logs.join("\n")).toMatch(/module-json-extensibility\.md/);
    } finally {
      cleanup();
    }
  });

  test("third-party module name colliding with first-party shortname is rejected", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("@evil/squatter", {
        runner: async () => 0,
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
        readManifest: async () => ({
          name: "vault",
          manifestName: "@evil/squatter",
          kind: "api",
          port: 1950,
          paths: ["/vault"],
          health: "/healthz",
        }),
        findGlobalInstall: () => "/fake/prefix/@evil/squatter/package.json",
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/collides with a first-party/);
    } finally {
      cleanup();
    }
  });

  test("local absolute path resolves package name + module.json", async () => {
    const { path, cleanup } = makeTempPath();
    const pkgDir = mkdtempSync(join(tmpdir(), "pcli-localpkg-"));
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install(pkgDir, {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
        readManifest: async () => ({
          name: "demo",
          manifestName: "@local/demo",
          kind: "api",
          port: 1951,
          paths: ["/demo"],
          health: "/healthz",
        }),
        readPackageName: () => "@local/demo",
      });
      expect(code).toBe(0);
      expect(calls[0]).toEqual(["bun", "add", "-g", pkgDir]);
      // hub#85: third-party row keys by `manifest.name`, not `manifestName`.
      const seeded = findService("demo", path);
      expect(seeded?.name).toBe("demo");
      expect(findService("@local/demo", path)).toBeUndefined();
      // hub#83: lifecycle needs installDir to find module.json + spawn cwd.
      expect(seeded?.installDir).toBe(pkgDir);
    } finally {
      cleanup();
      rmSync(pkgDir, { recursive: true, force: true });
    }
  });

  test("local-path re-install skips bun add when symlink already points at it (hub#89)", async () => {
    // Reproduces the lockfile-pollution loop from hub#89: every
    // `parachute install /path/to/checkout` shells out `bun add -g
    // /path/to/checkout`, which appends a duplicate dependency to
    // ~/.bun/install/global/package.json. After ~5 re-installs bun's
    // lockfile parser gives up. Fix: if the global symlink already
    // resolves to this exact path, the install is a no-op for bun-add.
    const { path, cleanup } = makeTempPath();
    const pkgDir = mkdtempSync(join(tmpdir(), "pcli-localpkg-"));
    // macOS tmpdir is symlinked (/var → /private/var); install resolves
    // both sides via realpath, so the stub must too.
    const pkgDirReal = realpathSync(pkgDir);
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install(pkgDir, {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        // The symlink at <bun-globals>/node_modules/@local/demo already
        // points at the same checkout we're installing — second-+ run.
        linkedPath: (pkg) => (pkg === "@local/demo" ? pkgDirReal : null),
        portProbe: async () => false,
        log: (l) => logs.push(l),
        readManifest: async () => ({
          name: "demo",
          manifestName: "@local/demo",
          kind: "api",
          port: 1951,
          paths: ["/demo"],
          health: "/healthz",
        }),
        readPackageName: () => "@local/demo",
      });
      expect(code).toBe(0);
      // No `bun add -g <pkgDir>` invocation — that's the whole point.
      const bunAddCalls = calls.filter((c) => c[0] === "bun" && c[1] === "add");
      expect(bunAddCalls).toEqual([]);
      // Downstream init/seed/installDir wiring still ran.
      const seeded = findService("demo", path);
      expect(seeded?.installDir).toBe(pkgDir);
      // Operator-visible breadcrumb so they understand why `bun add` was skipped.
      expect(logs.join("\n")).toMatch(/already linked at .* — skipping bun add/);
    } finally {
      cleanup();
      rmSync(pkgDir, { recursive: true, force: true });
    }
  });

  test("local-path install still bun-adds when symlink points elsewhere (hub#89)", async () => {
    // Operator moved their checkout: the global symlink is stale, pointing at
    // a different abspath. Re-run bun add against the new path so the link
    // gets refreshed (don't silently keep using the old target).
    const { path, cleanup } = makeTempPath();
    const pkgDir = mkdtempSync(join(tmpdir(), "pcli-localpkg-"));
    try {
      const calls: string[][] = [];
      const code = await install(pkgDir, {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        linkedPath: () => "/Users/someone/old/checkout",
        portProbe: async () => false,
        log: () => {},
        readManifest: async () => ({
          name: "demo",
          manifestName: "@local/demo",
          kind: "api",
          port: 1951,
          paths: ["/demo"],
          health: "/healthz",
        }),
        readPackageName: () => "@local/demo",
      });
      expect(code).toBe(0);
      expect(calls[0]).toEqual(["bun", "add", "-g", pkgDir]);
    } finally {
      cleanup();
      rmSync(pkgDir, { recursive: true, force: true });
    }
  });

  test("npm-installed third-party module persists installDir from bun globals", async () => {
    // hub#83: for `parachute install <npm-pkg>`, installDir is dirname of
    // the package.json that findGlobalInstall returns. Without this,
    // lifecycle has no way to locate the module's `.parachute/module.json`
    // and third-party `parachute start <name>` fails post-install.
    const { path, cleanup } = makeTempPath();
    try {
      const fakePrefix = "/fake/bun-globals/node_modules/@vendor/widget";
      const code = await install("@vendor/widget", {
        runner: async () => 0,
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: () => {},
        readManifest: async () => ({
          name: "widget",
          manifestName: "@vendor/widget",
          kind: "api",
          port: 1952,
          paths: ["/widget"],
          health: "/widget/health",
        }),
        findGlobalInstall: () => `${fakePrefix}/package.json`,
      });
      expect(code).toBe(0);
      // hub#85: third-party row keys by `manifest.name`, not `manifestName`.
      const seeded = findService("widget", path);
      expect(seeded?.installDir).toBe(fakePrefix);
      expect(findService("@vendor/widget", path)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("third-party with diverging name/manifestName keys services.json by name (hub#85)", async () => {
    // Repro for parachute-hub#85: parachute-agent ships `name: "agent",
    // manifestName: "parachute-agent"`. Install used to seed services.json
    // under `parachute-agent` (the npm label) while lifecycle looks up by
    // `agent` (the canonical short) → "unknown service". Fix: services.json
    // key is always `manifest.name` for third-party.
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const startCalls: string[] = [];
      const logs: string[] = [];
      const code = await install("parachute-agent", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        startService: async (short) => {
          startCalls.push(short);
          return 0;
        },
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
        readManifest: async () => ({
          name: "agent",
          manifestName: "parachute-agent",
          kind: "api",
          port: 1945,
          paths: ["/agent"],
          health: "/agent/health",
          startCmd: ["bun", "server.ts"],
        }),
        findGlobalInstall: () => "/fake/prefix/parachute-agent/package.json",
      });
      expect(code).toBe(0);
      // services.json is keyed by `name`, not `manifestName`.
      expect(findService("agent", path)?.name).toBe("agent");
      expect(findService("parachute-agent", path)).toBeUndefined();
      // Auto-start receives the canonical short name (= manifest.name).
      expect(startCalls).toEqual(["agent"]);
      // Log lines speak in the canonical short name too. Port comes from
      // assignServicePort (third-party gets the first unassigned canonical
      // slot, currently 1944), not the manifest's port hint.
      const joined = logs.join("\n");
      expect(joined).toMatch(/Seeded services\.json entry for agent/);
      expect(joined).toMatch(/agent registered on port \d+/);
      expect(joined).not.toMatch(/Seeded services\.json entry for parachute-agent/);
    } finally {
      cleanup();
    }
  });

  test("local absolute path that doesn't exist fails fast", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("/nonexistent/path/xyz", {
        runner: async () => 0,
        manifestPath: path,
        startService: async () => 0,
        isLinked: () => false,
        portProbe: async () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/path does not exist/);
    } finally {
      cleanup();
    }
  });
});
