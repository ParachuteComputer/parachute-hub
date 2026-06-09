/**
 * Security tests for the friend-facing vault-ADMIN deep-link mint —
 * `POST /account/vault-admin-token/<name>` (`handleAccountVaultAdminTokenPost`).
 *
 * The non-admin sibling of `/admin/vault-admin-token/<name>` (which is
 * first-admin-gated). This one is gated on ASSIGNMENT: an assigned user holds
 * `admin` on their vault (2026-05-30) and may bootstrap the vault's own admin
 * SPA — token rotation + Git backup config. Authorization is tested
 * adversarially. The spine:
 *   - No session              → 401.
 *   - Assigned vault          → 303 → <vault-url><managementUrl>#token=<jwt>,
 *                               token carries `vault:<name>:admin`,
 *                               `aud=vault.<name>`, `iss=<hub>`, sub=user.
 *   - UNassigned vault        → 403 (cross-vault blocked).
 *   - First admin             → 403 (no user_vaults rows → uses SPA path).
 *   - Unrotated user (item F) → 303 → /account/change-password, NO mint
 *                               (does not reintroduce the #469 bypass).
 *   - CSRF missing/mismatch   → 400.
 *   - Invalid vault name      → 400.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAccountVaultAdminTokenPost } from "../account-vault-admin-token.ts";
import { VAULT_ADMIN_TOKEN_TTL_SECONDS } from "../admin-vault-admin-token.ts";
import { CSRF_FIELD_NAME, buildCsrfCookie, generateCsrfToken } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-account-vault-admin-token-"));
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
});
afterEach(() => {
  harness.cleanup();
});

const deps = (extra: { managementUrl?: string } = {}) => ({
  db: harness.db,
  hubOrigin: ISSUER,
  ...extra,
});

/** A shared CSRF token + matching cookie value for the double-submit handshake. */
function csrfPair(): { token: string; cookieFragment: string } {
  const token = generateCsrfToken();
  const cookie = buildCsrfCookie(token, { secure: false }).split(";")[0] ?? "";
  return { token, cookieFragment: cookie };
}

/**
 * First-admin operator + a friend assigned to `vaults`. `passwordChanged`
 * defaults true (the precondition for minting now — item F gates an unrotated
 * friend first). Pass `passwordChanged: false` to exercise the force-change gate.
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
  opts: { cookie?: string; csrfToken?: string; omitCsrf?: boolean; method?: string } = {},
): Request {
  const body = new URLSearchParams();
  if (!opts.omitCsrf && opts.csrfToken !== undefined) body.set(CSRF_FIELD_NAME, opts.csrfToken);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`${ISSUER}/account/vault-admin-token/${encodeURIComponent(vaultName)}`, {
    method: opts.method ?? "POST",
    headers,
    body: body.toString(),
  });
}

/** Pull the `#token=<jwt>` out of a 303 Location fragment. */
function tokenFromLocation(location: string): string {
  const m = location.match(/[#&]token=([^&]+)$/);
  expect(m).not.toBeNull();
  return m![1] as string;
}

describe("handleAccountVaultAdminTokenPost — happy path (assigned vault)", () => {
  test("303 → vault admin SPA with #token carrying vault:<name>:admin", async () => {
    const { friendId, cookie, csrfToken } = await seedFriend(["work"]);
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("work", { cookie, csrfToken }),
      "work",
      deps(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const location = res.headers.get("location") ?? "";
    // Default managementUrl is the relative "admin/" (B4 per-instance form)
    // → lands on the vault admin SPA home under the vault's mount.
    expect(location.startsWith(`${ISSUER}/vault/work/admin/#token=`)).toBe(true);

    const token = tokenFromLocation(location);
    const validated = await validateAccessToken(harness.db, token, ISSUER);
    expect(validated.payload.sub).toBe(friendId);
    expect(validated.payload.iss).toBe(ISSUER);
    expect(validated.payload.aud).toBe("vault.work");
    const scopeClaim = (validated.payload as { scope?: string }).scope ?? "";
    expect(scopeClaim.split(/\s+/)).toEqual(["vault:work:admin"]);
    expect((validated.payload as { vault_scope?: string[] }).vault_scope).toEqual(["work"]);

    // Short TTL (10 min, deep-link bootstrap token — not the 90-day headless one).
    const expMs = new Date((validated.payload.exp ?? 0) * 1000).getTime();
    const skew = expMs - Date.now();
    expect(skew).toBeGreaterThan((VAULT_ADMIN_TOKEN_TTL_SECONDS - 60) * 1000);
    expect(skew).toBeLessThan((VAULT_ADMIN_TOKEN_TTL_SECONDS + 60) * 1000);

    // A revocable registry row was written for the friend.
    const rows = harness.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get();
    expect(rows?.n).toBe(1);
  });

  test("honors a vault-declared RELATIVE managementUrl (B4 per-instance form)", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"]);
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("work", { cookie, csrfToken }),
      "work",
      deps({ managementUrl: "manage/" }),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(`${ISSUER}/vault/work/manage/#token=`)).toBe(true);
  });

  test("a LEADING-SLASH managementUrl resolves origin-absolute (B4 inverted pin)", async () => {
    // Pre-B4 "/manage/" joined under the vault mount (/vault/work/manage/).
    // Under the unified semantics a leading-"/" is origin-absolute.
    const { cookie, csrfToken } = await seedFriend(["work"]);
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("work", { cookie, csrfToken }),
      "work",
      deps({ managementUrl: "/manage/" }),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(`${ISSUER}/manage/#token=`)).toBe(true);
  });

  test('COMPAT SHIM: the literal legacy "/admin/" managementUrl still joins under the vault (one release)', async () => {
    // Deployed vaults declare managementUrl "/admin/" — the OLD per-instance
    // form. Origin-absolute resolution would deep-link the daemon-level
    // /vault/admin mount instead of the instance SPA, so the literal
    // "/admin"/"/admin/" keeps the old vault-join for one release with a
    // deprecation log.
    const { cookie, csrfToken } = await seedFriend(["work"]);
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("work", { cookie, csrfToken }),
      "work",
      deps({ managementUrl: "/admin/" }),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(`${ISSUER}/vault/work/admin/#token=`)).toBe(true);
  });

  test("a friend assigned to multiple vaults can deep-link each, never cross-vault", async () => {
    const { cookie, csrfToken } = await seedFriend(["work", "home"]);
    for (const v of ["work", "home"]) {
      const res = await handleAccountVaultAdminTokenPost(
        mintReq(v, { cookie, csrfToken }),
        v,
        deps(),
      );
      expect(res.status).toBe(303);
      const token = tokenFromLocation(res.headers.get("location") ?? "");
      const validated = await validateAccessToken(harness.db, token, ISSUER);
      expect(validated.payload.aud).toBe(`vault.${v}`);
    }
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("secret", { cookie, csrfToken }),
      "secret",
      deps(),
    );
    expect(res.status).toBe(403);
  });
});

