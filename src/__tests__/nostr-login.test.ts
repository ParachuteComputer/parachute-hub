/**
 * `/api/auth/nostr/*` — the human key door (design note "Human key door — sign
 * in with a Nostr key", rows 1-3).
 *
 * Coverage (auth surface — every new input gets a rejection test):
 *   - challenge: two challenges differ; template shape; TTL; limiter 429s;
 *     wrong method 405
 *   - verify happy path: a real keypair generated here, linked through the
 *     `user_pubkeys` write path, mints a `sessions` ROW and sets the session
 *     cookie, and the redirect target follows `loginRedirectTarget`
 *   - verify rejections, each with its own code: wrong nonce, REUSED nonce,
 *     expired nonce, unlinked key, bad signature, tampered id, wrong `u`
 *     origin, wrong `u` path, wrong method tag, wrong kind, stale created_at,
 *     duplicate binding tag, wrong statement, malformed body, malformed event
 *   - no session row is created by ANY rejection
 *   - 2FA: an enrolled user gets `requires_2fa` + a pending-login cookie and NO
 *     session; `PARACHUTE_NOSTR_LOGIN_2FA=off` mints directly
 *   - `next` is sanitized through the same `safeNext` the password doors use
 *   - dispatch: the routes are reachable THROUGH `hubFetch`, with the real
 *     `linkageBoundOrigins` wiring (see the last describe block — everything
 *     above calls the handler directly and would pass even if the route were
 *     never wired into the server)
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { NOSTR_AUTH_KIND, type NostrEvent, nostrEventId } from "../nostr-event.ts";
import {
  NOSTR_LOGIN_2FA_ENV,
  NOSTR_LOGIN_CHALLENGE_TTL_MS,
  NOSTR_LOGIN_MAX_CREATED_AT_SKEW_SECONDS,
  NOSTR_LOGIN_VERIFY_PATH,
  _resetNostrLoginChallenges,
  handleNostrLogin,
  signInStatement,
} from "../nostr-login.ts";
import { PENDING_LOGIN_COOKIE_NAME } from "../pending-login.ts";
import { bindPubkeyOperatorAttested } from "../pubkey-links.ts";
import {
  NOSTR_LOGIN_CHALLENGE_MAX_ATTEMPTS,
  NOSTR_LOGIN_VERIFY_MAX_ATTEMPTS,
  __resetForTests as resetRateLimit,
} from "../rate-limit.ts";
import { SESSION_COOKIE_NAME } from "../sessions.ts";
import { generateTotpSecret } from "../totp.ts";
import { persistEnrollment } from "../two-factor-store.ts";
import { createUser } from "../users.ts";

const ORIGIN = "https://hub.example";
const BOUND = [ORIGIN, "http://localhost:1939"];
const PASSWORD = "correct-horse-battery";
/** Computed access (not `process.env.X`) to stay on the right side of `noDelete`. */
const AUTO_PROVISION_ENV = "PARACHUTE_NOSTR_AUTO_PROVISION";

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** A fresh keypair per call — the door's whole subject is a real signature. */
function keypair(): { secret: Uint8Array; pubkey: string } {
  const secret = schnorr.utils.randomSecretKey();
  return { secret, pubkey: bytesToHex(schnorr.getPublicKey(secret)) };
}

let db: Database;
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "phub-nostr-login-"));
  db = openHubDb(hubDbPath(configDir));
  resetRateLimit();
  _resetNostrLoginChallenges();
  delete process.env[NOSTR_LOGIN_2FA_ENV];
});

afterEach(() => {
  db.close();
  rmSync(configDir, { recursive: true, force: true });
  delete process.env[NOSTR_LOGIN_2FA_ENV];
});

