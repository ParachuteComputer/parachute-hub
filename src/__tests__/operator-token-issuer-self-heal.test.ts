/**
 * hub#481 — `selfHealOperatorTokenIssuer` re-mints a genuine-but-stale
 * operator token under the hub's current issuer.
 *
 * Background: a box that ran init/setup at loopback and was LATER exposed
 * publicly carries an `operator.token` whose `iss` (e.g. `http://127.0.0.1:1939`)
 * no longer matches the hub's current issuer. The hub rejects it on every CLI
 * auth flow. The self-heal re-issues the hub's OWN credential under the new
 * issuer, preserving scope-set + sub, gated on the token's signature verifying
 * against this hub's current keys (no privilege-escalation surface).
 *
 * Mirrors the existing `operator-token.test.ts` harness shape.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken, validateAccessToken } from "../jwt-sign.ts";
import {
  OPERATOR_TOKEN_AUDIENCE,
  OPERATOR_TOKEN_CLIENT_ID,
  OPERATOR_TOKEN_FILENAME,
  OPERATOR_TOKEN_SCOPE_SET_CLAIM,
  issueOperatorToken,
  operatorTokenPath,
  readOperatorTokenFile,
  selfHealOperatorTokenIssuer,
  writeOperatorTokenFile,
} from "../operator-token.ts";
import { rotateSigningKey } from "../signing-keys.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-op-heal-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const LOOPBACK_ISSUER = "http://127.0.0.1:1939";
const PUBLIC_ISSUER = "https://gitcoin-parachute.unforced.dev";

describe("selfHealOperatorTokenIssuer", () => {
  test("stale-iss genuine token + non-loopback new issuer → rotated, scope-set preserved, valid under new issuer", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Mint at loopback issuer with a non-default scope-set ("start").
        await issueOperatorToken(db, "user-abc", {
          dir: h.dir,
          issuer: LOOPBACK_ISSUER,
          scopeSet: "start",
        });

        const status = await selfHealOperatorTokenIssuer(db, {
          issuer: PUBLIC_ISSUER,
          configDir: h.dir,
        });
        expect(status.kind).toBe("rotated");
        if (status.kind === "rotated") {
          expect(status.scopeSet).toBe("start");
          expect(status.path).toBe(operatorTokenPath(h.dir));
        }

        // The on-disk token now has iss=PUBLIC_ISSUER, scope-set preserved,
        // and validates under the new issuer.
        const onDisk = await readOperatorTokenFile(h.dir);
        expect(onDisk).not.toBeNull();
        const validated = await validateAccessToken(db, onDisk as string, PUBLIC_ISSUER);
        expect(validated.payload.iss).toBe(PUBLIC_ISSUER);
        expect(validated.payload.sub).toBe("user-abc");
        expect(validated.payload[OPERATOR_TOKEN_SCOPE_SET_CLAIM]).toBe("start");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("iss already current → fresh, on-disk file byte-identical", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        await issueOperatorToken(db, "user-abc", {
          dir: h.dir,
          issuer: PUBLIC_ISSUER,
          scopeSet: "admin",
        });
        const before = await readFile(operatorTokenPath(h.dir));

        const status = await selfHealOperatorTokenIssuer(db, {
          issuer: PUBLIC_ISSUER,
          configDir: h.dir,
        });
        expect(status.kind).toBe("fresh");

        const after = await readFile(operatorTokenPath(h.dir));
        expect(after.equals(before)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("absent token file → absent, no throw", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const status = await selfHealOperatorTokenIssuer(db, {
          issuer: PUBLIC_ISSUER,
          configDir: h.dir,
        });
        expect(status.kind).toBe("absent");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("bad signature (corrupt token) → skipped:unverifiable, disk untouched", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Mint a real token at loopback, then corrupt its signature segment so
        // it no longer verifies against the hub's keys.
        const issued = await issueOperatorToken(db, "user-abc", {
          dir: h.dir,
          issuer: LOOPBACK_ISSUER,
          scopeSet: "start",
        });
        const parts = issued.token.split(".");
        const hdr = parts[0] ?? "";
        const body = parts[1] ?? "";
        const sig = parts[2] ?? "";
        // Flip a character in the signature; keep it base64url-shaped.
        const tampered = `${hdr}.${body}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
        await writeOperatorTokenFile(tampered, h.dir);

        const status = await selfHealOperatorTokenIssuer(db, {
          issuer: PUBLIC_ISSUER,
          configDir: h.dir,
        });
        expect(status.kind).toBe("skipped");
        if (status.kind === "skipped") expect(status.reason).toBe("unverifiable");

        const onDisk = await readOperatorTokenFile(h.dir);
        expect(onDisk).toBe(tampered);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("expired token (exp in the past) → skipped:unverifiable (jose throws), disk untouched", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Mint a token that expired in the past — jose's exp check throws on
        // validate, so the self-heal must classify it unverifiable.
        const issued = await issueOperatorToken(db, "user-abc", {
          dir: h.dir,
          issuer: LOOPBACK_ISSUER,
          scopeSet: "start",
          ttlSeconds: 60,
          now: () => new Date("2026-01-01T00:00:00Z"),
        });

        const status = await selfHealOperatorTokenIssuer(db, {
          issuer: PUBLIC_ISSUER,
          configDir: h.dir,
        });
        expect(status.kind).toBe("skipped");
        if (status.kind === "skipped") expect(status.reason).toBe("unverifiable");

        const onDisk = await readOperatorTokenFile(h.dir);
        expect(onDisk).toBe(issued.token);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("aud != operator (aud=scribe, valid sig, stale iss) → skipped:aud-mismatch, untouched", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // A hub-signed token with the WRONG audience must not be re-minted as
        // an operator token (privilege guard).
        const signed = await signAccessToken(db, {
          sub: "user-abc",
          scopes: ["scribe:transcribe"],
          audience: "scribe",
          clientId: OPERATOR_TOKEN_CLIENT_ID,
          issuer: LOOPBACK_ISSUER,
          extraClaims: { [OPERATOR_TOKEN_SCOPE_SET_CLAIM]: "admin" },
        });
        await writeOperatorTokenFile(signed.token, h.dir);

        const status = await selfHealOperatorTokenIssuer(db, {
          issuer: PUBLIC_ISSUER,
          configDir: h.dir,
        });
        expect(status.kind).toBe("skipped");
        if (status.kind === "skipped") expect(status.reason).toBe("aud-mismatch");

        const onDisk = await readOperatorTokenFile(h.dir);
        expect(onDisk).toBe(signed.token);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("missing/invalid pa_scope_set (stale iss, aud=operator) → skipped:no-scope-set, NOT widened to admin", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // aud=operator + stale iss + NO pa_scope_set claim. Falling back to a
        // default scope-set would silently widen to admin (hub#224); refuse.
        const signed = await signAccessToken(db, {
          sub: "user-abc",
          scopes: ["scribe:transcribe"],
          audience: OPERATOR_TOKEN_AUDIENCE,
          clientId: OPERATOR_TOKEN_CLIENT_ID,
          issuer: LOOPBACK_ISSUER,
        });
        await writeOperatorTokenFile(signed.token, h.dir);

        const status = await selfHealOperatorTokenIssuer(db, {
          issuer: PUBLIC_ISSUER,
          configDir: h.dir,
        });
        expect(status.kind).toBe("skipped");
        if (status.kind === "skipped") expect(status.reason).toBe("no-scope-set");

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

  test("missing sub (stale iss, aud=operator, valid scope-set) → skipped:no-sub, untouched", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // aud=operator + recognized scope-set + stale iss but NO sub — we can't
        // re-mint a token we can't attribute.
        const signed = await signAccessToken(db, {
          sub: "",
          scopes: ["parachute:host:start"],
          audience: OPERATOR_TOKEN_AUDIENCE,
          clientId: OPERATOR_TOKEN_CLIENT_ID,
          issuer: LOOPBACK_ISSUER,
          extraClaims: { [OPERATOR_TOKEN_SCOPE_SET_CLAIM]: "start" },
        });
        await writeOperatorTokenFile(signed.token, h.dir);

        const status = await selfHealOperatorTokenIssuer(db, {
          issuer: PUBLIC_ISSUER,
          configDir: h.dir,
        });
        expect(status.kind).toBe("skipped");
        if (status.kind === "skipped") expect(status.reason).toBe("no-sub");

        const onDisk = await readOperatorTokenFile(h.dir);
        expect(onDisk).toBe(signed.token);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("target issuer loopback (public token on disk) → skipped:issuer-loopback, public token preserved", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // A good PUBLIC-issuer token; calling self-heal with a loopback target
        // must never downgrade it.
        const issued = await issueOperatorToken(db, "user-abc", {
          dir: h.dir,
          issuer: PUBLIC_ISSUER,
          scopeSet: "admin",
        });

        const status = await selfHealOperatorTokenIssuer(db, {
          issuer: LOOPBACK_ISSUER,
          configDir: h.dir,
        });
        expect(status.kind).toBe("skipped");
        if (status.kind === "skipped") expect(status.reason).toBe("issuer-loopback");

        const onDisk = await readOperatorTokenFile(h.dir);
        expect(onDisk).toBe(issued.token);
        // Still a public-issuer token.
        const validated = await validateAccessToken(db, onDisk as string, PUBLIC_ISSUER);
        expect(validated.payload.iss).toBe(PUBLIC_ISSUER);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("scope-set preserved verbatim — 'auth' set stays 'auth', not widened to admin", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        await issueOperatorToken(db, "user-xyz", {
          dir: h.dir,
          issuer: LOOPBACK_ISSUER,
          scopeSet: "auth",
        });

        const status = await selfHealOperatorTokenIssuer(db, {
          issuer: PUBLIC_ISSUER,
          configDir: h.dir,
        });
        expect(status.kind).toBe("rotated");
        if (status.kind === "rotated") expect(status.scopeSet).toBe("auth");

        const onDisk = await readOperatorTokenFile(h.dir);
        const validated = await validateAccessToken(db, onDisk as string, PUBLIC_ISSUER);
        expect(validated.payload[OPERATOR_TOKEN_SCOPE_SET_CLAIM]).toBe("auth");
        // The minted scopes are the "auth" set, NOT the admin superset.
        expect(validated.payload.scope).toBe("parachute:host:auth");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("file path is the canonical operator.token under configDir", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        await issueOperatorToken(db, "user-abc", {
          dir: h.dir,
          issuer: LOOPBACK_ISSUER,
          scopeSet: "start",
        });
        const status = await selfHealOperatorTokenIssuer(db, {
          issuer: PUBLIC_ISSUER,
          configDir: h.dir,
        });
        if (status.kind === "rotated") {
          expect(status.path).toBe(join(h.dir, OPERATOR_TOKEN_FILENAME));
        } else {
          throw new Error(`expected rotated, got ${status.kind}`);
        }
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
