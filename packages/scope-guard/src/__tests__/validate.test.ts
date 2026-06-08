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
  /** Count of `/.well-known/jwks.json` GETs served — observes forced reloads. */
  jwksFetchCount: () => number;
  /** Reset the JWKS fetch counter to zero (call before a case's assertions). */
  resetJwksFetchCount: () => void;
}

function startJwksFixture(): JwksFixture {
  let keys: Keypair[] = [];
  let down = false;
  let revokedJtis: string[] = [];
  let revocationDown = false;
  let jwksFetches = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/jwks.json") {
        jwksFetches += 1;
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
    jwksFetchCount: () => jwksFetches,
    resetJwksFetchCount: () => {
      jwksFetches = 0;
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
  /**
   * Force a raw value into the `permissions` claim. Used to exercise the
   * passthrough (a plain object surfaces verbatim) and the malformed-input
   * paths the validate code leaves `undefined` (string / number / array /
   * null). Omit to emit no `permissions` claim at all.
   */
  permissionsRaw?: unknown;
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
  if (opts.permissionsRaw !== undefined) {
    payload.permissions = opts.permissionsRaw;
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

/** Assert a promise rejects with a HubJwtError of `code` (module-scoped so
 * the rotation-retry describe block can reuse it). */
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
  // `expectError` is module-scoped (defined near the top helpers) so the
  // rotation-retry block can share it.

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
    // Genuinely-invalid token: signed by a key never in the JWKS. Under the
    // rotation-retry hardening this now force-reloads the JWKS once and
    // retries — but the fixture still serves only the published key, so the
    // retry fails the same way and we surface `signature`. The dedicated
    // throttle + recovery tests below pin the reload behavior; this case
    // pins that an unrecoverable token still fails (no infinite loop, code
    // unchanged) after the single retry.
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

describe("createScopeGuard — JWKS force-reload-and-retry on rotation (hub#543)", () => {
  // The gap these tests pin: jose's `createRemoteJWKSet` only self-heals an
  // *unknown kid* (reactive reload inside the getter, rate-limited by
  // `cooldownDuration`). It does NOT recover a *same-kid* rotation (key bytes
  // change under an unchanged kid → JWSSignatureVerificationFailed, thrown
  // OUTSIDE the getter), a no-kid token against a multi-key set
  // (JWKSMultipleMatchingKeys), or staleness inside `cacheMaxAge`. Those would
  // produce hard 401s until cacheMaxAge expiry or a restart. validateHubJwt
  // now force-reloads the JWKS and retries once on a rotation-class failure
  // (signature/kid/jwks), throttled so a flood of bad tokens can't storm the
  // hub. Observability seam: the fixture counts `/.well-known/jwks.json` GETs.

  test("same-kid rotation recovers: reload fires, retry succeeds", async () => {
    // The terminal-today case. Fixture serves key A under kid K; we then sign
    // a token with key B under the SAME kid K and flip the fixture to B. The
    // first verify fails `signature` (cached key A can't verify a B-signed
    // token) → forced reload picks up B → retry succeeds.
    const keyA = await makeKeypair("rotk");
    const keyB = await makeKeypair("rotk"); // same kid, different bytes
    fixture.setKeys([keyA]);

    const guard = makeGuard();
    guard.resetJwksCache(); // cold getter
    // Warm the getter on key A so the stale-cache scenario is real (the
    // signature failure must come from a *cached* key, not a cold fetch that
    // would already see B).
    const warmToken = await signJwt(keyA, { iss: fixture.origin, jti: "warm" });
    expect((await guard.validateHubJwt(warmToken)).jti).toBe("warm");

    // Rotate: same kid, key B is now authoritative on the wire.
    fixture.setKeys([keyB]);
    fixture.resetJwksFetchCount();

    const rotatedToken = await signJwt(keyB, { iss: fixture.origin, jti: "rotated" });
    const claims = await guard.validateHubJwt(rotatedToken);
    expect(claims.jti).toBe("rotated");
    // Exactly one forced reload fetched the new key set.
    expect(fixture.jwksFetchCount()).toBe(1);

    fixture.setKeys([kp]);
    guard.resetJwksCache();
  });

  test("new-kid path still works (jose's own reload — no regression)", async () => {
    // jose reactively reloads on an unknown kid all on its own. Adding our
    // retry layer must not break that path. Fixture has only key A (kid kA);
    // sign with key B under a NEW kid kB and publish B. jose's getter sees an
    // unknown kid, reloads internally, finds kB, verifies.
    const keyA = await makeKeypair("kA");
    const keyB = await makeKeypair("kB");
    fixture.setKeys([keyA]);

    const guard = makeGuard();
    guard.resetJwksCache();
    const warmToken = await signJwt(keyA, { iss: fixture.origin, jti: "warmkid" });
    expect((await guard.validateHubJwt(warmToken)).jti).toBe("warmkid");

    fixture.setKeys([keyA, keyB]); // 24h-overlap shape: both keys live
    const newKidToken = await signJwt(keyB, { iss: fixture.origin, jti: "newkid" });
    const claims = await guard.validateHubJwt(newKidToken);
    expect(claims.jti).toBe("newkid");

    fixture.setKeys([kp]);
    guard.resetJwksCache();
  });

  test("throttle: two bad-signature tokens in quick succession → exactly ONE reload", async () => {
    // The refetch-storm guard. Two genuinely-bad tokens arrive back-to-back
    // within the throttle window; only the first is allowed to force a reload.
    // An injected clock holds time fixed inside the window.
    //
    // Crucially these are SAME-KID signature failures (wrong key bytes under
    // the published kid), NOT unknown-kid: jose only reactively reloads on an
    // unknown kid, so with same-kid every `/.well-known/jwks.json` fetch in
    // the count is unambiguously OUR forced reload — no jose-cooldown
    // confound.
    let clock = 1_000_000;
    const evil = await makeKeypair("k1"); // same published kid, wrong bytes
    fixture.setKeys([kp]); // only the good key is on the wire

    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      jwksReloadMinIntervalMs: 10_000,
      jwksReloadNow: () => clock,
    });
    guard.resetJwksCache();
    // Warm the getter so the bad tokens hit a populated cache and the
    // signature failure is genuinely "cached key can't verify," not a cold
    // fetch.
    const warm = await signJwt(kp, { iss: fixture.origin, jti: "warm-throttle" });
    expect((await guard.validateHubJwt(warm)).jti).toBe("warm-throttle");
    fixture.resetJwksFetchCount();

    const bad1 = await signJwt(evil, { iss: fixture.origin, jti: "b1" });
    const bad2 = await signJwt(evil, { iss: fixture.origin, jti: "b2" });

    // First bad token: signature fails → forced reload (1 fetch).
    await expectError(guard.validateHubJwt(bad1), "signature");
    expect(fixture.jwksFetchCount()).toBe(1);
    // Second bad token, same window: throttle skips the forced reload → still 1.
    await expectError(guard.validateHubJwt(bad2), "signature");
    expect(fixture.jwksFetchCount()).toBe(1);

    // After the window elapses, a forced reload is allowed again (→ 2 total).
    clock += 10_001;
    await expectError(guard.validateHubJwt(bad1), "signature");
    expect(fixture.jwksFetchCount()).toBe(2);

    fixture.setKeys([kp]);
    guard.resetJwksCache();
  });

  test("genuinely-invalid token still fails after the one retry (no infinite loop)", async () => {
    // A token signed by a key that's never in the JWKS: reload fetches the
    // (unchanged) key set, retry fails the same way, classify unchanged. One
    // retry only — no loop.
    const evil = await makeKeypair("k1"); // same published kid, wrong bytes
    fixture.setKeys([kp]);
    const guard = makeGuard();
    guard.resetJwksCache();
    const warm = await signJwt(kp, { iss: fixture.origin, jti: "warm-evil" });
    await guard.validateHubJwt(warm);
    fixture.resetJwksFetchCount();

    const token = await signJwt(evil, { iss: fixture.origin, jti: "evil" });
    let caught: HubJwtError | undefined;
    try {
      await guard.validateHubJwt(token);
    } catch (e) {
      caught = e as HubJwtError;
    }
    expect(caught).toBeInstanceOf(HubJwtError);
    expect(caught?.code).toBe("signature");
    // Exactly one forced reload (the retry), not a storm.
    expect(fixture.jwksFetchCount()).toBe(1);
    guard.resetJwksCache();
  });

  test("expired token does NOT trigger a reload", async () => {
    const guard = makeGuard();
    guard.resetJwksCache();
    const warm = await signJwt(kp, { iss: fixture.origin, jti: "warm-exp" });
    await guard.validateHubJwt(warm);
    fixture.resetJwksFetchCount();

    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await signJwt(kp, { iss: fixture.origin, expiresAtSeconds: past });
    await expectError(guard.validateHubJwt(token), "expired");
    // Expiry is a token-level fact a fresh JWKS can't fix → no forced reload.
    expect(fixture.jwksFetchCount()).toBe(0);
    guard.resetJwksCache();
  });

  test("wrong-issuer token does NOT trigger a reload", async () => {
    const guard = makeGuard();
    guard.resetJwksCache();
    const warm = await signJwt(kp, { iss: fixture.origin, jti: "warm-iss" });
    await guard.validateHubJwt(warm);
    fixture.resetJwksFetchCount();

    const token = await signJwt(kp, { iss: "http://attacker.example", jti: "wrong-iss" });
    await expectError(guard.validateHubJwt(token), "issuer");
    expect(fixture.jwksFetchCount()).toBe(0);
    guard.resetJwksCache();
  });

  test("injected bare-function getter (no .reload): no crash, behaves as today", async () => {
    // The test-injected getter seam may be a bare function with no `.reload`.
    // forceReloadJwks returns false → no retry, original error surfaces. A
    // same-kid-rotated token is therefore terminal (the pre-hardening
    // behavior), proving the retry is genuinely gated on a reload seam.
    const keyA = await makeKeypair("bk");
    const keyB = await makeKeypair("bk"); // same kid, different bytes

    // A bare-function getter that only ever resolves key A — no `.reload`.
    const { importJWK } = await import("jose");
    const cryptoKeyA = await importJWK(
      { kty: "RSA", n: keyA.publicJwk.n, e: keyA.publicJwk.e, alg: "RS256" },
      "RS256",
    );
    const bareGetter = (async () => cryptoKeyA) as unknown as import("../jwks").JwksGetter;
    expect("reload" in bareGetter).toBe(false);

    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      jwksGetter: bareGetter,
    });
    // Key-A-signed token verifies fine through the bare getter.
    const good = await signJwt(keyA, { iss: fixture.origin, jti: "bare-good" });
    expect((await guard.validateHubJwt(good)).jti).toBe("bare-good");

    // Key-B-signed token under the same kid: the bare getter still hands back
    // key A, verify fails, no `.reload` to call → terminal `signature`.
    const rotated = await signJwt(keyB, { iss: fixture.origin, jti: "bare-rot" });
    await expectError(guard.validateHubJwt(rotated), "signature");
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

describe("createScopeGuard — permissions claim surfacing", () => {
  // The permissions claim is a raw passthrough: scope-guard surfaces the
  // object verbatim (after full signature/issuer/expiry/revocation
  // validation) without interpreting it. Consumers (e.g. vault reading
  // `permissions.scoped_tags`) own the semantics. The validate-side contract:
  // surface a non-null plain object, leave everything else `undefined`, never
  // throw on malformed input. Mirrors the vault_scope tests above.

  test("permissions object surfaces verbatim on claims", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, {
      iss: fixture.origin,
      permissionsRaw: { scoped_tags: ["work", "personal"], extra: 1 },
    });
    const claims = await guard.validateHubJwt(token);
    expect(claims.permissions).toEqual({ scoped_tags: ["work", "personal"], extra: 1 });
    guard.resetJwksCache();
  });

  test("token without permissions claim → permissions === undefined", async () => {
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin });
    const claims = await guard.validateHubJwt(token);
    expect(claims.permissions).toBeUndefined();
    guard.resetJwksCache();
  });

  test("empty permissions object surfaces as {} (distinct from absent)", async () => {
    // `{}` must stay distinguishable from "no claim" (undefined) — the lib
    // does NOT default absent to `{}`.
    const guard = makeGuard();
    const token = await signJwt(kp, { iss: fixture.origin, permissionsRaw: {} });
    const claims = await guard.validateHubJwt(token);
    expect(claims.permissions).toEqual({});
    expect(claims.permissions).not.toBeUndefined();
    guard.resetJwksCache();
  });

  test("non-object permissions (string / number / array / null) → undefined, no throw", async () => {
    // Malformed input is tolerated: the claim is dropped (undefined), the
    // token still validates. An array is JSON-typeof "object" but is not a
    // plain object, so it must also drop.
    const guard = makeGuard();

    const tokenStr = await signJwt(kp, { iss: fixture.origin, permissionsRaw: "scoped" });
    expect((await guard.validateHubJwt(tokenStr)).permissions).toBeUndefined();

    const tokenNum = await signJwt(kp, { iss: fixture.origin, permissionsRaw: 42 });
    expect((await guard.validateHubJwt(tokenNum)).permissions).toBeUndefined();

    const tokenArr = await signJwt(kp, { iss: fixture.origin, permissionsRaw: ["work"] });
    expect((await guard.validateHubJwt(tokenArr)).permissions).toBeUndefined();

    const tokenNull = await signJwt(kp, { iss: fixture.origin, permissionsRaw: null });
    expect((await guard.validateHubJwt(tokenNull)).permissions).toBeUndefined();

    guard.resetJwksCache();
  });
});

