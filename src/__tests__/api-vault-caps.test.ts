/**
 * Tests for `/api/vault-caps*` (B5 admin visibility / D-slice).
 * Covers:
 *
 *   - Auth boundary: GET + PUT require a bearer carrying `parachute:host:admin`.
 *   - GET joins services.json vault names with persisted caps (uncapped =
 *     null cap_bytes), ordered by name.
 *   - PUT sets/updates a cap (upsert), validates positive cap, refuses a
 *     vault not registered in services.json (400 vault_not_found).
 *   - 405 on wrong methods.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleListVaultCaps, handleSetVaultCap } from "../api-vault-caps.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { createUser } from "../users.ts";
import { getVaultCapBytes, setVaultCap } from "../vault-caps.ts";

const ISSUER = "https://hub.test";
const HOST_ADMIN_SCOPE = "parachute:host:admin";

interface Harness {
  db: Database;
  manifestPath: string;
  cleanup: () => void;
}

function manifestWithVaults(...names: string[]): string {
  const paths = names.map((n) => `/vault/${n}`);
  return JSON.stringify({
    services: [
      { name: "parachute-vault", port: 4101, paths, health: "/health", version: "0.0.0-test" },
    ],
  });
}

function makeHarness(servicesJson?: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-vault-caps-"));
  const db = openHubDb(hubDbPath(dir));
  const manifestPath = join(dir, "services.json");
  writeFileSync(manifestPath, servicesJson ?? manifestWithVaults("beta", "personal"));
  return {
    db,
    manifestPath,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

async function makeAdminBearer(scopes = [HOST_ADMIN_SCOPE]): Promise<string> {
  const user = await createUser(harness.db, "operator", "any-password", {
    allowMulti: true,
    passwordChanged: true,
  });
  const minted = await signAccessToken(harness.db, {
    sub: user.id,
    scopes,
    audience: "hub",
    clientId: "parachute-hub-spa",
    issuer: ISSUER,
    ttlSeconds: 600,
  });
  return minted.token;
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${ISSUER}${path}`, init);
}

function withBearer(path: string, bearer: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", `Bearer ${bearer}`);
  return new Request(`${ISSUER}${path}`, { ...init, headers });
}

function deps() {
  return { db: harness.db, issuer: ISSUER, manifestPath: harness.manifestPath };
}

describe("handleListVaultCaps", () => {
  test("401 with no Authorization header", async () => {
    const res = await handleListVaultCaps(req("/api/vault-caps"), deps());
    expect(res.status).toBe(401);
  });

  test("403 when bearer lacks parachute:host:admin", async () => {
    const bearer = await makeAdminBearer(["other:scope"]);
    const res = await handleListVaultCaps(withBearer("/api/vault-caps", bearer), deps());
    expect(res.status).toBe(403);
  });

  test("405 on POST", async () => {
    const bearer = await makeAdminBearer();
    const res = await handleListVaultCaps(
      withBearer("/api/vault-caps", bearer, { method: "POST" }),
      deps(),
    );
    expect(res.status).toBe(405);
  });

  test("joins services.json vaults with caps, uncapped = null cap_bytes", async () => {
    const bearer = await makeAdminBearer();
    // Only "beta" has a persisted cap; "personal" stays uncapped.
    setVaultCap(harness.db, "beta", 1024 * 1024 * 1024);
    const res = await handleListVaultCaps(withBearer("/api/vault-caps", bearer), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      vault_caps: Array<{ vault_name: string; cap_bytes: number | null }>;
    };
    // Both vaults present, ordered by name (beta, personal).
    expect(body.vault_caps.map((c) => c.vault_name)).toEqual(["beta", "personal"]);
    const beta = body.vault_caps.find((c) => c.vault_name === "beta");
    const personal = body.vault_caps.find((c) => c.vault_name === "personal");
    expect(beta?.cap_bytes).toBe(1024 * 1024 * 1024);
    expect(personal?.cap_bytes).toBeNull();
  });
});

describe("handleSetVaultCap", () => {
  test("401 with no Authorization header", async () => {
    const res = await handleSetVaultCap(
      req("/api/vault-caps/beta", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cap_bytes: 1000 }),
      }),
      "beta",
      deps(),
    );
    expect(res.status).toBe(401);
  });

  test("403 when bearer lacks parachute:host:admin", async () => {
    const bearer = await makeAdminBearer(["other:scope"]);
    const res = await handleSetVaultCap(
      withBearer("/api/vault-caps/beta", bearer, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cap_bytes: 1000 }),
      }),
      "beta",
      deps(),
    );
    expect(res.status).toBe(403);
  });

  test("400 on a fractional (non-integer) cap", async () => {
    const bearer = await makeAdminBearer();
    const res = await handleSetVaultCap(
      withBearer("/api/vault-caps/beta", bearer, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cap_bytes: 1.5 }),
      }),
      "beta",
      deps(),
    );
    expect(res.status).toBe(400);
  });

  test("405 on GET", async () => {
    const bearer = await makeAdminBearer();
    const res = await handleSetVaultCap(withBearer("/api/vault-caps/beta", bearer), "beta", deps());
    expect(res.status).toBe(405);
  });

  test("sets a cap on a registered vault and persists it (upsert)", async () => {
    const bearer = await makeAdminBearer();
    const res = await handleSetVaultCap(
      withBearer("/api/vault-caps/beta", bearer, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cap_bytes: 2 * 1024 * 1024 * 1024 }),
      }),
      "beta",
      deps(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vault_cap: { cap_bytes: number } };
    expect(body.vault_cap.cap_bytes).toBe(2 * 1024 * 1024 * 1024);
    expect(getVaultCapBytes(harness.db, "beta")).toBe(2 * 1024 * 1024 * 1024);
  });

  test("400 vault_not_found for a vault not in services.json", async () => {
    const bearer = await makeAdminBearer();
    const res = await handleSetVaultCap(
      withBearer("/api/vault-caps/ghost", bearer, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cap_bytes: 1000 }),
      }),
      "ghost",
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("vault_not_found");
    // Nothing persisted for the rejected name.
    expect(getVaultCapBytes(harness.db, "ghost")).toBeNull();
  });

  test("400 on non-positive cap", async () => {
    const bearer = await makeAdminBearer();
    const res = await handleSetVaultCap(
      withBearer("/api/vault-caps/beta", bearer, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cap_bytes: 0 }),
      }),
      "beta",
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });
});
