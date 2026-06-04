/**
 * Security tests for the friend-facing scoped vault token mint —
 * `POST /account/vault-token/<name>` (`handleAccountVaultTokenPost`).
 *
 * This is a new auth-mint surface, so the authorization is tested
 * adversarially. The spine:
 *   - No session            → 401 (no mint).
 *   - Assigned vault        → 200, token carries `vault:<name>:<verb>`,
 *                             `aud=vault.<name>`, `iss=<hub>`, sub=user.
 *   - UNassigned vault      → 403 (cannot mint for a vault not in the
 *                             user's `user_vaults` assignment — blocks
 *                             cross-vault).
 *   - `admin` verb          → minted for an ASSIGNED vault (2026-05-30:
 *                             assigned users hold full vault authority).
 *   - Broader/garbage verb  → rejected.
 *   - First admin           → 403 (no `user_vaults` rows → unrestricted
 *                             admins use the SPA path, not this one).
 *   - CSRF missing/mismatch → 400.
 *   - Rate limit            → 429 after the bucket fills.
 *   - The minted token is a valid hub JWT the vault would accept.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_VAULT_TOKEN_TTL_SECONDS } from "../account-home-ui.ts";
import { handleAccountVaultTokenPost } from "../account-vault-token.ts";
import { CSRF_FIELD_NAME, buildCsrfCookie, generateCsrfToken } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import { __resetForTests } from "../rate-limit.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-account-vault-token-"));
  const db = openHubDb(hubDbPath(dir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
  __resetForTests();
});
afterEach(() => {
  harness.cleanup();
  __resetForTests();
});

const deps = () => ({ db: harness.db, hubOrigin: ISSUER });

/** A shared CSRF token + matching cookie value for the double-submit handshake. */
function csrfPair(): { token: string; cookieFragment: string } {
  const token = generateCsrfToken();
  // buildCsrfCookie(...) → "parachute_hub_csrf=<token>; HttpOnly; ...". We only
  // need the name=value fragment to join with the session cookie.
  const cookie = buildCsrfCookie(token, { secure: false }).split(";")[0] ?? "";
  return { token, cookieFragment: cookie };
}

/**
 * Build the first-admin operator + a friend assigned to `vaults`.
 *
 * `passwordChanged` defaults to true: the friend has already rotated the admin-
 * set temp password, which is the precondition for minting a token now (item F
 * / hub#469 — an unrotated friend is force-redirected before any mint). Pass
 * `passwordChanged: false` to exercise the force-change gate.
 */
async function seedFriend(
  vaults: string[],
  opts: { passwordChanged?: boolean } = {},
): Promise<{ friendId: string; cookie: string; csrfToken: string }> {
  await createUser(harness.db, "operator", "operator-password-123");
  const friend = await createUser(harness.db, "friend", "friend-password-123", {
    assignedVaults: vaults,
    allowMulti: true,
    passwordChanged: opts.passwordChanged ?? true,
  });
  const session = createSession(harness.db, { userId: friend.id });
  const { token, cookieFragment } = csrfPair();
  const sessionCookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
  const cookie = `${sessionCookie}; ${cookieFragment}`;
  return { friendId: friend.id, cookie, csrfToken: token };
}

function mintReq(
  vaultName: string,
  opts: { cookie?: string; csrfToken?: string; verb?: string; omitCsrf?: boolean } = {},
): Request {
  const body = new URLSearchParams();
  if (!opts.omitCsrf && opts.csrfToken !== undefined) body.set(CSRF_FIELD_NAME, opts.csrfToken);
  if (opts.verb !== undefined) body.set("verb", opts.verb);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`${ISSUER}/account/vault-token/${encodeURIComponent(vaultName)}`, {
    method: "POST",
    headers,
    body: body.toString(),
  });
}

