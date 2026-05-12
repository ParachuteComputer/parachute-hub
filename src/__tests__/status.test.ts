import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { status } from "../commands/status.ts";
import { writePid } from "../process-state.ts";
import { upsertService } from "../services-manifest.ts";

function makeTempPath(): { path: string; cleanup: () => void; configDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-status-"));
  return {
    path: join(dir, "services.json"),
    configDir: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("status", () => {
  test("empty manifest prints hint and exits 0", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toMatch(/No services installed/);
    } finally {
      cleanup();
    }
  });

  test("all-healthy returns 0 and prints table", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      upsertService(
        {
          name: "parachute-scribe",
          port: 3200,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.1.0",
        },
        path,
      );
      const seen: string[] = [];
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        fetchImpl: async (url) => {
          seen.push(String(url));
          return new Response(null, { status: 200 });
        },
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(seen).toContain("http://localhost:1940/health");
      expect(seen).toContain("http://localhost:3200/scribe/health");
      expect(lines[0]).toMatch(/SERVICE/);
      expect(lines.some((l) => l.includes("parachute-vault"))).toBe(true);
      expect(lines.some((l) => l.includes("ok"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("any-failing returns 1", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
        print: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.some((l) => l.includes("ECONNREFUSED"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("http non-2xx counts as unhealthy with status code", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 503 }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.some((l) => l.includes("http 503"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("running process shows pid + uptime and still probes", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      writePid("vault", 4242, configDir);
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        configDir,
        alive: () => true,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines.some((l) => l.includes("running"))).toBe(true);
      expect(lines.some((l) => l.includes("4242"))).toBe(true);
      expect(lines.some((l) => l.includes("ok"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("known-stopped process skips probe and doesn't fail exit", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      writePid("vault", 4242, configDir);
      let probed = false;
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        configDir,
        alive: () => false,
        fetchImpl: async () => {
          probed = true;
          return new Response(null, { status: 200 });
        },
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(probed).toBe(false);
      expect(lines.some((l) => l.includes("stopped"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("unknown process state (no pid file) still probes — externally managed OK", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      let probed = false;
      const code = await status({
        manifestPath: path,
        configDir,
        fetchImpl: async () => {
          probed = true;
          return new Response(null, { status: 200 });
        },
        print: () => {},
      });
      expect(code).toBe(0);
      expect(probed).toBe(true);
    } finally {
      cleanup();
    }
  });

  // URL column: the launch-day pain was a user staring at the table not
  // knowing where to point Claude.ai or curl. Each row gets a "  → URL"
  // continuation line so the next step is obvious.
  test("vault row prints MCP URL beneath it (path + /mcp suffix)", async () => {
    const { path, cleanup } = makeTempPath();
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
      const lines: string[] = [];
      await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l.includes("→ http://127.0.0.1:1940/vault/default/mcp"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("scribe row prints root URL (API is at /, ignore path prefix)", async () => {
    const { path, cleanup } = makeTempPath();
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
      const lines: string[] = [];
      await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l === "  → http://127.0.0.1:1943")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("notes row prints UI URL (port + /notes mount)", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "parachute-notes",
          port: 1942,
          paths: ["/notes"],
          health: "/notes/health",
          version: "0.0.1",
        },
        path,
      );
      const lines: string[] = [];
      await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l === "  → http://127.0.0.1:1942/notes")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("channel row prints port + /channel mount", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "parachute-channel",
          port: 1941,
          paths: ["/channel"],
          health: "/channel/health",
          version: "0.1.0",
        },
        path,
      );
      const lines: string[] = [];
      await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l === "  → http://127.0.0.1:1941/channel")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("unknown service falls back to bare host:port + paths[0]", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "third-party-thing",
          port: 9000,
          paths: ["/widget"],
          health: "/health",
          version: "1.0.0",
        },
        path,
      );
      const lines: string[] = [];
      await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l === "  → http://127.0.0.1:9000/widget")).toBe(true);
    } finally {
      cleanup();
    }
  });

  // Canonical-port drift warning (hub#195). When a known service ends up at
  // a non-canonical port (because of an upgrade rewrite, a port-walk fallback,
  // or an operator edit), surface it in `parachute status` so a silent miswire
  // is operator-visible. Warning, not error — operators may have moved the
  // service deliberately to dodge a third-party clash.
  describe("canonical-port drift warning", () => {
    test("warns when scribe is at non-canonical port (1944 instead of 1943)", async () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(
          {
            name: "parachute-scribe",
            port: 1944,
            paths: ["/scribe"],
            health: "/scribe/health",
            version: "0.4.0",
          },
          path,
        );
        const lines: string[] = [];
        await status({
          manifestPath: path,
          fetchImpl: async () => new Response(null, { status: 200 }),
          print: (l) => lines.push(l),
        });
        expect(lines.some((l) => l.includes("canonical port is 1943"))).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("does not warn when service is on its canonical port", async () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(
          {
            name: "parachute-scribe",
            port: 1943,
            paths: ["/scribe"],
            health: "/scribe/health",
            version: "0.4.0",
          },
          path,
        );
        const lines: string[] = [];
        await status({
          manifestPath: path,
          fetchImpl: async () => new Response(null, { status: 200 }),
          print: (l) => lines.push(l),
        });
        expect(lines.some((l) => l.includes("canonical port"))).toBe(false);
      } finally {
        cleanup();
      }
    });

    test("does not warn for third-party services with no canonical port", async () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(
          {
            name: "third-party-thing",
            port: 9000,
            paths: ["/widget"],
            health: "/health",
            version: "1.0.0",
          },
          path,
        );
        const lines: string[] = [];
        await status({
          manifestPath: path,
          fetchImpl: async () => new Response(null, { status: 200 }),
          print: (l) => lines.push(l),
        });
        expect(lines.some((l) => l.includes("canonical port"))).toBe(false);
      } finally {
        cleanup();
      }
    });

    test("warning does not affect exit code (status stays 0 when healthy)", async () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(
          {
            name: "parachute-scribe",
            port: 1944,
            paths: ["/scribe"],
            health: "/scribe/health",
            version: "0.4.0",
          },
          path,
        );
        const code = await status({
          manifestPath: path,
          fetchImpl: async () => new Response(null, { status: 200 }),
          print: () => {},
        });
        // Drift is informational. A healthy probed service still returns 0
        // even when the port has drifted off canonical.
        expect(code).toBe(0);
      } finally {
        cleanup();
      }
    });

    test("warning still fires when service is stopped (probe skipped)", async () => {
      const { path, configDir, cleanup } = makeTempPath();
      try {
        upsertService(
          {
            name: "parachute-scribe",
            port: 1944,
            paths: ["/scribe"],
            health: "/scribe/health",
            version: "0.4.0",
          },
          path,
        );
        writePid("scribe", 4242, configDir);
        const lines: string[] = [];
        await status({
          manifestPath: path,
          configDir,
          alive: () => false,
          fetchImpl: async () => new Response(null, { status: 200 }),
          print: (l) => lines.push(l),
        });
        // Drift is computed from services.json, not from the probe — a
        // stopped service with a drifted port should still surface the
        // warning so operators see the miswire even before they start it.
        expect(lines.some((l) => l.includes("canonical port is 1943"))).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("multi-vault instance rows do not surface a drift warning (intentional gap)", async () => {
      // Pinning the documented gap: `parachute-vault-default` is not
      // a canonical manifest name in FIRST_PARTY_FALLBACKS, so
      // `canonicalPortForManifest` returns undefined and no drift
      // warning fires — even when the row's port differs from the
      // canonical `parachute-vault` port (1940). Rationale lives on
      // `canonicalPortForManifest` in service-spec.ts; this test pins
      // the behavior so a future change to the lookup shape doesn't
      // accidentally start emitting drift on every multi-vault row
      // without an explicit decision.
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(
          {
            name: "parachute-vault-default",
            port: 1944,
            paths: ["/vault/default"],
            health: "/vault/default/health",
            version: "0.2.4",
          },
          path,
        );
        const lines: string[] = [];
        await status({
          manifestPath: path,
          fetchImpl: async () => new Response(null, { status: 200 }),
          print: (l) => lines.push(l),
        });
        expect(lines.some((l) => l.includes("canonical port"))).toBe(false);
      } finally {
        cleanup();
      }
    });
  });

  test("stopped services still render a URL line so the user knows where to point clients post-start", async () => {
    const { path, configDir, cleanup } = makeTempPath();
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
      writePid("vault", 4242, configDir);
      const lines: string[] = [];
      await status({
        manifestPath: path,
        configDir,
        alive: () => false,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l.includes("→ http://127.0.0.1:1940/vault/default/mcp"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  describe("install-source surface (hub#243)", () => {
    test("renders SOURCE column header + per-row label", async () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/vault/default/health",
            version: "0.4.4-rc.3",
            installDir: "/Users/me/code/parachute-vault",
          },
          path,
        );
        const lines: string[] = [];
        await status({
          manifestPath: path,
          fetchImpl: async () => new Response(null, { status: 200 }),
          print: (l) => lines.push(l),
          installSourceDeps: {
            bunGlobalPrefixes: () => ["/home/test/.bun/install/global/node_modules"],
            resolveBunGlobal: () => null,
            readJson: (p) =>
              p === "/Users/me/code/parachute-vault/package.json"
                ? { name: "@openparachute/vault", version: "0.4.4-rc.3" }
                : (() => {
                    throw new Error("nope");
                  })(),
            readGitHead: () => "8aa167b",
          },
        });
        expect(lines[0]).toMatch(/SOURCE/);
        expect(lines.some((l) => l.includes("bun-linked → parachute-vault @ 8aa167b"))).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("STALE continuation line fires when bun-linked live version != cached version", async () => {
      // Reproduces hub#243's motivating case: services.json says 0.3.11-rc.1
      // but the live source has been rebuilt to 0.3.15-rc.1. Operator should
      // see STALE in one glance from `parachute status` output.
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(
          {
            name: "parachute-notes",
            port: 1942,
            paths: ["/notes"],
            health: "/notes/health",
            version: "0.3.11-rc.1",
            installDir: "/Users/me/code/parachute-notes",
          },
          path,
        );
        const lines: string[] = [];
        await status({
          manifestPath: path,
          fetchImpl: async () => new Response(null, { status: 200 }),
          print: (l) => lines.push(l),
          installSourceDeps: {
            bunGlobalPrefixes: () => ["/home/test/.bun/install/global/node_modules"],
            resolveBunGlobal: () => null,
            readJson: (p) =>
              p === "/Users/me/code/parachute-notes/package.json"
                ? { name: "@openparachute/notes", version: "0.3.15-rc.1" }
                : (() => {
                    throw new Error("nope");
                  })(),
            readGitHead: () => "051c404",
          },
        });
        expect(
          lines.some((l) =>
            l.includes("STALE: services.json cached 0.3.11-rc.1; live package.json 0.3.15-rc.1"),
          ),
        ).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("npm-installed services render as `npm (<version>)` and never STALE", async () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(
          {
            name: "parachute-scribe",
            port: 1943,
            paths: ["/scribe"],
            health: "/scribe/health",
            version: "0.4.2-rc.1",
            installDir: "/home/test/.bun/install/global/node_modules/@openparachute/scribe",
          },
          path,
        );
        const lines: string[] = [];
        await status({
          manifestPath: path,
          fetchImpl: async () => new Response(null, { status: 200 }),
          print: (l) => lines.push(l),
          installSourceDeps: {
            bunGlobalPrefixes: () => ["/home/test/.bun/install/global/node_modules"],
            resolveBunGlobal: () => null,
            readJson: (p) =>
              p === "/home/test/.bun/install/global/node_modules/@openparachute/scribe/package.json"
                ? { name: "@openparachute/scribe", version: "0.4.2-rc.1" }
                : (() => {
                    throw new Error("nope");
                  })(),
            readGitHead: () => undefined,
          },
        });
        expect(lines.some((l) => l.includes("npm (0.4.2-rc.1)"))).toBe(true);
        expect(lines.some((l) => l.includes("STALE:"))).toBe(false);
      } finally {
        cleanup();
      }
    });

    test("entries without installDir fall back to bun-global symlink lookup", async () => {
      // Some services.json entries (older first-party rows, or rows written
      // by a service that doesn't echo installDir) leave the field absent.
      // detectInstallSource maps the entry name → first-party package and
      // probes bun globals for the symlink. Pins that fallback path.
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/vault/default/health",
            version: "0.4.4-rc.3",
            // No installDir.
          },
          path,
        );
        const lines: string[] = [];
        await status({
          manifestPath: path,
          fetchImpl: async () => new Response(null, { status: 200 }),
          print: (l) => lines.push(l),
          installSourceDeps: {
            bunGlobalPrefixes: () => ["/home/test/.bun/install/global/node_modules"],
            resolveBunGlobal: (pkg) =>
              pkg === "@openparachute/vault" ? "/Users/me/code/parachute-vault" : null,
            readJson: (p) =>
              p === "/Users/me/code/parachute-vault/package.json"
                ? { name: "@openparachute/vault", version: "0.4.4-rc.3" }
                : (() => {
                    throw new Error("nope");
                  })(),
            readGitHead: () => "8aa167b",
          },
        });
        expect(lines.some((l) => l.includes("bun-linked → parachute-vault @ 8aa167b"))).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("third-party row without installDir + no mapping renders as 'unknown'", async () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(
          {
            name: "agent",
            port: 1946,
            paths: ["/agent"],
            health: "/agent/health",
            version: "0.1.4-rc.1",
            // No installDir; agent isn't in FIRST_PARTY_FALLBACKS by short name,
            // and the fallback bun-global lookup needs a known package name.
          },
          path,
        );
        const lines: string[] = [];
        await status({
          manifestPath: path,
          fetchImpl: async () => new Response(null, { status: 200 }),
          print: (l) => lines.push(l),
          installSourceDeps: {
            bunGlobalPrefixes: () => ["/home/test/.bun/install/global/node_modules"],
            resolveBunGlobal: () => null,
            readJson: () => {
              throw new Error("not reached");
            },
            readGitHead: () => undefined,
          },
        });
        expect(lines.some((l) => l.includes("unknown"))).toBe(true);
      } finally {
        cleanup();
      }
    });
  });
});
