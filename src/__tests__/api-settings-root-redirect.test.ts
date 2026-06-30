/**
 * Tests for `/api/settings/root-redirect`.
 *
 * Covers:
 *   - `validateRootRedirect` pure validator (null/empty clear, safe path,
 *     open-redirect rejection).
 *   - GET response shape (root_redirect + resolved + source).
 *   - PUT happy path + open-redirect rejection (the highest-stakes part).
 *   - PUT clear (null) reverts to env/default precedence.
 *   - Auth gating: 401 missing/empty bearer, 403 wrong scope.
 *   - "Change takes effect on the next request" — the GET resolved value
 *     reflects the value just written, without restarting.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE,
  handleApiSettingsRootRedirect,
  validateRootRedirect,
} from "../api-settings-root-redirect.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { getRootRedirect, setRootRedirect } from "../hub-settings.ts";
import { recordTokenMint, signAccessToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "http://127.0.0.1:1939";

interface Harness {
  dir: string;
  db: ReturnType<typeof openHubDb>;
  userId: string;
  cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-settings-root-redirect-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const user = await createUser(db, "owner", "pw");
  return {
    dir,
    db,
    userId: user.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function mintBearer(h: Harness, scopes: string[]): Promise<string> {
  const signed = await signAccessToken(h.db, {
    sub: h.userId,
    scopes,
    audience: "parachute-hub",
    clientId: "parachute-hub",
    issuer: ISSUER,
    ttlSeconds: 3600,
  });
  recordTokenMint(h.db, {
    jti: signed.jti,
    createdVia: "operator_mint",
    subject: h.userId,
    clientId: "parachute-hub",
    scopes,
    expiresAt: signed.expiresAt,
  });
  return signed.token;
}

function getReq(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/settings/root-redirect", { method: "GET", headers });
}

function putReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/settings/root-redirect", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Empty env so the resolver's env layer is deterministic (the host's real
// PARACHUTE_HUB_ROOT_REDIRECT must not leak into GET's resolved/source).
const noEnv: NodeJS.ProcessEnv = {};

function deps(
  h: Harness,
  overrides: Partial<Parameters<typeof handleApiSettingsRootRedirect>[1]> = {},
) {
  return {
    db: h.db,
    issuer: ISSUER,
    env: noEnv,
    ...overrides,
  };
}

describe("validateRootRedirect — pure validator", () => {
  test("null → normalized null (clear)", () => {
    expect(validateRootRedirect(null)).toEqual({ ok: true, normalized: null });
  });

  test("empty string → normalized null (clear footgun guard)", () => {
    expect(validateRootRedirect("")).toEqual({ ok: true, normalized: null });
  });

  test("safe same-origin path → normalized verbatim", () => {
    expect(validateRootRedirect("/surface/reading-room")).toEqual({
      ok: true,
      normalized: "/surface/reading-room",
    });
  });

  test("rejects off-origin + scheme shapes", () => {
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "javascript:alert(1)",
      "admin",
      "/",
    ]) {
      const r = validateRootRedirect(bad);
      expect(r.ok).toBe(false);
    }
  });

  test("rejects non-string non-null", () => {
    expect(validateRootRedirect(42).ok).toBe(false);
    expect(validateRootRedirect({}).ok).toBe(false);
  });
});

describe("auth gating", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  test("405 on non-GET/PUT", async () => {
    const res = await handleApiSettingsRootRedirect(
      new Request("http://localhost/api/settings/root-redirect", { method: "POST" }),
      deps(h),
    );
    expect(res.status).toBe(405);
  });

  test("401 when Authorization header is missing", async () => {
    const res = await handleApiSettingsRootRedirect(getReq(), deps(h));
    expect(res.status).toBe(401);
  });

  test("401 on empty bearer", async () => {
    const res = await handleApiSettingsRootRedirect(getReq({ authorization: "Bearer " }), deps(h));
    expect(res.status).toBe(401);
  });

  test("403 when the bearer lacks the required scope", async () => {
    const bearer = await mintBearer(h, ["parachute:host:auth"]);
    const resGet = await handleApiSettingsRootRedirect(
      getReq({ authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(resGet.status).toBe(403);
    const resPut = await handleApiSettingsRootRedirect(
      putReq({ root_redirect: "/surface/x" }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(resPut.status).toBe(403);
    // Nothing was written.
    expect(getRootRedirect(h.db)).toBeNull();
  });
});

describe("GET /api/settings/root-redirect", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  test("default shape when unset: /admin from the default layer", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE]);
    const res = await handleApiSettingsRootRedirect(
      getReq({ authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ root_redirect: null, resolved: "/admin", source: "default" });
  });

  test("reflects a stored value with source=db", async () => {
    setRootRedirect(h.db, "/surface/reading-room");
    const bearer = await mintBearer(h, [API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE]);
    const res = await handleApiSettingsRootRedirect(
      getReq({ authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      root_redirect: "/surface/reading-room",
      resolved: "/surface/reading-room",
      source: "db",
    });
  });

  test("surfaces an env-sourced resolved value while the stored row is null", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE]);
    const res = await handleApiSettingsRootRedirect(
      getReq({ authorization: `Bearer ${bearer}` }),
      deps(h, { env: { PARACHUTE_HUB_ROOT_REDIRECT: "/surface/from-env" } }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      root_redirect: null,
      resolved: "/surface/from-env",
      source: "env",
    });
  });
});

describe("PUT /api/settings/root-redirect", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  test("stores a safe path + GET reflects it on the next request (no restart)", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE]);
    const put = await handleApiSettingsRootRedirect(
      putReq({ root_redirect: "/surface/reading-room" }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(put.status).toBe(200);
    expect((await put.json()) as unknown).toEqual({ root_redirect: "/surface/reading-room" });
    expect(getRootRedirect(h.db)).toBe("/surface/reading-room");

    const get = await handleApiSettingsRootRedirect(
      getReq({ authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    const body = (await get.json()) as Record<string, unknown>;
    expect(body.resolved).toBe("/surface/reading-room");
    expect(body.source).toBe("db");
  });

  test("null clears the row", async () => {
    setRootRedirect(h.db, "/surface/x");
    const bearer = await mintBearer(h, [API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE]);
    const res = await handleApiSettingsRootRedirect(
      putReq({ root_redirect: null }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(200);
    expect(getRootRedirect(h.db)).toBeNull();
  });

  test("rejects open-redirect payloads with 400 and writes nothing", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE]);
    for (const bad of [
      "//evil.com",
      "https://evil.com",
      "javascript:alert(1)",
      "/\\evil.com",
      "/",
    ]) {
      const res = await handleApiSettingsRootRedirect(
        putReq({ root_redirect: bad }, { authorization: `Bearer ${bearer}` }),
        deps(h),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_root_redirect");
      expect(getRootRedirect(h.db)).toBeNull();
    }
  });

  test("400 on a body without a root_redirect field", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE]);
    const res = await handleApiSettingsRootRedirect(
      putReq({ wrong: "x" }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(400);
  });

  test("400 on non-JSON body", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE]);
    const res = await handleApiSettingsRootRedirect(
      putReq("not json{", { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(400);
  });
});
