/**
 * hub#516 — `validateHostAdminToken` accepts the operator / SPA host-admin
 * token's `iss` against the SET of origins the hub answers on (loopback ∪
 * expose-state public ∪ env/platform), not the single per-request issuer, so
 * the loopback CLI works on an exposed box. OAuth-token validation
 * (`validateAccessToken` with a pinned `expectedIssuer`) is NOT touched — see
 * the strict-iss regression at the bottom of this file.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateHostAdminToken } from "../host-admin-token-validation.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { recordTokenMint, signAccessToken, validateAccessToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const LOOPBACK = "http://127.0.0.1:1939";
const PUBLIC_TS = "https://parachute.taildf9ce2.ts.net";
const FOREIGN = "https://evil.example.com";

interface H {
  db: ReturnType<typeof openHubDb>;
  userId: string;
  cleanup: () => void;
}

async function makeH(): Promise<H> {
  const dir = mkdtempSync(join(tmpdir(), "phub-host-admin-tok-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const user = await createUser(db, "owner", "pw");
  return {
    db,
    userId: user.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Mint an operator-shaped token (aud: "operator", host:admin) at `iss`. */
async function mintOperatorAt(h: H, iss: string): Promise<string> {
  const signed = await signAccessToken(h.db, {
    sub: h.userId,
    scopes: ["parachute:host:admin", "parachute:host:auth"],
    audience: "operator",
    clientId: "parachute-hub",
    issuer: iss,
    ttlSeconds: 3600,
  });
  recordTokenMint(h.db, {
    jti: signed.jti,
    createdVia: "operator_mint",
    subject: "operator",
    clientId: "parachute-hub",
    scopes: ["parachute:host:admin", "parachute:host:auth"],
    expiresAt: signed.expiresAt,
  });
  return signed.token;
}

describe("validateHostAdminToken (hub#516)", () => {
  // The live repro: operator token minted with the PUBLIC origin as `iss`,
  // presented on a LOOPBACK request (known-origins set built from the loopback
  // per-request issuer + the expose-state public origin) → ACCEPTED.
  test("live repro: public-iss operator token accepted when public origin is in the known set", async () => {
    const h = await makeH();
    try {
      const token = await mintOperatorAt(h, PUBLIC_TS);
      const knownIssuers = [LOOPBACK, "http://localhost:1939", PUBLIC_TS];
      const { payload } = await validateHostAdminToken(h.db, token, knownIssuers);
      expect(payload.iss).toBe(PUBLIC_TS);
      expect(payload.sub).toBe(h.userId);
    } finally {
      h.cleanup();
    }
  });

  test("loopback-iss operator token, loopback known set → accepted (unchanged)", async () => {
    const h = await makeH();
    try {
      const token = await mintOperatorAt(h, LOOPBACK);
      const { payload } = await validateHostAdminToken(h.db, token, [
        LOOPBACK,
        "http://localhost:1939",
      ]);
      expect(payload.iss).toBe(LOOPBACK);
    } finally {
      h.cleanup();
    }
  });

  test("FOREIGN iss → REJECTED (no widening to arbitrary issuers)", async () => {
    const h = await makeH();
    try {
      // A token the hub itself signed but whose iss is NOT one of its known
      // origins. The signature verifies, but the belt-and-suspenders iss ∈
      // known-origins check must still reject it.
      const token = await mintOperatorAt(h, FOREIGN);
      const knownIssuers = [LOOPBACK, "http://localhost:1939", PUBLIC_TS];
      await expect(validateHostAdminToken(h.db, token, knownIssuers)).rejects.toThrow(
        /unexpected "iss" claim value/,
      );
    } finally {
      h.cleanup();
    }
  });

  test("empty known-origins set rejects every token (fails closed)", async () => {
    const h = await makeH();
    try {
      const token = await mintOperatorAt(h, LOOPBACK);
      await expect(validateHostAdminToken(h.db, token, [])).rejects.toThrow(
        /unexpected "iss" claim value/,
      );
    } finally {
      h.cleanup();
    }
  });

  test("expose-state absent (loopback-only set): public-iss token rejected; loopback-iss accepted", async () => {
    const h = await makeH();
    try {
      // Before `expose`, the known set is loopback-only — a public-iss token
      // shouldn't exist yet, and if presented, it's not in the set → reject.
      const publicTok = await mintOperatorAt(h, PUBLIC_TS);
      const loopbackOnly = [LOOPBACK, "http://localhost:1939"];
      await expect(validateHostAdminToken(h.db, publicTok, loopbackOnly)).rejects.toThrow(
        /unexpected "iss" claim value/,
      );

      const loopbackTok = await mintOperatorAt(h, LOOPBACK);
      const { payload } = await validateHostAdminToken(h.db, loopbackTok, loopbackOnly);
      expect(payload.iss).toBe(LOOPBACK);
    } finally {
      h.cleanup();
    }
  });

  test("signature still enforced: a token signed by an unknown key is rejected", async () => {
    const h = await makeH();
    try {
      // Mint against a SECOND hub's key, then try to validate against the
      // first hub's JWKS. The known-origins set includes the iss, but the
      // signature check (step 1) must reject it before iss is even considered.
      const other = await makeH();
      try {
        const foreignSigned = await mintOperatorAt(other, PUBLIC_TS);
        await expect(validateHostAdminToken(h.db, foreignSigned, [PUBLIC_TS])).rejects.toThrow();
      } finally {
        other.cleanup();
      }
    } finally {
      h.cleanup();
    }
  });

  // Pin the invariant: OAuth/access-token validation stays STRICT per-request
  // issuer. The relaxation lives only in validateHostAdminToken; the core
  // primitive validateAccessToken(db, token, expectedIssuer) still rejects a
  // mismatched iss. (Mirrors jwt-sign.test.ts's defense-in-depth test; kept
  // here so the hub#516 guard travels with the relaxation.)
  test("OAuth-token validation UNCHANGED: validateAccessToken pins iss strictly", async () => {
    const h = await makeH();
    try {
      // A vault-aud OAuth-shaped token minted at the public origin.
      const signed = await signAccessToken(h.db, {
        sub: h.userId,
        scopes: ["vault:read"],
        audience: "vault.default",
        clientId: "some-mcp-client",
        issuer: PUBLIC_TS,
        ttlSeconds: 3600,
      });
      // Strict per-request validation against a DIFFERENT (loopback) issuer
      // still rejects — the relaxation must NOT leak to this path.
      await expect(validateAccessToken(h.db, signed.token, LOOPBACK)).rejects.toThrow(
        /unexpected "iss" claim value/,
      );
      // And it accepts when the issuer matches (sanity).
      const { payload } = await validateAccessToken(h.db, signed.token, PUBLIC_TS);
      expect(payload.aud).toBe("vault.default");
    } finally {
      h.cleanup();
    }
  });
});
