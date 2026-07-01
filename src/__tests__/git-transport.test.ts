import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSurfaceRepo, isSurfaceRegistered, registerSurface } from "../git-registry.ts";
import {
  type GitTransportDeps,
  extractToken,
  findHeaderEnd,
  handleGitTransport,
  parseCgiHeaders,
  parseGitPath,
  requiredAccess,
} from "../git-transport.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "http://127.0.0.1:1939";

interface Harness {
  dir: string;
  gitRoot: string;
  db: ReturnType<typeof openHubDb>;
  userId: string;
  cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "phub-git-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const u = await createUser(db, "owner", "pw");
  return {
    dir,
    gitRoot: join(dir, "git"),
    db,
    userId: u.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function mint(h: Harness, scopes: string[]): Promise<string> {
  const { token } = await signAccessToken(h.db, {
    sub: h.userId,
    scopes,
    audience: "surface",
    clientId: "test-client",
    issuer: ISSUER,
  });
  return token;
}

function deps(h: Harness, extra?: Partial<GitTransportDeps>): GitTransportDeps {
  return {
    db: h.db,
    gitRoot: h.gitRoot,
    knownIssuers: () => [ISSUER],
    // Default: treat every name as declared + provision on demand (the Phase-0a
    // "feel it" behavior). The declaration-gate tests below override `isDeclared`
    // or use the real registry.
    isDeclared: () => true,
    ensureRepo: (name) => ensureSurfaceRepo(h.gitRoot, name),
    ...extra,
  };
}

function gitReq(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init);
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe("parseGitPath", () => {
  test("parses name + subpath", () => {
    expect(parseGitPath("/git/gitcoin-brain/info/refs")).toEqual({
      name: "gitcoin-brain",
      gitSubpath: "info/refs",
    });
  });
  test("strips a trailing .git on the name segment", () => {
    expect(parseGitPath("/git/foo.git/git-receive-pack")).toEqual({
      name: "foo",
      gitSubpath: "git-receive-pack",
    });
  });
  test("rejects non-/git paths", () => {
    expect(parseGitPath("/surface/foo")).toBeNull();
  });
  test("rejects a bare /git/<name> with no subpath", () => {
    expect(parseGitPath("/git/foo")).toBeNull();
    expect(parseGitPath("/git/foo/")).toBeNull();
  });
  test("rejects path traversal in the name", () => {
    expect(parseGitPath("/git/../etc/info/refs")).toBeNull();
    expect(parseGitPath("/git/.../info/refs")).toBeNull();
  });
  test("rejects traversal in the subpath", () => {
    expect(parseGitPath("/git/foo/../../etc/passwd")).toBeNull();
  });
  test("rejects slashes / illegal chars in the name", () => {
    expect(parseGitPath("/git/a@b/info/refs")).toBeNull();
  });
});

describe("requiredAccess", () => {
  test("receive-pack is write", () => {
    expect(requiredAccess("git-receive-pack", null)).toBe("write");
    expect(requiredAccess("info/refs", "git-receive-pack")).toBe("write");
  });
  test("upload-pack is read", () => {
    expect(requiredAccess("git-upload-pack", null)).toBe("read");
    expect(requiredAccess("info/refs", "git-upload-pack")).toBe("read");
  });
  test("dumb / unknown paths default to read", () => {
    expect(requiredAccess("info/refs", null)).toBe("read");
    expect(requiredAccess("HEAD", null)).toBe("read");
    expect(requiredAccess("objects/info/packs", null)).toBe("read");
  });
});

describe("extractToken", () => {
  test("Bearer", () => {
    const r = gitReq("/git/foo/info/refs", { headers: { authorization: "Bearer abc.def.ghi" } });
    expect(extractToken(r)).toBe("abc.def.ghi");
  });
  test("Basic x-access-token:<jwt>", () => {
    const b64 = Buffer.from("x-access-token:my.jwt.tok").toString("base64");
    const r = gitReq("/git/foo/info/refs", { headers: { authorization: `Basic ${b64}` } });
    expect(extractToken(r)).toBe("my.jwt.tok");
  });
  test("Basic <jwt>:x-oauth-basic (legacy, token in username)", () => {
    const b64 = Buffer.from("my.jwt.tok:x-oauth-basic").toString("base64");
    const r = gitReq("/git/foo/info/refs", { headers: { authorization: `Basic ${b64}` } });
    expect(extractToken(r)).toBe("my.jwt.tok");
  });
  test("no header → null", () => {
    expect(extractToken(gitReq("/git/foo/info/refs"))).toBeNull();
  });
});

describe("parseCgiHeaders", () => {
  test("default 200 when no Status line", () => {
    const { status, headers } = parseCgiHeaders(
      "Content-Type: application/x-git-upload-pack-advertisement",
    );
    expect(status).toBe(200);
    expect(headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });
  test("honors a Status line", () => {
    const { status } = parseCgiHeaders("Status: 404 Not Found\r\nContent-Type: text/plain");
    expect(status).toBe(404);
  });
});

describe("findHeaderEnd", () => {
  const enc = new TextEncoder();
  test("finds CRLFCRLF", () => {
    const buf = enc.encode("A: b\r\nC: d\r\n\r\nBODY");
    const r = findHeaderEnd(buf);
    expect(r?.sepLen).toBe(4);
    expect(new TextDecoder().decode(buf.slice(0, r?.idx))).toBe("A: b\r\nC: d");
  });
  test("finds LFLF", () => {
    const buf = enc.encode("A: b\n\nBODY");
    const r = findHeaderEnd(buf);
    expect(r?.sepLen).toBe(2);
  });
  test("returns null without a boundary", () => {
    expect(findHeaderEnd(enc.encode("A: b\r\n"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auth gate (handler-direct — no real server needed)
// ---------------------------------------------------------------------------

describe("handleGitTransport — auth gate", () => {
  test("401 + WWW-Authenticate: Bearer when no credential", async () => {
    const h = await makeHarness();
    try {
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-receive-pack"),
        deps(h),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate") ?? "").toContain("Bearer");
      // Nothing provisioned on an unauthenticated probe.
      expect(existsSync(join(h.gitRoot, "foo.git"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("401 on an invalid/garbage token", async () => {
    const h = await makeHarness();
    try {
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-receive-pack", {
          headers: { authorization: "Bearer not-a-jwt" },
        }),
        deps(h),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate") ?? "").toContain("Bearer");
    } finally {
      h.cleanup();
    }
  });

  test("403 when a valid token lacks surface:<name>:write (push)", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["surface:foo:read", "vault:default:read"]);
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-receive-pack", {
          headers: { authorization: `Bearer ${token}` },
        }),
        deps(h),
      );
      expect(res.status).toBe(403);
      // A read-only credential never provisions a write repo on a push attempt.
      expect(existsSync(join(h.gitRoot, "foo.git"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("403 on a read (upload-pack) with neither read nor write scope", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["surface:other:read"]);
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-upload-pack", {
          headers: { authorization: `Bearer ${token}` },
        }),
        deps(h),
      );
      expect(res.status).toBe(403);
    } finally {
      h.cleanup();
    }
  });

  test("a write token authorizes a push info/refs (advertisement, 200)", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["surface:foo:write"]);
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-receive-pack", {
          headers: { authorization: `Bearer ${token}` },
        }),
        deps(h),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("git-receive-pack-advertisement");
      // First authenticated access provisions the bare repo.
      expect(existsSync(join(h.gitRoot, "foo.git"))).toBe(true);
      const body = await res.text();
      expect(body).toContain("git-receive-pack");
    } finally {
      h.cleanup();
    }
  });

  test("a read token authorizes a fetch info/refs (upload-pack, 200)", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["surface:foo:read"]);
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-upload-pack", {
          headers: { authorization: `Bearer ${token}` },
        }),
        deps(h),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("git-upload-pack-advertisement");
      // Drain the body so the http-backend service finishes before teardown
      // (else cleanup's rmSync can race the still-running `git upload-pack`).
      await res.text();
    } finally {
      h.cleanup();
    }
  });

  test("onPushed does NOT fire for a fetch (upload-pack) advertisement", async () => {
    const h = await makeHarness();
    let pushed = 0;
    try {
      const token = await mint(h, ["surface:foo:read"]);
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-upload-pack", {
          headers: { authorization: `Bearer ${token}` },
        }),
        deps(h, { onPushed: () => void pushed++ }),
      );
      expect(res.status).toBe(200);
      await res.text();
      // Give any (erroneous) background fire a tick to run.
      await new Promise((r) => setTimeout(r, 50));
      expect(pushed).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("write ⊇ read: a write token may also fetch", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["surface:foo:write"]);
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-upload-pack", {
          headers: { authorization: `Bearer ${token}` },
        }),
        deps(h),
      );
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      h.cleanup();
    }
  });

  test("Basic x-access-token:<jwt> is accepted (older-git compat)", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["surface:foo:write"]);
      const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-receive-pack", {
          headers: { authorization: `Basic ${b64}` },
        }),
        deps(h),
      );
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Declaration gate (Phase 1) — provision/serve only a REGISTERED surface
// ---------------------------------------------------------------------------