describe("handleAccountVaultAdminTokenPost — authorization gates (adversarial)", () => {
  test("401 when no session cookie is present", async () => {
    const { token, cookieFragment } = csrfPair();
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("work", { cookie: cookieFragment, csrfToken: token }),
      "work",
      deps(),
    );
    expect(res.status).toBe(401);
  });

  test("403 for a vault the friend is NOT assigned to (cross-vault)", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"]);
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("other", { cookie, csrfToken }),
      "other",
      deps(),
    );
    expect(res.status).toBe(403);
    // No token minted.
    const rows = harness.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get();
    expect(rows?.n).toBe(0);
  });

  test("403 — the first admin cannot deep-link here (no user_vaults rows; uses SPA path)", async () => {
    // Mirrors `/admin/vault-admin-token` being friend-blocked: the inverse, this
    // friend surface refuses the unrestricted admin. Admins use the SPA's
    // first-admin-gated /admin/vault-admin-token instead.
    const admin = await createUser(harness.db, "operator", "operator-password-123");
    const session = createSession(harness.db, { userId: admin.id });
    const { token, cookieFragment } = csrfPair();
    const cookie = `${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}; ${cookieFragment}`;
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("work", { cookie, csrfToken: token }),
      "work",
      deps(),
    );
    expect(res.status).toBe(403);
  });

  test("an invalid vault name is rejected before any mint", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"]);
    for (const name of ["has..dots", "Work", "WORK"]) {
      const res = await handleAccountVaultAdminTokenPost(
        mintReq(name, { cookie, csrfToken }),
        name,
        deps(),
      );
      expect(res.status).toBe(400);
    }
  });

  // Item F / hub#469 — force-change gate. An assigned user who has NOT rotated
  // the admin-set temp password is redirected to change-password BEFORE minting,
  // so the temp-password handoff can't be parlayed into a vault-admin deep-link.
  // This is the SAME gate /account/vault-token applies (post-#550) — it does NOT
  // reintroduce the bypass #469 closed. Fires AFTER authority (so an unassigned
  // request still 403s) and BEFORE the mint.
  test("authorized but unrotated user → 303 to /account/change-password, NO mint (item F)", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"], { passwordChanged: false });
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("work", { cookie, csrfToken }),
      "work",
      deps(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/change-password");
    // Critically: no token was minted and no deep-link token leaked.
    const rows = harness.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get();
    expect(rows?.n).toBe(0);
  });

  test("an UNASSIGNED unrotated user still 403s (authority precedes the force-change gate)", async () => {
    const { cookie, csrfToken } = await seedFriend(["work"], { passwordChanged: false });
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("other", { cookie, csrfToken }),
      "other",
      deps(),
    );
    expect(res.status).toBe(403);
  });
});

describe("handleAccountVaultAdminTokenPost — CSRF + method", () => {
  test("405 on non-POST", async () => {
    const { cookie } = await seedFriend(["work"]);
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("work", { cookie, method: "GET" }),
      "work",
      deps(),
    );
    expect(res.status).toBe(405);
  });

  test("400 when the CSRF token is missing", async () => {
    const { cookie } = await seedFriend(["work"]);
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("work", { cookie, omitCsrf: true }),
      "work",
      deps(),
    );
    expect(res.status).toBe(400);
  });

  test("400 when the CSRF form token does not match the cookie", async () => {
    const { cookie } = await seedFriend(["work"]);
    const res = await handleAccountVaultAdminTokenPost(
      mintReq("work", { cookie, csrfToken: generateCsrfToken() }),
      "work",
      deps(),
    );
    expect(res.status).toBe(400);
  });
});