describe("handleAccountVaultTokenPost — happy path (assigned vault)", () => {
  test("200 mints vault:<name>:read for an assigned vault, valid hub JWT", async () => {
    const { friendId, cookie, csrfToken } = await seedFriend(["work"]);
    const res = await handleAccountVaultTokenPost(
      mintReq("work", { cookie, csrfToken, verb: "read" }),
      "work",
      deps(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('data-testid="minted-token-banner"');

    // Pull the token out of the show-once banner and validate it as a hub JWT.
    const m = html.match(/data-testid="minted-token-value">([^<]+)</);
    expect(m).not.toBeNull();
    const token = m![1] as string;
    const validated = await validateAccessToken(harness.db, token, ISSUER);
    expect(validated.payload.sub).toBe(friendId);
    expect(validated.payload.iss).toBe(ISSUER);
    expect(validated.payload.aud).toBe("vault.work");
    const scopeClaim = (validated.payload as { scope?: string }).scope ?? "";
    expect(scopeClaim.split(/\s+/)).toEqual(["vault:work:read"]);
    // vault_scope pin — token can only ever be used against `work`.
    expect((validated.payload as { vault_scope?: string[] }).vault_scope).toEqual(["work"]);

    // TTL ≈ 90 days.
    const expMs = new Date((validated.payload.exp ?? 0) * 1000).getTime();
    const skew = expMs - Date.now();
    expect(skew).toBeGreaterThan((ACCOUNT_VAULT_TOKEN_TTL_SECONDS - 60) * 1000);
    expect(skew).toBeLessThan((ACCOUNT_VAULT_TOKEN_TTL_SECONDS + 60) * 1000);
  });

  test("200 mints vault:<name>:write when verb=write (default-role assignment)", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"]);
    const res = await handleAccountVaultTokenPost(
      mintReq("work", { cookie, csrfToken, verb: "write" }),
      "work",
      deps(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const token = html.match(/data-testid="minted-token-value">([^<]+)</)?.[1] as string;
    const validated = await validateAccessToken(harness.db, token, ISSUER);
    const scopeClaim = (validated.payload as { scope?: string }).scope ?? "";
    expect(scopeClaim.split(/\s+/)).toEqual(["vault:work:write"]);
  });

  test("a friend assigned to multiple vaults can mint for each, never cross-vault", async () => {
    const { cookie, csrfToken } = await seedFriend(["work", "home"]);
    for (const v of ["work", "home"]) {
      const res = await handleAccountVaultTokenPost(
        mintReq(v, { cookie, csrfToken, verb: "read" }),
        v,
        deps(),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      const token = html.match(/data-testid="minted-token-value">([^<]+)</)?.[1] as string;
      const validated = await validateAccessToken(harness.db, token, ISSUER);
      expect(validated.payload.aud).toBe(`vault.${v}`);
    }
    // ...but a vault NOT in {work, home} is refused.
    const res = await handleAccountVaultTokenPost(
      mintReq("secret", { cookie, csrfToken, verb: "read" }),
      "secret",
      deps(),
    );
    expect(res.status).toBe(403);
  });
});

describe("handleAccountVaultTokenPost — authorization gates (adversarial)", () => {
  test("401 when no session cookie is present", async () => {
    // Even with a CSRF token, no session = no identity = no mint.
    const { token, cookieFragment } = csrfPair();
    const res = await handleAccountVaultTokenPost(
      mintReq("work", { cookie: cookieFragment, csrfToken: token, verb: "read" }),
      "work",
      deps(),
    );
    expect(res.status).toBe(401);
  });

  test("403 when minting for a vault the friend is NOT assigned to (cross-vault)", async () => {
    // Friend is assigned to `work` only; attempts `other`.
    const { cookie, csrfToken } = await seedFriend(["work"]);
    const res = await handleAccountVaultTokenPost(
      mintReq("other", { cookie, csrfToken, verb: "read" }),
      "other",
      deps(),
    );
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('data-testid="mint-error-banner"');
    expect(html).toContain("not assigned");
    // Critically: no token was minted.
    expect(html).not.toContain('data-testid="minted-token-banner"');
  });

  test("a non-assigned friend cannot mint even for a vault that EXISTS for another user", async () => {
    // Two friends; friend B is assigned to `shared`, friend A is not.
    await createUser(harness.db, "operator", "operator-password-123");
    const friendB = await createUser(harness.db, "bee", "bee-password-12345", {
      assignedVaults: ["shared"],
      allowMulti: true,
    });
    expect(friendB.id).toBeTruthy();
    const friendA = await createUser(harness.db, "aay", "aay-password-12345", {
      assignedVaults: ["mine"],
      allowMulti: true,
    });
    const sessionA = createSession(harness.db, { userId: friendA.id });
    const { token, cookieFragment } = csrfPair();
    const cookie = `${buildSessionCookie(sessionA.id, Math.floor(SESSION_TTL_MS / 1000))}; ${cookieFragment}`;
    const res = await handleAccountVaultTokenPost(
      mintReq("shared", { cookie, csrfToken: token, verb: "read" }),
      "shared",
      deps(),
    );
    expect(res.status).toBe(403);
  });

  test("403 — the first admin cannot mint here (no user_vaults rows; uses SPA path)", async () => {
    // The first-created user is the unrestricted admin: empty assignedVaults,
    // so vaultVerbsForUserVault returns null for every vault → 403. Admins
    // mint via /admin/vault-admin-token, not this friend surface.
    const admin = await createUser(harness.db, "operator", "operator-password-123");
    const session = createSession(harness.db, { userId: admin.id });
    const { token, cookieFragment } = csrfPair();
    const cookie = `${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}; ${cookieFragment}`;
    const res = await handleAccountVaultTokenPost(
      mintReq("work", { cookie, csrfToken: token, verb: "read" }),
      "work",
      deps(),
    );
    expect(res.status).toBe(403);
  });

  test("200 mints vault:<name>:admin when verb=admin (assigned users hold admin, 2026-05-30)", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"]);
    const res = await handleAccountVaultTokenPost(
      mintReq("work", { cookie, csrfToken, verb: "admin" }),
      "work",
      deps(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const token = html.match(/data-testid="minted-token-value">([^<]+)</)?.[1] as string;
    const validated = await validateAccessToken(harness.db, token, ISSUER);
    const scopeClaim = (validated.payload as { scope?: string }).scope ?? "";
    expect(scopeClaim.split(/\s+/)).toEqual(["vault:work:admin"]);
  });

  test("a garbage / broader verb is rejected", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"]);
    for (const verb of ["host", "delete", "read write", "*", ""]) {
      const res = await handleAccountVaultTokenPost(
        mintReq("work", { cookie, csrfToken, verb }),
        "work",
        deps(),
      );
      expect(res.status).toBe(400);
    }
  });

  test("a syntactically invalid vault name is rejected before any mint", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"]);
    const res = await handleAccountVaultTokenPost(
      mintReq("has..dots", { cookie, csrfToken, verb: "read" }),
      "has..dots",
      deps(),
    );
    expect(res.status).toBe(400);
  });

  // Item F / hub#469 — force-change gate. An assigned friend who has NOT yet
  // rotated the admin-set temp password is redirected to the change-password
  // rail instead of minting a long-lived token (which would outlive the
  // rotation). The gate fires AFTER the authority checks (so an unassigned
  // request still 403s) and BEFORE the mint.
  test("authorized but unrotated friend → 303 to /account/change-password, no mint (item F)", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"], { passwordChanged: false });
    const res = await handleAccountVaultTokenPost(
      mintReq("work", { cookie, csrfToken, verb: "read" }),
      "work",
      deps(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/change-password");
    // No token row was written for the friend.
    const rows = harness.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens")
      .get();
    expect(rows?.n).toBe(0);
  });

  test("an UNASSIGNED unrotated friend still 403s (authority precedes the force-change gate)", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"], { passwordChanged: false });
    const res = await handleAccountVaultTokenPost(
      mintReq("other", { cookie, csrfToken, verb: "read" }),
      "other",
      deps(),
    );
    expect(res.status).toBe(403);
  });
});

describe("handleAccountVaultTokenPost — CSRF + method + rate limit", () => {
  test("405 on non-POST", async () => {
    const { cookie } = await seedFriend(["work"]);
    const req = new Request(`${ISSUER}/account/vault-token/work`, {
      method: "GET",
      headers: { cookie },
    });
    const res = await handleAccountVaultTokenPost(req, "work", deps());
    expect(res.status).toBe(405);
  });

  test("400 when the CSRF token is missing", async () => {
    const { cookie } = await seedFriend(["work"]);
    const res = await handleAccountVaultTokenPost(
      mintReq("work", { cookie, omitCsrf: true, verb: "read" }),
      "work",
      deps(),
    );
    expect(res.status).toBe(400);
  });

  test("400 when the CSRF form token does not match the cookie", async () => {
    const { cookie } = await seedFriend(["work"]);
    // Send a different (non-matching) CSRF token in the form than the cookie.
    const res = await handleAccountVaultTokenPost(
      mintReq("work", { cookie, csrfToken: generateCsrfToken(), verb: "read" }),
      "work",
      deps(),
    );
    expect(res.status).toBe(400);
  });

  test("429 once the per-user mint bucket fills (10 / 10 min)", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"]);
    // 10 admitted, 11th denied.
    for (let i = 0; i < 10; i++) {
      const res = await handleAccountVaultTokenPost(
        mintReq("work", { cookie, csrfToken, verb: "read" }),
        "work",
        deps(),
      );
      expect(res.status).toBe(200);
    }
    const denied = await handleAccountVaultTokenPost(
      mintReq("work", { cookie, csrfToken, verb: "read" }),
      "work",
      deps(),
    );
    expect(denied.status).toBe(429);
  });

  test("CSRF failure does NOT burn a rate-limit slot", async () => {
    // A cross-site POST with a bad CSRF token should 400 before the bucket is
    // touched — otherwise an attacker could exhaust the victim's mint bucket.
    const { cookie, csrfToken } = await seedFriend(["work"]);
    for (let i = 0; i < 15; i++) {
      const res = await handleAccountVaultTokenPost(
        mintReq("work", { cookie, csrfToken: generateCsrfToken(), verb: "read" }),
        "work",
        deps(),
      );
      expect(res.status).toBe(400);
    }
    // The legitimate mint still succeeds — the bucket was never touched.
    const ok = await handleAccountVaultTokenPost(
      mintReq("work", { cookie, csrfToken, verb: "read" }),
      "work",
      deps(),
    );
    expect(ok.status).toBe(200);
  });
});
