/**
 * Multi-use public-signup links + email-as-username + per-vault caps
 * (DEMO-PREP-2026-06-25 Workstream B: B1 multi-use invite, B2 email capture,
 * B4 public signup page; the cap value persisted for B3's Phase-2 enforcement).
 *
 * Coverage required by the brief:
 *   - multi-use exhaustion (used_count == max_uses → refused)
 *   - expiry refusal (multi-use link past expires_at → 410)
 *   - email capture (stored on users + on the invite, validated)
 *   - signup → vault provision with the cap PERSISTED to vault_caps
 *   - backwards-compat with legacy single-use invites
 *
 * Plus: the migration is backwards-compatible (legacy rows redeem unchanged),
 * the invite primitive's seat accounting, and the API mint gates.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAccountSetupGet, handleAccountSetupPost } from "../account-setup.ts";
import type { RunResult } from "../admin-vaults.ts";
import { handleCreateInvite } from "../api-invites.ts";
import { CSRF_FIELD_NAME, buildCsrfCookie, generateCsrfToken } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  InviteExhaustedError,
  InviteUsedError,
  assertInviteRedeemable,
  findInviteByRawToken,
  inviteStatus,
  issueInvite,
  recordInviteRedemption,
} from "../invites.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { __resetForTests } from "../rate-limit.ts";
import { createUser, getUserByUsernameCI } from "../users.ts";
import { getVaultCapBytes } from "../vault-caps.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-public-signup-"));
  const db = openHubDb(hubDbPath(dir));
  const manifestPath = join(dir, "services.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      services: [
        {
          name: "parachute-vault",
          port: 4101,
          paths: ["/vault/seed"],
          health: "/health",
          version: "0.0.0-test",
        },
      ],
    }),
  );
  return {
    db,
    manifestPath,
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

/** Stub vault create: append the named vault path to services.json. */
function makeStubRunCommand() {
  const calls: string[][] = [];
  const run = async (cmd: readonly string[]): Promise<RunResult> => {
    calls.push([...cmd]);
    const name = cmd[2] ?? "";
    const manifest = JSON.parse(readFileSync(harness.manifestPath, "utf8")) as {
      services: { name: string; paths: string[] }[];
    };
    const vaultSvc = manifest.services.find((s) => s.name === "parachute-vault");
    if (vaultSvc && !vaultSvc.paths.includes(`/vault/${name}`)) {
      vaultSvc.paths.push(`/vault/${name}`);
      writeFileSync(harness.manifestPath, JSON.stringify(manifest));
    }
    const createJson = {
      name,
      token: "",
      paths: {
        vault_dir: `/d/${name}`,
        vault_db: `/d/${name}/v.db`,
        vault_config: `/d/${name}/v.yaml`,
      },
      set_as_default: false,
    };
    return { exitCode: 0, stdout: JSON.stringify(createJson), stderr: "" };
  };
  return { run, calls };
}

function csrfPair(): { token: string; cookieFragment: string } {
  const token = generateCsrfToken();
  const cookie = buildCsrfCookie(token, { secure: false }).split(";")[0] ?? "";
  return { token, cookieFragment: cookie };
}

