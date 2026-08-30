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
 *   - the statement binding: an event signed against ANOTHER account's
 *     statement is refused even when every other check passes (the
 *     confused-deputy case — see `linkageStatement`)
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
  linkageStatement,
} from "../api-account-pubkeys.ts";
import { CSRF_COOKIE_NAME } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { NOSTR_AUTH_KIND, type NostrEvent, nostrEventId } from "../nostr-event.ts";
import { listUserPubkeys } from "../pubkey-links.ts";
import { __resetForTests as resetRateLimit } from "../rate-limit.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { createUser, getUserByUsername } from "../users.ts";

const TEST_CSRF = "csrf-account-pubkeys";
const CSRF_COOKIE = `${CSRF_COOKIE_NAME}=${TEST_CSRF}`;
const ORIGIN = "https://hub.example";
const BOUND = [ORIGIN, "http://localhost:1939"];
/** Every test user is created with this password (used by the HIGH-2 first-link step-up). */
const PASSWORD = "correct-horse-battery";

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

interface TestUser {
  userId: string;
  username: string;
  cookie: string;
}

/** The statement `/verify` will recompute for this account on this origin. */
const statement = (username: string): string => linkageStatement(ORIGIN, username);

async function userWithSession(username: string): Promise<TestUser> {
  const u = await createUser(db, username, PASSWORD, {
    allowMulti: true,
    passwordChanged: true,
  });
  const session = createSession(db, { userId: u.id });
  return {
    userId: u.id,
    username: u.username,
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

/**
 * A fully-valid linkage event for `username`: right kind, right tags, right
 * statement. Overrides let a test break exactly one thing.
 */
function signLinkage(
  secret: Uint8Array,
  username: string,
  challenge: string,
  over: {
    u?: string;
    method?: string;
    kind?: number;
    created_at?: number;
    content?: string;
  } = {},
): NostrEvent {
  return signEvent(secret, {
    tags: linkageTags(challenge, { u: over.u, method: over.method }),
    content: over.content ?? statement(username),
    ...(over.kind === undefined ? {} : { kind: over.kind }),
    ...(over.created_at === undefined ? {} : { created_at: over.created_at }),
  });
}

async function getChallenge(cookie: string): Promise<string> {
  const res = await call("POST", "/challenge", cookie, { __csrf: TEST_CSRF });
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}

async function linkKey(
  user: TestUser,
  secret: Uint8Array,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const challenge = await getChallenge(user.cookie);
  const event = signLinkage(secret, user.username, challenge);
  // Always supply the password: the FIRST link requires it (HIGH-2 step-up),
  // and it is ignored on subsequent links. `extra` can override.
  return call("POST", "/verify", user.cookie, {
    __csrf: TEST_CSRF,
    event,
    password: PASSWORD,
    ...extra,
  });
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
    const alice = await userWithSession("alice");
    for (const [path, body] of [
      ["/challenge", {}],
      ["/verify", { event: {} }],
      ["/unlink", { pubkey: PUBKEY_A }],
    ] as const) {
      const res = await call("POST", path, alice.cookie, { ...body, __csrf: "wrong" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("csrf_failed");
    }
  });

  test("the read route does not require CSRF but does require a session", async () => {
    const alice = await userWithSession("alice");
    expect((await call("GET", "", alice.cookie)).status).toBe(200);
  });

  test("unknown methods and subpaths 405/404 rather than falling through", async () => {
    const alice = await userWithSession("alice");
    // CSRF is checked before the method dispatch, so an unknown method still
    // has to carry the token — an unauthenticated probe gets 403, not 405.
    expect((await call("DELETE", "", alice.cookie)).status).toBe(403);
    expect((await call("DELETE", "", alice.cookie, { __csrf: TEST_CSRF })).status).toBe(405);
    expect((await call("POST", "/nope", alice.cookie, { __csrf: TEST_CSRF })).status).toBe(404);
    expect((await call("GET", "/nope", alice.cookie)).status).toBe(404);
  });

  test("existing /api/account routes keep 405-before-auth", async () => {
    const req = new Request(`${ORIGIN}/api/account/password`, { method: "GET" });
    expect((await handleApiAccount(req, "/password", { db })).status).toBe(405);
  });
});

describe("POST /challenge", () => {
  test("returns a single-use challenge plus the exact event template to sign", async () => {
    const alice = await userWithSession("alice");
    const res = await call("POST", "/challenge", alice.cookie, { __csrf: TEST_CSRF });
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
    expect(body.event_template.tags).toEqual([
      ["u", `${ORIGIN}${PUBKEY_VERIFY_PATH}`],
      ["method", "POST"],
      ["challenge", body.challenge],
    ]);
  });

  test("the template's content is a legible statement naming this account and hub", async () => {
    const alice = await userWithSession("alice");
    const res = await call("POST", "/challenge", alice.cookie, { __csrf: TEST_CSRF });
    const body = (await res.json()) as { event_template: { content: string } };
    // A human asked to sign this can read who and where it binds them to.
    expect(body.event_template.content).toBe(statement("alice"));
    expect(body.event_template.content).toContain("alice");
    expect(body.event_template.content).toContain(ORIGIN);
  });

  test("is rate limited per user", async () => {
    const alice = await userWithSession("alice");
    let sawLimit = false;
    for (let i = 0; i < 40; i++) {
      const res = await call("POST", "/challenge", alice.cookie, { __csrf: TEST_CSRF });
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
    const alice = await userWithSession("alice");
    const res = await linkKey(alice, SECRET_A, { label: "laptop" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linked: boolean; pubkey: string; label: string };
    expect(body).toMatchObject({ linked: true, pubkey: PUBKEY_A, label: "laptop" });
    expect(listUserPubkeys(db, alice.userId).map((l) => l.pubkey)).toEqual([PUBKEY_A]);
  });

  test("the event returned by /challenge verbatim is exactly what /verify accepts", async () => {
    // No hand-built event: sign precisely the template the server handed out.
    const alice = await userWithSession("alice");
    const chRes = await call("POST", "/challenge", alice.cookie, { __csrf: TEST_CSRF });
    const { event_template } = (await chRes.json()) as {
      event_template: { kind: number; content: string; tags: string[][] };
    };
    const unsigned = {
      pubkey: PUBKEY_A,
      created_at: Math.floor(Date.now() / 1000),
      kind: event_template.kind,
      tags: event_template.tags,
      content: event_template.content,
    };
    const id = nostrEventId(unsigned);
    const event = { ...unsigned, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), SECRET_A)) };
    const res = await call("POST", "/verify", alice.cookie, {
      __csrf: TEST_CSRF,
      event,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
  });

  test("stores the verbatim proof event so possession stays re-verifiable", async () => {
    const alice = await userWithSession("alice");
    await linkKey(alice, SECRET_A);
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
    const alice = await userWithSession("alice");
    expect((await linkKey(alice, SECRET_A, { label: "old" })).status).toBe(200);
    const res = await linkKey(alice, SECRET_A, { label: "new" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { relinked: boolean }).relinked).toBe(true);
    expect(listUserPubkeys(db, alice.userId)).toHaveLength(1);
    expect(listUserPubkeys(db, alice.userId)[0]!.label).toBe("new");
  });

  // hub#862. The wizard omits `label` entirely when its field is blank, so a
  // plain "prove this key again" round trip used to silently wipe a label the
  // user had set. Absent is now "unspecified"; only an explicit erase erases.
  test("a re-verify carrying no label keeps the existing one", async () => {
    const alice = await userWithSession("alice");
    expect((await linkKey(alice, SECRET_A, { label: "laptop" })).status).toBe(200);

    const res = await linkKey(alice, SECRET_A);
    expect(res.status).toBe(200);
    expect((await res.json()) as { relinked: boolean; label: string | null }).toMatchObject({
      relinked: true,
      label: "laptop",
    });
    expect(listUserPubkeys(db, alice.userId)[0]!.label).toBe("laptop");
  });

  test("a re-verify with an explicit null or empty label clears it", async () => {
    for (const [name, cleared] of [
      ["alice", null],
      ["bob", ""],
    ] as const) {
      const user = await userWithSession(name);
      const secret = name === "alice" ? SECRET_A : SECRET_B;
      expect((await linkKey(user, secret, { label: "laptop" })).status).toBe(200);
      const res = await linkKey(user, secret, { label: cleared });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { label: string | null }).label).toBeNull();
      expect(listUserPubkeys(db, user.userId)[0]!.label).toBeNull();
    }
  });
});

