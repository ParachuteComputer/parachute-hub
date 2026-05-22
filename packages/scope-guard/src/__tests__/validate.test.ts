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
  /**
   * Typed seam for the `vault_scope` claim. Two non-array values are
   * load-bearing here:
   *
   *   - `undefined` (the field omitted) → claim emitted as `[]` (default
   *     mint-shape hub uses post-PR-4, including for admins).
   *   - `"OMIT_CLAIM"` → claim NOT emitted at all (pre-PR-4 wire shape;
   *     surfaces at scope-guard as `[]` for back-compat).
   *
   * Explicit `null` IS allowed by the type but the `??` fallback in the
   * helper collapses it to `[]` — same as the default. The on-wire null
   * path (a literal JSON `null` value in the JWT payload) is exercised
   * via `vaultScopeRaw: null` instead, which bypasses the typed seam.
   */
  vaultScope?: string[] | null | "OMIT_CLAIM";
  /**
   * Force a raw value into the `vault_scope` claim, bypassing the typed
   * `vaultScope` seam. Used to exercise the malformed-input paths the
   * validate code normalizes to `[]`: non-array string / number /
   * JSON-null, plus mixed arrays with non-string entries.
   */
  vaultScopeRaw?: unknown;
}

async function signJwt(kp: Keypair, opts: SignOpts): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = opts.expiresAtSeconds ?? iat + (opts.ttlSeconds ?? 60);
  const payload: Record<string, unknown> = {
    scope: opts.scope ?? "vault:read",
    client_id: opts.clientId ?? "test-client",
  };
  if (opts.vaultScopeRaw !== undefined) {
    payload.vault_scope = opts.vaultScopeRaw;
  } else if (opts.vaultScope !== "OMIT_CLAIM") {
    // Default: include `vault_scope: []` (hub's PR-4 behavior — always
    // emit, even for admins). "OMIT_CLAIM" is the test seam for pre-PR-4
    // tokens that lack the claim entirely.
    payload.vault_scope = opts.vaultScope ?? [];
  }
  const builder = new SignJWT(payload)
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

  test("token without jti (strict default) → code: shape, revocation not consulted", async () => {
    // hub#218 hardening: a hub-signed JWT lacking `jti` is rejected by
    // default. The hub token-registry contract (hub#212 Phase 1) stamps
    // jti on every mint; a jti-less hub JWT is an anomaly we refuse to
    // validate. Also pins ordering: jti-presence check runs before the
    // revocation lookup (which depends on jti existing), so a jti-less
    // token costs zero revocation calls.
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
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(tokenNoJti);
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught).toBeInstanceOf(HubJwtError);
    expect(caught?.code).toBe("shape");
    expect(caught?.message).toMatch(/missing required `jti`/);
    expect(revocationCalls).toBe(0);
    guard.resetJwksCache();
    guard.resetRevocationCache();
  });

  test("token with empty-string jti → code: shape (strict default)", async () => {
    // Empty-string jti is treated the same as missing — revocation lookup
    // would be a no-op (no list entry can match the empty string in a way
    // that maps back to a real token) and accepting it would let an
    // attacker bypass the registry contract by emitting `jti: ""` on a
    // forged token.
    const guard = makeGuard();
    const iat = Math.floor(Date.now() / 1000);
    const tokenEmptyJti = await new SignJWT({ scope: "vault:read", client_id: "test-client" })
      .setProtectedHeader({ alg: "RS256", kid: kp.kid })
      .setIssuer(fixture.origin)
      .setSubject("user-1")
      .setAudience("operator")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .setJti("")
      .sign(kp.privateKey);
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(tokenEmptyJti);
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught).toBeInstanceOf(HubJwtError);
    expect(caught?.code).toBe("shape");
    expect(caught?.message).toMatch(/missing required `jti`/);
    guard.resetJwksCache();
  });

  test("allowMissingJti: true → jti-less token accepted, logger fires, revocation skipped", async () => {
    // The opt-out path. Operators with pre-Phase-1 legacy tokens in flight
    // set `allowMissingJti: true` during the transition window; jti-less
    // tokens validate successfully but the missing claim is logged so
    // operators can monitor the legacy-token decay curve before flipping
    // strict-mode back on.
    let revocationCalls = 0;
    const logged: Array<{ sub: string; aud: string | undefined; iat?: number }> = [];
    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      allowMissingJti: true,
      missingJtiLogger: (info) => logged.push(info),
      revocationFetcher: async () => {
        revocationCalls += 1;
        return { generated_at: new Date().toISOString(), jtis: [] };
      },
    });
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
    expect(claims.sub).toBe("user-1");
    expect(revocationCalls).toBe(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.sub).toBe("user-1");
    expect(logged[0]?.aud).toBe("operator");
    expect(logged[0]?.iat).toBe(iat);
    guard.resetJwksCache();
    guard.resetRevocationCache();
  });

  test("allowMissingJti: true + no logger supplied → no throw, no observability", async () => {
    // The logger is optional — operators who opt in without wiring a
    // logger get the back-compat behavior (silent accept). The logger
    // is the observability seam, not a required dependency of the opt-out.
    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      allowMissingJti: true,
    });
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
    guard.resetJwksCache();
  });

  test("allowMissingJti: true does NOT relax revocation enforcement for tokens that DO carry jti", async () => {
    // The opt-out narrows the jti-presence check, not the revocation
    // lookup. A token with jti still goes through revocation; opt-out is
    // a transition aid for legacy tokens, not a general-purpose
    // security-relax.
    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      allowMissingJti: true,
    });
    fixture.setRevokedJtis(["jti-doomed"]);
    const token = await signJwt(kp, { iss: fixture.origin, jti: "jti-doomed" });
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(token);
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught?.code).toBe("revoked");
    guard.resetJwksCache();
    guard.resetRevocationCache();
  });

  test("jti-presence check runs AFTER signature/iss/sub/aud (no info leak on malformed tokens)", async () => {
    // Pin the ordering: a jti-less token whose signature is bad surfaces
    // as `signature`, not `shape`. Without this ordering an attacker
    // probing for forgeable shapes could distinguish "bad signature on a
    // jti-having token" from "bad signature on a jti-less token" — the
    // former is a single failure, the latter could be two stacked
    // failures we'd surface unhelpfully.
    const guard = makeGuard();
    const otherKp = await makeKeypair("k1"); // same kid, different key
    const iat = Math.floor(Date.now() / 1000);
    const tokenBadSigNoJti = await new SignJWT({ scope: "vault:read" })
      .setProtectedHeader({ alg: "RS256", kid: otherKp.kid })
      .setIssuer(fixture.origin)
      .setSubject("user-1")
      .setAudience("operator")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(otherKp.privateKey);
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(tokenBadSigNoJti);
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught?.code).toBe("signature");
    guard.resetJwksCache();
  });
});

