import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleAccountCapabilities,
  handleAccountCreateVault,
  handleAccountGetVaultCaps,
  handleAccountListVaults,
  handleAccountMintVaultToken,
  handleAccountRoot,
  handleAccountSetVaultCaps,
} from "../account-api.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken, validateAccessToken } from "../jwt-sign.ts";
import { upsertService } from "../services-manifest.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";
import { getVaultCap } from "../vault-caps.ts";

const ISSUER = "http://127.0.0.1:1939";
const HOST_ADMIN_SCOPE = "parachute:host:admin";
const ACCOUNT_ADMIN_SCOPE = "account:self:admin";
const ACCOUNT_READ_SCOPE = "account:self:read";

type RunResult = { exitCode: number; stdout: string; stderr: string };

/** Mirror of the `parachute-vault create --json` stdout shape (see admin-vaults.test). */
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

interface Harness {
  db: Database;
  dir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(vaultNames: string[] = ["beta", "personal"]): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-account-api-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const manifestPath = join(dir, "services.json");
  const paths = vaultNames.map((n) => `/vault/${n}`);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      services: [
        { name: "parachute-vault", port: 4101, paths, health: "/health", version: "0.4.2" },
      ],
    }),
  );
  return {
    db,
    dir,
    manifestPath,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function deps(
  h: Harness,
  extra: Partial<{ runCommand: (cmd: readonly string[]) => Promise<RunResult> }> = {},
) {
  return { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath, ...extra };
}

async function bearer(h: Harness, scopes: string[], sub = "operator-user"): Promise<string> {
  const minted = await signAccessToken(h.db, {
    sub,
    scopes,
    audience: "account",
    clientId: "parachute-hub-spa",
    issuer: ISSUER,
    ttlSeconds: 600,
  });
  return minted.token;
}

function withBearer(path: string, token: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`${ISSUER}${path}`, { ...init, headers });
}

function jsonReq(path: string, token: string, method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return withBearer(path, token, init);
}

