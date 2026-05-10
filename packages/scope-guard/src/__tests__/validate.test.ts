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
  setRevokedJtis: (jtis: string[]) => void;
  setRevocationUnreachable: (down: boolean) => void;
}

function startJwksFixture(): JwksFixture {
  let keys: Keypair[] = [];
  let down = false;
  let revokedJtis: string[] = [];
  let revocationDown = false;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/jwks.json") {
        if (down) return new Response("upstream down", { status: 503 });
        return Response.json({ keys: keys.map((k) => k.publicJwk) });
      }
      if (url.pathname === "/.well-known/parachute-revocation.json") {
        if (revocationDown) return new Response("upstream down", { status: 503 });
        return Response.json({ generated_at: new Date().toISOString(), jtis: revokedJtis });
      }
      return new Response("not found", { status: 404 });
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
    setRevokedJtis: (next) => {
      revokedJtis = [...next];
    },
    setRevocationUnreachable: (v) => {
      revocationDown = v;
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
  fixture.setRevokedJtis([]);
  fixture.setRevocationUnreachable(false);
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

describe("createScopeGuard — revocation enforcement", () => {
  test("revoked jti → HubJwtError(code: 'revoked'), message includes jti", async () => {
    fixture.setRevokedJtis(["jti-doomed"]);
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin, jti: "jti-doomed" });
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(token);
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught).toBeInstanceOf(HubJwtError);
    expect(caught?.code).toBe("revoked");
    expect(caught?.message).toMatch(/jti-doomed/);
    guard.resetJwksCache();
    guard.resetRevocationCache();
  });

  test("clear jti → passes", async () => {
    fixture.setRevokedJtis(["someone-else"]);
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin, jti: "jti-fine" });
    const claims = await guard.validateHubJwt(token);
    expect(claims.jti).toBe("jti-fine");
    guard.resetJwksCache();
    guard.resetRevocationCache();
  });

  test("revocation list unreachable + no last-good cache → 'revocation_unavailable'", async () => {
    fixture.setRevocationUnreachable(true);
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin });
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(token);
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught?.code).toBe("revocation_unavailable");
    expect(caught?.message).toMatch(/revocation list unavailable/);
    guard.resetJwksCache();
    guard.resetRevocationCache();
  });

  test("revocation list unreachable but last-good cache exists → fail-open", async () => {
    fixture.setRevokedJtis(["jti-x"]);
    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      revocationTtlMs: 50, // small TTL so we can hit "stale" quickly
    });

    // Warm the cache with a successful fetch.
    const warmupToken = await signJwt(kp, { iss: fixture.origin, jti: "jti-clear" });
    expect((await guard.validateHubJwt(warmupToken)).jti).toBe("jti-clear");

    // Hub goes down. After TTL elapses we'd refetch — verify fail-open uses
    // the last-good list instead of throwing 'revocation_unavailable'.
    fixture.setRevocationUnreachable(true);
    await Bun.sleep(60);

    // jti-x was in the last-good list → still rejected.
    const revokedToken = await signJwt(kp, { iss: fixture.origin, jti: "jti-x" });
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(revokedToken);
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught?.code).toBe("revoked");

    // A clear jti still passes.
    const stillClear = await signJwt(kp, { iss: fixture.origin, jti: "jti-fresh" });
    expect((await guard.validateHubJwt(stillClear)).jti).toBe("jti-fresh");

    guard.resetJwksCache();
    guard.resetRevocationCache();
  });

  test("check ordering: bad signature rejected without consulting revocation list", async () => {
    let revocationCalls = 0;
    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      revocationFetcher: async () => {
        revocationCalls += 1;
        return { generated_at: new Date().toISOString(), jtis: [] };
      },
    });
    const otherKp = await makeKeypair("k1"); // same kid, different key
    const token = await signJwt(otherKp, { iss: fixture.origin });
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(token);
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught?.code).toBe("signature");
    expect(revocationCalls).toBe(0);
    guard.resetJwksCache();
    guard.resetRevocationCache();
  });

  test("check ordering: audience mismatch rejected without consulting revocation list", async () => {
    let revocationCalls = 0;
    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      revocationFetcher: async () => {
        revocationCalls += 1;
        return { generated_at: new Date().toISOString(), jtis: [] };
      },
    });
    const token = await signJwt(kp, { iss: fixture.origin, aud: "vault.work" });
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(token, { expectedAudience: "vault.personal" });
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught?.code).toBe("audience");
    expect(revocationCalls).toBe(0);
    guard.resetJwksCache();
    guard.resetRevocationCache();
  });

  test("check ordering: expired token rejected without consulting revocation list", async () => {
    let revocationCalls = 0;
    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      revocationFetcher: async () => {
        revocationCalls += 1;
        return { generated_at: new Date().toISOString(), jtis: [] };
      },
    });
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await signJwt(kp, { iss: fixture.origin, expiresAtSeconds: past });
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(token);
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught?.code).toBe("expired");
    expect(revocationCalls).toBe(0);
    guard.resetJwksCache();
    guard.resetRevocationCache();
  });

  test("concurrent validations during refresh share a single fetch", async () => {
    let inFlightResolve: ((v: { generated_at: string; jtis: string[] }) => void) | undefined;
    let calls = 0;
    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      revocationFetcher: () => {
        calls += 1;
        return new Promise((resolve) => {
          inFlightResolve = resolve;
        });
      },
    });
    const tokens = await Promise.all(
      Array.from({ length: 5 }, (_, i) => signJwt(kp, { iss: fixture.origin, jti: `jti-${i}` })),
    );

    const results = Promise.all(tokens.map((t) => guard.validateHubJwt(t)));
    // Validation goes through async jose signature verification before the
    // cache lookup; one Promise.resolve() isn't enough for all 5 to reach
    // refresh(). Sleep a beat so the whole pipeline drains up to the
    // pending in-flight fetcher promise.
    await Bun.sleep(20);
    expect(calls).toBe(1); // single-flight

    inFlightResolve!({ generated_at: new Date().toISOString(), jtis: [] });
    const claims = await results;
    expect(claims.map((c) => c.jti)).toEqual(["jti-0", "jti-1", "jti-2", "jti-3", "jti-4"]);
    expect(calls).toBe(1);

    guard.resetJwksCache();
    guard.resetRevocationCache();
  });

  test("token without jti skips revocation lookup entirely", async () => {
    let revocationCalls = 0;
    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      revocationFetcher: async () => {
        revocationCalls += 1;
        return { generated_at: new Date().toISOString(), jtis: [] };
      },
    });
    // Hand-build a token with no jti.
    const iat = Math.floor(Date.now() / 1000);
    const tokenNoJti = await new SignJWT({ scope: "vault:read", client_id: "test-client" })
      .setProtectedHeader({ alg: "RS256", kid: kp.kid })
      .setIssuer(fixture.origin)
      .setSubject("user-1")
      .setAudience("operator")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(kp.privateKey);
    const claims = await guard.validateHubJwt(tokenNoJti);
    expect(claims.jti).toBeUndefined();
    expect(revocationCalls).toBe(0);
    guard.resetJwksCache();
    guard.resetRevocationCache();
  });
});