describe("handleGitTransport — declaration gate", () => {
  /** Deps wired to the REAL registry (isSurfaceRegistered + ensureSurfaceRepo). */
  function regDeps(h: Harness): GitTransportDeps {
    return deps(h, {
      isDeclared: (name) => isSurfaceRegistered(h.gitRoot, name),
      ensureRepo: (name) => ensureSurfaceRepo(h.gitRoot, name),
    });
  }

  test("404 for an authed write to an UNdeclared surface (no auto-provision)", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["surface:foo:write"]);
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-receive-pack", {
          headers: { authorization: `Bearer ${token}` },
        }),
        regDeps(h),
      );
      // A valid write token for an undeclared name is NOT enough — the registry
      // gate 404s (indistinguishable from a bad path) and nothing is provisioned.
      expect(res.status).toBe(404);
      expect(existsSync(join(h.gitRoot, "foo.git"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("a declared (registered) surface serves the push advertisement", async () => {
    const h = await makeHarness();
    try {
      // Lifecycle: surface-host registers the discovered `#surface` first.
      await registerSurface(h.gitRoot, "foo");
      expect(existsSync(join(h.gitRoot, "foo.git"))).toBe(true);
      const token = await mint(h, ["surface:foo:write"]);
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-receive-pack", {
          headers: { authorization: `Bearer ${token}` },
        }),
        regDeps(h),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("git-receive-pack-advertisement");
      await res.text();
    } finally {
      h.cleanup();
    }
  });

  test("grandfathering: an already-provisioned bare repo counts as declared", async () => {
    const h = await makeHarness();
    try {
      // A Phase-0a repo that exists on disk but has no registry.json entry.
      await ensureSurfaceRepo(h.gitRoot, "legacy");
      expect(isSurfaceRegistered(h.gitRoot, "legacy")).toBe(true);
      const token = await mint(h, ["surface:legacy:read"]);
      const res = await handleGitTransport(
        gitReq("/git/legacy/info/refs?service=git-upload-pack", {
          headers: { authorization: `Bearer ${token}` },
        }),
        regDeps(h),
      );
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      h.cleanup();
    }
  });

  test("gate runs AFTER auth: no token on an undeclared name still 401 (not 404)", async () => {
    const h = await makeHarness();
    try {
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-upload-pack"),
        regDeps(h),
      );
      // 401 (not 404) — an unauthenticated probe never learns registry membership.
      expect(res.status).toBe(401);
    } finally {
      h.cleanup();
    }
  });

  test("gate runs AFTER scope: wrong-surface token on an undeclared name is 403 (not 404)", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["surface:other:write"]);
      const res = await handleGitTransport(
        gitReq("/git/foo/info/refs?service=git-receive-pack", {
          headers: { authorization: `Bearer ${token}` },
        }),
        regDeps(h),
      );
      // 403 (scope) before 404 (registry) — a valid-but-wrong token never learns
      // membership either.
      expect(res.status).toBe(403);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Direct transfer POST (no prior info/refs GET) — auth enforced at BOTH points
