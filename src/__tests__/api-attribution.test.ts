/**
 * `GET /api/auth/attribution` (hub#833 phase 1b) — resolve a token subject to
 * the Nostr key(s) that subject has proved possession of, plus the stored
 * proof so a reader can re-verify independently.
 *
 * Coverage:
 *   - bearer posture: missing / malformed / unscoped bearer
 *   - `subject` validation: required, bounded
 *   - an unknown subject and a linked-key-less subject are INDISTINGUISHABLE
 *     (no user-existence oracle)
 *   - the proof event round-trips verifiably
 *   - `GET /api/auth/tokens` surfaces the additive `subject_pubkey` column
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { handleApiAttribution } from "../api-attribution.ts";
import { handleApiTokens } from "../api-tokens.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { recordTokenMint, signAccessToken } from "../jwt-sign.ts";
import { type NostrEvent, nostrEventId, verifyNostrEvent } from "../nostr-event.ts";
import { issuePubkeyChallenge, linkPubkey, unlinkPubkey } from "../pubkey-links.ts";
import { getActiveSigningKey } from "../signing-keys.ts";
import { createUser, deleteUser } from "../users.ts";

const ISSUER = "https://hub.example";

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const SECRET = hexToBytes("33".repeat(32));
const PUBKEY = bytesToHex(schnorr.getPublicKey(SECRET));

let db: Database;
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "phub-attribution-"));
  db = openHubDb(hubDbPath(configDir));
  getActiveSigningKey(db);
});

afterEach(() => {
  db.close();
  rmSync(configDir, { recursive: true, force: true });
});

async function bearer(scopes: string[]): Promise<string> {
  const minted = await signAccessToken(db, {
    sub: "operator",
    scopes,
    audience: "hub",
    clientId: "parachute-hub",
    issuer: ISSUER,
    ttlSeconds: 600,
  });
  return minted.token;
}

function get(path: string, token: string | null): Promise<Response> {
  return handleApiAttribution(
    new Request(`${ISSUER}${path}`, {
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    { db, issuer: ISSUER },
  );
}

/** Link a real signed key to a fresh user; returns the user id. */
async function linkedUser(username: string): Promise<string> {
  const u = await createUser(db, username, "correct-horse-battery", {
    allowMulti: true,
    passwordChanged: true,
  });
  const { challenge } = issuePubkeyChallenge(db, u.id, new Date());
  const unsigned = {
    pubkey: PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: 27235,
    tags: [["challenge", challenge]],
    content: "",
  };
  const id = nostrEventId(unsigned);
  const event: NostrEvent = {
    ...unsigned,
    id,
    sig: bytesToHex(schnorr.sign(hexToBytes(id), SECRET)),
  };
  const res = linkPubkey(db, {
    userId: u.id,
    pubkey: PUBKEY,
    challenge,
    proofEvent: JSON.stringify(event),
    proofEventId: id,
    label: "laptop",
  });
  expect(res.ok).toBe(true);
  return u.id;
}

