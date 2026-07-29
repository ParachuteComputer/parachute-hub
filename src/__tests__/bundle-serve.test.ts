import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeMount,
  notesDistCandidates,
  notesFetch,
  notesServeOptions,
  resolveBundleDistFrom,
} from "../bundle-serve.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-bundle-serve-"));
  writeFileSync(join(dir, "index.html"), "<html><body>notes spa</body></html>");
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('install', () => {});");
  writeFileSync(join(dir, "manifest.webmanifest"), '{"name":"Notes","start_url":"/notes/"}');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function req(path: string): Request {
  return new Request(`http://127.0.0.1${path}`);
}

describe("notesServeOptions (hub#399 residual)", () => {
  test("sets idleTimeout: 255 to outlast edge keep-alive pools, matching hub-server.ts", () => {
    const opts = notesServeOptions(5173, "/tmp/dist", "/notes");
    expect(opts.idleTimeout).toBe(255);
    expect(opts.port).toBe(5173);
    expect(typeof opts.fetch).toBe("function");
  });
});

describe("normalizeMount", () => {
  test("strips trailing slashes", () => {
    expect(normalizeMount("/notes/")).toBe("/notes");
    expect(normalizeMount("/notes")).toBe("/notes");
    expect(normalizeMount("/notes///")).toBe("/notes");
  });

  test("collapses root-equivalents to empty string", () => {
    expect(normalizeMount("")).toBe("");
    expect(normalizeMount("/")).toBe("");
  });
});

describe("notesFetch with default /notes mount", () => {
  test("GET /notes/sw.js serves the SW with JS content-type, not text/html", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notes/sw.js"));
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).not.toContain("text/html");
      expect(ct).toMatch(/javascript/);
      expect(await res.text()).toContain("addEventListener");
    } finally {
      h.cleanup();
    }
  });

  test("GET /notes/manifest.webmanifest serves application/manifest+json", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notes/manifest.webmanifest"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/manifest+json");
      expect(await res.text()).toContain('"name":"Notes"');
    } finally {
      h.cleanup();
    }
  });

  test("GET /notes/ serves the SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notes/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("notes spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /notes (no trailing slash) serves the SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notes"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("notes spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /notes/nonexistent/deep/route falls back to SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notes/nonexistent/deep/route"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("notes spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /notesx/foo (mount-prefix collision) is not stripped", async () => {
    // Guards against startsWith("/notes") matching unrelated /notesx routes.
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notesx/foo"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    } finally {
      h.cleanup();
    }
  });
});

describe("notesFetch with empty mount (root deployment)", () => {
  test("GET /sw.js serves the SW directly", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "")(req("/sw.js"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toMatch(/javascript/);
    } finally {
      h.cleanup();
    }
  });

  test("GET / serves the SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "")(req("/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    } finally {
      h.cleanup();
    }
  });
});