function call(
  method: string,
  subpath: string,
  opts: { body?: unknown; now?: () => Date; ip?: string; origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  // `clientIpFromRequest` reads x-forwarded-for; distinct IPs keep the per-IP
  // limiter from bleeding between cases within one test.
  headers["x-forwarded-for"] = opts.ip ?? "203.0.113.7";
  const req = new Request(`${ORIGIN}/api/auth/nostr${subpath}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return handleNostrLogin(req, subpath, {
    db,
    hubBoundOrigins: BOUND,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

async function getChallenge(opts: { now?: () => Date; ip?: string } = {}): Promise<string> {
  const res = await call("GET", "/challenge", opts);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { challenge: string };
  return body.challenge;
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

function loginTags(challenge: string, over: { u?: string; method?: string } = {}): string[][] {
  return [
    ["u", over.u ?? `${ORIGIN}${NOSTR_LOGIN_VERIFY_PATH}`],
    ["method", over.method ?? "POST"],
    ["challenge", challenge],
  ];
}

/** A well-formed sign-in event for `challenge`, overridable field by field. */
function signInEvent(
  secret: Uint8Array,
  challenge: string,
  over: {
    created_at?: number;
    kind?: number;
    tags?: string[][];
    content?: string;
  } = {},
): NostrEvent {
  return signEvent(secret, {
    tags: over.tags ?? loginTags(challenge),
    content: over.content ?? signInStatement(ORIGIN),
    ...(over.created_at === undefined ? {} : { created_at: over.created_at }),
    ...(over.kind === undefined ? {} : { kind: over.kind }),
  });
}

/** Create a user and bind `pubkey` to it through the real `user_pubkeys` path. */
async function linkedUser(
  username: string,
  pubkey: string,
): Promise<{ id: string; username: string }> {
  const u = await createUser(db, username, PASSWORD, { allowMulti: true, passwordChanged: true });
  const bound = bindPubkeyOperatorAttested(db, { userId: u.id, pubkey, label: "test" });
  expect(bound.ok).toBe(true);
  return { id: u.id, username: u.username };
}

function sessionRows(userId: string): number {
  const row = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
    .get(userId);
  return row?.n ?? 0;
}

function allSessionRows(): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()?.n ?? 0;
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string };
  return body.error ?? "";
}

// --- row 1: the challenge store ------------------------------------------

describe("GET /api/auth/nostr/challenge", () => {
  test("two challenges differ", async () => {
    const a = await getChallenge();
    const b = await getChallenge();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
  });

  test("returns the exact event template the client must sign", async () => {
    const at = new Date("2026-09-03T12:00:00.000Z");
    const res = await call("GET", "/challenge", { now: () => at });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      challenge: string;
      expires_at: string;
      event_template: { kind: number; content: string; tags: string[][] };
    };
    expect(body.expires_at).toBe(
      new Date(at.getTime() + NOSTR_LOGIN_CHALLENGE_TTL_MS).toISOString(),
    );
    expect(body.event_template.kind).toBe(NOSTR_AUTH_KIND);
    expect(body.event_template.content).toBe(signInStatement(ORIGIN));
    expect(body.event_template.tags).toEqual([
      ["u", `${ORIGIN}${NOSTR_LOGIN_VERIFY_PATH}`],
      ["method", "POST"],
      ["challenge", body.challenge],
    ]);
  });

  test("the statement names the origin and never an account", async () => {
    const statement = signInStatement(ORIGIN);
    expect(statement.startsWith(`${ORIGIN} asks you to sign in`)).toBe(true);
    expect(statement).not.toContain("Account:");
  });

  test("an expired nonce is rejected at verify", async () => {
    const at = new Date("2026-09-03T12:00:00.000Z");
    const { secret, pubkey } = keypair();
    await linkedUser("expiry", pubkey);
    const challenge = await getChallenge({ now: () => at });
    const late = new Date(at.getTime() + NOSTR_LOGIN_CHALLENGE_TTL_MS + 1000);
    const res = await call("POST", "/verify", {
      body: { event: signInEvent(secret, challenge, { created_at: Math.floor(+late / 1000) }) },
      now: () => late,
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("challenge_expired");
    expect(allSessionRows()).toBe(0);
  });

  test("the limiter 429s and sets retry-after", async () => {
    const ip = "198.51.100.4";
    for (let i = 0; i < NOSTR_LOGIN_CHALLENGE_MAX_ATTEMPTS; i++) {
      expect((await call("GET", "/challenge", { ip })).status).toBe(200);
    }
    const res = await call("GET", "/challenge", { ip });
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe("too_many_attempts");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // A different IP is a different bucket.
    expect((await call("GET", "/challenge", { ip: "198.51.100.5" })).status).toBe(200);
  });

  test("POST to /challenge is 405, GET to /verify is 405, unknown subpath 404", async () => {
    expect((await call("POST", "/challenge")).status).toBe(405);
    expect((await call("GET", "/verify")).status).toBe(405);
    expect((await call("GET", "/nope")).status).toBe(404);
  });
});

// --- row 2: verify + session mint ----------------------------------------

describe("POST /api/auth/nostr/verify — the happy path", () => {
  test("a signed event from a linked key mints a session row and sets the cookie", async () => {
    const { secret, pubkey } = keypair();
    const user = await linkedUser("member", pubkey);
    const challenge = await getChallenge();

    const res = await call("POST", "/verify", { body: { event: signInEvent(secret, challenge) } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; redirect: string };
    expect(body.ok).toBe(true);
    // `passwordChanged: true` + first-admin → the plain post-login default.
    expect(body.redirect).toBe("/admin/vaults");

    expect(sessionRows(user.id)).toBe(1);
    const cookie = setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    // The cookie value is the session row's id, not something re-derived.
    const sessionId = (cookie ?? "").slice(`${SESSION_COOKIE_NAME}=`.length).split(";")[0] ?? "";
    const row = db
      .query<{ user_id: string }, [string]>("SELECT user_id FROM sessions WHERE id = ?")
      .get(sessionId);
    expect(row?.user_id).toBe(user.id);
  });

  test("`next` rides through the same safeNext the password doors use", async () => {
    const { secret, pubkey } = keypair();
    await linkedUser("nexter", pubkey);

    const ok = await call("POST", "/verify", {
      body: { event: signInEvent(secret, await getChallenge()), next: "/account/" },
    });
    expect(((await ok.json()) as { redirect: string }).redirect).toBe("/account/");

    // An absolute URL is an open redirect — refused, falls back to the default.
    const evil = await call("POST", "/verify", {
      body: {
        event: signInEvent(secret, await getChallenge()),
        next: "https://evil.example/steal",
      },
    });
    expect(((await evil.json()) as { redirect: string }).redirect).toBe("/admin/vaults");

    // Protocol-relative is the classic bypass of a naive leading-`/` check.
    const proto = await call("POST", "/verify", {
      body: { event: signInEvent(secret, await getChallenge()), next: "//evil.example/steal" },
    });
    expect(((await proto.json()) as { redirect: string }).redirect).toBe("/admin/vaults");
  });

  test("a user with password_changed=false lands on change-password, not `next`", async () => {
    const { secret, pubkey } = keypair();
    const admin = await createUser(db, "owner", PASSWORD, { passwordChanged: true });
    expect(admin.id).toBeTruthy();
    const u = await createUser(db, "fresh", PASSWORD, { allowMulti: true });
    expect(bindPubkeyOperatorAttested(db, { userId: u.id, pubkey }).ok).toBe(true);

    const res = await call("POST", "/verify", {
      body: { event: signInEvent(secret, await getChallenge()) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect: string };
    expect(body.redirect.startsWith("/account/change-password")).toBe(true);
    expect(sessionRows(u.id)).toBe(1);
  });

  test("the door writes no grants — user_vaults is untouched", async () => {
    const { secret, pubkey } = keypair();
    const user = await linkedUser("nogrants", pubkey);
    const before =
      db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_vaults WHERE user_id = ?")
        .get(user.id)?.n ?? 0;
    expect(
      (
        await call("POST", "/verify", {
          body: { event: signInEvent(secret, await getChallenge()) },
        })
      ).status,
    ).toBe(200);
    const after =
      db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_vaults WHERE user_id = ?")
        .get(user.id)?.n ?? 0;
    expect(after).toBe(before);
  });
});

describe("POST /api/auth/nostr/verify — rejections, each with its own code", () => {
  test("an unknown nonce is 401 unknown_challenge", async () => {
    const { secret, pubkey } = keypair();
    await linkedUser("unknown-nonce", pubkey);
    await getChallenge(); // a live nonce exists; the event names a different one
    const res = await call("POST", "/verify", {
      body: { event: signInEvent(secret, "ff".repeat(32)) },
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unknown_challenge");
    expect(allSessionRows()).toBe(0);
  });

  test("a REUSED nonce is 401 — single-use, consumed before the mint", async () => {
    const { secret, pubkey } = keypair();
    const user = await linkedUser("replayer", pubkey);
    const challenge = await getChallenge();
    const event = signInEvent(secret, challenge);

    const first = await call("POST", "/verify", { body: { event } });
    expect(first.status).toBe(200);
    expect(sessionRows(user.id)).toBe(1);

    // Byte-for-byte the same request. The signature is still perfectly valid;
    // the nonce is gone.
    const second = await call("POST", "/verify", { body: { event } });
    expect(second.status).toBe(401);
    expect(await errorCode(second)).toBe("unknown_challenge");
    expect(sessionRows(user.id)).toBe(1);
    expect(setCookies(second)).toHaveLength(0);
  });

  test("an expired nonce is 401 challenge_expired, distinct from unknown", async () => {
    const at = new Date("2026-09-03T12:00:00.000Z");
    const { secret, pubkey } = keypair();
    await linkedUser("expired", pubkey);
    const challenge = await getChallenge({ now: () => at });
    const late = new Date(at.getTime() + NOSTR_LOGIN_CHALLENGE_TTL_MS + 1);
    const res = await call("POST", "/verify", {
      body: { event: signInEvent(secret, challenge, { created_at: Math.floor(+late / 1000) }) },
      now: () => late,
    });
    expect(await errorCode(res)).toBe("challenge_expired");
    // ...and it is spent, so a retry inside a fresh clock still fails.
    const retry = await call("POST", "/verify", {
      body: { event: signInEvent(secret, challenge) },
    });
    expect(await errorCode(retry)).toBe("unknown_challenge");
  });

  test("an unlinked key is 401 unknown_pubkey — auto-provision is not consulted", async () => {
    process.env[AUTO_PROVISION_ENV] = "1";
    try {
      const { secret } = keypair();
      await createUser(db, "owner", PASSWORD, { passwordChanged: true });
      const res = await call("POST", "/verify", {
        body: { event: signInEvent(secret, await getChallenge()) },
      });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("unknown_pubkey");
      expect(allSessionRows()).toBe(0);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()?.n).toBe(1);
    } finally {
      delete process.env[AUTO_PROVISION_ENV];
    }
  });

  test("a signature by a different key is 401 proof_failed", async () => {
    const { pubkey } = keypair();
    const other = keypair();
    await linkedUser("victim", pubkey);
    const challenge = await getChallenge();
    // Signed by `other`, but claiming the linked pubkey.
    const forged = { ...signInEvent(other.secret, challenge), pubkey };
    const res = await call("POST", "/verify", { body: { event: forged } });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("proof_failed");
    expect(allSessionRows()).toBe(0);
  });

  test("a tampered id is 401 proof_failed and does not spend the nonce", async () => {
    const { secret, pubkey } = keypair();
    await linkedUser("tamper", pubkey);
    const challenge = await getChallenge();
    const event = signInEvent(secret, challenge);
    const tampered = {
      ...event,
      id: `${event.id.slice(0, 63)}${event.id.endsWith("a") ? "b" : "a"}`,
    };
    expect(await errorCode(await call("POST", "/verify", { body: { event: tampered } }))).toBe(
      "proof_failed",
    );
    // Rejections before step 6 leave the nonce spendable — the member retries.
    const good = await call("POST", "/verify", { body: { event } });
    expect(good.status).toBe(200);
  });

  test("a `u` tag naming another origin is 400 invalid_event", async () => {
    const { secret, pubkey } = keypair();
    await linkedUser("wrongorigin", pubkey);
    const challenge = await getChallenge();
    const res = await call("POST", "/verify", {
      body: {
        event: signInEvent(secret, challenge, {
          tags: loginTags(challenge, { u: `https://evil.example${NOSTR_LOGIN_VERIFY_PATH}` }),
          // Signed against the statement for the origin the attacker named.
          content: signInStatement("https://evil.example"),
        }),
      },
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_event");
    expect(allSessionRows()).toBe(0);
  });

  test("a `u` tag naming another PATH on this hub is refused", async () => {
    const { secret, pubkey } = keypair();
    await linkedUser("wrongpath", pubkey);
    const challenge = await getChallenge();
    // A signature harvested by the linkage ceremony must not open the door.
    const res = await call("POST", "/verify", {
      body: {
        event: signInEvent(secret, challenge, {
          tags: loginTags(challenge, { u: `${ORIGIN}/api/account/pubkeys/verify` }),
        }),
      },
    });
    expect(await errorCode(res)).toBe("invalid_event");
  });

  test("wrong method tag, wrong kind, stale created_at, duplicate tag", async () => {
    const { secret, pubkey } = keypair();
    await linkedUser("bindings", pubkey);

    const c1 = await getChallenge();
    expect(
      await errorCode(
        await call("POST", "/verify", {
          body: { event: signInEvent(secret, c1, { tags: loginTags(c1, { method: "GET" }) }) },
        }),
      ),
    ).toBe("invalid_event");

    const c2 = await getChallenge();
    expect(
      await errorCode(
        await call("POST", "/verify", { body: { event: signInEvent(secret, c2, { kind: 1 }) } }),
      ),
    ).toBe("invalid_event");

    const c3 = await getChallenge();
    const stale = Math.floor(Date.now() / 1000) - NOSTR_LOGIN_MAX_CREATED_AT_SKEW_SECONDS - 5;
    expect(
      await errorCode(
        await call("POST", "/verify", {
          body: { event: signInEvent(secret, c3, { created_at: stale }) },
        }),
      ),
    ).toBe("invalid_event");

    const c5 = await getChallenge();
    expect(
      await errorCode(
        await call("POST", "/verify", {
          body: {
            event: signInEvent(secret, c5, {
              tags: [...loginTags(c5), ["u", `${ORIGIN}${NOSTR_LOGIN_VERIFY_PATH}`]],
            }),
          },
        }),
      ),
    ).toBe("invalid_event");

    expect(allSessionRows()).toBe(0);
  });

  test("a drift NIP-98's ±60s would reject is accepted — ±5 min is the design", async () => {
    const { secret, pubkey } = keypair();
    const user = await linkedUser("drift", pubkey);
    const challenge = await getChallenge();
    const drifted = Math.floor(Date.now() / 1000) - 120;
    const res = await call("POST", "/verify", {
      body: { event: signInEvent(secret, challenge, { created_at: drifted }) },
    });
    expect(res.status).toBe(200);
    expect(sessionRows(user.id)).toBe(1);
  });

  test("a wrong statement in `content` is refused even when everything else passes", async () => {
    const { secret, pubkey } = keypair();
    await linkedUser("statement", pubkey);
    const challenge = await getChallenge();
    const res = await call("POST", "/verify", {
      body: { event: signInEvent(secret, challenge, { content: "sign this to continue" }) },
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_event");
  });

  test("an absent `challenge` tag is 400 invalid_event", async () => {
    const { secret, pubkey } = keypair();
    await linkedUser("nochallenge", pubkey);
    await getChallenge();
    const res = await call("POST", "/verify", {
      body: {
        event: signInEvent(secret, "", {
          tags: [
            ["u", `${ORIGIN}${NOSTR_LOGIN_VERIFY_PATH}`],
            ["method", "POST"],
          ],
        }),
      },
    });
    expect(await errorCode(res)).toBe("invalid_event");
  });

  test("a malformed body is 400 invalid_request; a malformed event is 400 invalid_event", async () => {
    const notJson = await handleNostrLogin(
      new Request(`${ORIGIN}${NOSTR_LOGIN_VERIFY_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      "/verify",
      { db, hubBoundOrigins: BOUND },
    );
    expect(notJson.status).toBe(400);
    expect(await errorCode(notJson)).toBe("invalid_request");

    expect(await errorCode(await call("POST", "/verify", { body: [1, 2, 3] }))).toBe(
      "invalid_request",
    );
    expect(await errorCode(await call("POST", "/verify", { body: {} }))).toBe("invalid_request");
    expect(await errorCode(await call("POST", "/verify", { body: { event: {}, next: 7 } }))).toBe(
      "invalid_request",
    );
    expect(
      await errorCode(await call("POST", "/verify", { body: { event: { pubkey: "nope" } } })),
    ).toBe("invalid_event");
    expect(allSessionRows()).toBe(0);
  });

  test("a cross-site Origin is 403 — login CSRF cannot plant an attacker session", async () => {
    const { secret, pubkey } = keypair();
    await linkedUser("csrf", pubkey);
    const challenge = await getChallenge();
    const res = await call("POST", "/verify", {
      body: { event: signInEvent(secret, challenge) },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("csrf_origin_mismatch");
    expect(allSessionRows()).toBe(0);
    // A non-browser client sends no Origin and is let through.
    const cli = await call("POST", "/verify", {
      body: { event: signInEvent(secret, challenge) },
      origin: null,
    });
    expect(cli.status).toBe(200);
  });

  test("the verify limiter 429s on its own bucket", async () => {
    const ip = "198.51.100.9";
    const { secret } = keypair();
    for (let i = 0; i < NOSTR_LOGIN_VERIFY_MAX_ATTEMPTS; i++) {
      const res = await call("POST", "/verify", {
        body: { event: signInEvent(secret, "ab".repeat(32)) },
        ip,
      });
      expect(res.status).toBe(401);
    }
    const limited = await call("POST", "/verify", {
      body: { event: signInEvent(secret, "ab".repeat(32)) },
      ip,
    });
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("too_many_attempts");
    // The challenge bucket is separate and untouched by the verify flurry.
    expect((await call("GET", "/challenge", { ip })).status).toBe(200);
  });
});

// --- row 3: the 2FA divert ------------------------------------------------

describe("POST /api/auth/nostr/verify — 2FA divert", () => {
  async function enrolledLinkedUser(username: string): Promise<{
    id: string;
    secret: Uint8Array;
  }> {
    const { secret, pubkey } = keypair();
    const user = await linkedUser(username, pubkey);
    await persistEnrollment(db, user.id, generateTotpSecret("owner").secret);
    return { id: user.id, secret };
  }

  test("an enrolled user gets no session and a pending login instead", async () => {
    const { id, secret } = await enrolledLinkedUser("twofa");
    const res = await call("POST", "/verify", {
      body: { event: signInEvent(secret, await getChallenge()) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requires_2fa: boolean; redirect: string; ok?: boolean };
    expect(body.requires_2fa).toBe(true);
    expect(body.redirect).toBe("/login/2fa");
    expect(body.ok).toBeUndefined();

    // No session — the whole point.
    expect(sessionRows(id)).toBe(0);
    const cookies = setCookies(res);
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(false);
    const pending = cookies.find((c) => c.startsWith(`${PENDING_LOGIN_COOKIE_NAME}=`));
    expect(pending).toBeDefined();
    expect(pending).toContain("HttpOnly");
    // Path=/login so it rides the /login/2fa POST, exactly like the password door.
    expect(pending).toContain("Path=/login");
  });

  test("the divert still spends the nonce — the half-login is not replayable", async () => {
    const { secret } = await enrolledLinkedUser("twofa-replay");
    const challenge = await getChallenge();
    const event = signInEvent(secret, challenge);
    expect((await call("POST", "/verify", { body: { event } })).status).toBe(200);
    const again = await call("POST", "/verify", { body: { event } });
    expect(again.status).toBe(401);
    expect(await errorCode(again)).toBe("unknown_challenge");
  });

  test("PARACHUTE_NOSTR_LOGIN_2FA=off mints directly", async () => {
    const { id, secret } = await enrolledLinkedUser("twofa-off");
    process.env[NOSTR_LOGIN_2FA_ENV] = "off";
    const res = await call("POST", "/verify", {
      body: { event: signInEvent(secret, await getChallenge()) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; requires_2fa?: boolean };
    expect(body.ok).toBe(true);
    expect(body.requires_2fa).toBeUndefined();
    expect(sessionRows(id)).toBe(1);
    expect(setCookies(res).some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
  });

  test("the divert is ON by default and for any value that isn't an off-spelling", async () => {
    const { id, secret } = await enrolledLinkedUser("twofa-default");
    for (const value of [undefined, "", "on", "1", "require", "true"]) {
      if (value === undefined) delete process.env[NOSTR_LOGIN_2FA_ENV];
      else process.env[NOSTR_LOGIN_2FA_ENV] = value;
      const res = await call("POST", "/verify", {
        body: { event: signInEvent(secret, await getChallenge()) },
      });
      const body = (await res.json()) as { requires_2fa?: boolean };
      expect(body.requires_2fa).toBe(true);
    }
    expect(sessionRows(id)).toBe(0);
  });

  test("a user WITHOUT 2FA is unaffected by the toggle", async () => {
    const { secret, pubkey } = keypair();
    const user = await linkedUser("no-twofa", pubkey);
    const res = await call("POST", "/verify", {
      body: { event: signInEvent(secret, await getChallenge()) },
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(sessionRows(user.id)).toBe(1);
  });
});

// --- dispatch wiring ------------------------------------------------------
//
// Everything above calls `handleNostrLogin` directly. That proves the handler
// and proves nothing about the server: this PR could ship a door that 404s in
// production and all 30 cases above would still be green. These go through the
// real `hubFetch` dispatch, so they also exercise the production
// `linkageBoundOrigins` wiring rather than the tests' hand-written `BOUND`.

describe("dispatch wiring — /api/auth/nostr/* through hubFetch", () => {
  /**
   * `issuer: ORIGIN` makes `resolveIssuerSource` return "env", so
   * `linkageBoundOrigins` KEEPS ORIGIN — it drops only the request-derived
   * (Host-sourced) issuer. That is the production shape for a hub whose
   * operator has pinned an origin, and the only shape in which the key door
   * works off-loopback at all.
   */
  function handler() {
    return hubFetch(configDir, {
      getDb: () => db,
      issuer: ORIGIN,
      manifestPath: join(configDir, "services.json"),
      connectionsStorePath: join(configDir, "connections.json"),
      loadExposeHubOrigin: () => undefined,
    });
  }

  function wireReq(path: string, opts: { method?: string; body?: unknown } = {}): Request {
    const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.44" };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      headers.origin = ORIGIN;
    }
    return new Request(`${ORIGIN}${path}`, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  }

  test("a full challenge → sign → verify round trip mints a session on the real route", async () => {
    const { secret, pubkey } = keypair();
    // Also satisfies the pre-admin lockout (`userCount === 0` gates `/api/*`).
    const user = await linkedUser("wired", pubkey);
    const fetch = handler();

    const challengeRes = await fetch(wireReq("/api/auth/nostr/challenge"));
    expect(challengeRes.status).toBe(200);
    const issued = (await challengeRes.json()) as {
      challenge: string;
      event_template: { tags: string[][]; content: string };
    };
    expect(issued.challenge).toMatch(/^[0-9a-f]{64}$/);
    // The template the SERVER built, against the origin it actually answers on.
    expect(issued.event_template.tags[0]).toEqual(["u", `${ORIGIN}${NOSTR_LOGIN_VERIFY_PATH}`]);

    // Sign exactly what the server handed back — no locally reconstructed tags.
    const event = signEvent(secret, {
      tags: issued.event_template.tags,
      content: issued.event_template.content,
    });
    const verifyRes = await fetch(
      wireReq(NOSTR_LOGIN_VERIFY_PATH, { method: "POST", body: { event } }),
    );
    expect(verifyRes.status).toBe(200);
    expect(((await verifyRes.json()) as { ok: boolean }).ok).toBe(true);
    expect(sessionRows(user.id)).toBe(1);
    expect(setCookies(verifyRes).some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
  });

  test("an unknown subpath under /api/auth/nostr is the door's own 404, not the SPA shell", async () => {
    await linkedUser("wired-404", keypair().pubkey);
    const res = await handler()(wireReq("/api/auth/nostr/nope"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await errorCode(res)).toBe("not_found");
  });

  test("the routes are anonymous — no cookie, no bearer, still 200", async () => {
    await linkedUser("wired-anon", keypair().pubkey);
    const res = await handler()(wireReq("/api/auth/nostr/challenge"));
    expect(res.status).toBe(200);
    // Nothing in the sibling `/api/auth/*` family would answer without a bearer.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
