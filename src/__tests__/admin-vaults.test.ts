import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ADMIN_SCOPE, type RunResult, handleCreateVault } from "../admin-vaults.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { upsertService, writeManifest } from "../services-manifest.ts";
import { rotateSigningKey } from "../signing-keys.ts";

/**
 * Build the JSON shape `parachute-vault create --json` emits (PR #184).
 * Post the pvt_* DROP the `token` is a hub-issued access JWT (scoped
 * `vault:<name>:admin`), and may be the empty string when the vault
 * couldn't mint — in which case `token_guidance` carries the reason.
 */
function vaultCreateJson(
  name: string,
  token = `hubjwt.${name}.access`,
  tokenGuidance?: string,
): string {
  return JSON.stringify({
    name,
    token,
    ...(tokenGuidance ? { token_guidance: tokenGuidance } : {}),
    paths: {
      vault_dir: `/home/test/.parachute/vault/${name}`,
      vault_db: `/home/test/.parachute/vault/${name}/vault.db`,
      vault_config: `/home/test/.parachute/vault/${name}/config.yaml`,
    },
    set_as_default: false,
  });
}

const ISSUER = "http://127.0.0.1:1939";

interface Harness {
  dir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-admin-vaults-"));
  return {
    dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function adminToken(db: ReturnType<typeof openHubDb>): Promise<string> {
  const { token } = await signAccessToken(db, {
    sub: "user-admin",
    scopes: [HOST_ADMIN_SCOPE, "vault:admin"],
    audience: "operator",
    clientId: "test-client",
    issuer: ISSUER,
  });
  return token;
}

async function readOnlyToken(db: ReturnType<typeof openHubDb>): Promise<string> {
  const { token } = await signAccessToken(db, {
    sub: "user-readonly",
    scopes: ["vault:read"],
    audience: "operator",
    clientId: "test-client",
    issuer: ISSUER,
  });
  return token;
}

interface CallOpts {
  body?: unknown;
  authHeader?: string | null;
  contentType?: string | null;
  manifestPath: string;
  db: ReturnType<typeof openHubDb>;
  runCommand?: (cmd: readonly string[]) => Promise<RunResult>;
}

async function call(opts: CallOpts): Promise<Response> {
  const headers = new Headers();
  if (opts.authHeader === undefined) {
    headers.set("authorization", `Bearer ${await adminToken(opts.db)}`);
  } else if (opts.authHeader !== null) {
    headers.set("authorization", opts.authHeader);
  }
  if (opts.contentType === undefined) headers.set("content-type", "application/json");
  else if (opts.contentType !== null) headers.set("content-type", opts.contentType);

  const init: RequestInit = { method: "POST", headers };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const req = new Request(`${ISSUER}/vaults`, init);
  return handleCreateVault(req, {
    db: opts.db,
    issuer: ISSUER,
    manifestPath: opts.manifestPath,
    ...(opts.runCommand ? { runCommand: opts.runCommand } : {}),
  });
}

describe("POST /vaults — auth", () => {
  test("401 when Authorization header missing", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          authHeader: null,
          body: { name: "work" },
        });
        expect(res.status).toBe(401);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("403 when token lacks parachute:host:admin scope", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          authHeader: `Bearer ${await readOnlyToken(db)}`,
          body: { name: "work" },
        });
        expect(res.status).toBe(403);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("POST /vaults — body validation", () => {
  test("400 when Content-Type is not application/json", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          contentType: "text/plain",
          body: '{"name":"work"}',
        });
        expect(res.status).toBe(400);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 on malformed JSON", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: "not-json",
        });
        expect(res.status).toBe(400);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 when name is empty / missing / non-string", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        for (const body of [{}, { name: "" }, { name: 42 }, { name: null }]) {
          const res = await call({ db, manifestPath: h.manifestPath, body });
          expect(res.status).toBe(400);
        }
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 when name has invalid characters", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        for (const name of ["my vault", "../etc", "foo/bar", "x.y", "a:b"]) {
          const res = await call({ db, manifestPath: h.manifestPath, body: { name } });
          expect(res.status).toBe(400);
        }
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // Item I — uppercase is rejected at the hub edge (vault's init is
  // lowercase-only `[a-z0-9_-]`; a hub `[a-zA-Z0-9_-]` superset drifted from it).
  test("400 when name contains uppercase letters (item I — lowercase-only)", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        for (const name of ["Work", "MyVault", "FOO", "camelCase"]) {
          const res = await call({ db, manifestPath: h.manifestPath, body: { name } });
          expect(res.status).toBe(400);
        }
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test('400 when name is the reserved "list"', async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({ db, manifestPath: h.manifestPath, body: { name: "list" } });
        expect(res.status).toBe(400);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test('400 when name is "new" (would shadow SPA create route)', async () => {
    // Without the reservation, a vault named "new" would capture
    // `/vault/new` via the dynamic-proxy lookup and render the SPA's
    // create-vault page unreachable.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({ db, manifestPath: h.manifestPath, body: { name: "new" } });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error_description: string };
        expect(body.error_description).toMatch(/reserved/i);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test('400 when name is "assets" (would shadow SPA static bundle)', async () => {
    // A vault named "assets" would capture `/vault/assets/*` and break
    // SPA JS/CSS loading at both /vault and /hub mounts.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({ db, manifestPath: h.manifestPath, body: { name: "assets" } });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error_description: string };
        expect(body.error_description).toMatch(/reserved/i);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test('400 when name is "admin" (would shadow the /vault/admin daemon-level mount — B2h)', async () => {
    // A vault named "admin" would capture `/vault/admin`, the daemon-level
    // mount for vault's own multi-vault admin surface (B-route). The reserved
    // set is now the consolidated RESERVED_VAULT_NAMES in vault-name.ts, so
    // the wizard + invite redemption reject it too.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({ db, manifestPath: h.manifestPath, body: { name: "admin" } });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error_description: string };
        expect(body.error_description).toMatch(/reserved/i);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("POST /vaults — orchestration", () => {
  test("201 on happy path with vault already registered → calls `parachute-vault create`", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Seed services.json with the parachute-vault entry; vault is registered.
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            version: "0.3.5",
          },
          h.manifestPath,
        );
        const calls: Array<readonly string[]> = [];
        const runCommand = async (cmd: readonly string[]): Promise<RunResult> => {
          calls.push(cmd);
          // Simulate successful CLI by adding the new path to the manifest.
          upsertService(
            {
              name: "parachute-vault",
              port: 1940,
              paths: ["/vault/default", "/vault/work"],
              health: "/health",
              version: "0.3.5",
            },
            h.manifestPath,
          );
          return { exitCode: 0, stdout: vaultCreateJson("work"), stderr: "" };
        };
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { name: string; url: string; version: string };
        expect(body.name).toBe("work");
        expect(body.url).toBe(`${ISSUER}/vault/work`);
        expect(body.version).toBe("0.3.5");
        expect(calls).toEqual([["parachute-vault", "create", "work", "--json"]]);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("201 on bootstrap path (vault not yet registered) → calls `parachute install vault`", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Empty manifest: vault NOT registered yet. The bootstrap path runs
        // `parachute install vault`, which seeds the default vault. The
        // `name` requested by the caller is honored on follow-up calls
        // through the create-with-json branch (above); first-vault-on-host
        // doesn't currently surface a token (install has no --json yet).
        writeManifest({ services: [] }, h.manifestPath);
        const calls: Array<readonly string[]> = [];
        const runCommand = async (cmd: readonly string[]): Promise<RunResult> => {
          calls.push(cmd);
          upsertService(
            {
              name: "parachute-vault",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
              version: "0.3.5",
            },
            h.manifestPath,
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        };
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "default" },
          runCommand,
        });
        expect(res.status).toBe(201);
        expect(calls).toEqual([["parachute", "install", "vault"]]);
        // Bootstrap path: response carries name/url/version, no token/paths
        // (install doesn't emit JSON yet — known gap, follow-up issue).
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.token).toBeUndefined();
        expect(body.paths).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("201 response includes token + paths from `parachute-vault create --json` stdout", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            version: "0.3.5",
          },
          h.manifestPath,
        );
        const runCommand = async (_cmd: readonly string[]): Promise<RunResult> => {
          upsertService(
            {
              name: "parachute-vault",
              port: 1940,
              paths: ["/vault/default", "/vault/work"],
              health: "/health",
              version: "0.3.5",
            },
            h.manifestPath,
          );
          return {
            exitCode: 0,
            stdout: vaultCreateJson("work", "hubjwt.work.access"),
            stderr: "",
          };
        };
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          name: string;
          token?: string;
          paths?: { vault_dir: string; vault_db: string; vault_config: string };
        };
        expect(body.token).toBe("hubjwt.work.access");
        expect(body.paths).toEqual({
          vault_dir: "/home/test/.parachute/vault/work",
          vault_db: "/home/test/.parachute/vault/work/vault.db",
          vault_config: "/home/test/.parachute/vault/work/config.yaml",
        });
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("201 forwards an empty token + token_guidance when the vault couldn't mint (post-DROP)", async () => {
    // The vault emits `token: ""` + a `token_guidance` reason when no hub
    // origin was reachable to mint against (e.g. loopback create). The hub
    // must forward both verbatim so the SPA can render the
    // created-but-no-token state instead of confusing it with a re-POST.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            version: "0.3.5",
          },
          h.manifestPath,
        );
        const runCommand = async (_cmd: readonly string[]): Promise<RunResult> => {
          upsertService(
            {
              name: "parachute-vault",
              port: 1940,
              paths: ["/vault/default", "/vault/work"],
              health: "/health",
              version: "0.3.5",
            },
            h.manifestPath,
          );
          return {
            exitCode: 0,
            stdout: vaultCreateJson("work", "", "no hub origin reachable to mint against"),
            stderr: "",
          };
        };
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        // Still a fresh create — HTTP 201, NOT 200.
        expect(res.status).toBe(201);
        const body = (await res.json()) as { token?: string; token_guidance?: string };
        expect(body.token).toBe("");
        expect(body.token_guidance).toBe("no hub origin reachable to mint against");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("500 when `parachute-vault create --json` exits 0 but stdout is unparseable", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            version: "0.3.5",
          },
          h.manifestPath,
        );
        const runCommand = async (): Promise<RunResult> => ({
          exitCode: 0,
          stdout: "this-is-not-json",
          stderr: "",
        });
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        expect(res.status).toBe(500);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("200 idempotent re-POST when vault already exists, no token in response", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default", "/vault/work"],
            health: "/health",
            version: "0.3.5",
          },
          h.manifestPath,
        );
        let runCalled = false;
        const runCommand = async (): Promise<RunResult> => {
          runCalled = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        };
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.name).toBe("work");
        expect(body.url).toBe(`${ISSUER}/vault/work`);
        // Token is single-emit at create time — re-POST never re-emits it.
        expect(body.token).toBeUndefined();
        expect(body.paths).toBeUndefined();
        expect(runCalled).toBe(false);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("500 when CLI exits non-zero, error message includes full cmd + stderr tail", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            version: "0.3.5",
          },
          h.manifestPath,
        );
        const runCommand = async (): Promise<RunResult> => ({
          exitCode: 1,
          stdout: "",
          stderr: "vault create failed: name 'work' already exists\n",
        });
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error_description: string };
        // #97 NIT: full cmd in the error message (cmd.join), not just argv[0..1].
        expect(body.error_description).toContain("parachute-vault create work --json");
        // #97 NIT: stderr tail surfaced so the operator can see why.
        expect(body.error_description).toContain("name 'work' already exists");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("500 when CLI exits 0 but services.json doesn't reflect the new vault", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            version: "0.3.5",
          },
          h.manifestPath,
        );
        const runCommand = async (): Promise<RunResult> => ({
          exitCode: 0,
          stdout: vaultCreateJson("work"),
          stderr: "",
        });
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        expect(res.status).toBe(500);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("POST /vaults — method gating", () => {
  test("405 on GET", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const req = new Request(`${ISSUER}/vaults`, { method: "GET" });
        const res = await handleCreateVault(req, {
          db,
          issuer: ISSUER,
          manifestPath: h.manifestPath,
        });
        expect(res.status).toBe(405);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