describe("notesFetch /health (2026-07-11, hub-parity P5)", () => {
  test("GET /notes/health answers 2xx explicitly, not the SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notes/health"));
      expect(res.status).toBe(200);
      // Explicit JSON, not the index.html SPA-shell fallback — proves the
      // health path is a real handler, not an accident of the catch-all.
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.text()).not.toContain("notes spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /health answers 2xx at the mount root too (empty mount)", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "")(req("/health"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
    } finally {
      h.cleanup();
    }
  });

  test("survives a missing dist/index.html — health doesn't depend on the SPA shell existing", async () => {
    // A harness with NO index.html written — the SPA-shell fallback would
    // throw/404 on this dist, but /health is answered before that code path
    // is ever reached.
    const dir = mkdtempSync(join(tmpdir(), "pcli-bundle-serve-empty-"));
    try {
      const res = notesFetch(dir, "/app")(req("/app/health"));
      expect(res.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// hub-parity P5 (2026-07-11): the shim generalized beyond notes to serve
// @openparachute/app (mount `/app`, port 1944) via the same
// FIRST_PARTY_FALLBACKS startCmd shape (`--package @openparachute/app`).
// These tests re-run the load-bearing PWA regression (sw.js / manifest
// content-type, SPA fallback, mount-strip) for a NON-notes package/mount to
// prove the generalization didn't accidentally hardcode "notes" anywhere in
// the serving path (only `resolveBundleDistFrom`'s package resolution is
// notes-specific, and that's parameterized separately below).
describe("notesFetch generalized for a non-notes package (hub-parity P5 — the app mount)", () => {
  function makeAppHarness(): Harness {
    const dir = mkdtempSync(join(tmpdir(), "pcli-app-serve-"));
    writeFileSync(join(dir, "index.html"), "<html><body>app spa</body></html>");
    writeFileSync(join(dir, "sw.js"), "self.addEventListener('install', () => {});");
    writeFileSync(join(dir, "manifest.webmanifest"), '{"name":"Parachute","start_url":"/app/"}');
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("GET /app/sw.js serves the SW with JS content-type, not text/html", async () => {
    const h = makeAppHarness();
    try {
      const res = notesFetch(h.dir, "/app")(req("/app/sw.js"));
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).not.toContain("text/html");
      expect(ct).toMatch(/javascript/);
    } finally {
      h.cleanup();
    }
  });

  test("GET /app/manifest.webmanifest serves application/manifest+json", async () => {
    const h = makeAppHarness();
    try {
      const res = notesFetch(h.dir, "/app")(req("/app/manifest.webmanifest"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/manifest+json");
      expect(await res.text()).toContain('"name":"Parachute"');
    } finally {
      h.cleanup();
    }
  });

  test("GET /app/ serves the SPA shell", async () => {
    const h = makeAppHarness();
    try {
      const res = notesFetch(h.dir, "/app")(req("/app/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("app spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /app/some/deep/route falls back to the SPA shell (client-side routing)", async () => {
    const h = makeAppHarness();
    try {
      const res = notesFetch(h.dir, "/app")(req("/app/some/deep/route"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("app spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /appendix/foo (mount-prefix collision) is not stripped", async () => {
    const h = makeAppHarness();
    try {
      const res = notesFetch(h.dir, "/app")(req("/appendix/foo"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    } finally {
      h.cleanup();
    }
  });
});

describe("notesDistCandidates", () => {
  test("returns cwd, then global node_modules, then global root", () => {
    const cands = notesDistCandidates("/some/cwd", "/home/user");
    expect(cands).toEqual([
      "/some/cwd",
      "/home/user/.bun/install/global/node_modules",
      "/home/user/.bun/install/global",
    ]);
  });

  // hub#780: the supervisor launches shim-served services (notes/app) with
  // cwd = "/". From "/", `Bun.resolveSync` falls through to bun's own install
  // *cache*, which can shadow the bun-global link and silently serve a
  // months-old published bundle. A real checkout cwd is never "/", so "/" is
  // dropped as a candidate — resolution is forced through the global link table.
  test("omits cwd when it is '/' — the supervisor's launch cwd (hub#780)", () => {
    expect(notesDistCandidates("/", "/home/user")).toEqual([
      "/home/user/.bun/install/global/node_modules",
      "/home/user/.bun/install/global",
    ]);
  });
});

/**
 * hub#780 regression. On Aaron's live box (2026-07-27) the supervisor launched
 * bundle-serve with cwd `/`; from `/`, `Bun.resolveSync` fell through to bun's
 * install *cache* (`~/.bun/install/cache/<pkg>@<ver>@@@1`), which shadowed the
 * bun-global link — hub served npm `@openparachute/app@0.22.5` for nine hours
 * while `status` reported the linked checkout. The fix drops `/` as a resolution
 * candidate so the global link (the intended source for a supervised service)
 * always wins. These tests drive the exact resolver ordering with a stubbed
 * `resolveSync`, so they fail on the unfixed candidate list and pass on the fix.
 */
describe("resolveBundleDistFrom cwd=/ cache-shadow (hub#780)", () => {
  const APP_PKG = "@openparachute/app";

  test("with cwd '/' and a resolvable install-cache entry, resolution takes the global link, never the cache", () => {
    const home = "/home/op";
    const globalNodeModules = join(home, ".bun/install/global/node_modules");
    const linkPkgJson = join(globalNodeModules, APP_PKG, "package.json");
    const linkDist = join(globalNodeModules, APP_PKG, "dist");
    // What real Bun returns when it resolves the package from cwd `/`: an entry
    // inside its own install cache, laid down by any `bun add`/install.
    const cachePkgJson = join(
      home,
      ".bun/install/cache",
      `${APP_PKG}@0.22.5@@@1`,
      "node_modules",
      APP_PKG,
      "package.json",
    );

    const probed: string[] = [];
    const out = resolveBundleDistFrom({
      cwd: "/",
      home,
      pkg: APP_PKG,
      resolveSync: (_specifier, base) => {
        probed.push(base);
        if (base === "/") return cachePkgJson; // the shadow — must NOT win
        if (base === globalNodeModules) return linkPkgJson; // the intended source
        throw new Error(`unexpected base: ${base}`);
      },
      existsSync: () => true, // every resolved package has a dist/ in this fixture
    });

    // The global link's dist — never the cache path the cwd `/` resolve returned.
    expect(out).toBe(linkDist);
    expect(out).not.toContain(".bun/install/cache");
    // "/" is dropped from the candidate list entirely, so it's never probed.
    expect(probed).not.toContain("/");
    expect(probed[0]).toBe(globalNodeModules);
  });
});

/**
 * `resolveBundleDistFrom` is the hub#194 fix — when the cwd-relative resolve
 * fails (hub repo dir doesn't depend on @openparachute/notes), we walk down
 * to bun's global install dirs before giving up. Tests use a stub
 * `resolveSync` so we can drive the candidate order without writing real
 * fixtures into `~/.bun/install/global`.
 */
describe("resolveBundleDistFrom (hub#194)", () => {
  function makeFixture(): { home: string; cleanup: () => void; pkgRoot: string; dist: string } {
    // realpathSync — on macOS `mkdtempSync` returns a /var/folders path
    // that resolves to /private/var/folders; we want the resolved form so
    // string comparisons against `Bun.resolveSync` output line up.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pcli-bundle-resolve-")));
    const home = join(root, "home");
    const pkgRoot = join(home, ".bun/install/global/node_modules/@openparachute/app");
    mkdirSync(pkgRoot, { recursive: true });
    const dist = join(pkgRoot, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), '{"name":"@openparachute/app"}');
    return { home, pkgRoot, dist, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("first-candidate (cwd) hit returns its dist immediately", () => {
    const f = makeFixture();
    try {
      const calls: string[] = [];
      const out = resolveBundleDistFrom({
        cwd: "/cwd-with-app",
        home: f.home,
        resolveSync: (specifier, base) => {
          calls.push(base);
          if (base === "/cwd-with-app") {
            return "/cwd-with-app/node_modules/@openparachute/app/package.json";
          }
          throw new Error(`unexpected base: ${base}`);
        },
        existsSync: (p) => p === "/cwd-with-app/node_modules/@openparachute/app/dist",
      });
      expect(out).toBe("/cwd-with-app/node_modules/@openparachute/app/dist");
      // Only the cwd candidate should be probed — we short-circuit on hit.
      expect(calls).toEqual(["/cwd-with-app"]);
    } finally {
      f.cleanup();
    }
  });

  test("falls through to global node_modules when cwd resolve fails (hub#194 root cause)", () => {
    // The exact scenario from hub#194: hub repo's cwd has no dependency on
    // notes, so the first candidate throws ResolveMessage. Bun does NOT
    // auto-consult ~/.bun/install/global, so we have to try it explicitly.
    const f = makeFixture();
    try {
      const calls: string[] = [];
      const out = resolveBundleDistFrom({
        cwd: "/hub-repo-cwd-without-notes",
        home: f.home,
        resolveSync: (specifier, base) => {
          calls.push(base);
          if (base === "/hub-repo-cwd-without-notes") {
            throw new Error(`Cannot find module '${specifier}' from '${base}'`);
          }
          // Real Bun.resolveSync against the global node_modules dir
          // resolves into the package's package.json.
          return Bun.resolveSync(specifier, base);
        },
        // Use real existsSync — the fixture has dist/ on disk.
      });
      expect(out).toBe(f.dist);
      // Both candidates probed, in order.
      expect(calls[0]).toBe("/hub-repo-cwd-without-notes");
      expect(calls[1]).toBe(join(f.home, ".bun/install/global/node_modules"));
    } finally {
      f.cleanup();
    }
  });

  test("falls through past global node_modules to the older global root layout", () => {
    // Defensive: older Bun versions used a flatter global layout. We probe
    // both. This test forces the first two candidates to fail and pins
    // that the third is reached.
    const probed: string[] = [];
    expect(() =>
      resolveBundleDistFrom({
        cwd: "/cwd",
        home: "/h",
        resolveSync: (_specifier, base) => {
          probed.push(base);
          throw new Error(`Cannot find module from '${base}'`);
        },
      }),
    ).toThrow(/Could not resolve @openparachute\/app from any of/);
    expect(probed).toEqual([
      "/cwd",
      "/h/.bun/install/global/node_modules",
      "/h/.bun/install/global",
    ]);
  });

  test("error message names every candidate that was tried", () => {
    let caught: unknown;
    try {
      resolveBundleDistFrom({
        cwd: "/probe-cwd",
        home: "/probe-home",
        resolveSync: (_specifier, base) => {
          throw new Error(`Cannot find module from '${base}'`);
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("/probe-cwd");
    expect(msg).toContain("/probe-home/.bun/install/global/node_modules");
    expect(msg).toContain("/probe-home/.bun/install/global");
    // Hint operators at the actionable next step.
    expect(msg).toMatch(/bun add -g @openparachute\/app|parachute install app/);
  });

  test("resolved package without dist/ throws a hard error (no fallthrough)", () => {
    // If the package resolves but lacks a dist/ directory, that's a
    // packaging issue — falling through to other candidates would just
    // re-resolve the same package. Surface the problem with the resolved
    // path so the operator can file the right issue against the package.
    expect(() =>
      resolveBundleDistFrom({
        cwd: "/cwd-with-app",
        home: "/h",
        resolveSync: () => "/cwd-with-notes/node_modules/@openparachute/notes/package.json",
        existsSync: () => false,
      }),
    ).toThrow(/has no dist\/ directory/);
  });
});

/**
 * `--package` generalization (hub-parity P5, 2026-07-11). `resolveBundleDistFrom`
 * defaults `pkg` to `@openparachute/notes` (every test above omits it and
 * still resolves notes — back-compat), but a caller like the `app`
 * FIRST_PARTY_FALLBACKS entry passes a different package name. These tests
 * pin the resolver against a real on-disk fixture for a NON-notes package,
 * proving the specifier passed to `Bun.resolveSync` (and every error message)
 * is the caller's `pkg`, not a hardcoded "notes" string.
 */
describe("resolveBundleDistFrom --package (hub-parity P5)", () => {
  const APP_PKG = "@openparachute/app";

  function makeAppFixture(): { home: string; cleanup: () => void; dist: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pcli-app-resolve-")));
    const home = join(root, "home");
    const pkgRoot = join(home, ".bun/install/global/node_modules", APP_PKG);
    mkdirSync(pkgRoot, { recursive: true });
    const dist = join(pkgRoot, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: APP_PKG }));
    return { home, dist, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("resolves a non-notes package's dist/ via the global node_modules fallback", () => {
    const f = makeAppFixture();
    try {
      const out = resolveBundleDistFrom({
        cwd: "/hub-repo-cwd-without-app",
        home: f.home,
        pkg: APP_PKG,
        resolveSync: (specifier, base) => {
          if (base === "/hub-repo-cwd-without-app") {
            throw new Error(`Cannot find module '${specifier}' from '${base}'`);
          }
          return Bun.resolveSync(specifier, base);
        },
      });
      expect(out).toBe(f.dist);
    } finally {
      f.cleanup();
    }
  });

  // hub#788: the shim's default flipped notes → app when notes was retired.
  // Every earlier describe block exercises the default implicitly (none pass
  // `pkg`); this pins it explicitly against the specifier handed to resolveSync.
  test("default pkg (no --package) resolves @openparachute/app — was notes pre-hub#788", () => {
    const specifiers: string[] = [];
    expect(() =>
      resolveBundleDistFrom({
        cwd: "/cwd",
        home: "/h",
        resolveSync: (specifier) => {
          specifiers.push(specifier);
          throw new Error("not found");
        },
      }),
    ).toThrow();
    expect(specifiers).toEqual([
      "@openparachute/app/package.json",
      "@openparachute/app/package.json",
      "@openparachute/app/package.json",
    ]);
  });

  test("error message names the caller's package, not the hardcoded default", () => {
    // The probe package must NOT be the default (now @openparachute/app), or
    // the assertion can't tell "named the caller's package" from "hardcoded".
    const OTHER_PKG = "@acme/custom-surface";
    let caught: unknown;
    try {
      resolveBundleDistFrom({
        cwd: "/probe-cwd",
        home: "/probe-home",
        pkg: OTHER_PKG,
        resolveSync: () => {
          throw new Error("nope");
        },
      });
    } catch (err) {
      caught = err;
    }
    const msg = (caught as Error).message;
    expect(msg).toContain("Could not resolve @acme/custom-surface");
    expect(msg).toContain("bun add -g @acme/custom-surface");
    expect(msg).not.toContain("@openparachute/app");
  });

  test("no-dist/ hard error names the caller's package", () => {
    expect(() =>
      resolveBundleDistFrom({
        cwd: "/cwd-with-app",
        home: "/h",
        pkg: APP_PKG,
        resolveSync: () => "/cwd-with-app/node_modules/@openparachute/app/package.json",
        existsSync: () => false,
      }),
    ).toThrow(new RegExp(`${APP_PKG.replace("/", "\\/")} resolved at .* has no dist/ directory`));
  });
});
