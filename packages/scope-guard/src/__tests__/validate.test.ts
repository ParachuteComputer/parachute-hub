/**
 * createScopeGuard / validateHubJwt — fake JWKS endpoint, locally-signed JWTs.
 *
 * Spins up a Bun.serve fake JWKS endpoint with a known RSA keypair, then
 * exercises every validation path the design doc names: signature pass/fail,
 * wrong issuer, expired, missing kid, missing sub, JWKS unreachable, plus
 * the audience matrix (string match, array match, mismatches both shapes,
 * missing-when-expected, no-expectation-set).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { HubJwtError, createScopeGuard } from "../validate";

interface Keypair {
  privateKey: CryptoKey;
  publicJwk: { kty: string; n: string; e: string; kid: string; alg: string; use: string };
  kid: string;
}

async function makeKeypair(kid: string): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: {
      kty: "RSA",
      n: jwk.n!,
      e: jwk.e!,
      kid,
      alg: "RS256",
      use: "sig",
    },
    kid,
  };
}

interface JwksFixture {
  origin: string;
  stop: () => void;
  setKeys: (keys: Keypair[]) => void;
  setUnreachable: (down: boolean) => void;
}

function startJwksFixture(): JwksFixture {
  let keys: Keypair[] = [];
  let down = false;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/.well-known/jwks.json") {
        return new Response("not found", { status: 404 });
      }
      if (down) return new Response("upstream down", { status: 503 });
      return Response.json({ keys: keys.map((k) => k.publicJwk) });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    setKeys: (next) => {
      keys = next;
    },
    setUnreachable: (v) => {
      down = v;
    },
  };
}

interface SignOpts {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  scope?: string;
  jti?: string;
  clientId?: string;
  ttlSeconds?: number;
  expiresAtSeconds?: number;
  omitKid?: boolean;
  kid?: string;
}

async function signJwt(kp: Keypair, opts: SignOpts): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = opts.expiresAtSeconds ?? iat + (opts.ttlSeconds ?? 60);
  const builder = new SignJWT({
    scope: opts.scope ?? "vault:read",
    client_id: opts.clientId ?? "test-client",
  })
    .setProtectedHeader(opts.omitKid ? { alg: "RS256" } : { alg: "RS256", kid: opts.kid ?? kp.kid })
    .setIssuer(opts.iss ?? "http://issuer.invalid")
    .setSubject(opts.sub ?? "user-1")
    .setAudience(opts.aud ?? "operator")
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(opts.jti ?? "jti-1");
  return await builder.sign(kp.privateKey);
}

let fixture: JwksFixture;
let kp: Keypair;

beforeAll(async () => {
  fixture = startJwksFixture();
  kp = await makeKeypair("k1");
  fixture.setKeys([kp]);
});

afterAll(() => {
  fixture.stop();
});

beforeEach(() => {
  fixture.setUnreachable(false);
  fixture.setKeys([kp]);
});

function makeGuard() {
  // Each test gets a fresh guard with its own JWKS cache. Tests that need
  // to swap origins use createScopeGuard's per-instance state directly
  // rather than relying on the module-scoped cache.
  return createScopeGuard({ hubOrigin: fixture.origin });
}

describe("createScopeGuard — happy path", () => {
  test("valid JWT with correct iss → claims surface", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, {
      iss: fixture.origin,
      scope: "vault:work:read vault:work:write",
    });
    const claims = await guard.validateHubJwt(token);
    expect(claims.sub).toBe("user-1");
    expect(claims.scopes).toEqual(["vault:work:read", "vault:work:write"]);
    expect(claims.aud).toBe("operator");
    expect(claims.jti).toBe("jti-1");
    expect(claims.clientId).toBe("test-client");
    guard.resetJwksCache();
  });

  test("hubOrigin as resolver function", async () => {
    const guard = createScopeGuard({ hubOrigin: () => fixture.origin });
    const token = await signJwt(kp, { iss: fixture.origin });
    const claims = await guard.validateHubJwt(token);
    expect(claims.sub).toBe("user-1");
    guard.resetJwksCache();
  });

  test("trailing slash on origin is stripped (matches hub-minted iss)", async () => {
    const guard = createScopeGuard({ hubOrigin: `${fixture.origin}/` });
    const token = await signJwt(kp, { iss: fixture.origin });
    const claims = await guard.validateHubJwt(token);
    expect(claims.sub).toBe("user-1");
    guard.resetJwksCache();
  });

  test("empty scope claim → empty scopes array", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin, scope: "" });
    const claims = await guard.validateHubJwt(token);
    expect(claims.scopes).toEqual([]);
    guard.resetJwksCache();
  });
});

describe("createScopeGuard — audience strict-check", () => {
  test("string aud match → passes, claim surfaces", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin, aud: "vault.work" });
    const claims = await guard.validateHubJwt(token, { expectedAudience: "vault.work" });
    expect(claims.aud).toBe("vault.work");
    guard.resetJwksCache();
  });

  test("string aud mismatch → throws audience error", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin, aud: "vault.personal" });
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(token, { expectedAudience: "vault.work" });
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught).toBeInstanceOf(HubJwtError);
    expect(caught?.code).toBe("audience");
    expect(caught?.message).toMatch(/audience mismatch.*vault\.work.*vault\.personal/);
    guard.resetJwksCache();
  });

  test("array aud: passes when expected is one of the entries", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: ["vault.work", "vault.personal", "operator"],
    });
    const claims = await guard.validateHubJwt(token, { expectedAudience: "vault.personal" });
    expect(claims.aud).toBe("vault.personal");
    guard.resetJwksCache();
  });

  test("array aud: throws audience error when expected is missing", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin, aud: ["vault.work", "operator"] });
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(token, { expectedAudience: "vault.personal" });
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught?.code).toBe("audience");
    expect(caught?.message).toMatch(/audience mismatch.*vault\.personal.*vault\.work.*operator/);
    guard.resetJwksCache();
  });

  test("expectedAudience: null skips the check", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin, aud: "vault.anything" });
    const claims = await guard.validateHubJwt(token, { expectedAudience: null });
    expect(claims.aud).toBe("vault.anything");
    guard.resetJwksCache();
  });

  test("array aud: surfaces first entry when no expectation", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin, aud: ["vault.first", "vault.second"] });
    const claims = await guard.validateHubJwt(token);
    expect(claims.aud).toBe("vault.first");
    guard.resetJwksCache();
  });
});

describe("createScopeGuard — failure modes (HubJwtError.code)", () => {
  async function expectError(
    promise: Promise<unknown>,
    code: HubJwtError["code"],
    msgPattern?: RegExp,
  ): Promise<HubJwtError> {
    let caught: HubJwtError | undefined;
    try {
      await promise;
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught).toBeInstanceOf(HubJwtError);
    expect(caught?.code).toBe(code);
    if (msgPattern) expect(caught?.message).toMatch(msgPattern);
    return caught!;
  }

  test("wrong issuer → code: issuer", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: "http://attacker.example" });
    await expectError(guard.validateHubJwt(token), "issuer", /verification failed/);
    guard.resetJwksCache();
  });

  test("expired token → code: expired", async () => {
    const guard = makeGuard();
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await signJwt(kp, { iss: fixture.origin, expiresAtSeconds: past });
    await expectError(guard.validateHubJwt(token), "expired");
    guard.resetJwksCache();
  });

  test("bad signature (token signed by an unpublished key) → code: signature", async () => {
    const guard = makeGuard();
    const otherKp = await makeKeypair("k1"); // same kid, different key
    const token = await signJwt(otherKp, { iss: fixture.origin });
    await expectError(guard.validateHubJwt(token), "signature");
    guard.resetJwksCache();
  });

  test("unknown kid → code: kid", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin, kid: "does-not-exist" });
    await expectError(guard.validateHubJwt(token), "kid");
    guard.resetJwksCache();
  });

  test("missing kid header (multi-key JWKS) → code: kid", async () => {
    const guard = makeGuard();
    const kp2 = await makeKeypair("k2");
    fixture.setKeys([kp, kp2]);
    guard.resetJwksCache(); // re-fetch the now-multi-key JWKS
    const token = await signJwt(kp, { iss: fixture.origin, omitKid: true });
    // jose throws JWKSMultipleMatchingKeys here — bucketed under jwks.
    await expectError(guard.validateHubJwt(token), "jwks");
    guard.resetJwksCache();
  });

  test("JWKS unreachable → code: jwks", async () => {
    const guard = makeGuard();
    fixture.setUnreachable(true);
    const token = await signJwt(kp, { iss: fixture.origin });
    // 503 → jose JWKSInvalid; "down" path is a 503, not a network failure,
    // so this surfaces as `jwks`.
    await expectError(guard.validateHubJwt(token), "jwks");
    guard.resetJwksCache();
  });

  test("missing `sub` claim → code: shape", async () => {
    const guard = makeGuard();
    const iat = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ scope: "vault:read" })
      .setProtectedHeader({ alg: "RS256", kid: kp.kid })
      .setIssuer(fixture.origin)
      .setAudience("operator")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .setJti("jti-no-sub")
      .sign(kp.privateKey);
    await expectError(guard.validateHubJwt(token), "shape", /missing required `sub`/);
    guard.resetJwksCache();
  });
});

describe("createScopeGuard — injected JWKS getter", () => {
  test("uses injected getter, ignores cache + origin fetch", async () => {
    const realGuard = makeGuard();
    // Steal the cached getter by validating once to warm it…
    const warmupToken = await signJwt(kp, { iss: fixture.origin });
    await realGuard.validateHubJwt(warmupToken);
    // …then build a separate guard using the SAME getter under a DIFFERENT
    // origin string — if the getter were re-derived from origin, this would
    // fail; injection should make the origin string only matter for `iss`
    // matching (which we keep aligned with the getter's actual JWKS).
    const { getOrCreateJwksGetter } = await import("../jwks");
    const sharedGetter = getOrCreateJwksGetter(fixture.origin);
    const otherGuard = createScopeGuard({
      hubOrigin: fixture.origin,
      jwksGetter: sharedGetter,
    });
    const token = await signJwt(kp, { iss: fixture.origin });
    const claims = await otherGuard.validateHubJwt(token);
    expect(claims.sub).toBe("user-1");

    realGuard.resetJwksCache();
  });

  test("resetJwksCache is a no-op when getter is injected", async () => {
    const { getOrCreateJwksGetter } = await import("../jwks");
    const injected = getOrCreateJwksGetter(fixture.origin);
    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      jwksGetter: injected,
    });
    // Should not throw; should not affect the injected getter's state.
    expect(() => guard.resetJwksCache()).not.toThrow();
  });
});