function postReq(token: string, fields: Record<string, string>, csrfCookie: string): Request {
  const form = new URLSearchParams(fields);
  return new Request(`${ISSUER}/account/setup/${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: csrfCookie },
    body: form.toString(),
  });
}

function deps(runCommand?: (cmd: readonly string[]) => Promise<RunResult>) {
  return {
    db: harness.db,
    hubOrigin: ISSUER,
    manifestPath: harness.manifestPath,
    ...(runCommand !== undefined ? { runCommand } : {}),
  };
}

/** Drive one full public-signup redemption (multi-use shape) for a new account. */
async function signup(
  rawToken: string,
  username: string,
  email: string,
  run: (cmd: readonly string[]) => Promise<RunResult>,
): Promise<Response> {
  const { token: csrfToken, cookieFragment } = csrfPair();
  __resetForTests(); // each signup is a distinct IP-bucket attempt window
  return handleAccountSetupPost(
    postReq(
      rawToken,
      {
        [CSRF_FIELD_NAME]: csrfToken,
        username,
        email,
        password: `${username}-strong-password-1`,
        password_confirm: `${username}-strong-password-1`,
        vault_name: username,
      },
      cookieFragment,
    ),
    rawToken,
    deps(run),
  );
}

// ===========================================================================
// B1 — multi-use seat accounting (primitive level)
// ===========================================================================

describe("invite primitive — multi-use seats (v15)", () => {
  test("legacy default is single-use: max_uses=1, used_count=0", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { invite } = issueInvite(harness.db, { createdBy: admin.id });
    expect(invite.maxUses).toBe(1);
    expect(invite.usedCount).toBe(0);
    expect(invite.email).toBeNull();
    expect(invite.vaultCapBytes).toBeNull();
  });

  // recordInviteRedemption's redeemed_user_id FKs users(id), so tests pass
  // real committed user ids (as the production redeem path does).
  async function makeUsers(...names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const n of names) {
      const u = await createUser(harness.db, n, `${n}-password-1`, { allowMulti: true });
      ids.push(u.id);
    }
    return ids;
  }

  test("recordInviteRedemption bumps used_count, stamps used_at on first only", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const [u1, u2] = await makeUsers("ra", "rb");
    const { rawToken, invite } = issueInvite(harness.db, { createdBy: admin.id, maxUses: 3 });
    const t0 = new Date("2026-06-25T00:00:00Z");
    const t1 = new Date("2026-06-25T01:00:00Z");
    expect(recordInviteRedemption(harness.db, invite.tokenHash, u1!, "a@x.io", t0)).toBe(true);
    let row = findInviteByRawToken(harness.db, rawToken);
    expect(row?.usedCount).toBe(1);
    expect(row?.usedAt).toBe(t0.toISOString());
    expect(row?.email).toBe("a@x.io");
    // Second redeem: used_count bumps, used_at preserved (COALESCE), email updates.
    expect(recordInviteRedemption(harness.db, invite.tokenHash, u2!, "b@x.io", t1)).toBe(true);
    row = findInviteByRawToken(harness.db, rawToken);
    expect(row?.usedCount).toBe(2);
    expect(row?.usedAt).toBe(t0.toISOString()); // unchanged
    expect(row?.email).toBe("b@x.io"); // latest redeemer
  });

  test("exhaustion: the (max_uses+1)th record is refused (zero rows)", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const [u1, u2, u3] = await makeUsers("ea", "eb", "ec");
    const { invite } = issueInvite(harness.db, { createdBy: admin.id, maxUses: 2 });
    expect(recordInviteRedemption(harness.db, invite.tokenHash, u1!)).toBe(true);
    expect(recordInviteRedemption(harness.db, invite.tokenHash, u2!)).toBe(true);
    // Third — over cap.
    expect(recordInviteRedemption(harness.db, invite.tokenHash, u3!)).toBe(false);
  });

  test("status: partially-used multi-use link stays 'pending'; exhausted → 'redeemed'", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const [u1, u2] = await makeUsers("sa", "sb");
    const { rawToken, invite } = issueInvite(harness.db, { createdBy: admin.id, maxUses: 2 });
    recordInviteRedemption(harness.db, invite.tokenHash, u1!);
    expect(inviteStatus(findInviteByRawToken(harness.db, rawToken)!)).toBe("pending");
    recordInviteRedemption(harness.db, invite.tokenHash, u2!);
    expect(inviteStatus(findInviteByRawToken(harness.db, rawToken)!)).toBe("redeemed");
  });

  test("assertInviteRedeemable: exhausted single-use throws InviteUsedError, multi-use throws InviteExhaustedError", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const [u1, u2, u3] = await makeUsers("aa", "ab", "ac");
    const single = issueInvite(harness.db, { createdBy: admin.id, maxUses: 1 });
    recordInviteRedemption(harness.db, single.invite.tokenHash, u1!);
    expect(() => assertInviteRedeemable(harness.db, single.rawToken)).toThrow(InviteUsedError);

    const multi = issueInvite(harness.db, { createdBy: admin.id, maxUses: 2 });
    recordInviteRedemption(harness.db, multi.invite.tokenHash, u2!);
    recordInviteRedemption(harness.db, multi.invite.tokenHash, u3!);
    expect(() => assertInviteRedeemable(harness.db, multi.rawToken)).toThrow(InviteExhaustedError);
  });
});

// ===========================================================================
// B4 — public signup page end-to-end (multi-use redemption)
// ===========================================================================

describe("public signup page — multi-use redemption + caps", () => {
  test("two strangers redeem ONE link → two accounts, two vaults, cap persisted, used_count=2", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const cap = 1024 * 1024 * 1024; // 1 GiB
    const { rawToken } = issueInvite(harness.db, {
      createdBy: admin.id,
      maxUses: 5,
      vaultCapBytes: cap,
    });
    const stub = makeStubRunCommand();

    const r1 = await signup(rawToken, "alice", "alice@example.com", stub.run);
    expect(r1.status).toBe(302);
    const r2 = await signup(rawToken, "bob", "bob@example.com", stub.run);
    expect(r2.status).toBe(302);

    // Two distinct accounts with their emails stored.
    const alice = getUserByUsernameCI(harness.db, "alice");
    const bob = getUserByUsernameCI(harness.db, "bob");
    expect(alice?.email).toBe("alice@example.com");
    expect(bob?.email).toBe("bob@example.com");
    expect(alice?.assignedVaults).toEqual(["alice"]);
    expect(bob?.assignedVaults).toEqual(["bob"]);

    // Each provisioned vault carries the cap (B4 persistence for the Phase-2 reader).
    expect(getVaultCapBytes(harness.db, "alice")).toBe(cap);
    expect(getVaultCapBytes(harness.db, "bob")).toBe(cap);

    // The link recorded two redemptions, still has seats, stays pending.
    const after = findInviteByRawToken(harness.db, rawToken);
    expect(after?.usedCount).toBe(2);
    expect(after?.maxUses).toBe(5);
    expect(inviteStatus(after!)).toBe("pending");
  });

  test("multi-use link with NO cap on the invite → provisioned vault has NO vault_caps row (uncapped contract)", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    // issueInvite directly (bypasses the API's auto-default) with no cap.
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id, maxUses: 5 });
    const stub = makeStubRunCommand();
    expect((await signup(rawToken, "nina", "nina@example.com", stub.run)).status).toBe(302);
    // No cap row → the Phase-2 reader treats the vault as uncapped.
    expect(getVaultCapBytes(harness.db, "nina")).toBeNull();
  });

  test("exhaustion refusal: the (N+1)th signup on a maxed link → 410", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id, maxUses: 1 + 1 });
    const stub = makeStubRunCommand();
    expect((await signup(rawToken, "alice", "alice@example.com", stub.run)).status).toBe(302);
    expect((await signup(rawToken, "bob", "bob@example.com", stub.run)).status).toBe(302);
    // Third — link is exhausted.
    const r3 = await signup(rawToken, "carol", "carol@example.com", stub.run);
    expect(r3.status).toBe(410);
    expect(await r3.text()).toContain("Signups closed");
    expect(getUserByUsernameCI(harness.db, "carol")).toBeNull();
  });

  test("expiry refusal: a multi-use link past expires_at → 410, no account created", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const t0 = new Date("2026-06-25T00:00:00Z");
    const { rawToken } = issueInvite(harness.db, {
      createdBy: admin.id,
      maxUses: 10,
      expiresInSeconds: 60,
      now: () => t0,
    });
    const stub = makeStubRunCommand();
    const later = new Date(t0.getTime() + 120_000);
    const { token: csrfToken, cookieFragment } = csrfPair();
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "dave",
          email: "dave@example.com",
          password: "dave-strong-password-1",
          password_confirm: "dave-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      { ...deps(stub.run), now: () => later },
    );
    expect(res.status).toBe(410);
    expect(getUserByUsernameCI(harness.db, "dave")).toBeNull();
  });

  test("email capture: GET renders the email field for a multi-use link", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id, maxUses: 5 });
    const html = await handleAccountSetupGet(
      new Request(`${ISSUER}/account/setup/${rawToken}`),
      rawToken,
      deps(),
    ).text();
    expect(html).toContain('name="email"');
    expect(html).toContain('type="email"');
  });

  test("email validation: malformed email → 400 re-render, no account", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id, maxUses: 5 });
    const stub = makeStubRunCommand();
    const { token: csrfToken, cookieFragment } = csrfPair();
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "eve",
          email: "not-an-email",
          password: "eve-strong-password-1",
          password_confirm: "eve-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      deps(stub.run),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("valid email");
    expect(getUserByUsernameCI(harness.db, "eve")).toBeNull();
  });

  test("missing email on a multi-use link → 400, no account", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id, maxUses: 5 });
    const stub = makeStubRunCommand();
    const { token: csrfToken, cookieFragment } = csrfPair();
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "frank",
          password: "frank-strong-password-1",
          password_confirm: "frank-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      deps(stub.run),
    );
    expect(res.status).toBe(400);
    expect(getUserByUsernameCI(harness.db, "frank")).toBeNull();
  });
});

// ===========================================================================
// Backwards-compat — legacy single-use invites redeem unchanged
// ===========================================================================

describe("backwards-compat — legacy single-use invites", () => {
  test("a legacy invite row (no v15 columns set) redeems with NO email field and single-use", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    // Simulate a legacy invite: a default issueInvite is max_uses=1 / no email
    // / no cap — exactly what a pre-v15 row looks like after the migration's
    // column defaults backfill it.
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id, vaultName: "maya" });

    // GET form has NO email field (single-use → friends flow, no email).
    const html = await handleAccountSetupGet(
      new Request(`${ISSUER}/account/setup/${rawToken}`),
      rawToken,
      deps(),
    ).text();
    expect(html).not.toContain('name="email"');

    const stub = makeStubRunCommand();
    const { token: csrfToken, cookieFragment } = csrfPair();
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "maya",
          // No email submitted — single-use doesn't require it.
          password: "maya-strong-password-1",
          password_confirm: "maya-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      deps(stub.run),
    );
    expect(res.status).toBe(302);

    const user = getUserByUsernameCI(harness.db, "maya");
    expect(user).not.toBeNull();
    expect(user?.email).toBeNull(); // no email captured on the friends flow
    expect(user?.assignedVaults).toEqual(["maya"]);

    // Vault provisioned WITHOUT a cap (legacy invites carry no cap).
    expect(getVaultCapBytes(harness.db, "maya")).toBeNull();

    // Single-use: a replay is refused (used → 410).
    __resetForTests();
    const replay = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "maya2",
          password: "maya2-strong-password-1",
          password_confirm: "maya2-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      deps(stub.run),
    );
    expect(replay.status).toBe(410);
    expect(await replay.text()).toContain("already used");
  });
});

// ===========================================================================
// API mint gates (POST /api/invites) — admin creates a multi-use capped link
// ===========================================================================

describe("POST /api/invites — multi-use + cap mint gates", () => {
  async function adminBearer(adminId: string): Promise<string> {
    const minted = await signAccessToken(harness.db, {
      sub: adminId,
      scopes: ["parachute:host:admin"],
      audience: "hub",
      clientId: "parachute-hub-spa",
      issuer: ISSUER,
      ttlSeconds: 300,
      vaultScope: [],
    });
    return minted.token;
  }

  function createReq(bearer: string, body: Record<string, unknown>): Request {
    return new Request(`${ISSUER}/api/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("mints a multi-use capped link; wire shape carries the new fields", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const bearer = await adminBearer(admin.id);
    const cap = 1024 * 1024 * 1024;
    const res = await handleCreateInvite(
      createReq(bearer, { max_uses: 25, vault_cap_bytes: cap }),
      { db: harness.db, issuer: ISSUER, manifestPath: harness.manifestPath },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invite: { max_uses: number; used_count: number; vault_cap_bytes: number; email: null };
      url: string;
    };
    expect(body.invite.max_uses).toBe(25);
    expect(body.invite.used_count).toBe(0);
    expect(body.invite.vault_cap_bytes).toBe(cap);
    expect(body.url).toContain("/account/setup/");
  });

  test("auto-applies the ~1 GiB default cap to a multi-use provisioning link with no explicit cap", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const bearer = await adminBearer(admin.id);
    const res = await handleCreateInvite(createReq(bearer, { max_uses: 10 }), {
      db: harness.db,
      issuer: ISSUER,
      manifestPath: harness.manifestPath,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invite: { vault_cap_bytes: number } };
    expect(body.invite.vault_cap_bytes).toBe(1024 * 1024 * 1024);
  });

  test("single-use link with no explicit cap stays uncapped (no auto-default)", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const bearer = await adminBearer(admin.id);
    const res = await handleCreateInvite(createReq(bearer, {}), {
      db: harness.db,
      issuer: ISSUER,
      manifestPath: harness.manifestPath,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invite: { vault_cap_bytes: number | null } };
    expect(body.invite.vault_cap_bytes).toBeNull();
  });

  test("rejects max_uses > 1 with a pre-named username", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const bearer = await adminBearer(admin.id);
    const res = await handleCreateInvite(
      createReq(bearer, { max_uses: 10, username: "jonathan" }),
      { db: harness.db, issuer: ISSUER, manifestPath: harness.manifestPath },
    );
    expect(res.status).toBe(400);
  });

  test("rejects max_uses > 1 with a pinned NEW vault name", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const bearer = await adminBearer(admin.id);
    const res = await handleCreateInvite(
      createReq(bearer, { max_uses: 10, vault_name: "shared", provision_vault: true }),
      { db: harness.db, issuer: ISSUER, manifestPath: harness.manifestPath },
    );
    expect(res.status).toBe(400);
  });

  test("rejects vault_cap_bytes on a non-provisioning invite", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const bearer = await adminBearer(admin.id);
    const res = await handleCreateInvite(
      createReq(bearer, { provision_vault: false, vault_cap_bytes: 1000 }),
      { db: harness.db, issuer: ISSUER, manifestPath: harness.manifestPath },
    );
    expect(res.status).toBe(400);
  });

  test("rejects max_uses out of range", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const bearer = await adminBearer(admin.id);
    const res = await handleCreateInvite(createReq(bearer, { max_uses: 0 }), {
      db: harness.db,
      issuer: ISSUER,
      manifestPath: harness.manifestPath,
    });
    expect(res.status).toBe(400);
  });
});
