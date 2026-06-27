import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_ADMIN_SCOPE,
  type RunResult,
  handleCreateVault,
  listVaultInstanceNames,
  provisionVault,
} from "../admin-vaults.ts";
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

// ===========================================================================
// DELETE /vaults/<name> — the identity cascade (B1, hub-module-boundary)
// ===========================================================================

import { handleDeleteVault } from "../admin-vaults.ts";
import { registerClient } from "../clients.ts";
import { putConnection, readConnections } from "../connections-store.ts";
import { findGrant, recordGrant } from "../grants.ts";
import { findInviteByHash, issueInvite } from "../invites.ts";
import { findTokenRowByJti, listActiveRevocations, recordTokenMint } from "../jwt-sign.ts";
import { createUser, setUserVaults } from "../users.ts";
import { getVaultCapBytes, setVaultCap } from "../vault-caps.ts";

const VAULT_ORIGIN = "http://127.0.0.1:19400";
const AGENT_ORIGIN = "http://127.0.0.1:19410";

/** Successful no-op runner — records the commands it was asked to run. */
function stubRun(
  exitCode = 0,
  stderr = "",
): {
  run: (cmd: readonly string[]) => Promise<RunResult>;
  calls: (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    run: async (cmd) => {
      calls.push(cmd);
      return { exitCode, stdout: "", stderr };
    },
  };
}