// ---------------------------------------------------------------------------

describe("handleGitTransport — direct transfer POST", () => {
  test("401 on a direct POST to git-receive-pack with no credential", async () => {
    const h = await makeHarness();
    try {
      const res = await handleGitTransport(
        gitReq("/git/foo/git-receive-pack", {
          method: "POST",
          headers: { "content-type": "application/x-git-receive-pack-request" },
        }),
        deps(h),
      );
      // A client that skips the info/refs GET is still gated at the POST.
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate") ?? "").toContain("Bearer");
      expect(existsSync(join(h.gitRoot, "foo.git"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("403 on a direct POST to git-receive-pack with only read scope", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["surface:foo:read"]);
      const res = await handleGitTransport(
        gitReq("/git/foo/git-receive-pack", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/x-git-receive-pack-request",
          },
        }),
        deps(h),
      );
      // receive-pack requires write; a read token is refused at the POST itself.
      expect(res.status).toBe(403);
      expect(existsSync(join(h.gitRoot, "foo.git"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("401 on a direct POST to git-upload-pack with no credential", async () => {
    const h = await makeHarness();
    try {
      const res = await handleGitTransport(
        gitReq("/git/foo/git-upload-pack", {
          method: "POST",
          headers: { "content-type": "application/x-git-upload-pack-request" },
        }),
        deps(h),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate") ?? "").toContain("Bearer");
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Dispatch wiring through hubFetch
// ---------------------------------------------------------------------------

describe("hubFetch /git dispatch", () => {
  test("routes /git/* to the transport (401 unauth, with WWW-Authenticate)", async () => {
    const h = await makeHarness();
    try {
      const handler = hubFetch(h.dir, {
        getDb: () => h.db,
        gitRoot: h.gitRoot,
        issuer: ISSUER,
        loopbackPort: 1939,
      });
      const res = await handler(gitReq("/git/foo/info/refs?service=git-upload-pack"));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate") ?? "").toContain("Bearer");
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Real git push round-trip through a live server
// ---------------------------------------------------------------------------

function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): { code: number; out: string; err: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/**
 * Async git — for any client op that talks to the in-process `Bun.serve`. The
 * synchronous `spawnSync` would BLOCK Bun's single event loop, starving the
 * server that's meant to answer this very request → deadlock. The async spawn
 * keeps the loop free so the server can respond. (Setup ops above use the sync
 * helper because they never touch the server.)
 */
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

describe("git push round-trip", () => {
  test("an authed push lands the ref in the bare repo + fires post-receive", async () => {
    const h = await makeHarness();
    // Capture the onPushed deploy hand-off. Wire it through the low-level
    // handler with a live server so we exercise the true subprocess-exit fire.
    const pushedNames: string[] = [];
    let resolvePushed: (name: string) => void = () => {};
    const pushedOnce = new Promise<string>((r) => {
      resolvePushed = r;
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        handleGitTransport(req, {
          db: h.db,
          gitRoot: h.gitRoot,
          knownIssuers: () => [ISSUER],
          isDeclared: (name) => isSurfaceRegistered(h.gitRoot, name),
          ensureRepo: (name) => ensureSurfaceRepo(h.gitRoot, name),
          onPushed: (name) => {
            pushedNames.push(name);
            resolvePushed(name);
          },
        }),
    });
    const work = mkdtempSync(join(tmpdir(), "phub-git-work-"));
    try {
      const token = await mint(h, ["surface:foo:write"]);
      // Declare the surface first (the Phase-1 lifecycle: surface-host registers
      // a discovered `#surface` note before the push) — provisions the bare repo.
      await registerSurface(h.gitRoot, "foo");
      const base = `http://127.0.0.1:${server.port}`;

      // Author a commit in a throwaway working repo.
      expect(git(["init", "-q", "-b", "main", work], tmpdir()).code).toBe(0);
      git(["config", "user.email", "test@parachute.computer"], work);
      git(["config", "user.name", "Test"], work);
      Bun.write(join(work, "index.html"), "<h1>surface</h1>\n");
      expect(git(["add", "-A"], work).code).toBe(0);
      expect(git(["commit", "-q", "-m", "first"], work).code).toBe(0);
      const localRev = git(["rev-parse", "HEAD"], work).out.trim();

      // Push through the hub-authenticated endpoint (token via extraHeader, so
      // the request carries Authorization up-front — exercises info/refs +
      // receive-pack transfer end-to-end). Async spawn (see gitAsync) so the
      // in-process server can answer.
      const push = await gitAsync(
        [
          "-c",
          `http.extraHeader=Authorization: Bearer ${token}`,
          "push",
          `${base}/git/foo`,
          "main",
        ],
        work,
      );
      expect(push.code).toBe(0);

      // The ref landed in the hub-side bare repo at the pushed sha.
      const bare = join(h.gitRoot, "foo.git");
      const serverRev = git(
        ["--git-dir", bare, "rev-parse", "refs/heads/main"],
        tmpdir(),
      ).out.trim();
      expect(serverRev).toBe(localRev);

      // post-receive placeholder fired and logged the ref.
      const logPath = join(bare, "post-receive.log");
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, "utf8")).toContain("refs/heads/main");

      // The deploy hand-off fired with the surface name (the receive-pack
      // subprocess exited 0). It's observed off the subprocess, which can lag
      // the client's push return by a tick — await the signal.
      const pushedName = await Promise.race([
        pushedOnce,
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error("onPushed timeout")), 5000)),
      ]);
      expect(pushedName).toBe("foo");
      expect(pushedNames).toEqual(["foo"]);
    } finally {
      server.stop(true);
      rmSync(work, { recursive: true, force: true });
      h.cleanup();
    }
  });
});
