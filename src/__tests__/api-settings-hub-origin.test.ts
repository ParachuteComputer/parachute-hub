/**
 * Tests for `/api/settings/hub-origin` (hub#298).
 *
 * Covers:
 *   - GET response shape (hub_origin + resolved_issuer + source)
 *   - PUT validation (URL shape, scheme, hostname, trailing slash,
 *     path/query/fragment rejection)
 *   - PUT clear (null) reverts to env/request precedence
 *   - Auth gating: 401 missing/empty bearer, 403 wrong scope
 *   - "Change takes effect on the next request" — the GET issuer
 *     reflects the value just written, without restarting.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE,
  handleApiSettingsHubOrigin,
  validateHubOrigin,
} from "../api-settings-hub-origin.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { resolveIssuer, resolveIssuerSource } from "../hub-server.ts";
import { getHubOrigin, setHubOrigin } from "../hub-settings.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "phub-api-settings-hub-origin-"));
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
  return new Request("http://localhost/api/settings/hub-origin", { method: "GET", headers });
}

function putReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/settings/hub-origin", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function deps(
  h: Harness,
  overrides: Partial<Parameters<typeof handleApiSettingsHubOrigin>[1]> = {},
) {
  return {
    db: h.db,
    issuer: ISSUER,
    resolvedIssuer: resolveIssuer(getReq(), h.db, undefined),
    resolvedSource: resolveIssuerSource(h.db, undefined),
    ...overrides,
  };
}

describe("validateHubOrigin — pure validator", () => {
  test("null → normalized null (clear)", () => {
    expect(validateHubOrigin(null)).toEqual({ ok: true, normalized: null });
  });

  test("empty string → normalized null (footgun guard)", () => {
    expect(validateHubOrigin("")).toEqual({ ok: true, normalized: null });
  });

  test("valid https URL → normalized verbatim", () => {
    const result = validateHubOrigin("https://hub.example.com");
    expect(result).toEqual({ ok: true, normalized: "https://hub.example.com" });
  });

  test("valid http URL (loopback dev shape) → normalized verbatim", () => {
    const result = validateHubOrigin("http://127.0.0.1:1939");
    expect(result).toEqual({ ok: true, normalized: "http://127.0.0.1:1939" });
  });

  test("rejects trailing slash", () => {
    const result = validateHubOrigin("https://hub.example.com/");
    expect(result.ok).toBe(false);
  });

  test("rejects ftp scheme", () => {
    const result = validateHubOrigin("ftp://hub.example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.description).toMatch(/scheme/);
  });

  test("rejects file: scheme", () => {
    const result = validateHubOrigin("file:///etc/passwd");
    expect(result.ok).toBe(false);
  });

  test("rejects malformed URL", () => {
    const result = validateHubOrigin("not-a-url");
    expect(result.ok).toBe(false);
  });

  test("rejects URL with path component", () => {
    const result = validateHubOrigin("https://hub.example.com/path");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.description).toMatch(/path/);
  });

  test("rejects URL with query", () => {
    const result = validateHubOrigin("https://hub.example.com?q=1");
    expect(result.ok).toBe(false);
  });

  test("rejects URL with fragment", () => {
    const result = validateHubOrigin("https://hub.example.com#frag");
    expect(result.ok).toBe(false);
  });

  test("rejects URL with embedded user:pass credentials", () => {
    // The normalization step re-stringifies as `protocol + "//" + host`,
    // which silently strips a user:pass component — an operator who
    // typos credentials in would have them invisibly dropped. Reject
    // hard so the footgun surfaces.
    const result = validateHubOrigin("https://user:pass@host.example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.description).toMatch(/credentials/);
  });

  test("rejects URL with embedded username only", () => {
    const result = validateHubOrigin("https://user@host.example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.description).toMatch(/credentials/);
  });

  test("rejects non-string non-null types", () => {
    expect(validateHubOrigin(42).ok).toBe(false);
    expect(validateHubOrigin(true).ok).toBe(false);
    expect(validateHubOrigin({}).ok).toBe(false);
    expect(validateHubOrigin(undefined).ok).toBe(false);
  });
});

describe("auth gating", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  test("405 on non-GET/PUT methods", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(
      new Request("http://localhost/api/settings/hub-origin", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
      }),
      deps(h),
    );
    expect(res.status).toBe(405);
  });

  test("401 on missing bearer (GET)", async () => {
    const res = await handleApiSettingsHubOrigin(getReq(), deps(h));
    expect(res.status).toBe(401);
  });

  test("401 on missing bearer (PUT)", async () => {
    const res = await handleApiSettingsHubOrigin(
      putReq({ hub_origin: "https://hub.example.com" }),
      deps(h),
    );
    expect(res.status).toBe(401);
  });

  test("401 on empty bearer value", async () => {
    const res = await handleApiSettingsHubOrigin(getReq({ authorization: "Bearer " }), deps(h));
    expect(res.status).toBe(401);
  });

  test("403 on bearer without parachute:host:admin", async () => {
    // host:auth reads catalogs but must NOT flip the canonical hub URL.
    const bearer = await mintBearer(h, ["parachute:host:auth"]);
    const resGet = await handleApiSettingsHubOrigin(
      getReq({ authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(resGet.status).toBe(403);
    const resPut = await handleApiSettingsHubOrigin(
      putReq({ hub_origin: "https://hub.example.com" }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(resPut.status).toBe(403);
  });
});

describe("GET /api/settings/hub-origin", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  test("returns null + request source when nothing is configured", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(
      getReq({ authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hub_origin: string | null;
      resolved_issuer: string;
      source: string;
    };
    expect(body.hub_origin).toBeNull();
    expect(body.source).toBe("request");
    expect(body.resolved_issuer).toBe("http://localhost"); // request origin from getReq()
  });

  test("returns env source + env-resolved issuer when configuredIssuer is set", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      resolvedIssuer: "https://hub.from-env.example",
      resolvedSource: "env",
    });
    const body = (await res.json()) as {
      hub_origin: string | null;
      resolved_issuer: string;
      source: string;
    };
    expect(body.hub_origin).toBeNull();
    expect(body.resolved_issuer).toBe("https://hub.from-env.example");
    expect(body.source).toBe("env");
  });

  test("returns settings source when hub_origin row is set", async () => {
    setHubOrigin(h.db, "https://hub.example.com");
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      resolvedIssuer: "https://hub.example.com",
      resolvedSource: "settings",
    });
    const body = (await res.json()) as {
      hub_origin: string | null;
      resolved_issuer: string;
      source: string;
    };
    expect(body.hub_origin).toBe("https://hub.example.com");
    expect(body.resolved_issuer).toBe("https://hub.example.com");
    expect(body.source).toBe("settings");
  });
});

describe("PUT /api/settings/hub-origin", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  test("400 on non-JSON body", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(
      new Request("http://localhost/api/settings/hub-origin", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: "not json",
      }),
      deps(h),
    );
    expect(res.status).toBe(400);
  });

  test("400 on missing hub_origin field", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(
      putReq({}, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("400 on invalid URL", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(
      putReq({ hub_origin: "not-a-url" }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_hub_origin");
  });

  test("400 on trailing slash", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(
      putReq({ hub_origin: "https://hub.example.com/" }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(400);
  });

  test("400 on ftp: scheme", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(
      putReq({ hub_origin: "ftp://hub.example.com" }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(400);
  });

  test("200 + writes the new value to hub_settings (https)", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(
      putReq({ hub_origin: "https://hub.example.com" }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hub_origin: string | null };
    expect(body.hub_origin).toBe("https://hub.example.com");
    expect(getHubOrigin(h.db)).toBe("https://hub.example.com");
  });

  test("200 + accepts http loopback URL (dev shape)", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(
      putReq({ hub_origin: "http://127.0.0.1:1939" }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(200);
    expect(getHubOrigin(h.db)).toBe("http://127.0.0.1:1939");
  });

  test("200 + clears the value on null", async () => {
    setHubOrigin(h.db, "https://hub.example.com");
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(
      putReq({ hub_origin: null }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hub_origin: string | null };
    expect(body.hub_origin).toBeNull();
    expect(getHubOrigin(h.db)).toBeNull();
  });

  test("200 + clears the value on empty string", async () => {
    setHubOrigin(h.db, "https://hub.example.com");
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);
    const res = await handleApiSettingsHubOrigin(
      putReq({ hub_origin: "" }, { authorization: `Bearer ${bearer}` }),
      deps(h),
    );
    expect(res.status).toBe(200);
    expect(getHubOrigin(h.db)).toBeNull();
  });
});

describe("change takes effect on the next request (no restart needed)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  test("GET → PUT → GET reflects the just-written value", async () => {
    const bearer = await mintBearer(h, [API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE]);

    // Initial GET — nothing configured. The GET handler reads
    // resolved_issuer from `deps`, so we re-walk the precedence chain
    // on each request the way the dispatcher does in production.
    const g1 = await handleApiSettingsHubOrigin(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      resolvedIssuer: resolveIssuer(getReq(), h.db, undefined),
      resolvedSource: resolveIssuerSource(h.db, undefined),
    });
    const b1 = (await g1.json()) as { source: string; resolved_issuer: string };
    expect(b1.source).toBe("request");

    // Write through.
    const p = await handleApiSettingsHubOrigin(
      putReq({ hub_origin: "https://hub.example.com" }, { authorization: `Bearer ${bearer}` }),
      {
        db: h.db,
        issuer: ISSUER,
        resolvedIssuer: resolveIssuer(putReq({}), h.db, undefined),
        resolvedSource: resolveIssuerSource(h.db, undefined),
      },
    );
    expect(p.status).toBe(200);

    // Second GET — same dispatcher contract — sees the new value
    // immediately. This is the core "no restart needed" claim.
    const g2 = await handleApiSettingsHubOrigin(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      resolvedIssuer: resolveIssuer(getReq(), h.db, undefined),
      resolvedSource: resolveIssuerSource(h.db, undefined),
    });
    const b2 = (await g2.json()) as {
      hub_origin: string | null;
      source: string;
      resolved_issuer: string;
    };
    expect(b2.hub_origin).toBe("https://hub.example.com");
    expect(b2.source).toBe("settings");
    expect(b2.resolved_issuer).toBe("https://hub.example.com");
  });
});
