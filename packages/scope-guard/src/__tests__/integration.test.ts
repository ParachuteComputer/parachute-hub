/**
 * End-to-end integration test: mint a JWT through hub's real `signAccessToken`
 * (hits the actual `signing_keys` table, signs with the active key), serve
 * the corresponding `/.well-known/jwks.json` from the same db, then validate
 * through `createScopeGuard`. Asserts:
 *
 *   - valid hub-issued JWT → claims surface, scope check passes
 *   - missing scope → `hasScope` returns false (consumers map this to 403)
 *   - missing token → `extractBearer` returns undefined (→ 401)
 *   - expired token → HubJwtError(code: "expired") (→ 401)
 *
 * The hub imports here intentionally use `.ts` extensions — they live under
 * the parent hub package which uses `allowImportingTsExtensions`. This test
 * file lives under the scope-guard sub-package, but Bun resolves the imports
 * at runtime regardless of tsconfig.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../../../../src/hub-db.ts";
import { pemToJwk } from "../../../../src/jwks.ts";
import { signAccessToken } from "../../../../src/jwt-sign.ts";
import { getAllPublicKeys } from "../../../../src/signing-keys.ts";
import { extractBearer, hasScope } from "../index";
import { HubJwtError, createScopeGuard } from "../validate";

type HubDb = ReturnType<typeof openHubDb>;

interface Harness {
  origin: string;
  db: HubDb;
  cleanup: () => void;
}

function startHarness(): Harness {
  const configDir = mkdtempSync(join(tmpdir(), "scope-guard-it-"));
  const db = openHubDb(hubDbPath(configDir));
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/.well-known/jwks.json") {
        return new Response("not found", { status: 404 });
      }
      const keys = getAllPublicKeys(db).map((k) => pemToJwk(k.publicKeyPem, k.kid));
      return Response.json({ keys });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    db,
    cleanup: () => {
      server.stop(true);
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

let h: Harness;

beforeAll(() => {
  h = startHarness();
});

afterAll(() => {
  h.cleanup();
});

describe("integration: real hub JWT through scope-guard", () => {
  test("valid JWT → claims surface, scope check passes", async () => {
    const { token } = await signAccessToken(h.db, {
      sub: "user-1",
      scopes: ["vault:work:write"],
      audience: "vault.work",
      clientId: "test-client",
      issuer: h.origin,
    });
    const guard = createScopeGuard({ hubOrigin: h.origin });
    const claims = await guard.validateHubJwt(token, { expectedAudience: "vault.work" });
    expect(claims.sub).toBe("user-1");
    expect(claims.scopes).toEqual(["vault:work:write"]);
    expect(claims.aud).toBe("vault.work");
    expect(claims.clientId).toBe("test-client");
    expect(hasScope(claims.scopes, "vault:work:read")).toBe(true);
    expect(hasScope(claims.scopes, "vault:read")).toBe(true);
    guard.resetJwksCache();
  });

  test("missing scope → hasScope returns false (consumer maps to 403)", async () => {
    const { token } = await signAccessToken(h.db, {
      sub: "user-1",
      scopes: ["vault:work:read"],
      audience: "vault.work",
      clientId: "test-client",
      issuer: h.origin,
    });
    const guard = createScopeGuard({ hubOrigin: h.origin });
    const claims = await guard.validateHubJwt(token, { expectedAudience: "vault.work" });
    expect(hasScope(claims.scopes, "vault:work:write")).toBe(false);
    expect(hasScope(claims.scopes, "vault:work:admin")).toBe(false);
    guard.resetJwksCache();
  });

  test("missing Authorization header → extractBearer returns undefined (consumer maps to 401)", () => {
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer(null)).toBeUndefined();
    expect(extractBearer("")).toBeUndefined();
  });

  test("expired token → HubJwtError(code: 'expired')", async () => {
    const { token } = await signAccessToken(h.db, {
      sub: "user-1",
      scopes: ["vault:work:read"],
      audience: "vault.work",
      clientId: "test-client",
      issuer: h.origin,
      ttlSeconds: -10, // already expired
    });
    const guard = createScopeGuard({ hubOrigin: h.origin });
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(token, { expectedAudience: "vault.work" });
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught).toBeInstanceOf(HubJwtError);
    expect(caught?.code).toBe("expired");
    guard.resetJwksCache();
  });

  test("audience mismatch is the resource-server backstop", async () => {
    const { token } = await signAccessToken(h.db, {
      sub: "user-1",
      scopes: ["vault:work:read"],
      audience: "vault.work",
      clientId: "test-client",
      issuer: h.origin,
    });
    const guard = createScopeGuard({ hubOrigin: h.origin });
    let caught: HubJwtError | undefined;
    try {
      // Token stamped for vault.work; resource server is vault.personal.
      await guard.validateHubJwt(token, { expectedAudience: "vault.personal" });
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught?.code).toBe("audience");
    guard.resetJwksCache();
  });
});