describe("POST /verify — the statement binding", () => {
  test("an event signed against ANOTHER account's statement is refused", async () => {
    // The confused-deputy case (`linkageStatement`): mallory holds a hub
    // account but no key. She mints her own challenge and gets the victim to
    // sign an event carrying it — but the statement the victim signed names
    // the victim's account, not mallory's, so /verify refuses it. The key
    // never lands on mallory's account, and mallory's writes never resolve to
    // the victim's npub.
    const mallory = await userWithSession("mallory");
    const victim = await userWithSession("victim");
    const challenge = await getChallenge(mallory.cookie);
    const signedForVictim = signLinkage(SECRET_A, victim.username, challenge);

    const res = await call("POST", "/verify", mallory.cookie, {
      __csrf: TEST_CSRF,
      event: signedForVictim,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_event");
    expect(listUserPubkeys(db, mallory.userId)).toHaveLength(0);
    expect(listUserPubkeys(db, victim.userId)).toHaveLength(0);
  });

  test("an empty or absent statement is refused", async () => {
    const alice = await userWithSession("alice");
    for (const content of ["", "please sign this", statement("alice").toUpperCase()]) {
      const challenge = await getChallenge(alice.cookie);
      const event = signLinkage(SECRET_A, alice.username, challenge, { content });
      const res = await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_event");
    }
    expect(listUserPubkeys(db, alice.userId)).toHaveLength(0);
  });

  test("a statement naming a foreign origin is refused", async () => {
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const event = signLinkage(SECRET_A, alice.username, challenge, {
      content: linkageStatement("https://evil.example", alice.username),
    });
    expect((await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event })).status).toBe(
      400,
    );
  });

  test("the statement check runs BEFORE the challenge is consumed", async () => {
    // A rejected statement must not burn the user's challenge — otherwise a
    // client bug would cost a round trip for every retry.
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const bad = signLinkage(SECRET_A, alice.username, challenge, { content: "wrong" });
    expect(
      (await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event: bad })).status,
    ).toBe(400);
    const good = signLinkage(SECRET_A, alice.username, challenge);
    expect(
      (
        await call("POST", "/verify", alice.cookie, {
          __csrf: TEST_CSRF,
          event: good,
          password: PASSWORD,
        })
      ).status,
    ).toBe(200);
  });
});