describe("bearer posture", () => {
  test("requires a bearer", async () => {
    expect((await get("/api/auth/attribution?subject=x", null)).status).toBe(401);
  });

  test("rejects a bogus bearer", async () => {
    expect((await get("/api/auth/attribution?subject=x", "not-a-jwt")).status).toBe(401);
  });

  test("rejects a bearer without parachute:host:auth", async () => {
    const res = await get("/api/auth/attribution?subject=x", await bearer(["vault:work:admin"]));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  test("rejects non-GET", async () => {
    const res = await handleApiAttribution(
      new Request(`${ISSUER}/api/auth/attribution?subject=x`, { method: "POST" }),
      { db, issuer: ISSUER },
    );
    expect(res.status).toBe(405);
  });
});

describe("subject validation", () => {
  test("requires a non-empty subject", async () => {
    const token = await bearer(["parachute:host:auth"]);
    for (const qs of ["", "?subject=", "?subject=%20"]) {
      const res = await get(`/api/auth/attribution${qs}`, token);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    }
  });

  test("bounds the subject length", async () => {
    const token = await bearer(["parachute:host:auth"]);
    const res = await get(`/api/auth/attribution?subject=${"x".repeat(300)}`, token);
    expect(res.status).toBe(400);
  });
});

describe("resolution", () => {
  test("returns the linked keys with a re-verifiable proof", async () => {
    const userId = await linkedUser("alice");
    const res = await get(
      `/api/auth/attribution?subject=${userId}`,
      await bearer(["parachute:host:auth"]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      subject: string;
      pubkeys: { pubkey: string; label: string; proof_event: NostrEvent }[];
    };
    expect(body.subject).toBe(userId);
    expect(body.pubkeys).toHaveLength(1);
    expect(body.pubkeys[0]!.pubkey).toBe(PUBKEY);
    expect(body.pubkeys[0]!.label).toBe("laptop");
    // The whole point of phase 1: a third party can check it themselves.
    expect(verifyNostrEvent(body.pubkeys[0]!.proof_event)).toEqual({ ok: true });
  });

  test("an unknown subject and an unlinked subject are indistinguishable", async () => {
    const u = await createUser(db, "bob", "correct-horse-battery", {
      allowMulti: true,
      passwordChanged: true,
    });
    const token = await bearer(["parachute:host:auth"]);
    const unlinked = await (await get(`/api/auth/attribution?subject=${u.id}`, token)).json();
    const unknown = await (
      await get("/api/auth/attribution?subject=no-such-user-at-all", token)
    ).json();
    expect((unlinked as { pubkeys: unknown[] }).pubkeys).toEqual([]);
    expect((unknown as { pubkeys: unknown[] }).pubkeys).toEqual([]);
    // Identical but for the echoed subject — no existence oracle.
    expect(Object.keys(unlinked as object).sort()).toEqual(Object.keys(unknown as object).sort());
  });

  test("never reveals another subject's keys", async () => {
    const alice = await linkedUser("alice");
    const bob = await createUser(db, "bob", "correct-horse-battery", {
      allowMulti: true,
      passwordChanged: true,
    });
    const res = await get(
      `/api/auth/attribution?subject=${bob.id}`,
      await bearer(["parachute:host:auth"]),
    );
    const dump = JSON.stringify(await res.json());
    expect(dump).not.toContain(PUBKEY);
    expect(dump).not.toContain(alice);
  });

  test("keeps a registry-attributed proof resolvable after unlink", async () => {
    const userId = await linkedUser("alice");
    recordTokenMint(db, {
      jti: "jti-unlinked-proof",
      createdVia: "cli_mint",
      subject: userId,
      userId,
      clientId: "parachute-hub",
      scopes: ["vault:work:read"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(unlinkPubkey(db, userId, PUBKEY)).toBe(true);

    const res = await get(
      `/api/auth/attribution?subject=${userId}`,
      await bearer(["parachute:host:auth"]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pubkeys: { proof_event: NostrEvent }[] };
    expect(body.pubkeys).toHaveLength(1);
    expect(verifyNostrEvent(body.pubkeys[0]!.proof_event)).toEqual({ ok: true });
  });

  test("keeps a registry-attributed proof resolvable after account deletion", async () => {
    const userId = await linkedUser("alice");
    recordTokenMint(db, {
      jti: "jti-deleted-user-proof",
      createdVia: "cli_mint",
      subject: userId,
      userId,
      clientId: "parachute-hub",
      scopes: ["vault:work:read"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(deleteUser(db, userId)).toBe(true);

    const res = await get(
      `/api/auth/attribution?subject=${userId}`,
      await bearer(["parachute:host:auth"]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pubkeys: { proof_event: NostrEvent }[] };
    expect(body.pubkeys).toHaveLength(1);
    expect(verifyNostrEvent(body.pubkeys[0]!.proof_event)).toEqual({ ok: true });
  });
});

describe("GET /api/auth/tokens surfaces the snapshot", () => {
  test("subject_pubkey rides the registry list", async () => {
    const userId = await linkedUser("alice");
    recordTokenMint(db, {
      jti: "jti-listed",
      createdVia: "cli_mint",
      subject: userId,
      clientId: "parachute-hub",
      scopes: ["vault:work:read"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await handleApiTokens(
      new Request(`${ISSUER}/api/auth/tokens`, {
        headers: { authorization: `Bearer ${await bearer(["parachute:host:auth"])}` },
      }),
      { db, issuer: ISSUER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: { jti: string; subject_pubkey: string | null }[] };
    const row = body.tokens.find((t) => t.jti === "jti-listed");
    expect(row?.subject_pubkey).toBe(PUBKEY);
  });
});
