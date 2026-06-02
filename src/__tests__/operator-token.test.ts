import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExposeState } from "../expose-state.ts";
import { writeExposeState } from "../expose-state.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken, validateAccessToken } from "../jwt-sign.ts";
import {
  OPERATOR_TOKEN_AUDIENCE,
  OPERATOR_TOKEN_AUTO_ROTATE_THRESHOLD_SECONDS,
  OPERATOR_TOKEN_CLIENT_ID,
  OPERATOR_TOKEN_FILENAME,
  OPERATOR_TOKEN_SCOPES,
  OPERATOR_TOKEN_SCOPE_SETS,
  OPERATOR_TOKEN_SCOPE_SET_CLAIM,
  OPERATOR_TOKEN_TTL_SECONDS,
  buildKnownIssuersForOperatorToken,
  issueOperatorToken,
  mintOperatorToken,
  operatorTokenPath,
  readOperatorTokenFile,
  useOperatorTokenWithAutoRotate,
  writeOperatorTokenFile,
} from "../operator-token.ts";
import { rotateSigningKey } from "../signing-keys.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-operator-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const TEST_ISSUER = "http://127.0.0.1:1939";

describe("mintOperatorToken", () => {
  test("returns a JWT with operator audience, broad scopes, and ~1y TTL", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const minted = await mintOperatorToken(db, "user-abc", {
          issuer: TEST_ISSUER,
          now: () => new Date("2026-04-26T00:00:00Z"),
        });
        expect(minted.token.split(".")).toHaveLength(3);
        const validated = await validateAccessToken(db, minted.token, TEST_ISSUER);
        expect(validated.payload.sub).toBe("user-abc");
        expect(validated.payload.aud).toBe(OPERATOR_TOKEN_AUDIENCE);
        expect(validated.payload.iss).toBe(TEST_ISSUER);
        expect(validated.payload.scope).toBe(OPERATOR_TOKEN_SCOPES.join(" "));
        const exp = validated.payload.exp ?? 0;
        const iat = validated.payload.iat ?? 0;
        expect(exp - iat).toBe(OPERATOR_TOKEN_TTL_SECONDS);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("admin scope-set includes hub:admin + parachute:host:* + vault/scribe/channel admins (#213)", () => {
    // OPERATOR_TOKEN_SCOPES === OPERATOR_TOKEN_SCOPE_SETS.admin (back-compat
    // alias). The pre-#213 set was 5 scopes; #213 added the fine-grained
    // parachute:host:install/start/expose/auth/vault scopes to the admin
    // superset (admin is "everything", per the scope-set vocabulary).
    expect(OPERATOR_TOKEN_SCOPES).toEqual([
      "hub:admin",
      "parachute:host:admin",
      "parachute:host:install",
      "parachute:host:start",
      "parachute:host:expose",
      "parachute:host:auth",
      "parachute:host:vault",
      "vault:admin",
      "scribe:admin",
      "channel:send",
    ]);
  });
});

describe("writeOperatorTokenFile + readOperatorTokenFile", () => {
  test("writes mode 0600 and round-trips the plaintext", async () => {
    const h = makeHarness();
    try {
      const path = await writeOperatorTokenFile("plaintext-abc", h.dir);
      expect(path).toBe(join(h.dir, OPERATOR_TOKEN_FILENAME));
      const stat = statSync(path);
      // Mask off file-type bits; just compare permission bits.
      expect(stat.mode & 0o777).toBe(0o600);
      const round = await readOperatorTokenFile(h.dir);
      expect(round).toBe("plaintext-abc");
    } finally {
      h.cleanup();
    }
  });

  test("readOperatorTokenFile returns null when missing", async () => {
    const h = makeHarness();
    try {
      expect(await readOperatorTokenFile(h.dir)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("overwrite is atomic — second write replaces the first plaintext", async () => {
    const h = makeHarness();
    try {
      await writeOperatorTokenFile("first", h.dir);
      await writeOperatorTokenFile("second", h.dir);
      const round = await readOperatorTokenFile(h.dir);
      expect(round).toBe("second");
      // No leftover .tmp
      const tmp = `${operatorTokenPath(h.dir)}.tmp`;
      await readFile(tmp).then(
        () => expect.unreachable("tmp file should be renamed away"),
        (err: NodeJS.ErrnoException) => expect(err.code).toBe("ENOENT"),
      );
    } finally {
      h.cleanup();
    }
  });
});

describe("issueOperatorToken", () => {
  test("mints + writes the token to disk in one call", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const issued = await issueOperatorToken(db, "user-xyz", {
          dir: h.dir,
          issuer: TEST_ISSUER,
        });
        expect(issued.path).toBe(join(h.dir, OPERATOR_TOKEN_FILENAME));
        const fromDisk = await readOperatorTokenFile(h.dir);
        expect(fromDisk).toBe(issued.token);
        const validated = await validateAccessToken(db, issued.token, TEST_ISSUER);
        expect(validated.payload.sub).toBe("user-xyz");
        expect(validated.payload.iss).toBe(TEST_ISSUER);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("operator token defaults (#213)", () => {
  test("default lifetime is 90d (was 365d through 0.5.7)", () => {
    expect(OPERATOR_TOKEN_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
  });

  test("auto-rotate threshold is 7d", () => {
    expect(OPERATOR_TOKEN_AUTO_ROTATE_THRESHOLD_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

describe("mintOperatorToken scope-sets (#213)", () => {
  test("default scope-set is admin and embeds the pa_scope_set claim", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const minted = await mintOperatorToken(db, "user-abc", { issuer: TEST_ISSUER });
        expect(minted.scopeSet).toBe("admin");
        const validated = await validateAccessToken(db, minted.token, TEST_ISSUER);
        expect(validated.payload[OPERATOR_TOKEN_SCOPE_SET_CLAIM]).toBe("admin");
        expect(validated.payload.scope).toBe(OPERATOR_TOKEN_SCOPE_SETS.admin.join(" "));
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("--scope-set=start mints with parachute:host:start only", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const minted = await mintOperatorToken(db, "user-abc", {
          issuer: TEST_ISSUER,
          scopeSet: "start",
        });
        expect(minted.scopeSet).toBe("start");
        const validated = await validateAccessToken(db, minted.token, TEST_ISSUER);
        expect(validated.payload.scope).toBe("parachute:host:start");
        expect(validated.payload[OPERATOR_TOKEN_SCOPE_SET_CLAIM]).toBe("start");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("install scope-set carries vault:read for new-vault discovery", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const minted = await mintOperatorToken(db, "u", {
          issuer: TEST_ISSUER,
          scopeSet: "install",
        });
        const validated = await validateAccessToken(db, minted.token, TEST_ISSUER);
        const scopes = String(validated.payload.scope ?? "").split(" ");
        expect(scopes).toContain("parachute:host:install");
        expect(scopes).toContain("vault:read");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("admin set is the superset of all narrow sets", () => {
    const admin = new Set(OPERATOR_TOKEN_SCOPE_SETS.admin);
    for (const setName of ["install", "start", "expose", "auth", "vault"] as const) {
      for (const scope of OPERATOR_TOKEN_SCOPE_SETS[setName]) {
        // vault:read is in `install` but not (directly) in admin — admin
        // carries vault:admin which subsumes :read at the resource server.
        if (scope === "vault:read") continue;
        expect(admin.has(scope)).toBe(true);
      }
    }
  });
});

describe("readOperatorTokenFile permission warning (#213)", () => {
  test("does not warn when file is mode 0600", async () => {
    const h = makeHarness();
    const origErr = console.error;
    let stderr = "";
    console.error = (...a: unknown[]) => {
      stderr += `${a.map(String).join(" ")}\n`;
    };
    try {
      await writeOperatorTokenFile("token-abc", h.dir);
      await readOperatorTokenFile(h.dir);
      expect(stderr).toBe("");
    } finally {
      console.error = origErr;
      h.cleanup();
    }
  });

  test("warns (without failing) when file is world-readable", async () => {
    const h = makeHarness();
    const origErr = console.error;
    let stderr = "";
    console.error = (...a: unknown[]) => {
      stderr += `${a.map(String).join(" ")}\n`;
    };
    try {
      const path = await writeOperatorTokenFile("token-abc", h.dir);
      chmodSync(path, 0o644);
      const round = await readOperatorTokenFile(h.dir);
      expect(round).toBe("token-abc");
      expect(stderr).toContain("operator token file");
      expect(stderr).toContain("0644");
      expect(stderr).toContain("chmod 0600");
    } finally {
      console.error = origErr;
      h.cleanup();
    }
  });
});

describe("useOperatorTokenWithAutoRotate (#213)", () => {
  test("returns the token unchanged when remaining lifetime > threshold", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const issued = await issueOperatorToken(db, "user-abc", {
          dir: h.dir,
          issuer: TEST_ISSUER,
          // Default 90d, fresh — well above threshold.
        });
        const used = await useOperatorTokenWithAutoRotate(db, {
          configDir: h.dir,
          issuer: TEST_ISSUER,
        });
        expect(used).not.toBeNull();
        expect(used?.status.kind).toBe("fresh");
        expect(used?.rotated).toBeUndefined();
        expect(used?.token).toBe(issued.token);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("auto-rotates when within 7d of expiry, preserving scope-set", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Mint with a 1-day TTL — well below the 7d threshold.
        const original = await issueOperatorToken(db, "user-abc", {
          dir: h.dir,
          issuer: TEST_ISSUER,
          scopeSet: "start",
          ttlSeconds: 24 * 60 * 60,
        });
        expect(original.scopeSet).toBe("start");

        const used = await useOperatorTokenWithAutoRotate(db, {
          configDir: h.dir,
          issuer: TEST_ISSUER,
        });
        expect(used).not.toBeNull();
        expect(used?.status.kind).toBe("rotated");
        expect(used?.rotated?.scopeSet).toBe("start");
        // The on-disk token is now the rotated one.
        const onDisk = await readOperatorTokenFile(h.dir);
        expect(onDisk).toBe(used!.token);
        expect(onDisk).not.toBe(original.token);
        // The rotated token is still scope-set "start".
        const validated = await validateAccessToken(db, used!.token, TEST_ISSUER);
        expect(validated.payload[OPERATOR_TOKEN_SCOPE_SET_CLAIM]).toBe("start");
        expect(validated.payload.scope).toBe("parachute:host:start");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("does NOT auto-rotate a non-operator-audience JWT stashed at the path (privilege guard)", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Hand-sign a narrow JWT with aud=scribe (not "operator") and a
        // 1-hour TTL. Even though it's within the rotation window, the
        // helper must not silently upgrade it to a full operator token.
        const signed = await signAccessToken(db, {
          sub: "user-abc",
          scopes: ["scribe:transcribe"],
          audience: "scribe",
          clientId: OPERATOR_TOKEN_CLIENT_ID,
          issuer: TEST_ISSUER,
          ttlSeconds: 3600,
        });
        await writeOperatorTokenFile(signed.token, h.dir);

        const used = await useOperatorTokenWithAutoRotate(db, {
          configDir: h.dir,
          issuer: TEST_ISSUER,
        });
        expect(used).not.toBeNull();
        expect(used?.status.kind).toBe("skipped");
        if (used?.status.kind === "skipped") {
          expect(used.status.reason).toBe("aud-mismatch");
        }
        expect(used?.rotated).toBeUndefined();
        expect(used?.token).toBe(signed.token);
        // On-disk file unchanged.
        const onDisk = await readOperatorTokenFile(h.dir);
        expect(onDisk).toBe(signed.token);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // hub#224 — when a JWT carries the operator audience + short TTL but
  // lacks a recognized `pa_scope_set` claim, the helper now refuses to
  // auto-rotate. Pre-hardening the fallback widened to admin; the test
  // pins the new "skipped, no-scope-set" outcome.
  test("does NOT auto-rotate an aud=operator token that lacks pa_scope_set (no silent widening)", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // aud=operator + 1h TTL + NO pa_scope_set claim. Pre-#224 this would
        // fall back to OPERATOR_TOKEN_DEFAULT_SCOPE_SET (admin) on rotation
        // — a silent widening of a token of unknown provenance.
        const signed = await signAccessToken(db, {
          sub: "user-abc",
          scopes: ["scribe:transcribe"],
          audience: OPERATOR_TOKEN_AUDIENCE,
          clientId: OPERATOR_TOKEN_CLIENT_ID,
          issuer: TEST_ISSUER,
          ttlSeconds: 3600,
        });
        await writeOperatorTokenFile(signed.token, h.dir);

        const used = await useOperatorTokenWithAutoRotate(db, {
          configDir: h.dir,
          issuer: TEST_ISSUER,
        });
        expect(used).not.toBeNull();
        expect(used?.status.kind).toBe("skipped");
        if (used?.status.kind === "skipped") {
          expect(used.status.reason).toBe("no-scope-set");
        }
        expect(used?.rotated).toBeUndefined();
        expect(used?.token).toBe(signed.token);
        // On-disk file unchanged — no widening occurred.
        const onDisk = await readOperatorTokenFile(h.dir);
        expect(onDisk).toBe(signed.token);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("returns null when no operator token file exists", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const used = await useOperatorTokenWithAutoRotate(db, {
          configDir: h.dir,
          issuer: TEST_ISSUER,
        });
        expect(used).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("validateAccessToken rejects a fully-expired token (jose enforces exp)", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Mint a token that's already expired.
        const expiredAt = new Date("2026-01-01T00:00:00Z");
        const issued = await issueOperatorToken(db, "user-abc", {
          dir: h.dir,
          issuer: TEST_ISSUER,
          ttlSeconds: 60,
          now: () => expiredAt,
        });
        expect(issued.token.length).toBeGreaterThan(0);
        await expect(
          useOperatorTokenWithAutoRotate(db, { configDir: h.dir, issuer: TEST_ISSUER }),
        ).rejects.toThrow();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

// hub#516 — the operator token's `iss` is the hub's PUBLIC origin after
// `parachute expose`, but callers resolve `issuer` inconsistently (status →
// loopback, lifecycle → public). The client-side validation now accepts the
// token if its `iss` is ANY of the hub's known origins (loopback aliases ∪
// expose-state public origin ∪ env), gated FIRST on the JWKS signature. These
// tests pin the four-corner matrix: public-iss accepted with loopback config
// (the status bug), loopback-iss accepted, foreign-iss rejected, and
// foreign-SIGNATURE rejected even when its iss is in the known set.
const PUBLIC_ISSUER = "https://parachute.taildf9ce2.ts.net";

/** Minimal valid expose-state advertising `hubOrigin` (the public origin). */
function exposeStateForOrigin(hubOrigin: string): ExposeState {
  return {
    version: 1,
    layer: "tailnet",
    mode: "path",
    canonicalFqdn: new URL(hubOrigin).host,
    port: 1939,
    funnel: false,
    entries: [],
    hubOrigin,
  };
}

describe("useOperatorTokenWithAutoRotate known-issuer set (hub#516)", () => {
  // The PARACHUTE_HUB_ORIGIN / RENDER_EXTERNAL_URL / FLY_APP_NAME env vars feed
  // the platform-origin seed of the known-issuer set. Tests that assert a
  // public-iss is REJECTED when expose-state is absent must not have a stray
  // env public origin leaking the iss back in — clear them around each test.
  function withCleanPlatformEnv<T>(fn: () => T): T {
    const saved = {
      hub: process.env.PARACHUTE_HUB_ORIGIN,
      render: process.env.RENDER_EXTERNAL_URL,
      fly: process.env.FLY_APP_NAME,
    };
    // Computed-key delete (not `delete process.env.FOO`) so biome's noDelete
    // doesn't fire — matches spawn-env-propagation.test.ts. A `= undefined`
    // assignment would coerce to the string "undefined" and leak a bogus
    // origin into the known-issuer set, so a real delete is required here.
    for (const k of ["PARACHUTE_HUB_ORIGIN", "RENDER_EXTERNAL_URL", "FLY_APP_NAME"]) {
      delete process.env[k];
    }
    try {
      return fn();
    } finally {
      if (saved.hub !== undefined) process.env.PARACHUTE_HUB_ORIGIN = saved.hub;
      if (saved.render !== undefined) process.env.RENDER_EXTERNAL_URL = saved.render;
      if (saved.fly !== undefined) process.env.FLY_APP_NAME = saved.fly;
    }
  }

  test("accepts a PUBLIC-iss operator token when config resolves loopback (the status bug)", async () => {
    await withCleanPlatformEnv(async () => {
      const h = makeHarness();
      try {
        const db = openHubDb(hubDbPath(h.dir));
        try {
          rotateSigningKey(db);
          // Mint the operator token under the hub's PUBLIC origin — what
          // happens on an exposed box (selfHealOperatorTokenIssuer re-mints to
          // the public iss).
          const issued = await issueOperatorToken(db, "user-abc", {
            dir: h.dir,
            issuer: PUBLIC_ISSUER,
          });
          // Expose-state advertises the public origin (so it lands in the
          // known set). The CALLER resolves loopback (status's hardcoded path).
          writeExposeState(exposeStateForOrigin(PUBLIC_ISSUER), join(h.dir, "expose-state.json"));

          const used = await useOperatorTokenWithAutoRotate(db, {
            configDir: h.dir,
            issuer: TEST_ISSUER, // loopback — the status scenario
          });
          expect(used).not.toBeNull();
          expect(used?.status.kind).toBe("fresh");
          expect(used?.token).toBe(issued.token);
          expect(used?.payload.iss).toBe(PUBLIC_ISSUER);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });
  });

  test("accepts a loopback-iss operator token with loopback config", async () => {
    await withCleanPlatformEnv(async () => {
      const h = makeHarness();
      try {
        const db = openHubDb(hubDbPath(h.dir));
        try {
          rotateSigningKey(db);
          const issued = await issueOperatorToken(db, "user-abc", {
            dir: h.dir,
            issuer: TEST_ISSUER,
          });
          // No expose-state — known set is loopback aliases only.
          const used = await useOperatorTokenWithAutoRotate(db, {
            configDir: h.dir,
            issuer: TEST_ISSUER,
          });
          expect(used).not.toBeNull();
          expect(used?.status.kind).toBe("fresh");
          expect(used?.token).toBe(issued.token);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });
  });

  test("rejects a token whose iss is FOREIGN to the known set", async () => {
    await withCleanPlatformEnv(async () => {
      const h = makeHarness();
      try {
        const db = openHubDb(hubDbPath(h.dir));
        try {
          rotateSigningKey(db);
          // Hub-SIGNED (so the signature gate passes) but stamped with an iss
          // that's neither loopback nor in expose-state nor env. Must reject.
          const issued = await issueOperatorToken(db, "user-abc", {
            dir: h.dir,
            issuer: "https://evil.example.com",
          });
          expect(issued.token.length).toBeGreaterThan(0);
          // expose-state advertises the PUBLIC origin (not the evil one), so
          // the foreign iss is not in the known set.
          writeExposeState(exposeStateForOrigin(PUBLIC_ISSUER), join(h.dir, "expose-state.json"));

          await expect(
            useOperatorTokenWithAutoRotate(db, { configDir: h.dir, issuer: TEST_ISSUER }),
          ).rejects.toThrow(/unexpected "iss" claim value/);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });
  });

  test("rejects a FOREIGN-SIGNED token even when its iss is in the known set (signature gate first)", async () => {
    await withCleanPlatformEnv(async () => {
      const h = makeHarness();
      const foreign = makeHarness();
      try {
        const db = openHubDb(hubDbPath(h.dir));
        // A DIFFERENT hub (different signing key) mints a token stamped with an
        // iss that IS in our known set. The signature won't verify against our
        // JWKS, so it must be rejected at the signature gate regardless of iss.
        const foreignDb = openHubDb(hubDbPath(foreign.dir));
        try {
          rotateSigningKey(db);
          rotateSigningKey(foreignDb);
          const foreignToken = await mintOperatorToken(foreignDb, "user-abc", {
            issuer: PUBLIC_ISSUER,
          });
          await writeOperatorTokenFile(foreignToken.token, h.dir);
          // Our expose-state advertises PUBLIC_ISSUER — so the iss WOULD pass
          // the belt-and-suspenders check. The signature gate must still reject.
          writeExposeState(exposeStateForOrigin(PUBLIC_ISSUER), join(h.dir, "expose-state.json"));

          await expect(
            useOperatorTokenWithAutoRotate(db, { configDir: h.dir, issuer: TEST_ISSUER }),
          ).rejects.toThrow();
        } finally {
          db.close();
          foreignDb.close();
        }
      } finally {
        h.cleanup();
        foreign.cleanup();
      }
    });
  });

  test("expose-state absent: loopback-iss accepted, public-iss rejected (no public origin known)", async () => {
    await withCleanPlatformEnv(async () => {
      const h = makeHarness();
      try {
        const db = openHubDb(hubDbPath(h.dir));
        try {
          rotateSigningKey(db);
          // A loopback-iss token is accepted (loopback alias is always in the set).
          const loopbackTok = await issueOperatorToken(db, "user-abc", {
            dir: h.dir,
            issuer: TEST_ISSUER,
          });
          const usedLoopback = await useOperatorTokenWithAutoRotate(db, {
            configDir: h.dir,
            issuer: TEST_ISSUER,
          });
          expect(usedLoopback?.token).toBe(loopbackTok.token);

          // Overwrite with a public-iss token. No expose-state, no env public
          // origin → the public iss is NOT known → reject. (Correct: with no
          // exposure configured, the hub doesn't legitimately answer on it.)
          const publicTok = await issueOperatorToken(db, "user-abc", {
            dir: h.dir,
            issuer: PUBLIC_ISSUER,
          });
          expect(publicTok.token.length).toBeGreaterThan(0);
          await expect(
            useOperatorTokenWithAutoRotate(db, { configDir: h.dir, issuer: TEST_ISSUER }),
          ).rejects.toThrow(/unexpected "iss" claim value/);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });
  });

  test("auto-rotate still fires for a near-expiry token validated via the known set", async () => {
    await withCleanPlatformEnv(async () => {
      const h = makeHarness();
      try {
        const db = openHubDb(hubDbPath(h.dir));
        try {
          rotateSigningKey(db);
          // Public-iss + 1-day TTL (below the 7d threshold). Validates via the
          // known set (expose-state public origin), then auto-rotates.
          const original = await issueOperatorToken(db, "user-abc", {
            dir: h.dir,
            issuer: PUBLIC_ISSUER,
            scopeSet: "start",
            ttlSeconds: 24 * 60 * 60,
          });
          writeExposeState(exposeStateForOrigin(PUBLIC_ISSUER), join(h.dir, "expose-state.json"));

          const used = await useOperatorTokenWithAutoRotate(db, {
            configDir: h.dir,
            issuer: PUBLIC_ISSUER, // lifecycle's public-origin scenario
          });
          expect(used).not.toBeNull();
          expect(used?.status.kind).toBe("rotated");
          expect(used?.rotated?.scopeSet).toBe("start");
          expect(used?.token).not.toBe(original.token);
          // Re-mint stamps opts.issuer as the new iss; still validates.
          const validated = await validateAccessToken(db, used!.token, PUBLIC_ISSUER);
          expect(validated.payload.iss).toBe(PUBLIC_ISSUER);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });
  });

  test("buildKnownIssuersForOperatorToken includes loopback aliases + expose-state public origin", async () => {
    await withCleanPlatformEnv(() => {
      const h = makeHarness();
      try {
        writeExposeState(exposeStateForOrigin(PUBLIC_ISSUER), join(h.dir, "expose-state.json"));
        const set = buildKnownIssuersForOperatorToken(h.dir, TEST_ISSUER);
        expect(set).toContain("http://127.0.0.1:1939");
        expect(set).toContain("http://localhost:1939");
        expect(set).toContain(PUBLIC_ISSUER);
        // The seed issuer is included too.
        expect(set).toContain(TEST_ISSUER);
        // A foreign origin is NOT present.
        expect(set).not.toContain("https://evil.example.com");
      } finally {
        h.cleanup();
      }
    });
  });
});

// closes #212 Phase 1 — operator-mint paths write to the unified token
// registry so they show up in the revocation list and admin UI alongside
// OAuth refresh tokens and CLI mints.
describe("mintOperatorToken registry write (#212)", () => {
  test("writes a tokens row with created_via='operator_mint', subject='operator', user_id NULL", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const minted = await mintOperatorToken(db, "user-abc", {
          issuer: TEST_ISSUER,
          scopeSet: "start",
        });
        const row = db
          .query<
            {
              jti: string;
              user_id: string | null;
              subject: string | null;
              created_via: string;
              scopes: string;
              expires_at: string;
            },
            [string]
          >(
            "SELECT jti, user_id, subject, created_via, scopes, expires_at FROM tokens WHERE jti = ?",
          )
          .get(minted.jti);
        expect(row).not.toBeNull();
        expect(row?.user_id).toBeNull();
        expect(row?.subject).toBe("operator");
        expect(row?.created_via).toBe("operator_mint");
        expect(row?.scopes).toBe("parachute:host:start");
        expect(row?.expires_at).toBe(minted.expiresAt);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("auto-rotation writes a fresh registry row for the rotated token", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const original = await issueOperatorToken(db, "user-abc", {
          dir: h.dir,
          issuer: TEST_ISSUER,
          ttlSeconds: 24 * 60 * 60, // within rotation window
        });
        const used = await useOperatorTokenWithAutoRotate(db, {
          configDir: h.dir,
          issuer: TEST_ISSUER,
        });
        expect(used?.status.kind).toBe("rotated");
        // The rotated token has a new jti.
        const newJti = used!.payload.jti as string;
        expect(newJti).not.toBe(original.jti);
        const row = db
          .query<{ jti: string; created_via: string }, [string]>(
            "SELECT jti, created_via FROM tokens WHERE jti = ?",
          )
          .get(newJti);
        expect(row).not.toBeNull();
        expect(row?.created_via).toBe("operator_mint");
        // Both the original and the rotated row exist (the original isn't
        // auto-revoked — it stays valid until its own exp). Phase 2 may add
        // a "revoke prior on rotation" toggle; for now we keep both.
        const origRow = db
          .query<{ jti: string }, [string]>("SELECT jti FROM tokens WHERE jti = ?")
          .get(original.jti);
        expect(origRow).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