describe("createScopeGuard — jwksOrigin seam (vault#464)", () => {
  // A SECOND JWKS endpoint standing in for the co-located loopback hub. The
  // module-scoped `fixture` plays the role of the PUBLIC origin (the FQDN the
  // token's `iss` is minted against, post-expose). The vault#464 scenario:
  // validate `iss` against the public origin, but FETCH the keys from loopback.
  let loopback: JwksFixture;

  beforeAll(() => {
    loopback = startJwksFixture();
    loopback.setKeys([kp]);
  });

  afterAll(() => {
    loopback.stop();
  });

  beforeEach(() => {
    loopback.setUnreachable(false);
    loopback.setKeys([kp]);
    loopback.resetJwksFetchCount();
  });

  test("public iss + loopback jwksOrigin → keys fetched from loopback, iss matches public", async () => {
    // The crux of vault#464: the token is minted by the PUBLIC hub (iss =
    // public FQDN), but only the LOOPBACK endpoint serves the signing keys.
    // The public endpoint serves NO keys — so if the guard fetched JWKS from
    // `hubOrigin` (the bug), verification would fail with no-matching-key.
    fixture.setKeys([]); // public origin: zero keys
    loopback.setKeys([kp]); // loopback origin: the real signing key
    fixture.resetJwksFetchCount();
    loopback.resetJwksFetchCount();

    const guard = createScopeGuard({
      hubOrigin: fixture.origin, // public FQDN — validates iss
      jwksOrigin: () => loopback.origin, // loopback — fetches keys
    });
    const token = await signJwt(kp, { iss: fixture.origin });

    const claims = await guard.validateHubJwt(token);
    expect(claims.sub).toBe("user-1");

    // The keys came from loopback, never the public origin.
    expect(loopback.jwksFetchCount()).toBeGreaterThan(0);
    expect(fixture.jwksFetchCount()).toBe(0);

    guard.resetJwksCache();
    fixture.setKeys([kp]); // restore for the shared module fixture
  });

  test("public iss but loopback serves wrong key → signature/kid failure (proves fetch origin is loopback)", async () => {
    // Positive control for the test above: if the fetch origin really is
    // loopback, swapping loopback's key out (while the public origin holds the
    // correct one) must FAIL — confirming the public origin's keys are never
    // consulted.
    const otherKp = await makeKeypair("k-other");
    fixture.setKeys([kp]); // public has the correct key — must be ignored
    loopback.setKeys([otherKp]); // loopback has a different key

    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      jwksOrigin: () => loopback.origin,
      // Disable the rotation-retry reload storm; one shot is enough to assert.
      jwksReloadMinIntervalMs: 0,
    });
    const token = await signJwt(kp, { iss: fixture.origin });

    // kid "k1" isn't in loopback's set → no-matching-key (kid).
    await expectError(guard.validateHubJwt(token), "kid");

    guard.resetJwksCache();
    loopback.setKeys([kp]);
  });

  test("iss is still validated against hubOrigin, NOT jwksOrigin", async () => {
    // Decoupling must not weaken the iss pin: a token whose iss is the LOOPBACK
    // origin (not the public hubOrigin) must be rejected even though the keys
    // would verify — the iss check uses hubOrigin alone.
    loopback.setKeys([kp]);

    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      jwksOrigin: () => loopback.origin,
    });
    // Token minted against the loopback origin — wrong issuer for this guard.
    const token = await signJwt(kp, { iss: loopback.origin });

    await expectError(guard.validateHubJwt(token), "issuer");

    guard.resetJwksCache();
  });

  test("jwksOrigin omitted → fetches from hubOrigin exactly as before (backward compat)", async () => {
    // The default path: no jwksOrigin. Keys MUST be fetched from hubOrigin and
    // the loopback endpoint must never be touched.
    fixture.setKeys([kp]);
    fixture.resetJwksFetchCount();
    loopback.resetJwksFetchCount();

    const guard = createScopeGuard({ hubOrigin: fixture.origin });
    const token = await signJwt(kp, { iss: fixture.origin });

    const claims = await guard.validateHubJwt(token);
    expect(claims.sub).toBe("user-1");
    expect(fixture.jwksFetchCount()).toBeGreaterThan(0);
    expect(loopback.jwksFetchCount()).toBe(0);

    guard.resetJwksCache();
  });

  test("jwksOrigin as a literal string (not just a resolver)", async () => {
    fixture.setKeys([]); // public: no keys
    loopback.setKeys([kp]);

    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      jwksOrigin: loopback.origin, // literal string form
    });
    const token = await signJwt(kp, { iss: fixture.origin });

    const claims = await guard.validateHubJwt(token);
    expect(claims.sub).toBe("user-1");

    guard.resetJwksCache();
    fixture.setKeys([kp]);
  });

  test("jwksOrigin resolver is re-evaluated per call (env change picked up without restart)", async () => {
    // The resolver flips from public→loopback mid-life. The first call (public,
    // no keys) fails; after the env flips, the next call succeeds from loopback
    // — proving the resolver isn't captured once at construction.
    fixture.setKeys([]); // public has no keys → first call must fail
    loopback.setKeys([kp]);

    let current = fixture.origin;
    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      jwksOrigin: () => current,
      jwksReloadMinIntervalMs: 0,
    });
    const token = await signJwt(kp, { iss: fixture.origin });

    // First: jwksOrigin === public (no keys) → kid failure.
    await expectError(guard.validateHubJwt(token), "kid");

    // Env flips to loopback; the guard must pick it up on the next call.
    current = loopback.origin;
    guard.resetJwksCache(); // drop the public-keyed (empty) cache entry
    const claims = await guard.validateHubJwt(token);
    expect(claims.sub).toBe("user-1");

    guard.resetJwksCache();
    fixture.setKeys([kp]);
  });

  test("trailing slash on jwksOrigin is stripped", async () => {
    fixture.setKeys([]);
    loopback.setKeys([kp]);

    const guard = createScopeGuard({
      hubOrigin: fixture.origin,
      jwksOrigin: `${loopback.origin}/`,
    });
    const token = await signJwt(kp, { iss: fixture.origin });

    const claims = await guard.validateHubJwt(token);
    expect(claims.sub).toBe("user-1");

    guard.resetJwksCache();
    fixture.setKeys([kp]);
  });
});