// ===========================================================================
// GET /.well-known/parachute-account — the capabilities descriptor
// ===========================================================================
describe("handleAccountCapabilities", () => {
  test("descriptor is public and reports the self-host door honestly", async () => {
    const res = handleAccountCapabilities(new Request(`${ISSUER}/.well-known/parachute-account`), {
      issuer: `${ISSUER}/`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.door).toBe("self-host");
    expect(body.issuer).toBe(ISSUER); // trailing slash trimmed
    const features = body.features as Record<string, unknown>;
    expect(features.billing).toBe(false); // no billing on self-host
    expect(features.plans).toEqual([]);
    expect(features.vault_create).toBe(true);
    expect(features.vault_delete).toBe(true);
    expect(features.modules).toBe(true);
    expect(features.expose).toBe(true);
    expect(body.caps_writable).toBe(true);
    expect((body.limits as Record<string, unknown>).vaults_max).toBeNull();
  });

  test("405 on non-GET", () => {
    const res = handleAccountCapabilities(
      new Request(`${ISSUER}/.well-known/parachute-account`, { method: "POST" }),
      { issuer: ISSUER },
    );
    expect(res.status).toBe(405);
  });
});

// ===========================================================================
// Auth gates (shared shape across the surface)
// ===========================================================================
describe("account API — auth gates", () => {
  test("401 with no Authorization header", async () => {
    const h = makeHarness();
    try {
      const res = await handleAccountListVaults(withBearer("/account/vaults", null), deps(h));
      expect(res.status).toBe(401);
    } finally {
      h.cleanup();
    }
  });

  test("403 when the token carries neither account:self:* nor host:admin", async () => {
    const h = makeHarness();
    try {
      const token = await bearer(h, ["vault:beta:read"]);
      const res = await handleAccountListVaults(withBearer("/account/vaults", token), deps(h));
      expect(res.status).toBe(403);
    } finally {
      h.cleanup();
    }
  });

  test("a plain parachute:host:admin token is accepted (H1-independent)", async () => {
    const h = makeHarness();
    try {
      const token = await bearer(h, [HOST_ADMIN_SCOPE]);
      const res = await handleAccountListVaults(withBearer("/account/vaults", token), deps(h));
      expect(res.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  test("an account:self:admin token is accepted", async () => {
    const h = makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const res = await handleAccountListVaults(withBearer("/account/vaults", token), deps(h));
      expect(res.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  test("account:self:read is accepted on reads but rejected (403) on mutations", async () => {
    const h = makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_READ_SCOPE]);
      const read = await handleAccountListVaults(withBearer("/account/vaults", token), deps(h));
      expect(read.status).toBe(200);
      const write = await handleAccountCreateVault(
        jsonReq("/account/vaults", token, "POST", { name: "nope" }),
        deps(h),
      );
      expect(write.status).toBe(403);
    } finally {
      h.cleanup();
    }
  });
});

// ===========================================================================
// GET /account/vaults — list
// ===========================================================================
describe("handleAccountListVaults", () => {
  test("lists every registered vault with url + version + caps", async () => {
    const h = makeHarness(["alpha", "beta"]);
    try {
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const res = await handleAccountListVaults(withBearer("/account/vaults", token), deps(h));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        vaults: Array<{
          name: string;
          url: string;
          version: string;
          caps: { cap_bytes: number | null };
        }>;
      };
      const names = body.vaults.map((v) => v.name).sort();
      expect(names).toEqual(["alpha", "beta"]);
      const alpha = body.vaults.find((v) => v.name === "alpha");
      expect(alpha?.url).toBe(`${ISSUER}/vault/alpha`);
      expect(alpha?.version).toBe("0.4.2");
      expect(alpha?.caps.cap_bytes).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

// ===========================================================================
// POST /account/vaults — create (returns a ready-to-use vault token)
// ===========================================================================
describe("handleAccountCreateVault", () => {
  test("201 returns the vault token + services block on a fresh create", async () => {
    const h = makeHarness(["default"]);
    try {
      const token = await bearer(h, [HOST_ADMIN_SCOPE]);
      const runCommand = async (_cmd: readonly string[]): Promise<RunResult> => {
        upsertService(
          {
            name: "parachute-vault",
            port: 4101,
            paths: ["/vault/default", "/vault/work"],
            health: "/health",
            version: "0.4.2",
          },
          h.manifestPath,
        );
        return { exitCode: 0, stdout: vaultCreateJson("work", "hubjwt.work.access"), stderr: "" };
      };
      const res = await handleAccountCreateVault(
        jsonReq("/account/vaults", token, "POST", { name: "work" }),
        deps(h, { runCommand }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        name: string;
        url: string;
        vault_token: string;
        services: Record<string, { url: string; version: string }>;
      };
      expect(body.name).toBe("work");
      expect(body.url).toBe(`${ISSUER}/vault/work`);
      expect(body.vault_token).toBe("hubjwt.work.access");
      expect(body.services["vault:work"]?.url).toBe(`${ISSUER}/vault/work`);
      expect(body.services["vault:work"]?.version).toBe("0.4.2");
    } finally {
      h.cleanup();
    }
  });

  test("empty vault_token + token_guidance flow through so the app can fall back", async () => {
    const h = makeHarness(["default"]);
    try {
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const runCommand = async (_cmd: readonly string[]): Promise<RunResult> => {
        upsertService(
          {
            name: "parachute-vault",
            port: 4101,
            paths: ["/vault/default", "/vault/work"],
            health: "/health",
            version: "0.4.2",
          },
          h.manifestPath,
        );
        return {
          exitCode: 0,
          stdout: vaultCreateJson("work", "", "no hub origin reachable to mint against"),
          stderr: "",
        };
      };
      const res = await handleAccountCreateVault(
        jsonReq("/account/vaults", token, "POST", { name: "work" }),
        deps(h, { runCommand }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { vault_token: string; token_guidance?: string };
      expect(body.vault_token).toBe("");
      expect(body.token_guidance).toBe("no hub origin reachable to mint against");
    } finally {
      h.cleanup();
    }
  });

  test("400 invalid_name on a missing name", async () => {
    const h = makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const res = await handleAccountCreateVault(
        jsonReq("/account/vaults", token, "POST", {}),
        deps(h),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_name");
    } finally {
      h.cleanup();
    }
  });
});

// ===========================================================================
// POST /account/vaults/<name>/token — per-vault token mint
// ===========================================================================
describe("handleAccountMintVaultToken", () => {
  test("mints a vault token with aud=vault.<name> and default read+write scope", async () => {
    const h = makeHarness(["field-notes"]);
    try {
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const res = await handleAccountMintVaultToken(
        withBearer("/account/vaults/field-notes/token", token, { method: "POST" }),
        "field-notes",
        deps(h),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        vault_token: string;
        expires_at: string;
        services: Record<string, { url: string }>;
      };
      expect(body.vault_token.length).toBeGreaterThan(0);
      expect(body.services["vault:field-notes"]?.url).toBe(`${ISSUER}/vault/field-notes`);
      const validated = await validateAccessToken(h.db, body.vault_token, ISSUER);
      expect(validated.payload.aud).toBe("vault.field-notes");
      expect(validated.payload.scope).toBe("vault:field-notes:read vault:field-notes:write");
    } finally {
      h.cleanup();
    }
  });

  test("honors an explicit scopes list", async () => {
    const h = makeHarness(["field-notes"]);
    try {
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const res = await handleAccountMintVaultToken(
        jsonReq("/account/vaults/field-notes/token", token, "POST", {
          scopes: ["vault:field-notes:read"],
        }),
        "field-notes",
        deps(h),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { vault_token: string };
      const validated = await validateAccessToken(h.db, body.vault_token, ISSUER);
      expect(validated.payload.scope).toBe("vault:field-notes:read");
    } finally {
      h.cleanup();
    }
  });

  test("404 when the vault does not exist", async () => {
    const h = makeHarness(["field-notes"]);
    try {
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const res = await handleAccountMintVaultToken(
        withBearer("/account/vaults/ghost/token", token, { method: "POST" }),
        "ghost",
        deps(h),
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("vault_not_found");
    } finally {
      h.cleanup();
    }
  });

  test("400 invalid_scope when a requested scope names another vault", async () => {
    const h = makeHarness(["field-notes", "other"]);
    try {
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const res = await handleAccountMintVaultToken(
        jsonReq("/account/vaults/field-notes/token", token, "POST", {
          scopes: ["vault:other:read"],
        }),
        "field-notes",
        deps(h),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
    } finally {
      h.cleanup();
    }
  });
});

// ===========================================================================
// GET / PUT /account/vaults/<name>/caps
// ===========================================================================
describe("account caps", () => {
  test("GET reports null cap for an uncapped vault; PUT sets it; GET reflects", async () => {
    const h = makeHarness(["field-notes"]);
    try {
      const adminTok = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const readTok = await bearer(h, [ACCOUNT_READ_SCOPE]);

      const get0 = await handleAccountGetVaultCaps(
        withBearer("/account/vaults/field-notes/caps", readTok),
        "field-notes",
        deps(h),
      );
      expect(get0.status).toBe(200);
      expect(
        ((await get0.json()) as { caps: { cap_bytes: number | null } }).caps.cap_bytes,
      ).toBeNull();

      const put = await handleAccountSetVaultCaps(
        jsonReq("/account/vaults/field-notes/caps", adminTok, "PUT", { cap_bytes: 1048576 }),
        "field-notes",
        deps(h),
      );
      expect(put.status).toBe(200);
      expect(getVaultCap(h.db, "field-notes")?.capBytes).toBe(1048576);

      const get1 = await handleAccountGetVaultCaps(
        withBearer("/account/vaults/field-notes/caps", readTok),
        "field-notes",
        deps(h),
      );
      expect(((await get1.json()) as { caps: { cap_bytes: number | null } }).caps.cap_bytes).toBe(
        1048576,
      );
    } finally {
      h.cleanup();
    }
  });

  test("PUT 400 on a non-positive cap", async () => {
    const h = makeHarness(["field-notes"]);
    try {
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const res = await handleAccountSetVaultCaps(
        jsonReq("/account/vaults/field-notes/caps", token, "PUT", { cap_bytes: 0 }),
        "field-notes",
        deps(h),
      );
      expect(res.status).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  test("GET 404 for an unknown vault", async () => {
    const h = makeHarness(["field-notes"]);
    try {
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const res = await handleAccountGetVaultCaps(
        withBearer("/account/vaults/ghost/caps", token),
        "ghost",
        deps(h),
      );
      expect(res.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });
});

// ===========================================================================
// GET /account — bootstrap
// ===========================================================================
describe("handleAccountRoot", () => {
  test("returns account_id=self, door=self-host, and the operator email", async () => {
    const h = makeHarness();
    try {
      const user = await createUser(h.db, "operator", "any-password", {
        allowMulti: true,
        passwordChanged: true,
        email: "op@example.com",
      });
      const token = await bearer(h, [ACCOUNT_READ_SCOPE], user.id);
      const res = await handleAccountRoot(withBearer("/account", token), deps(h));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { account_id: string; email: string | null; door: string };
      expect(body.account_id).toBe("self");
      expect(body.door).toBe("self-host");
      expect(body.email).toBe("op@example.com");
    } finally {
      h.cleanup();
    }
  });
});
