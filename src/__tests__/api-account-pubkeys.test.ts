/**
 * `/api/account/pubkeys*` — the hub#833 phase-1a linkage ceremony over HTTP.
 *
 * Coverage (auth surface — every new input gets a rejection test):
 *   - auth posture: no session → 401 on every route; bad CSRF → 403 on every
 *     mutation; self-only (no client-supplied user id exists to test)
 *   - challenge: shape of the returned template, TTL, rate limit
 *   - verify: happy path; wrong kind; stale created_at; missing/foreign
 *     `u` tag; wrong `method` tag; absent challenge tag; unknown challenge;
 *     replayed event; a signature by a different key; a tampered id;
 *     malformed event shape; oversized label; cross-user pubkey collision
 *   - the challenge issued to user A cannot be spent by user B
 *   - list: returns only the caller's keys, never another user's
 *   - unlink: self-only, idempotent
 *   - no response body ever echoes the raw challenge back after consumption,
 *     and no error distinguishes the four challenge-failure modes
 *   - existing `/api/account/*` routes keep their 405-before-auth behavior
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { handleApiAccount } from "../api-account-2fa.ts";
import {
  MAX_PUBKEY_LABEL_LEN,
  PUBKEY_VERIFY_PATH,
  VERIFY_MAX_CREATED_AT_SKEW_SECONDS,
} from "../api-account-pubkeys.ts";
import { CSRF_COOKIE_NAME } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { NOSTR_AUTH_KIND, type NostrEvent, nostrEventId } from "../nostr-event.ts";
import { listUserPubkeys } from "../pubkey-links.ts";
import { __resetForTests as resetRateLimit } from "../rate-limit.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { createUser } from "../users.ts";

const TEST_CSRF = "csrf-account-pubkeys";
const CSRF_COOKIE = `${CSRF_COOKIE_NAME}=${TEST_CSRF}`;
const ORIGIN = "https://hub.example";
const BOUND = [ORIGIN, "http://localhost:1939"];

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const SECRET_A = hexToBytes("11".repeat(32));
const SECRET_B = hexToBytes("22".repeat(32));
const PUBKEY_A = bytesToHex(schnorr.getPublicKey(SECRET_A));
const PUBKEY_B = bytesToHex(schnorr.getPublicKey(SECRET_B));

let db: Database;
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "phub-api-pubkeys-"));
  db = openHubDb(hubDbPath(configDir));
  resetRateLimit();
});

afterEach(() => {
  db.close();
  rmSync(configDir, { recursive: true, force: true });
});

async function userWithSession(username: string): Promise<{ userId: string; cookie: string }> {
  const u = await createUser(db, username, "correct-horse-battery", {
    allowMulti: true,
    passwordChanged: true,
  });
  const session = createSession(db, { userId: u.id });
  return {
    userId: u.id,
    cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
  };
}

function call(
  method: string,
  subpath: string,
  cookie: string | null,
  body?: Record<string, unknown>,
  now?: () => Date,
): Promise<Response> {
  const req = new Request(`${ORIGIN}/api/account/pubkeys${subpath}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleApiAccount(req, `/pubkeys${subpath}`, {
    db,
    hubBoundOrigins: BOUND,
    ...(now ? { now } : {}),
  });
}

function signEvent(
  secret: Uint8Array,
  parts: { created_at?: number; kind?: number; tags?: string[][]; content?: string } = {},
): NostrEvent {
  const unsigned = {
    pubkey: bytesToHex(schnorr.getPublicKey(secret)),
    created_at: parts.created_at ?? Math.floor(Date.now() / 1000),
    kind: parts.kind ?? NOSTR_AUTH_KIND,
    tags: parts.tags ?? [],
    content: parts.content ?? "",
  };
  const id = nostrEventId(unsigned);
  return { ...unsigned, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), secret)) };
}

function linkageTags(challenge: string, over: { u?: string; method?: string } = {}): string[][] {
  return [
    ["u", over.u ?? `${ORIGIN}${PUBKEY_VERIFY_PATH}`],
    ["method", over.method ?? "POST"],
    ["challenge", challenge],
  ];
}

async function getChallenge(cookie: string): Promise<string> {
  const res = await call("POST", "/challenge", cookie, { __csrf: TEST_CSRF });
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}

async function linkKey(
  cookie: string,
  secret: Uint8Array,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const challenge = await getChallenge(cookie);
  const event = signEvent(secret, { tags: linkageTags(challenge) });
  return call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event, ...extra });
}

describe("auth posture", () => {
  test("every route needs a session", async () => {
    for (const [method, path, body] of [
      ["GET", "", undefined],
      ["POST", "/challenge", { __csrf: TEST_CSRF }],
      ["POST", "/verify", { __csrf: TEST_CSRF, event: {} }],
      ["POST", "/unlink", { __csrf: TEST_CSRF, pubkey: PUBKEY_A }],
    ] as const) {
      const res = await call(method, path, null, body as Record<string, unknown> | undefined);
      expect(res.status).toBe(401);
    }
  });

  test("every mutation needs a valid CSRF token", async () => {
    const { cookie } = await userWithSession("alice");
    for (const [path, body] of [
      ["/challenge", {}],
      ["/verify", { event: {} }],
      ["/unlink", { pubkey: PUBKEY_A }],
    ] as const) {
      const res = await call("POST", path, cookie, { ...body, __csrf: "wrong" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("csrf_failed");
    }
  });

  test("the read route does not require CSRF but does require a session", async () => {
    const { cookie } = await userWithSession("alice");
    expect((await call("GET", "", cookie)).status).toBe(200);
  });

  test("unknown methods and subpaths 405/404 rather than falling through", async () => {
    const { cookie } = await userWithSession("alice");
    // CSRF is checked before the method dispatch, so an unknown method still
    // has to carry the token — an unauthenticated probe gets 403, not 405.
    expect((await call("DELETE", "", cookie)).status).toBe(403);
    expect((await call("DELETE", "", cookie, { __csrf: TEST_CSRF })).status).toBe(405);
    expect((await call("POST", "/nope", cookie, { __csrf: TEST_CSRF })).status).toBe(404);
    expect((await call("GET", "/nope", cookie)).status).toBe(404);
  });

  test("existing /api/account routes keep 405-before-auth", async () => {
    const req = new Request(`${ORIGIN}/api/account/password`, { method: "GET" });
    expect((await handleApiAccount(req, "/password", { db })).status).toBe(405);
  });
});

describe("POST /challenge", () => {
  test("returns a single-use challenge plus the exact event template to sign", async () => {
    const { cookie } = await userWithSession("alice");
    const res = await call("POST", "/challenge", cookie, { __csrf: TEST_CSRF });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      challenge: string;
      expires_at: string;
      event_template: { kind: number; tags: string[][]; content: string };
    };
    expect(body.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now());
    expect(body.event_template.kind).toBe(NOSTR_AUTH_KIND);
    expect(body.event_template.content).toBe("");
    expect(body.event_template.tags).toEqual([
      ["u", `${ORIGIN}${PUBKEY_VERIFY_PATH}`],
      ["method", "POST"],
      ["challenge", body.challenge],
    ]);
  });

  test("is rate limited per user", async () => {
    const { cookie } = await userWithSession("alice");
    let sawLimit = false;
    for (let i = 0; i < 40; i++) {
      const res = await call("POST", "/challenge", cookie, { __csrf: TEST_CSRF });
      if (res.status === 429) {
        sawLimit = true;
        expect(res.headers.get("retry-after")).toBeTruthy();
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });
});

describe("POST /verify — happy path", () => {
  test("links a key proved by a real NIP-01 signature", async () => {
    const { cookie, userId } = await userWithSession("alice");
    const res = await linkKey(cookie, SECRET_A, { label: "laptop" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linked: boolean; pubkey: string; label: string };
    expect(body).toMatchObject({ linked: true, pubkey: PUBKEY_A, label: "laptop" });
    expect(listUserPubkeys(db, userId).map((l) => l.pubkey)).toEqual([PUBKEY_A]);
  });

  test("stores the verbatim proof event so possession stays re-verifiable", async () => {
    const { cookie } = await userWithSession("alice");
    await linkKey(cookie, SECRET_A);
    const stored = db
      .query<{ proof_event: string; proof_event_id: string }, [string]>(
        "SELECT proof_event, proof_event_id FROM user_pubkeys WHERE pubkey = ?",
      )
      .get(PUBKEY_A);
    const reparsed = JSON.parse(stored!.proof_event) as NostrEvent;
    expect(reparsed.pubkey).toBe(PUBKEY_A);
    expect(nostrEventId(reparsed)).toBe(reparsed.id);
    expect(stored!.proof_event_id).toBe(reparsed.id);
  });

  test("re-verifying the same key is idempotent", async () => {
    const { cookie, userId } = await userWithSession("alice");
    expect((await linkKey(cookie, SECRET_A, { label: "old" })).status).toBe(200);
    const res = await linkKey(cookie, SECRET_A, { label: "new" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { relinked: boolean }).relinked).toBe(true);
    expect(listUserPubkeys(db, userId)).toHaveLength(1);
    expect(listUserPubkeys(db, userId)[0]!.label).toBe("new");
  });
});

describe("POST /verify — rejections", () => {
  test("a malformed event is refused without touching the DB", async () => {
    const { cookie, userId } = await userWithSession("alice");
    const challenge = await getChallenge(cookie);
    for (const event of [null, 3, "str", {}, { pubkey: "nope" }]) {
      const res = await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_event");
    }
    expect(listUserPubkeys(db, userId)).toHaveLength(0);
    // The challenge survived — nothing was consumed.
    const good = signEvent(SECRET_A, { tags: linkageTags(challenge) });
    expect((await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event: good })).status).toBe(
      200,
    );
  });

  test("a wrong kind is refused", async () => {
    const { cookie } = await userWithSession("alice");
    const challenge = await getChallenge(cookie);
    const event = signEvent(SECRET_A, { kind: 1, tags: linkageTags(challenge) });
    const res = await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_event");
  });

  test("a stale created_at is refused", async () => {
    const { cookie } = await userWithSession("alice");
    const challenge = await getChallenge(cookie);
    const stale = Math.floor(Date.now() / 1000) - VERIFY_MAX_CREATED_AT_SKEW_SECONDS - 60;
    const event = signEvent(SECRET_A, { created_at: stale, tags: linkageTags(challenge) });
    const res = await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_event");
  });

  test("a far-future created_at is refused", async () => {
    const { cookie } = await userWithSession("alice");
    const challenge = await getChallenge(cookie);
    const future = Math.floor(Date.now() / 1000) + VERIFY_MAX_CREATED_AT_SKEW_SECONDS + 60;
    const event = signEvent(SECRET_A, { created_at: future, tags: linkageTags(challenge) });
    expect((await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event })).status).toBe(400);
  });

  test("a `u` tag naming a foreign origin is refused", async () => {
    const { cookie } = await userWithSession("alice");
    const challenge = await getChallenge(cookie);
    const event = signEvent(SECRET_A, {
      tags: linkageTags(challenge, { u: `https://evil.example${PUBKEY_VERIFY_PATH}` }),
    });
    const res = await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_event");
  });

  test("a `u` tag naming the right origin but a different path is refused", async () => {
    const { cookie } = await userWithSession("alice");
    const challenge = await getChallenge(cookie);
    const event = signEvent(SECRET_A, {
      tags: linkageTags(challenge, { u: `${ORIGIN}/oauth/token` }),
    });
    expect((await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event })).status).toBe(400);
  });

  test("a missing or wrong `method` tag is refused", async () => {
    const { cookie } = await userWithSession("alice");
    for (const method of ["GET", "post", ""]) {
      const challenge = await getChallenge(cookie);
      const event = signEvent(SECRET_A, { tags: linkageTags(challenge, { method }) });
      expect((await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event })).status).toBe(
        400,
      );
    }
  });

  test("an event with no challenge tag is refused", async () => {
    const { cookie } = await userWithSession("alice");
    await getChallenge(cookie);
    const event = signEvent(SECRET_A, {
      tags: [
        ["u", `${ORIGIN}${PUBKEY_VERIFY_PATH}`],
        ["method", "POST"],
      ],
    });
    expect((await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event })).status).toBe(400);
  });

  test("a tampered id is refused", async () => {
    const { cookie } = await userWithSession("alice");
    const challenge = await getChallenge(cookie);
    const event = signEvent(SECRET_A, { tags: linkageTags(challenge) });
    const res = await call("POST", "/verify", cookie, {
      __csrf: TEST_CSRF,
      event: { ...event, content: "smuggled" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("proof_failed");
  });

  test("a signature by a key other than the claimed pubkey is refused", async () => {
    const { cookie, userId } = await userWithSession("alice");
    const challenge = await getChallenge(cookie);
    const real = signEvent(SECRET_B, { tags: linkageTags(challenge) });
    // Claim A's pubkey but keep B's signature.
    const forged = { ...real, pubkey: PUBKEY_A };
    const withId = { ...forged, id: nostrEventId(forged) };
    const res = await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event: withId });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("proof_failed");
    expect(listUserPubkeys(db, userId)).toHaveLength(0);
  });

  test("an unknown challenge is refused with the same generic error as a replay", async () => {
    const { cookie } = await userWithSession("alice");
    const unknown = signEvent(SECRET_A, { tags: linkageTags("f".repeat(64)) });
    const resUnknown = await call("POST", "/verify", cookie, {
      __csrf: TEST_CSRF,
      event: unknown,
    });
    expect(resUnknown.status).toBe(400);
    const unknownBody = (await resUnknown.json()) as { error: string; error_description: string };

    const challenge = await getChallenge(cookie);
    const event = signEvent(SECRET_A, { tags: linkageTags(challenge) });
    expect((await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event })).status).toBe(200);
    const resReplay = await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event });
    expect(resReplay.status).toBe(400);
    const replayBody = (await resReplay.json()) as { error: string; error_description: string };

    // Indistinguishable: no oracle for "did that challenge ever exist".
    expect(replayBody).toEqual(unknownBody);
    expect(replayBody.error).toBe("challenge_invalid");
  });

  test("one user cannot spend another user's challenge", async () => {
    const alice = await userWithSession("alice");
    const bob = await userWithSession("bob");
    const challenge = await getChallenge(alice.cookie);
    const event = signEvent(SECRET_B, { tags: linkageTags(challenge) });
    const res = await call("POST", "/verify", bob.cookie, { __csrf: TEST_CSRF, event });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("challenge_invalid");
    expect(listUserPubkeys(db, bob.userId)).toHaveLength(0);
  });

  test("a key already linked to another user is refused without naming the holder", async () => {
    const alice = await userWithSession("alice");
    const bob = await userWithSession("bob");
    expect((await linkKey(alice.cookie, SECRET_A)).status).toBe(200);
    const res = await linkKey(bob.cookie, SECRET_A);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("pubkey_taken");
    // No cross-account leak: the holder's username / id appears nowhere.
    const dump = JSON.stringify(body);
    expect(dump).not.toContain("alice");
    expect(dump).not.toContain(alice.userId);
    expect(listUserPubkeys(db, bob.userId)).toHaveLength(0);
  });

  test("an oversized or non-string label is refused", async () => {
    const { cookie } = await userWithSession("alice");
    const challenge = await getChallenge(cookie);
    const event = signEvent(SECRET_A, { tags: linkageTags(challenge) });
    for (const label of [5, "x".repeat(MAX_PUBKEY_LABEL_LEN + 1), "has\nnewline"]) {
      const res = await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event, label });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_label");
    }
  });

  test("is rate limited per user", async () => {
    const { cookie } = await userWithSession("alice");
    const bad = signEvent(SECRET_A, { tags: linkageTags("0".repeat(64)) });
    let sawLimit = false;
    for (let i = 0; i < 40; i++) {
      const res = await call("POST", "/verify", cookie, { __csrf: TEST_CSRF, event: bad });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });
});

describe("GET /pubkeys", () => {
  test("lists only the caller's own keys and never the proof body", async () => {
    const alice = await userWithSession("alice");
    const bob = await userWithSession("bob");
    await linkKey(alice.cookie, SECRET_A, { label: "laptop" });
    await linkKey(bob.cookie, SECRET_B);

    const res = await call("GET", "", alice.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { pubkeys: Record<string, unknown>[] };
    expect(body.pubkeys).toHaveLength(1);
    expect(body.pubkeys[0]).toMatchObject({ pubkey: PUBKEY_A, label: "laptop" });
    expect(Object.keys(body.pubkeys[0]!).sort()).toEqual([
      "label",
      "last_verified_at",
      "linked_at",
      "proof_event_id",
      "pubkey",
    ]);
    const dump = JSON.stringify(body);
    expect(dump).not.toContain(PUBKEY_B);
    expect(dump).not.toContain(bob.userId);
  });
});

describe("POST /unlink", () => {
  test("removes the caller's own key and is idempotent", async () => {
    const { cookie, userId } = await userWithSession("alice");
    await linkKey(cookie, SECRET_A);
    const res = await call("POST", "/unlink", cookie, { __csrf: TEST_CSRF, pubkey: PUBKEY_A });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { unlinked: boolean }).unlinked).toBe(true);
    expect(listUserPubkeys(db, userId)).toHaveLength(0);

    const again = await call("POST", "/unlink", cookie, { __csrf: TEST_CSRF, pubkey: PUBKEY_A });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { unlinked: boolean }).unlinked).toBe(false);
  });

  test("cannot unlink another user's key, and reports the same shape as a no-op", async () => {
    const alice = await userWithSession("alice");
    const bob = await userWithSession("bob");
    await linkKey(alice.cookie, SECRET_A);
    const res = await call("POST", "/unlink", bob.cookie, { __csrf: TEST_CSRF, pubkey: PUBKEY_A });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { unlinked: boolean }).unlinked).toBe(false);
    expect(listUserPubkeys(db, alice.userId)).toHaveLength(1);
  });

  test("rejects a malformed pubkey", async () => {
    const { cookie } = await userWithSession("alice");
    for (const pubkey of ["", "nope", PUBKEY_A.toUpperCase(), 5, undefined]) {
      const res = await call("POST", "/unlink", cookie, { __csrf: TEST_CSRF, pubkey });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_pubkey");
    }
  });
});
