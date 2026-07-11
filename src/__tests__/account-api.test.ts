import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAccountDescriptor, validateVaultScopes } from "@openparachute/door-contract";
import {
  handleAccountCapabilities,
  handleAccountCreateVault,
  handleAccountGetVaultCaps,
  handleAccountListVaults,
  handleAccountMintVaultToken,
  handleAccountRoot,
  handleAccountSetVaultCaps,
} from "../account-api.ts";
import { handleCreateInvite } from "../api-invites.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { getSetting } from "../hub-settings.ts";
import { findInviteByRawToken, recordInviteRedemption, revokeInvite } from "../invites.ts";
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
  test("descriptor is public, wildcard-CORS, and conforms to the shared door-contract canon", async () => {
    const h = makeHarness();
    try {
      const res = handleAccountCapabilities(
        new Request(`${ISSUER}/.well-known/parachute-account`),
        { db: h.db, issuer: `${ISSUER}/` },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
      const body = (await res.json()) as Record<string, unknown>;
      // The shared conformance checker — empty issue list means the shape
      // is byte-conformant with the canonical ParachuteAccountDescriptor.
      expect(checkAccountDescriptor(body, { issuer: ISSUER, door: "hub" })).toEqual([]);
      expect(body.issuer).toBe(ISSUER); // trailing slash trimmed
      expect(body.door).toBe("hub");
      expect(body.account_endpoint).toBe(`${ISSUER}/account`);
      expect(body.auth).toEqual({ methods: ["password"], signin_path: "/login" });
      expect(body.vault_url_template).toContain("{name}");
      expect(body.vault_url_template).toBe(`${ISSUER}/vault/{name}`);
      expect(body.capabilities).toEqual({
        vault_create: true,
        vault_rename: false,
        vault_delete: true,
      });
      expect(body.plans).toEqual([]);
      expect(body.signup_path).toBeUndefined(); // fresh hub, no active public invite
      // Hub extras — additive, outside the shared contract (conformance
      // walks expected keys only, so these ride along without breaking it).
      const features = body.features as Record<string, unknown>;
      expect(features.billing).toBe(false);
      expect(features.modules).toBe(true);
      expect(features.expose).toBe(true);
      expect(features.import).toBe(true);
      expect(features.export).toBe(true);
      expect(body.caps_writable).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("405 on non-GET", () => {
    const h = makeHarness();
    try {
      const res = handleAccountCapabilities(
        new Request(`${ISSUER}/.well-known/parachute-account`, { method: "POST" }),
        { db: h.db, issuer: ISSUER },
      );
      expect(res.status).toBe(405);
    } finally {
      h.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Q2 — the conditional `signup_path`. Present only while an active
  // multi-use (public-signup) invite exists; absent on a fresh hub and
  // absent again once the invite is revoked / exhausted / expired (the
  // setting is lazily cleared on the next read, invites.ts's
  // activePublicSignupPath).
  // -------------------------------------------------------------------------
  test("signup_path appears after minting a max_uses:3 invite, disappears on revoke", async () => {
    const h = makeHarness();
    try {
      const admin = await createUser(h.db, "operator", "any-password", {
        allowMulti: true,
        passwordChanged: true,
      });
      const adminToken = await bearer(h, [HOST_ADMIN_SCOPE], admin.id);
      const mintRes = await handleCreateInvite(
        jsonReq("/api/invites", adminToken, "POST", { max_uses: 3 }),
        { db: h.db, issuer: ISSUER },
      );
      expect(mintRes.status).toBe(201);
      const minted = (await mintRes.json()) as { token: string };

      const afterMint = handleAccountCapabilities(
        new Request(`${ISSUER}/.well-known/parachute-account`),
        { db: h.db, issuer: ISSUER },
      );
      const afterMintBody = (await afterMint.json()) as Record<string, unknown>;
      expect(afterMintBody.signup_path).toBe(`/account/setup/${minted.token}`);

      const invite = findInviteByRawToken(h.db, minted.token);
      expect(invite).not.toBeNull();
      expect(revokeInvite(h.db, invite?.tokenHash ?? "")).toBe(true);

      const afterRevoke = handleAccountCapabilities(
        new Request(`${ISSUER}/.well-known/parachute-account`),
        { db: h.db, issuer: ISSUER },
      );
      expect(((await afterRevoke.json()) as Record<string, unknown>).signup_path).toBeUndefined();
      expect(getSetting(h.db, "public_signup_token")).toBeUndefined(); // lazily cleared
    } finally {
      h.cleanup();
    }
  });

  test("signup_path disappears once the invite is exhausted (used_count == max_uses)", async () => {
    const h = makeHarness();
    try {
      const admin = await createUser(h.db, "operator", "any-password", {
        allowMulti: true,
        passwordChanged: true,
      });
      const adminToken = await bearer(h, [HOST_ADMIN_SCOPE], admin.id);
      const mintRes = await handleCreateInvite(
        jsonReq("/api/invites", adminToken, "POST", { max_uses: 2 }),
        { db: h.db, issuer: ISSUER },
      );
      const minted = (await mintRes.json()) as { token: string };
      const invite = findInviteByRawToken(h.db, minted.token);
      expect(invite).not.toBeNull();

      // Redeem both seats directly (invites.ts core — the redeem HTTP flow
      // itself is out of scope here). `redeemed_user_id` FKs to `users`, so
      // reuse the admin row as the redeemer stand-in — the test only cares
      // that TWO redemptions land, not who they belong to.
      expect(recordInviteRedemption(h.db, invite?.tokenHash ?? "", admin.id)).toBe(true);
      expect(recordInviteRedemption(h.db, invite?.tokenHash ?? "", admin.id)).toBe(true);

      const res = handleAccountCapabilities(
        new Request(`${ISSUER}/.well-known/parachute-account`),
        { db: h.db, issuer: ISSUER },
      );
      expect(((await res.json()) as Record<string, unknown>).signup_path).toBeUndefined();
      expect(getSetting(h.db, "public_signup_token")).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("signup_path disappears once the invite expires (injected clock)", async () => {
    const h = makeHarness();
    try {
      const admin = await createUser(h.db, "operator", "any-password", {
        allowMulti: true,
        passwordChanged: true,
      });
      const adminToken = await bearer(h, [HOST_ADMIN_SCOPE], admin.id);
      const mintTime = new Date("2026-01-01T00:00:00.000Z");
      const mintRes = await handleCreateInvite(
        jsonReq("/api/invites", adminToken, "POST", { max_uses: 5, expires_in: 60 }),
        { db: h.db, issuer: ISSUER, now: () => mintTime },
      );
      expect(mintRes.status).toBe(201);

      const stillLive = handleAccountCapabilities(
        new Request(`${ISSUER}/.well-known/parachute-account`),
        { db: h.db, issuer: ISSUER, now: () => new Date(mintTime.getTime() + 30_000) },
      );
      expect(((await stillLive.json()) as Record<string, unknown>).signup_path).toBeDefined();

      const afterExpiry = handleAccountCapabilities(
        new Request(`${ISSUER}/.well-known/parachute-account`),
        { db: h.db, issuer: ISSUER, now: () => new Date(mintTime.getTime() + 120_000) },
      );
      expect(((await afterExpiry.json()) as Record<string, unknown>).signup_path).toBeUndefined();
      expect(getSetting(h.db, "public_signup_token")).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("signup_path is NOT set for a multi-use NON-provisioning invite (B1: a team link must never leak on the public descriptor)", async () => {
    const h = makeHarness();
    try {
      const admin = await createUser(h.db, "operator", "any-password", {
        allowMulti: true,
        passwordChanged: true,
      });
      const adminToken = await bearer(h, [HOST_ADMIN_SCOPE], admin.id);
      // A multi-use link with provision_vault=false is a team invite (here
      // account-only; a shared-vault one additionally pins an existing
      // vault_name and would hand out team-vault WRITE) — NOT a public signup
      // that gives each redeemer their own fresh vault. It must never be
      // persisted to public_signup_token nor advertised via the anonymous,
      // wildcard-CORS descriptor. Same `provisionVault` guard covers both the
      // account-only and shared-vault non-provisioning shapes.
      const mintRes = await handleCreateInvite(
        jsonReq("/api/invites", adminToken, "POST", { max_uses: 3, provision_vault: false }),
        { db: h.db, issuer: ISSUER },
      );
      expect(mintRes.status).toBe(201);
      // The raw token was NOT persisted (the write-side guard)...
      expect(getSetting(h.db, "public_signup_token")).toBeUndefined();
      // ...and the public descriptor advertises no signup_path.
      const desc = handleAccountCapabilities(
        new Request(`${ISSUER}/.well-known/parachute-account`),
        { db: h.db, issuer: ISSUER },
      );
      expect(((await desc.json()) as Record<string, unknown>).signup_path).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

// ===========================================================================
// The shared door-contract validateVaultScopes — behavioral no-op proof
// (hub-parity P2, item 5). These are the SAME fixtures the hub's prior local
// `parseScopesBody` scope-shape logic was exercised against (see the
// `handleAccountMintVaultToken` describe block below for the HTTP-level
// equivalents); asserting them directly against the shared validator proves
// the swap didn't change hub's wire behavior.
// ===========================================================================
describe("validateVaultScopes (shared door-contract validator) — hub's prior fixtures", () => {
  test("undefined / null / [] all default to read+write for the named vault", () => {
    for (const requested of [undefined, null, []]) {
      expect(validateVaultScopes(requested, "field-notes")).toEqual({
        ok: true,
        scopes: ["vault:field-notes:read", "vault:field-notes:write"],
      });
    }
  });

  test("an explicit single-scope array is honored verbatim", () => {
    expect(validateVaultScopes(["vault:field-notes:read"], "field-notes")).toEqual({
      ok: true,
      scopes: ["vault:field-notes:read"],
    });
  });

  test("a scope naming another vault is invalid_scope", () => {
    expect(validateVaultScopes(["vault:other:read"], "field-notes")).toEqual({
      ok: false,
      reason: "invalid_scope",
    });
  });

  test("a non-array requested value is invalid_request", () => {
    expect(validateVaultScopes("not-an-array", "field-notes")).toEqual({
      ok: false,
      reason: "invalid_request",
    });
  });

  test("a mixed array with a non-string entry is invalid_request, even when a valid scope leads", () => {
    // The whole-array pre-scan (byte-exact with hub's prior parseScopesBody):
    // a non-string entry anywhere rejects the WHOLE request as
    // invalid_request, never a positional invalid_scope.
    expect(validateVaultScopes(["vault:field-notes:read", 123], "field-notes")).toEqual({
      ok: false,
      reason: "invalid_request",
    });
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

  // Q6 (hub-parity P2): create-existing-name converges on 409 vault_taken —
  // this facade no longer answers 200-idempotent. `provisionVault` itself
  // stays idempotent (the invite-redeem caller doesn't route through here).
  test("409 vault_taken on an existing vault name (Q6 — no longer 200-idempotent)", async () => {
    const h = makeHarness(["beta", "personal"]);
    try {
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
      const res = await handleAccountCreateVault(
        jsonReq("/account/vaults", token, "POST", { name: "beta" }),
        deps(h),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("vault_taken");
      expect(body.message).toBe("That vault name is already taken.");
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
  test("returns the contract's AccountBootstrap — {id:self, door:hub, email}", async () => {
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
      const body = (await res.json()) as { id: string; email?: string; door: string };
      expect(body).toEqual({ id: "self", door: "hub", email: "op@example.com" });
    } finally {
      h.cleanup();
    }
  });

  test("omits email when the operator row has none", async () => {
    const h = makeHarness();
    try {
      const user = await createUser(h.db, "operator", "any-password", {
        allowMulti: true,
        passwordChanged: true,
      });
      const token = await bearer(h, [ACCOUNT_READ_SCOPE], user.id);
      const res = await handleAccountRoot(withBearer("/account", token), deps(h));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; email?: string; door: string };
      expect(body).toEqual({ id: "self", door: "hub" });
      expect(body.email).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});