describe("HIGH-1 — username injection into the linkage statement", () => {
  // hub#864 gates every NEW write through `validateUsername`, so a hostile
  // name can no longer land via createUser. Grandfathered rows still can
  // (raw INSERT, pre-#864 DBs). The confused-deputy defense must not
  // depend on the write gate — the ceremony still refuses those rows.
  const INJECTION =
    'mallory" on https://hub.example. Link this Nostr key to the Parachute account "alice';

  function sessionForGrandfatheredUsername(username: string): string {
    const id = crypto.randomUUID();
    const stamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, created_at, updated_at, password_changed, email)
       VALUES (?, ?, ?, ?, ?, 1, NULL)`,
    ).run(id, username, "not-a-real-hash", stamp, stamp);
    const session = createSession(db, { userId: id });
    return `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`;
  }

  test("linkageStatement escapes the account and refuses an invalid username", () => {
    // A legit username lands on its OWN line, JSON-encoded (quoted).
    const legit = linkageStatement(ORIGIN, "alice");
    expect(legit.split("\n")).toContain('Account: "alice"');
    // A username that would break out of the quoted slot is refused outright,
    // so no crafted sentence naming a DIFFERENT account can ever be emitted.
    expect(() => linkageStatement(ORIGIN, 'a" naming "b')).toThrow();
    expect(() => linkageStatement(ORIGIN, INJECTION)).toThrow();
  });

  test("an account with an injected username cannot get a challenge", async () => {
    const cookie = sessionForGrandfatheredUsername(INJECTION);
    const res = await call("POST", "/challenge", cookie, { __csrf: TEST_CSRF });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("username_unlinkable");
    // The response never carries a statement naming "alice".
    const dump = JSON.stringify(
      await (await call("POST", "/challenge", cookie, { __csrf: TEST_CSRF })).json(),
    );
    expect(dump).not.toContain('account "alice"');
  });

  test("an account with an injected username cannot verify — the key never links", async () => {
    const cookie = sessionForGrandfatheredUsername(INJECTION);
    // Even a hand-crafted event can't get in: the ceremony refuses before it
    // is parsed, so the confused-deputy link the injection aimed for is
    // impossible regardless of what the victim signed.
    const event = signEvent(SECRET_A, { content: "anything", tags: [] });
    const res = await call("POST", "/verify", cookie, {
      __csrf: TEST_CSRF,
      event,
      password: PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("username_unlinkable");
    const evil = getUserByUsername(db, INJECTION);
    expect(listUserPubkeys(db, evil!.id)).toHaveLength(0);
  });
});

describe("HIGH-2 — first-link password step-up", () => {
  test("the FIRST link is refused with no password, and no key is linked", async () => {
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const event = signLinkage(SECRET_A, alice.username, challenge);
    // A hijacked session (session + CSRF only) must not be able to bind an
    // attacker-held key to a victim who has no prior key.
    const res = await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("password_required");
    expect(listUserPubkeys(db, alice.userId)).toHaveLength(0);
  });

  test("the FIRST link is refused with the wrong password, and no key is linked", async () => {
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const event = signLinkage(SECRET_A, alice.username, challenge);
    const res = await call("POST", "/verify", alice.cookie, {
      __csrf: TEST_CSRF,
      event,
      password: "not-the-password",
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_credentials");
    expect(listUserPubkeys(db, alice.userId)).toHaveLength(0);
  });

  test("the FIRST link needs the password; a SECOND link on the same account does not", async () => {
    const alice = await userWithSession("alice");
    // First link — password required.
    const c1 = await getChallenge(alice.cookie);
    const first = await call("POST", "/verify", alice.cookie, {
      __csrf: TEST_CSRF,
      event: signLinkage(SECRET_A, alice.username, c1),
      password: PASSWORD,
    });
    expect(first.status).toBe(200);
    // Second link with a DIFFERENT key and NO password — allowed, because the
    // user has already proved possession of a key on this account.
    const c2 = await getChallenge(alice.cookie);
    const second = await call("POST", "/verify", alice.cookie, {
      __csrf: TEST_CSRF,
      event: signLinkage(SECRET_B, alice.username, c2),
    });
    expect(second.status).toBe(200);
    expect(
      listUserPubkeys(db, alice.userId)
        .map((l) => l.pubkey)
        .sort(),
    ).toEqual([PUBKEY_A, PUBKEY_B].sort());
  });
});

describe("POST /verify — rejections", () => {
  test("a malformed event is refused without touching the DB", async () => {
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    for (const event of [null, 3, "str", {}, { pubkey: "nope" }]) {
      const res = await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_event");
    }
    expect(listUserPubkeys(db, alice.userId)).toHaveLength(0);
    // The challenge survived — nothing was consumed.
    const good = signLinkage(SECRET_A, alice.username, challenge);
    expect(
      (
        await call("POST", "/verify", alice.cookie, {
          __csrf: TEST_CSRF,
          event: good,
          password: PASSWORD,
        })
      ).status,
    ).toBe(200);
  });

  test("a wrong kind is refused", async () => {
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const event = signLinkage(SECRET_A, alice.username, challenge, { kind: 1 });
    const res = await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_event");
  });

  test("a stale created_at is refused", async () => {
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const stale = Math.floor(Date.now() / 1000) - VERIFY_MAX_CREATED_AT_SKEW_SECONDS - 60;
    const event = signLinkage(SECRET_A, alice.username, challenge, { created_at: stale });
    const res = await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_event");
  });

  test("a far-future created_at is refused", async () => {
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const future = Math.floor(Date.now() / 1000) + VERIFY_MAX_CREATED_AT_SKEW_SECONDS + 60;
    const event = signLinkage(SECRET_A, alice.username, challenge, { created_at: future });
    expect((await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event })).status).toBe(
      400,
    );
  });

  test("a `u` tag naming a foreign origin is refused", async () => {
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const event = signLinkage(SECRET_A, alice.username, challenge, {
      u: `https://evil.example${PUBKEY_VERIFY_PATH}`,
    });
    const res = await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_event");
  });

  test("a `u` tag naming the right origin but a different path is refused", async () => {
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const event = signLinkage(SECRET_A, alice.username, challenge, { u: `${ORIGIN}/oauth/token` });
    expect((await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event })).status).toBe(
      400,
    );
  });

  test("a missing or wrong `method` tag is refused", async () => {
    const alice = await userWithSession("alice");
    for (const method of ["GET", "post", ""]) {
      const challenge = await getChallenge(alice.cookie);
      const event = signLinkage(SECRET_A, alice.username, challenge, { method });
      expect(
        (await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event })).status,
      ).toBe(400);
    }
  });

  test("an event with no challenge tag is refused", async () => {
    const alice = await userWithSession("alice");
    await getChallenge(alice.cookie);
    const event = signEvent(SECRET_A, {
      content: statement(alice.username),
      tags: [
        ["u", `${ORIGIN}${PUBKEY_VERIFY_PATH}`],
        ["method", "POST"],
      ],
    });
    expect((await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event })).status).toBe(
      400,
    );
  });

  test("duplicate binding tags are refused even when the first value is valid", async () => {
    const alice = await userWithSession("alice");
    for (const duplicate of [
      ["u", "https://evil.example/api/account/pubkeys/verify"],
      ["method", "GET"],
      ["challenge", "f".repeat(64)],
    ]) {
      const challenge = await getChallenge(alice.cookie);
      const event = signEvent(SECRET_A, {
        content: statement(alice.username),
        tags: [...linkageTags(challenge), duplicate],
      });
      const res = await call("POST", "/verify", alice.cookie, {
        __csrf: TEST_CSRF,
        event,
        password: PASSWORD,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_event");
    }
    expect(listUserPubkeys(db, alice.userId)).toHaveLength(0);
  });

  test("a tampered id is refused", async () => {
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const event = signLinkage(SECRET_A, alice.username, challenge);
    // Tampering with a covered field: the claimed `id` no longer hashes the
    // payload. Done via a tag (content is now statement-pinned).
    const res = await call("POST", "/verify", alice.cookie, {
      __csrf: TEST_CSRF,
      event: { ...event, tags: [...event.tags, ["smuggled", "value"]] },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("proof_failed");
  });

  test("a signature by a key other than the claimed pubkey is refused", async () => {
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const real = signLinkage(SECRET_B, alice.username, challenge);
    // Claim A's pubkey but keep B's signature.
    const forged = { ...real, pubkey: PUBKEY_A };
    const withId = { ...forged, id: nostrEventId(forged) };
    const res = await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event: withId });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("proof_failed");
    expect(listUserPubkeys(db, alice.userId)).toHaveLength(0);
  });

  test("an unknown challenge is refused with the same generic error as a replay", async () => {
    const alice = await userWithSession("alice");
    const unknown = signLinkage(SECRET_A, alice.username, "f".repeat(64));
    // Password supplied so the first-link step-up (HIGH-2) passes and the
    // request reaches the challenge check — otherwise the two arms would differ
    // on the step-up, not on the challenge-failure indistinguishability we test.
    const resUnknown = await call("POST", "/verify", alice.cookie, {
      __csrf: TEST_CSRF,
      event: unknown,
      password: PASSWORD,
    });
    expect(resUnknown.status).toBe(400);
    const unknownBody = (await resUnknown.json()) as { error: string; error_description: string };

    const challenge = await getChallenge(alice.cookie);
    const event = signLinkage(SECRET_A, alice.username, challenge);
    expect(
      (
        await call("POST", "/verify", alice.cookie, {
          __csrf: TEST_CSRF,
          event,
          password: PASSWORD,
        })
      ).status,
    ).toBe(200);
    const resReplay = await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event });
    expect(resReplay.status).toBe(400);
    const replayBody = (await resReplay.json()) as { error: string; error_description: string };

    // Indistinguishable: no oracle for "did that challenge ever exist".
    expect(replayBody).toEqual(unknownBody);
    expect(replayBody.error).toBe("challenge_invalid");
  });

  test("a captured signed event stays unusable after the ceremony completes", async () => {
    // The hard requirement: replay. The event below is byte-identical to the
    // one that succeeded — an attacker who captured it off the wire, out of a
    // log, or off the client's screen has exactly this. It buys nothing, at
    // any later time, even with the victim's own session.
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const captured = signLinkage(SECRET_A, alice.username, challenge);
    expect(
      (
        await call("POST", "/verify", alice.cookie, {
          __csrf: TEST_CSRF,
          event: captured,
          password: PASSWORD,
        })
      ).status,
    ).toBe(200);

    for (let i = 0; i < 3; i++) {
      const res = await call("POST", "/verify", alice.cookie, {
        __csrf: TEST_CSRF,
        event: captured,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("challenge_invalid");
    }
    // And the row it originally produced is untouched — a failed replay does
    // not refresh `last_verified_at` or re-stamp the proof.
    expect(listUserPubkeys(db, alice.userId)).toHaveLength(1);
  });

  test("one user cannot spend another user's challenge", async () => {
    const alice = await userWithSession("alice");
    const bob = await userWithSession("bob");
    const challenge = await getChallenge(alice.cookie);
    // Signed with BOB's statement so the statement check passes and the
    // challenge-ownership check is what actually rejects this. Password
    // supplied so the first-link step-up (HIGH-2) isn't what rejects it.
    const event = signLinkage(SECRET_B, bob.username, challenge);
    const res = await call("POST", "/verify", bob.cookie, {
      __csrf: TEST_CSRF,
      event,
      password: PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("challenge_invalid");
    expect(listUserPubkeys(db, bob.userId)).toHaveLength(0);
  });

  test("a key already linked to another user is refused without naming the holder", async () => {
    const alice = await userWithSession("alice");
    const bob = await userWithSession("bob");
    expect((await linkKey(alice, SECRET_A)).status).toBe(200);
    const res = await linkKey(bob, SECRET_A);
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
    const alice = await userWithSession("alice");
    const challenge = await getChallenge(alice.cookie);
    const event = signLinkage(SECRET_A, alice.username, challenge);
    for (const label of [5, "x".repeat(MAX_PUBKEY_LABEL_LEN + 1), "has\nnewline"]) {
      const res = await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event, label });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_label");
    }
  });

  test("is rate limited per user", async () => {
    const alice = await userWithSession("alice");
    const bad = signLinkage(SECRET_A, alice.username, "0".repeat(64));
    let sawLimit = false;
    for (let i = 0; i < 40; i++) {
      const res = await call("POST", "/verify", alice.cookie, { __csrf: TEST_CSRF, event: bad });
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
    await linkKey(alice, SECRET_A, { label: "laptop" });
    await linkKey(bob, SECRET_B);

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
    const alice = await userWithSession("alice");
    await linkKey(alice, SECRET_A);
    const res = await call("POST", "/unlink", alice.cookie, {
      __csrf: TEST_CSRF,
      pubkey: PUBKEY_A,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { unlinked: boolean }).unlinked).toBe(true);
    expect(listUserPubkeys(db, alice.userId)).toHaveLength(0);

    const again = await call("POST", "/unlink", alice.cookie, {
      __csrf: TEST_CSRF,
      pubkey: PUBKEY_A,
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { unlinked: boolean }).unlinked).toBe(false);
  });

  test("cannot unlink another user's key, and reports the same shape as a no-op", async () => {
    const alice = await userWithSession("alice");
    const bob = await userWithSession("bob");
    await linkKey(alice, SECRET_A);
    const res = await call("POST", "/unlink", bob.cookie, { __csrf: TEST_CSRF, pubkey: PUBKEY_A });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { unlinked: boolean }).unlinked).toBe(false);
    expect(listUserPubkeys(db, alice.userId)).toHaveLength(1);
  });

  test("rejects a malformed pubkey", async () => {
    const alice = await userWithSession("alice");
    for (const pubkey of ["", "nope", PUBKEY_A.toUpperCase(), 5, undefined]) {
      const res = await call("POST", "/unlink", alice.cookie, { __csrf: TEST_CSRF, pubkey });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_pubkey");
    }
  });
});