describe("createScopeGuard — vault_scope claim surfacing", () => {
  // The vault_scope claim is hub multi-user Phase 1 PR 4's per-user vault
  // pin. The validate-side contract is: surface what's there, normalize
  // every "no pin" shape to `[]`, never throw on malformed input. The
  // defense-in-depth check happens at the consumer via `enforceVaultScope`
  // — these tests pin the claim parsing only.

  test("hub-minted non-admin token (single-element array) → surfaces array", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, {
      iss: fixture.origin,
      vaultScope: ["aaron"],
      scope: "vault:aaron:read vault:aaron:write",
    });
    const claims = await guard.validateHubJwt(token);
    expect(claims.vaultScope).toEqual(["aaron"]);
    guard.resetJwksCache();
  });

  test("hub-minted admin token (explicit []) → surfaces []", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, {
      iss: fixture.origin,
      vaultScope: [],
      scope: "vault:read vault:write",
    });
    const claims = await guard.validateHubJwt(token);
    expect(claims.vaultScope).toEqual([]);
    guard.resetJwksCache();
  });

  test("pre-PR-4 token (claim absent) → surfaces [] (back-compat)", async () => {
    // Tokens minted before PR 4 lack the claim entirely. The validate
    // path treats that as `[]` (unrestricted) — the upstream scope-string
    // check remains the primary gate. Without this back-compat, every
    // operator-token and CLI-mint produced before the PR-4 cut would
    // start 403-ing the moment a consumer wired in `enforceVaultScope`,
    // which is the wrong tradeoff for a defense-in-depth check.
    const guard = makeGuard();
    const token = await signJwt(kp, {
      iss: fixture.origin,
      vaultScope: "OMIT_CLAIM",
      scope: "vault:read",
    });
    const claims = await guard.validateHubJwt(token);
    expect(claims.vaultScope).toEqual([]);
    guard.resetJwksCache();
  });

  test("malformed vault_scope (non-array) → surfaces [] (fail-open)", async () => {
    // A hand-crafted or buggy token with `vault_scope: "aaron"` (string
    // instead of array) is normalized to `[]`. The lib chooses fail-open
    // for malformed input at this layer because (a) it's the value the
    // hub never mints, (b) the scope-string check upstream is the
    // primary gate anyway. Throwing here would translate a typo into a
    // 401 instead of a clean 403 from the scope-string layer.
    //
    // Three shapes: string-on-wire, number-on-wire, JSON-null-on-wire.
    // The `null` case uses `vaultScopeRaw` (not `vaultScope`) because
    // the `signJwt` typed seam routes `null` through `?? []` — that
    // path tests the option-API ergonomics, this path tests the actual
    // JWT-payload-with-null-value the validate code receives.
    const guard = makeGuard();
    const tokenStr = await signJwt(kp, {
      iss: fixture.origin,
      vaultScopeRaw: "aaron",
    });
    const claimsStr = await guard.validateHubJwt(tokenStr);
    expect(claimsStr.vaultScope).toEqual([]);

    const tokenNum = await signJwt(kp, {
      iss: fixture.origin,
      vaultScopeRaw: 42,
    });
    const claimsNum = await guard.validateHubJwt(tokenNum);
    expect(claimsNum.vaultScope).toEqual([]);

    const tokenNull = await signJwt(kp, {
      iss: fixture.origin,
      vaultScopeRaw: null,
    });
    const claimsNull = await guard.validateHubJwt(tokenNull);
    expect(claimsNull.vaultScope).toEqual([]);

    guard.resetJwksCache();
  });

  test("array with non-string entries → those entries are filtered out", async () => {
    // Mixed array: keep the strings, drop the rest. Defends against a
    // buggy upstream that emits `["aaron", null]` from a partial lookup.
    const guard = makeGuard();
    const token = await signJwt(kp, {
      iss: fixture.origin,
      vaultScopeRaw: ["aaron", null, 42, "work"],
    });
    const claims = await guard.validateHubJwt(token);
    expect(claims.vaultScope).toEqual(["aaron", "work"]);
    guard.resetJwksCache();
  });

  test("multi-vault Phase 2-shape pin → surfaces full array", async () => {
    // Forward-compat: when Phase 2 lets a user belong to multiple vaults,
    // the wire shape is the same `string[]`. The validate layer doesn't
    // care about length — it surfaces what's there, the consumer's
    // `enforceVaultScope` does the membership check.
    const guard = makeGuard();
    const token = await signJwt(kp, {
      iss: fixture.origin,
      vaultScope: ["aaron", "work", "personal"],
    });
    const claims = await guard.validateHubJwt(token);
    expect(claims.vaultScope).toEqual(["aaron", "work", "personal"]);
    guard.resetJwksCache();
  });
});