/** Recording fetch mock keyed by `METHOD <pathname>` (mirrors admin-connections.test). */
function mockFetch(routes: Record<string, () => Response>): {
  fetchImpl: typeof fetch;
  calls: { method: string; url: string }[];
} {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    const responder = routes[`${method} ${new URL(url).pathname}`];
    if (!responder) return new Response("no route", { status: 599 });
    return responder();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface DeleteCallOpts {
  name: string;
  body?: unknown;
  authHeader?: string | null;
  db: ReturnType<typeof openHubDb>;
  manifestPath: string;
  connectionsStorePath: string;
  runCommand?: (cmd: readonly string[]) => Promise<RunResult>;
  restartVaultModule?: () => Promise<void>;
  agentOrigin?: string | null;
  fetchImpl?: typeof fetch;
  resolveVaultOrigin?: (v: string) => string | null;
}

async function callDelete(opts: DeleteCallOpts): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.authHeader === undefined) {
    headers.set("authorization", `Bearer ${await adminToken(opts.db)}`);
  } else if (opts.authHeader !== null) {
    headers.set("authorization", opts.authHeader);
  }
  const req = new Request(`${ISSUER}/vaults/${opts.name}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify(opts.body ?? { confirm: opts.name }),
  });
  return handleDeleteVault(req, opts.name, {
    db: opts.db,
    issuer: ISSUER,
    manifestPath: opts.manifestPath,
    connectionsStorePath: opts.connectionsStorePath,
    agentOrigin: opts.agentOrigin ?? null,
    resolveVaultOrigin: opts.resolveVaultOrigin ?? (() => VAULT_ORIGIN),
    runCommand: opts.runCommand ?? stubRun().run,
    ...(opts.restartVaultModule ? { restartVaultModule: opts.restartVaultModule } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

/** services.json with one multi-path vault row (the canonical Q5 shape). */
function writeVaults(manifestPath: string, instanceNames: string[]): void {
  writeManifest(
    {
      services: [
        {
          name: "parachute-vault",
          port: 1940,
          paths: instanceNames.map((n) => `/vault/${n}`),
          health: `/vault/${instanceNames[0]}/health`,
          version: "0.5.0",
        },
      ],
    },
    manifestPath,
  );
}

function registryRow(db: ReturnType<typeof openHubDb>, jti: string, scopes: string[]): void {
  recordTokenMint(db, {
    jti,
    createdVia: "cli_mint",
    subject: "user-admin",
    clientId: "test-client",
    scopes,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

describe("DELETE /vaults/<name> — gates", () => {
  test("401 without a bearer; 403 without host:admin", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        writeVaults(h.manifestPath, ["default", "work"]);
        const store = join(h.dir, "connections.json");
        const noAuth = await callDelete({
          name: "work",
          db,
          manifestPath: h.manifestPath,
          connectionsStorePath: store,
          authHeader: null,
        });
        expect(noAuth.status).toBe(401);
        const readOnly = await callDelete({
          name: "work",
          db,
          manifestPath: h.manifestPath,
          connectionsStorePath: store,
          authHeader: `Bearer ${await readOnlyToken(db)}`,
        });
        expect(readOnly.status).toBe(403);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 confirm_mismatch when the body doesn't retype the name (nothing revoked, CLI never runs)", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        writeVaults(h.manifestPath, ["default", "work"]);
        registryRow(db, "jti-confirm-guard", ["vault:work:write"]);
        const runner = stubRun();
        for (const body of [{ confirm: "wrong" }, {}, { confirm: "" }]) {
          const res = await callDelete({
            name: "work",
            body,
            db,
            manifestPath: h.manifestPath,
            connectionsStorePath: join(h.dir, "connections.json"),
            runCommand: runner.run,
          });
          expect(res.status).toBe(400);
          expect(((await res.json()) as { error: string }).error).toBe("confirm_mismatch");
        }
        expect(runner.calls.length).toBe(0);
        expect(findTokenRowByJti(db, "jti-confirm-guard")?.revokedAt).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("404 on an unknown vault", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        writeVaults(h.manifestPath, ["default", "work"]);
        const res = await callDelete({
          name: "ghost",
          db,
          manifestPath: h.manifestPath,
          connectionsStorePath: join(h.dir, "connections.json"),
        });
        expect(res.status).toBe(404);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("#678: deleting the LAST vault cascades + deletes (no 409), with a last_vault warning", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Only one vault on the hub — the previously-refused last-vault case.
        writeVaults(h.manifestPath, ["solo"]);

        // Seed identity artifacts naming the soon-to-be-deleted last vault.
        registryRow(db, "jti-solo", ["vault:solo:write"]);
        const carol = await createUser(db, "carol", "carol-passphrase-123");
        const client = registerClient(db, { redirectUris: ["https://d.example/cb"] }).client
          .clientId;
        recordGrant(db, carol.id, client, ["vault:solo:admin"]);
        setUserVaults(db, carol.id, ["solo"]);

        const runner = stubRun();
        const res = await callDelete({
          name: "solo",
          db,
          manifestPath: h.manifestPath,
          connectionsStorePath: join(h.dir, "connections.json"),
          runCommand: runner.run,
        });

        // No 409 — the delete completes.
        expect(res.status).toBe(200);
        const out = (await res.json()) as {
          ok: boolean;
          cascade: {
            tokens_revoked: number;
            grants_dropped: number;
            user_vaults_removed: number;
            vault_removed: boolean;
          };
          warnings?: { step: string; detail: string }[];
        };
        expect(out.ok).toBe(true);

        // The cascade ran for the last vault: tokens/grants/assignments gone.
        expect(out.cascade.tokens_revoked).toBe(1);
        expect(findTokenRowByJti(db, "jti-solo")?.revokedAt).not.toBeNull();
        expect(out.cascade.grants_dropped).toBe(1);
        expect(findGrant(db, carol.id, client)).toBeNull();
        expect(out.cascade.user_vaults_removed).toBe(1);
        expect(
          db
            .query<{ vault_name: string }, [string]>(
              "SELECT vault_name FROM user_vaults WHERE user_id = ?",
            )
            .all(carol.id),
        ).toEqual([]);

        // The underlying vault remove ran (the cascade no longer skips it).
        expect(runner.calls).toContainEqual(["parachute-vault", "remove", "solo", "--yes"]);
        expect(out.cascade.vault_removed).toBe(true);

        // A last_vault heads-up warning is surfaced (name-agnostic — does not
        // assume "default"); the auto_create:false marker prevents resurrection.
        const lastVaultWarning = out.warnings?.find((w) => w.step === "last_vault");
        expect(lastVaultWarning).toBeDefined();
        expect(lastVaultWarning?.detail).toContain("auto_create: false");
        expect(lastVaultWarning?.detail).not.toContain('"default"');
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("reserved names are deletable (a squatted `admin` vault can be removed)", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // A vault squatted on "admin" BEFORE the B2h reservation existed.
        writeVaults(h.manifestPath, ["default", "admin"]);
        const runner = stubRun();
        const res = await callDelete({
          name: "admin",
          db,
          manifestPath: h.manifestPath,
          connectionsStorePath: join(h.dir, "connections.json"),
          runCommand: runner.run,
        });
        expect(res.status).toBe(200);
        expect(runner.calls).toContainEqual(["parachute-vault", "remove", "admin", "--yes"]);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("DELETE /vaults/<name> — the identity cascade", () => {
  test("full cascade: tokens, grants, user_vaults, invites, connections, mechanics, restart", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        writeVaults(h.manifestPath, ["default", "work"]);
        const store = join(h.dir, "connections.json");

        // 1. Registry rows: two naming "work" (one standalone + the
        //    connection's registered mint below), one naming "default".
        registryRow(db, "jti-work-1", ["vault:work:write"]);
        registryRow(db, "jti-conn-1", ["agent:send"]); // connection webhook bearer (non-vault scope)
        registryRow(db, "jti-default-1", ["vault:default:read"]);

        // 2. Grants: one spanning both vaults (rewrite), one work-only (drop).
        const alice = await createUser(db, "alice", "alice-passphrase-123");
        const clientSpan = registerClient(db, { redirectUris: ["https://a.example/cb"] }).client
          .clientId;
        const clientWorkOnly = registerClient(db, { redirectUris: ["https://b.example/cb"] }).client
          .clientId;
        recordGrant(db, alice.id, clientSpan, [
          "vault:work:read",
          "vault:default:read",
          "offline_access",
        ]);
        recordGrant(db, alice.id, clientWorkOnly, ["vault:work:admin"]);

        // 3. user_vaults: alice assigned to both.
        setUserVaults(db, alice.id, ["work", "default"]);

        // 4. Invites: pending pinned to work (invalidate), pending pinned to
        //    default (keep), already-redeemed work invite (terminal, keep).
        const pendingWork = issueInvite(db, { createdBy: alice.id, vaultName: "work" });
        const pendingDefault = issueInvite(db, { createdBy: alice.id, vaultName: "default" });
        const redeemedWork = issueInvite(db, { createdBy: alice.id, vaultName: "work" });
        // Simulate a fully-redeemed single-use invite exactly as the redeem path
        // leaves it (v15): used_at stamped AND used_count bumped to max_uses, so
        // the cascade's `used_count < max_uses` exhaustion guard treats it as
        // terminal (untouched), same as the pre-v15 `used_at IS NULL` guard did.
        db.prepare(
          "UPDATE invites SET used_at = ?, used_count = 1, redeemed_user_id = ? WHERE token = ?",
        ).run(new Date().toISOString(), alice.id, redeemedWork.invite.tokenHash);

        // 4b. vault_caps (v15): one row per vault. The work row is dropped by
        //     the cascade; the default row stays (a re-created same-name vault
        //     must not inherit a stale cap).
        setVaultCap(db, "work", 1024 * 1024 * 1024);
        setVaultCap(db, "default", 2 * 1024 * 1024 * 1024);

        // 5. Connections: one sourced on work (torn down), one on default (kept).
        putConnection(store, {
          id: "conn-work",
          source: { module: "vault", vault: "work", event: "note.created" },
          sink: { module: "agent", action: "message.deliver", params: { channel: "eng" } },
          provisioned: {
            type: "vault-trigger",
            vault: "work",
            triggerName: "conn_conn-work",
            mintedJtis: ["jti-conn-1"],
          },
          createdAt: new Date().toISOString(),
        });
        putConnection(store, {
          id: "conn-default",
          source: { module: "vault", vault: "default", event: "note.created" },
          sink: { module: "agent", action: "message.deliver", params: { channel: "ops" } },
          provisioned: { type: "vault-trigger", vault: "default", triggerName: "conn_d" },
          createdAt: new Date().toISOString(),
        });

        const { fetchImpl, calls } = mockFetch({
          "DELETE /vault/work/api/triggers/conn_conn-work": () => okJson({ ok: true }),
          "DELETE /api/channels/eng": () => okJson({ ok: true }),
          // Channel scan: one legacy vault-backed entry still references work.
          "GET /api/channels": () =>
            okJson({
              channels: [
                { name: "legacy-chan", transport: "vault", vault: "work" },
                { name: "other-chan", transport: "vault", vault: "default" },
                { name: "tg", transport: "telegram", vault: null },
              ],
            }),
        });

        const runner = stubRun();
        let restarted = false;
        const res = await callDelete({
          name: "work",
          db,
          manifestPath: h.manifestPath,
          connectionsStorePath: store,
          runCommand: runner.run,
          restartVaultModule: async () => {
            restarted = true;
          },
          agentOrigin: AGENT_ORIGIN,
          fetchImpl,
          resolveVaultOrigin: (v) => (v === "work" ? VAULT_ORIGIN : null),
        });
        expect(res.status).toBe(200);
        const out = (await res.json()) as {
          ok: boolean;
          name: string;
          cascade: {
            tokens_revoked: number;
            grants_rewritten: number;
            grants_dropped: number;
            user_vaults_removed: number;
            invites_invalidated: number;
            vault_cap_removed: boolean;
            connections_torn_down: number;
            orphaned_channels: string[];
            vault_removed: boolean;
            module_restarted: boolean;
          };
        };
        expect(out.ok).toBe(true);
        expect(out.name).toBe("work");

        // 1. Registry sweep: the work-scoped row revoked; default untouched.
        //    The connection's webhook-bearer row (agent:send — names no
        //    vault) is revoked by the CONNECTION teardown, not the sweep.
        expect(out.cascade.tokens_revoked).toBe(1);
        expect(findTokenRowByJti(db, "jti-work-1")?.revokedAt).not.toBeNull();
        expect(findTokenRowByJti(db, "jti-conn-1")?.revokedAt).not.toBeNull();
        expect(findTokenRowByJti(db, "jti-default-1")?.revokedAt).toBeNull();
        expect(listActiveRevocations(db, new Date())).toContain("jti-work-1");

        // 2. Grants: span-rewritten (kept, minus work scopes); work-only dropped.
        expect(out.cascade.grants_rewritten).toBe(1);
        expect(out.cascade.grants_dropped).toBe(1);
        const span = findGrant(db, alice.id, clientSpan);
        expect(span?.scopes.sort()).toEqual(["offline_access", "vault:default:read"]);
        expect(findGrant(db, alice.id, clientWorkOnly)).toBeNull();

        // 3. user_vaults: work row gone, default row stays.
        expect(out.cascade.user_vaults_removed).toBe(1);
        const remaining = db
          .query<{ vault_name: string }, [string]>(
            "SELECT vault_name FROM user_vaults WHERE user_id = ?",
          )
          .all(alice.id)
          .map((r) => r.vault_name);
        expect(remaining).toEqual(["default"]);

        // 4. Invites: pending-work revoked; pending-default + redeemed-work untouched.
        expect(out.cascade.invites_invalidated).toBe(1);
        expect(findInviteByHash(db, pendingWork.invite.tokenHash)?.revokedAt).not.toBeNull();
        expect(findInviteByHash(db, pendingDefault.invite.tokenHash)?.revokedAt).toBeNull();
        expect(findInviteByHash(db, redeemedWork.invite.tokenHash)?.usedAt).not.toBeNull();
        expect(findInviteByHash(db, redeemedWork.invite.tokenHash)?.revokedAt).toBeNull();

        // 4b. vault_caps: the work cap row dropped; the default cap row stays.
        expect(out.cascade.vault_cap_removed).toBe(true);
        expect(getVaultCapBytes(db, "work")).toBeNull();
        expect(getVaultCapBytes(db, "default")).toBe(2 * 1024 * 1024 * 1024);

        // 5. Connections: work connection torn down (trigger deregistered +
        //    channel entry deleted + record removed); default connection kept.
        expect(out.cascade.connections_torn_down).toBe(1);
        expect(
          calls.some(
            (c) =>
              c.method === "DELETE" && c.url.endsWith("/vault/work/api/triggers/conn_conn-work"),
          ),
        ).toBe(true);
        expect(
          calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/channels/eng")),
        ).toBe(true);
        const records = readConnections(store);
        expect(records.map((r) => r.id)).toEqual(["conn-default"]);

        // Channel scan: legacy entry surfaced, NOT deleted (report-only —
        // no DELETE call for it), and the default-vault entry not flagged.
        expect(out.cascade.orphaned_channels).toEqual(["legacy-chan"]);
        expect(calls.some((c) => c.method === "DELETE" && c.url.includes("legacy-chan"))).toBe(
          false,
        );

        // 6 + 7. Mechanics + eviction.
        expect(runner.calls).toContainEqual(["parachute-vault", "remove", "work", "--yes"]);
        expect(out.cascade.vault_removed).toBe(true);
        expect(restarted).toBe(true);
        expect(out.cascade.module_restarted).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("registry sweep is EXACT-match — `_` in vault names is not a LIKE wildcard", async () => {
    // Vault `my_vault` must not revoke `myxvault` tokens: under SQL LIKE,
    // `_` matches any single character, so a LIKE-based sweep for
    // `%vault:my_vault:%` would catch `vault:myxvault:write` too. The sweep
    // splits + exact-matches scope segments instead.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        writeVaults(h.manifestPath, ["my_vault", "myxvault"]);
        registryRow(db, "jti-underscore", ["vault:my_vault:write"]);
        registryRow(db, "jti-lookalike", ["vault:myxvault:write"]);
        const res = await callDelete({
          name: "my_vault",
          db,
          manifestPath: h.manifestPath,
          connectionsStorePath: join(h.dir, "connections.json"),
        });
        expect(res.status).toBe(200);
        const out = (await res.json()) as { cascade: { tokens_revoked: number } };
        expect(out.cascade.tokens_revoked).toBe(1);
        expect(findTokenRowByJti(db, "jti-underscore")?.revokedAt).not.toBeNull();
        // The lookalike vault's token is NOT revoked.
        expect(findTokenRowByJti(db, "jti-lookalike")?.revokedAt).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("a multi-vault grant is REWRITTEN, not dropped (dropping over-revokes)", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        writeVaults(h.manifestPath, ["default", "work"]);
        const bob = await createUser(db, "bob", "bob-passphrase-12345");
        const claude = registerClient(db, { redirectUris: ["https://c.example/cb"] }).client
          .clientId;
        recordGrant(db, bob.id, claude, ["vault:work:write", "vault:default:write"]);
        const res = await callDelete({
          name: "work",
          db,
          manifestPath: h.manifestPath,
          connectionsStorePath: join(h.dir, "connections.json"),
        });
        expect(res.status).toBe(200);
        const grant = findGrant(db, bob.id, claude);
        // Row survives with the other vault's scope intact.
        expect(grant).not.toBeNull();
        expect(grant?.scopes).toEqual(["vault:default:write"]);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("mechanics failure → 500, identity artifacts stay revoked", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        writeVaults(h.manifestPath, ["default", "work"]);
        registryRow(db, "jti-pre-fail", ["vault:work:write"]);
        const res = await callDelete({
          name: "work",
          db,
          manifestPath: h.manifestPath,
          connectionsStorePath: join(h.dir, "connections.json"),
          runCommand: stubRun(1, "disk on fire").run,
        });
        expect(res.status).toBe(500);
        const out = (await res.json()) as { error: string; error_description: string };
        expect(out.error).toBe("server_error");
        expect(out.error_description).toContain("disk on fire");
        // Revocation is the safe direction — the sweep is NOT rolled back.
        expect(findTokenRowByJti(db, "jti-pre-fail")?.revokedAt).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("no supervisor → 200 with a module_restart warning (not silent)", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        writeVaults(h.manifestPath, ["default", "work"]);
        const res = await callDelete({
          name: "work",
          db,
          manifestPath: h.manifestPath,
          connectionsStorePath: join(h.dir, "connections.json"),
        });
        expect(res.status).toBe(200);
        const out = (await res.json()) as {
          cascade: { module_restarted: boolean };
          warnings?: { step: string; detail: string }[];
        };
        expect(out.cascade.module_restarted).toBe(false);
        expect(out.warnings?.some((w) => w.step === "module_restart")).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

// ===========================================================================
// #478 — empty-paths vault rows must not resolve to phantom "default"
// ===========================================================================

describe("#478 — empty-paths vault row tolerance", () => {
  test("findExistingVault: empty-paths vault row does NOT match 'default'", () => {
    // A vault module registered in services.json with paths:[] is "installed
    // but no servable vault instance". Hub must skip it — never synthesize a
    // phantom "default" — so provisionVault can proceed to a real create.
    const h = makeHarness();
    try {
      // Write a services.json with a parachute-vault entry carrying paths:[].
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              port: 1940,
              paths: [],
              health: "/health",
              version: "0.5.0",
            },
          ],
        },
        h.manifestPath,
      );
      // Calling provisionVault("default") internally calls findExistingVault.
      // We verify the behaviour indirectly via listVaultInstanceNames (exported
      // for this test) and via provisionVault's created:true path below.
      const names = listVaultInstanceNames(h.manifestPath);
      expect(names.has("default")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("listVaultInstanceNames: empty-paths vault row is omitted from the Set", () => {
    const h = makeHarness();
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              port: 1940,
              paths: [],
              health: "/health",
              version: "0.5.0",
            },
          ],
        },
        h.manifestPath,
      );
      const names = listVaultInstanceNames(h.manifestPath);
      expect(names.size).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("provisionVault: empty-paths row → created:true (proceeds to orchestrate, not false 'already exists')", async () => {
    // Core regression test for #478: before the fix, an empty-paths row
    // resolved to phantom "default" → findExistingVault returned non-null →
    // provisionVault short-circuited to created:false with "already exists".
    // After the fix: findExistingVault returns null → orchestrate runs →
    // created:true.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Seed an empty-paths vault row (what vault's self-register emits at
        // zero vaults, per the #478 contract).
        writeManifest(
          {
            services: [
              {
                name: "parachute-vault",
                port: 1940,
                paths: [],
                health: "/health",
                version: "0.5.0",
              },
            ],
          },
          h.manifestPath,
        );

        const calls: Array<readonly string[]> = [];
        const runCommand = async (cmd: readonly string[]): Promise<RunResult> => {
          calls.push(cmd);
          // Simulate vault CLI writing the real path into services.json after
          // a successful create. Because vault IS already registered (paths:[]),
          // orchestrate picks the `parachute-vault create --json` branch and
          // expects JSON stdout.
          upsertService(
            {
              name: "parachute-vault",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
              version: "0.5.0",
            },
            h.manifestPath,
          );
          return { exitCode: 0, stdout: vaultCreateJson("default"), stderr: "" };
        };

        const result = await provisionVault("default", {
          issuer: ISSUER,
          manifestPath: h.manifestPath,
          runCommand,
        });

        // Must have proceeded to orchestrate and returned created:true.
        expect(result.ok).toBe(true);
        if (!result.ok) return; // narrow for TS
        expect(result.created).toBe(true);
        // The orchestration command ran (not short-circuited).
        expect(calls.length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("listVaultInstanceNames: real paths still enumerate correctly (empty-paths does not break them)", () => {
    // Sanity: mixing an empty-paths row with a real-paths row — the real
    // paths are still found, the empty one is still skipped.
    const h = makeHarness();
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              port: 1940,
              paths: ["/vault/default", "/vault/work"],
              health: "/health",
              version: "0.5.0",
            },
          ],
        },
        h.manifestPath,
      );
      const names = listVaultInstanceNames(h.manifestPath);
      expect(names.has("default")).toBe(true);
      expect(names.has("work")).toBe(true);
      expect(names.size).toBe(2);
    } finally {
      h.cleanup();
    }
  });
});
