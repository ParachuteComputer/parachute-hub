import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surface } from "../commands/surface.ts";
import { ensureSurfaceRepo, isSurfaceRegistered, registerSurface } from "../git-registry.ts";
import { handleGitTransport } from "../git-transport.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import { issueOperatorToken } from "../operator-token.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "http://127.0.0.1:1939";
const HELPER = join(import.meta.dir, "..", "..", "scripts", "git-credential-parachute");

interface Tmp {
  dir: string;
  dbPath: string;
  userId: string;
  cleanup: () => void;
}

/** Seed a hub with a signing key, an owner user, and an admin operator token. */
async function makeTmp(): Promise<Tmp> {
  const dir = mkdtempSync(join(tmpdir(), "phub-surfcmd-"));
  const dbPath = hubDbPath(dir);
  const db = openHubDb(dbPath);
  let userId: string;
  try {
    rotateSigningKey(db);
    const u = await createUser(db, "owner", "pw");
    userId = u.id;
    await issueOperatorToken(db, userId, { dir, issuer: ISSUER });
  } finally {
    db.close();
  }
  return {
    dir,
    dbPath,
    userId,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function capture(fn: () => Promise<number> | number): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const origLog = console.log;
  const origErr = console.error;
  let stdout = "";
  let stderr = "";
  console.log = (...a: unknown[]) => {
    stdout += `${a.map(String).join(" ")}\n`;
  };
  console.error = (...a: unknown[]) => {
    stderr += `${a.map(String).join(" ")}\n`;
  };
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

/** Synchronous git — for setup ops that never touch the in-process server. */
function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): { code: number; err: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  return { code: r.status ?? -1, err: r.stderr ?? "" };
}

/** Async git — for ops that talk to the in-process Bun.serve (avoids event-loop deadlock). */
async function gitAsync(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([
    proc.exited,
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  return { code, err };
}

// ---------------------------------------------------------------------------
// help / dispatch
// ---------------------------------------------------------------------------

describe("parachute surface dispatch", () => {
  test("--help exits 0", async () => {
    const { code, stdout } = await capture(() => surface(["--help"]));
    expect(code).toBe(0);
    expect(stdout).toContain("Deploy tokens");
  });

  test("no args prints help + exits 1", async () => {
    const { code } = await capture(() => surface([]));
    expect(code).toBe(1);
  });

  test("unknown subcommand exits 1", async () => {
    const { code, stderr } = await capture(() => surface(["frobnicate"]));
    expect(code).toBe(1);
    expect(stderr).toContain("unknown subcommand");
  });

  test("token with no action prints help + exits 1", async () => {
    const { code } = await capture(() => surface(["token"]));
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mint
// ---------------------------------------------------------------------------

describe("parachute surface token mint", () => {
  test("no operator.token is an actionable error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phub-surfcmd-"));
    try {
      const { code, stderr } = await capture(() =>
        surface(["token", "mint", "foo"], { dbPath: hubDbPath(dir), configDir: dir }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("operator.token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing name is a usage error", async () => {
    const t = await makeTmp();
    try {
      const { code, stderr } = await capture(() =>
        surface(["token", "mint"], { dbPath: t.dbPath, configDir: t.dir }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("missing surface name");
    } finally {
      t.cleanup();
    }
  });

  test("--read and --write are mutually exclusive", async () => {
    const t = await makeTmp();
    try {
      const { code, stderr } = await capture(() =>
        surface(["token", "mint", "foo", "--read", "--write"], {
          dbPath: t.dbPath,
          configDir: t.dir,
        }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("mutually exclusive");
    } finally {
      t.cleanup();
    }
  });

  test("mints a write token: stdout is JUST the token, guidance on stderr", async () => {
    const t = await makeTmp();
    try {
      const { code, stdout, stderr } = await capture(() =>
        surface(["token", "mint", "gitcoin-brain", "--write"], {
          dbPath: t.dbPath,
          configDir: t.dir,
        }),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      expect(stdout).toBe(`${token}\n`); // pipe purity: token + newline only
      expect(token.split(".").length).toBe(3);
      // Guidance names the surface, the remote, and how to revoke.
      expect(stderr).toContain("surface:gitcoin-brain:write");
      expect(stderr).toContain("/git/gitcoin-brain");
      expect(stderr).toContain("PARACHUTE_SURFACE_TOKEN");
      expect(stderr).toContain("parachute surface token revoke");

      const db = openHubDb(t.dbPath);
      try {
        const validated = await validateAccessToken(db, token, [ISSUER]);
        expect(validated.payload.scope).toBe("surface:gitcoin-brain:write");
      } finally {
        db.close();
      }
    } finally {
      t.cleanup();
    }
  });

  test("--json emits token + jti + scope + remoteUrl + helper", async () => {
    const t = await makeTmp();
    try {
      const { code, stdout } = await capture(() =>
        surface(["token", "mint", "docs", "--read", "--json"], {
          dbPath: t.dbPath,
          configDir: t.dir,
        }),
      );
      expect(code).toBe(0);
      const blob = JSON.parse(stdout) as Record<string, unknown>;
      expect(blob.scope).toBe("surface:docs:read");
      expect(blob.access).toBe("read");
      expect(blob.surface).toBe("docs");
      expect(String(blob.remoteUrl)).toContain("/git/docs");
      expect(typeof blob.jti).toBe("string");
      expect(String(blob.credentialHelper)).toContain("x-access-token");
    } finally {
      t.cleanup();
    }
  });

  test("--ttl parses a duration; a bad one errors", async () => {
    const t = await makeTmp();
    try {
      const ok = await capture(() =>
        surface(["token", "mint", "foo", "--ttl", "30d"], { dbPath: t.dbPath, configDir: t.dir }),
      );
      expect(ok.code).toBe(0);
      const bad = await capture(() =>
        surface(["token", "mint", "foo", "--ttl", "banana"], {
          dbPath: t.dbPath,
          configDir: t.dir,
        }),
      );
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("invalid --ttl");
    } finally {
      t.cleanup();
    }
  });

  test("rejects a TTL over the 365d cap (--ttl and --expires-in)", async () => {
    const t = await makeTmp();
    try {
      const overTtl = await capture(() =>
        surface(["token", "mint", "foo", "--ttl", "400d"], { dbPath: t.dbPath, configDir: t.dir }),
      );
      expect(overTtl.code).toBe(1);
      expect(overTtl.stderr).toContain("365d cap");

      const overSecs = await capture(() =>
        surface(["token", "mint", "foo", "--expires-in", String(366 * 86400)], {
          dbPath: t.dbPath,
          configDir: t.dir,
        }),
      );
      expect(overSecs.code).toBe(1);
      expect(overSecs.stderr).toContain("365d cap");
    } finally {
      t.cleanup();
    }
  });

  test("rejects an invalid surface name", async () => {
    const t = await makeTmp();
    try {
      const { code, stderr } = await capture(() =>
        surface(["token", "mint", "../evil"], { dbPath: t.dbPath, configDir: t.dir }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("invalid surface name");
    } finally {
      t.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("parachute surface token list", () => {
  test("lists minted tokens; --json is structured; narrows by name", async () => {
    const t = await makeTmp();
    try {
      const deps = { dbPath: t.dbPath, configDir: t.dir };
      await capture(() => surface(["token", "mint", "alpha", "--write"], deps));
      await capture(() => surface(["token", "mint", "beta", "--read"], deps));

      const human = await capture(() => surface(["token", "list"], deps));
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("alpha");
      expect(human.stdout).toContain("beta");
      expect(human.stdout).toContain("active");

      const json = await capture(() => surface(["token", "list", "alpha", "--json"], deps));
      const rows = JSON.parse(json.stdout) as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.name).toBe("alpha");
      expect(rows[0]?.status).toBe("active");
      // never leaks the token bytes
      expect(json.stdout).not.toContain("eyJ");
    } finally {
      t.cleanup();
    }
  });

  test("empty list is a friendly message", async () => {
    const t = await makeTmp();
    try {
      const { code, stdout } = await capture(() =>
        surface(["token", "list"], { dbPath: t.dbPath, configDir: t.dir }),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("No surface deploy tokens");
    } finally {
      t.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe("parachute surface token revoke", () => {
  test("revokes a minted token; re-revoke is idempotent; unknown jti errors", async () => {
    const t = await makeTmp();
    try {
      const deps = { dbPath: t.dbPath, configDir: t.dir };
      const mint = await capture(() =>
        surface(["token", "mint", "foo", "--write", "--json"], deps),
      );
      const jti = String((JSON.parse(mint.stdout) as Record<string, unknown>).jti);

      const r1 = await capture(() => surface(["token", "revoke", jti], deps));
      expect(r1.code).toBe(0);
      expect(r1.stdout).toContain("Revoked");

      const r2 = await capture(() => surface(["token", "revoke", jti], deps));
      expect(r2.code).toBe(0);
      expect(r2.stdout).toContain("already revoked");

      const r3 = await capture(() => surface(["token", "revoke", "nope"], deps));
      expect(r3.code).toBe(1);
      expect(r3.stderr).toContain("no surface deploy token");
    } finally {
      t.cleanup();
    }
  });

  test("missing jti is a usage error", async () => {
    const t = await makeTmp();
    try {
      const { code, stderr } = await capture(() =>
        surface(["token", "revoke"], { dbPath: t.dbPath, configDir: t.dir }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("missing jti");
    } finally {
      t.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// scope enforcement (handler-level, deterministic)
// ---------------------------------------------------------------------------

describe("deploy-token scope enforcement", () => {
  test("a --read token cannot push (git-receive-pack → 403)", async () => {
    const t = await makeTmp();
    try {
      const mint = await capture(() =>
        surface(["token", "mint", "foo", "--read", "--json"], {
          dbPath: t.dbPath,
          configDir: t.dir,
        }),
      );
      const token = String((JSON.parse(mint.stdout) as Record<string, unknown>).token);
      const gitRoot = join(t.dir, "git");
      const db = openHubDb(t.dbPath);
      try {
        const res = await handleGitTransport(
          new Request("http://127.0.0.1/git/foo/info/refs?service=git-receive-pack", {
            headers: { authorization: `Bearer ${token}` },
          }),
          {
            db,
            gitRoot,
            knownIssuers: () => [ISSUER],
            isDeclared: () => true,
            ensureRepo: (name) => ensureSurfaceRepo(gitRoot, name),
          },
        );
        expect(res.status).toBe(403);
      } finally {
        db.close();
      }
    } finally {
      t.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// real git push round-trip via the shipped credential helper
// ---------------------------------------------------------------------------

describe("deploy token → real git push via git-credential-parachute", () => {
  test("a command-minted write token pushes; revoke then blocks the next push", async () => {
    const t = await makeTmp();
    const gitRoot = join(t.dir, "git");
    const work = mkdtempSync(join(tmpdir(), "phub-surfcmd-work-"));
    // Mint via the COMMAND (own handle, closes before the server opens).
    const mint = await capture(() =>
      surface(["token", "mint", "foo", "--write", "--json"], {
        dbPath: t.dbPath,
        configDir: t.dir,
      }),
    );
    const parsed = JSON.parse(mint.stdout) as { token: string; jti: string };

    // Declare the surface → provisions the bare repo (Phase-1 lifecycle).
    await registerSurface(gitRoot, "foo");

    const db = openHubDb(t.dbPath);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        handleGitTransport(req, {
          db,
          gitRoot,
          knownIssuers: () => [ISSUER],
          isDeclared: (name) => isSurfaceRegistered(gitRoot, name),
          ensureRepo: (name) => ensureSurfaceRepo(gitRoot, name),
        }),
    });
    const base = `http://127.0.0.1:${server.port}`;
    // The static-token mechanism: the SHIPPED helper reads $PARACHUTE_SURFACE_TOKEN.
    const helperEnv = { PARACHUTE_SURFACE_TOKEN: parsed.token };
    const helperCfg = `credential.helper=${HELPER}`;
    try {
      // Author a commit.
      expect(git(["init", "-q", "-b", "main", work], tmpdir()).code).toBe(0);
      git(["config", "user.email", "t@parachute.computer"], work);
      git(["config", "user.name", "T"], work);
      await Bun.write(join(work, "index.html"), "<h1>surface</h1>\n");
      expect(git(["add", "-A"], work).code).toBe(0);
      expect(git(["commit", "-q", "-m", "first"], work).code).toBe(0);

      // Push using ONLY the static deploy token, supplied by the helper script.
      const push = await gitAsync(
        ["-c", helperCfg, "push", `${base}/git/foo`, "main"],
        work,
        helperEnv,
      );
      expect(push.code).toBe(0);
      expect(existsSync(join(gitRoot, "foo.git", "post-receive.log"))).toBe(true);

      // Revoke the token (through the same DB handle the server validates on).
      const { revokeSurfaceToken } = await import("../surface-token.ts");
      expect(revokeSurfaceToken(db, parsed.jti, new Date()).status).toBe("revoked");

      // A follow-up push with the now-revoked token is rejected (git exits non-zero).
      await Bun.write(join(work, "index.html"), "<h1>v2</h1>\n");
      git(["commit", "-qam", "second"], work);
      const push2 = await gitAsync(
        ["-c", helperCfg, "push", `${base}/git/foo`, "main"],
        work,
        helperEnv,
      );
      expect(push2.code).not.toBe(0);
    } finally {
      server.stop(true);
      db.close();
      rmSync(work, { recursive: true, force: true });
      t.cleanup();
    }
  });
});
