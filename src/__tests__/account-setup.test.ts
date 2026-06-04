/**
 * Redemption-flow tests for one-time invite links —
 * `GET|POST /account/setup/<token>` (`account-setup.ts`).
 *
 * Adversarial coverage of the redeem path + the security invariants:
 *   - happy path: creates user + vault + session, invite marked used
 *   - replay rejected (used_at set → 410)
 *   - expired rejected (410)
 *   - revoked rejected (410)
 *   - tampered/unknown token → 404
 *   - createUser fails → invite STILL re-usable (the ordering guarantee)
 *   - INVARIANT: the redeemed user holds ONLY their one vault at the
 *     invite's role — never host:admin, never another vault
 *
 * Vault provisioning is stubbed via `runCommand`: the stub appends the
 * named vault to services.json (what `parachute-vault create` does) so
 * `provisionVault`'s post-orchestrate re-read finds it — no real shell-out.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAccountSetupGet, handleAccountSetupPost } from "../account-setup.ts";
import type { RunResult } from "../admin-vaults.ts";
import { CSRF_FIELD_NAME, buildCsrfCookie, generateCsrfToken } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { consumeInvite, findInviteByRawToken, issueInvite, revokeInvite } from "../invites.ts";
import { __resetForTests } from "../rate-limit.ts";
import { findActiveSession } from "../sessions.ts";
import { createUser, getUserByUsernameCI, userCount, vaultVerbsForUserVault } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  manifestPath: string;
  /** Names of vaults the stubbed `runCommand` has "created". */
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-account-setup-"));
  const db = openHubDb(hubDbPath(dir));
  const manifestPath = join(dir, "services.json");
  // Seed with vault registered (one path) so the create branch runs
  // `parachute-vault create <name>` rather than the bootstrap install.
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

/** Stub vault create: append the named vault path to services.json, emit create JSON. */
function makeStubRunCommand(opts: { fail?: boolean } = {}) {
  const calls: string[][] = [];
  const run = async (cmd: readonly string[]): Promise<RunResult> => {
    calls.push([...cmd]);
    if (opts.fail) return { exitCode: 1, stdout: "", stderr: "boom" };
    // cmd = ["parachute-vault", "create", <name>, "--json", ...]
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

function deps(runCommand?: (cmd: readonly string[]) => Promise<RunResult>) {
  return {
    db: harness.db,
    hubOrigin: ISSUER,
    manifestPath: harness.manifestPath,
    ...(runCommand !== undefined ? { runCommand } : {}),
  };
}

/** Build a POST request with CSRF cookie + form body. */
function postReq(token: string, fields: Record<string, string>, csrfCookie: string): Request {
  const form = new URLSearchParams(fields);
  return new Request(`${ISSUER}/account/setup/${token}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: csrfCookie,
    },
    body: form.toString(),
  });
}

describe("GET /account/setup/<token>", () => {
  test("renders the claim form for a valid invite", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id, vaultName: "maya" });
    const res = handleAccountSetupGet(
      new Request(`${ISSUER}/account/setup/${rawToken}`),
      rawToken,
      deps(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Claim your invite");
    // Pinned vault → shown read-only, not a name-it field.
    expect(html).toContain("maya");
  });

  test("unknown token → 404", async () => {
    const res = handleAccountSetupGet(new Request(`${ISSUER}/account/setup/nope`), "nope", deps());
    expect(res.status).toBe(404);
  });

  test("expired invite → 410", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const now = new Date("2026-06-04T00:00:00Z");
    const { rawToken } = issueInvite(harness.db, {
      createdBy: admin.id,
      expiresInSeconds: 60,
      now: () => now,
    });
    const later = new Date(now.getTime() + 120_000);
    const res = handleAccountSetupGet(
      new Request(`${ISSUER}/account/setup/${rawToken}`),
      rawToken,
      { ...deps(), now: () => later },
    );
    expect(res.status).toBe(410);
  });
});

describe("POST /account/setup/<token> — happy path", () => {
  test("creates user + vault + session, marks invite used", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken, invite } = issueInvite(harness.db, {
      createdBy: admin.id,
      vaultName: "maya",
    });
    const { token: csrfToken, cookieFragment } = csrfPair();
    const stub = makeStubRunCommand();
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "maya",
          password: "maya-strong-password-1",
          password_confirm: "maya-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      deps(stub.run),
    );
    // 302 → /account/ with a session cookie.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/account/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.length).toBeGreaterThan(0);

    // User created, password_changed=true (chose their own → no force-change).
    const user = getUserByUsernameCI(harness.db, "maya");
    expect(user).not.toBeNull();
    expect(user?.passwordChanged).toBe(true);
    expect(user?.assignedVaults).toEqual(["maya"]);

    // Vault provisioned via the create branch.
    expect(stub.calls.some((c) => c[0] === "parachute-vault" && c[1] === "create")).toBe(true);

    // Invite consumed.
    const after = findInviteByRawToken(harness.db, rawToken);
    expect(after?.usedAt).not.toBeNull();
    expect(after?.redeemedUserId).toBe(user?.id ?? "");

    // Session is live for that user.
    const sid = setCookie.split(";")[0]?.split("=")[1] ?? "";
    const sessionReq = new Request(`${ISSUER}/account/`, {
      headers: { cookie: `parachute_hub_session=${sid}` },
    });
    const session = findActiveSession(harness.db, sessionReq);
    expect(session?.userId).toBe(user?.id ?? "");

    void invite;
  });

  test("redeemer names their own vault when the invite doesn't pin one", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id }); // vault_name null
    const { token: csrfToken, cookieFragment } = csrfPair();
    const stub = makeStubRunCommand();
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "sam",
          password: "sam-strong-password-12",
          password_confirm: "sam-strong-password-12",
          vault_name: "sams-vault",
        },
        cookieFragment,
      ),
      rawToken,
      deps(stub.run),
    );
    expect(res.status).toBe(302);
    const user = getUserByUsernameCI(harness.db, "sam");
    expect(user?.assignedVaults).toEqual(["sams-vault"]);
  });
});

describe("POST /account/setup/<token> — security invariants", () => {
  test("redeemed user holds ONLY their vault at the invite role — NOT admin, NOT another vault", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id, vaultName: "maya" });
    const { token: csrfToken, cookieFragment } = csrfPair();
    const stub = makeStubRunCommand();
    await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "maya",
          password: "maya-strong-password-1",
          password_confirm: "maya-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      deps(stub.run),
    );
    const user = getUserByUsernameCI(harness.db, "maya");
    expect(user).not.toBeNull();
    const id = user?.id ?? "";

    // Exactly one vault assignment.
    expect(user?.assignedVaults).toEqual(["maya"]);
    // Role is 'write' (owner) → read/write/admin on THEIR vault only.
    expect(vaultVerbsForUserVault(harness.db, id, "maya")).toEqual(["read", "write", "admin"]);
    // No authority over any other vault.
    expect(vaultVerbsForUserVault(harness.db, id, "seed")).toBeNull();
    expect(vaultVerbsForUserVault(harness.db, id, "other")).toBeNull();
    // The invited user is NOT the first admin (admin is the earliest row).
    const firstId = harness.db
      .query<{ id: string }, []>("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
      .get()?.id;
    expect(firstId).toBe(admin.id);
    expect(firstId).not.toBe(id);
  });

  test("a 'read' invite lands a read-only assignment", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken } = issueInvite(harness.db, {
      createdBy: admin.id,
      vaultName: "shared",
      role: "read",
    });
    const { token: csrfToken, cookieFragment } = csrfPair();
    const stub = makeStubRunCommand();
    await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "guest",
          password: "guest-strong-password-1",
          password_confirm: "guest-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      deps(stub.run),
    );
    const user = getUserByUsernameCI(harness.db, "guest");
    expect(vaultVerbsForUserVault(harness.db, user?.id ?? "", "shared")).toEqual(["read"]);
  });
});

describe("POST /account/setup/<token> — rejection paths", () => {
  test("replay (used invite) → 410", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken, invite } = issueInvite(harness.db, { createdBy: admin.id, vaultName: "x" });
    consumeInvite(harness.db, invite.tokenHash, admin.id);
    const { token: csrfToken, cookieFragment } = csrfPair();
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "late",
          password: "late-strong-password-1",
          password_confirm: "late-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      deps(makeStubRunCommand().run),
    );
    expect(res.status).toBe(410);
    // No new user created.
    expect(getUserByUsernameCI(harness.db, "late")).toBeNull();
  });

  test("expired invite → 410", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const now = new Date("2026-06-04T00:00:00Z");
    const { rawToken } = issueInvite(harness.db, {
      createdBy: admin.id,
      vaultName: "x",
      expiresInSeconds: 60,
      now: () => now,
    });
    const { token: csrfToken, cookieFragment } = csrfPair();
    const later = new Date(now.getTime() + 120_000);
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "late",
          password: "late-strong-password-1",
          password_confirm: "late-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      { ...deps(makeStubRunCommand().run), now: () => later },
    );
    expect(res.status).toBe(410);
  });

  test("revoked invite → 410", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken, invite } = issueInvite(harness.db, { createdBy: admin.id, vaultName: "x" });
    revokeInvite(harness.db, invite.tokenHash);
    const { token: csrfToken, cookieFragment } = csrfPair();
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "late",
          password: "late-strong-password-1",
          password_confirm: "late-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      deps(makeStubRunCommand().run),
    );
    expect(res.status).toBe(410);
  });

  test("tampered/unknown token → 404", async () => {
    const { token: csrfToken, cookieFragment } = csrfPair();
    const res = await handleAccountSetupPost(
      postReq(
        "unknown-token",
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "x",
          password: "xxxxxxxxxxxx",
          password_confirm: "xxxxxxxxxxxx",
        },
        cookieFragment,
      ),
      "unknown-token",
      deps(makeStubRunCommand().run),
    );
    expect(res.status).toBe(404);
  });

  test("missing CSRF → 400, invite untouched", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id, vaultName: "x" });
    const res = await handleAccountSetupPost(
      // No CSRF cookie/field.
      new Request(`${ISSUER}/account/setup/${rawToken}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          username: "x",
          password: "xxxxxxxxxxxx",
          password_confirm: "xxxxxxxxxxxx",
        }).toString(),
      }),
      rawToken,
      deps(makeStubRunCommand().run),
    );
    expect(res.status).toBe(400);
    expect(findInviteByRawToken(harness.db, rawToken)?.usedAt).toBeNull();
  });
});

describe("POST /account/setup/<token> — re-usability on createUser failure (ordering)", () => {
  test("createUser collision leaves the invite UNCONSUMED (re-usable)", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    // Pre-create a user with the username the invitee will pick → createUser
    // raises UsernameTakenError, AFTER provisionVault has run.
    await createUser(harness.db, "taken", "taken-password-12", { allowMulti: true });

    const { rawToken, invite } = issueInvite(harness.db, {
      createdBy: admin.id,
      vaultName: "maya",
    });
    const { token: csrfToken, cookieFragment } = csrfPair();
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "taken",
          password: "another-strong-password-1",
          password_confirm: "another-strong-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      deps(makeStubRunCommand().run),
    );
    expect(res.status).toBe(409);
    // The invite must NOT be consumed — the ordering guarantee.
    const after = findInviteByRawToken(harness.db, rawToken);
    expect(after?.usedAt).toBeNull();
    expect(after?.redeemedUserId).toBeNull();

    // And a SECOND attempt with a free username succeeds + consumes it.
    __resetForTests();
    const second = csrfPair();
    const res2 = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: second.token,
          username: "maya",
          password: "maya-strong-password-12",
          password_confirm: "maya-strong-password-12",
        },
        second.cookieFragment,
      ),
      rawToken,
      deps(makeStubRunCommand().run),
    );
    expect(res2.status).toBe(302);
    expect(findInviteByRawToken(harness.db, rawToken)?.usedAt).not.toBeNull();
    void invite;
  });
});

describe("POST /account/setup/<token> — vault-name validation (N1)", () => {
  test("a 33-char invitee-chosen vault name → clear validation error, NOT a generic provision failure", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    // vault_name null → the redeemer names their own vault.
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id });
    const { token: csrfToken, cookieFragment } = csrfPair();
    const tooLong = "a".repeat(33); // passes the bare charset regex, exceeds the 32 cap
    const stub = makeStubRunCommand();
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "sam",
          password: "sam-strong-password-12",
          password_confirm: "sam-strong-password-12",
          vault_name: tooLong,
        },
        cookieFragment,
      ),
      rawToken,
      deps(stub.run),
    );
    // 400 with the validator's specific message — the vault CLI is never reached.
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("2–32 characters");
    expect(html).not.toContain("Could not provision your vault");
    expect(stub.calls.length).toBe(0);
    // No account created.
    expect(getUserByUsernameCI(harness.db, "sam")).toBeNull();
  });
});

describe("POST /account/setup/<token> — concurrent redeem (N2)", () => {
  test("two concurrent redeems of one invite create EXACTLY one account (no orphan)", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken } = issueInvite(harness.db, { createdBy: admin.id, vaultName: "maya" });
    const before = userCount(harness.db); // 1 (the admin)

    // Two POSTs with DIFFERENT usernames, fired together. Each has its own
    // CSRF pair. createUser awaits argon2 before its (synchronous) commit
    // transaction; the consume-inside-tx guard is what serializes them.
    const a = csrfPair();
    const b = csrfPair();
    const mk = (uname: string, csrf: { token: string; cookieFragment: string }) =>
      handleAccountSetupPost(
        postReq(
          rawToken,
          {
            [CSRF_FIELD_NAME]: csrf.token,
            username: uname,
            password: `${uname}-strong-password-1`,
            password_confirm: `${uname}-strong-password-1`,
          },
          csrf.cookieFragment,
        ),
        rawToken,
        deps(makeStubRunCommand().run),
      );
    const [r1, r2] = await Promise.all([mk("alice", a), mk("bob", b)]);

    const statuses = [r1.status, r2.status].sort();
    // Exactly one 302 (success) and one 410 (the loser's used-path).
    expect(statuses).toEqual([302, 410]);
    // EXACTLY one account was created from the invite — no orphan row.
    expect(userCount(harness.db) - before).toBe(1);
    const aliceExists = getUserByUsernameCI(harness.db, "alice") !== null;
    const bobExists = getUserByUsernameCI(harness.db, "bob") !== null;
    // Exactly one of the two usernames landed.
    expect(aliceExists !== bobExists).toBe(true);
    // The invite is consumed, pinned to whichever user won.
    const after = findInviteByRawToken(harness.db, rawToken);
    expect(after?.usedAt).not.toBeNull();
    const winner = getUserByUsernameCI(harness.db, aliceExists ? "alice" : "bob");
    expect(after?.redeemedUserId).toBe(winner?.id ?? "");
  });
});

describe("POST /account/setup/<token> — account-only invite (N3)", () => {
  test("provision_vault=false, no vault_name → user with empty assignedVaults, no vault shell-out", async () => {
    const admin = await createUser(harness.db, "operator", "operator-password-1");
    const { rawToken } = issueInvite(harness.db, {
      createdBy: admin.id,
      provisionVault: false,
    });
    const { token: csrfToken, cookieFragment } = csrfPair();
    const stub = makeStubRunCommand();
    const res = await handleAccountSetupPost(
      postReq(
        rawToken,
        {
          [CSRF_FIELD_NAME]: csrfToken,
          username: "accountonly",
          password: "accountonly-password-1",
          password_confirm: "accountonly-password-1",
        },
        cookieFragment,
      ),
      rawToken,
      deps(stub.run),
    );
    expect(res.status).toBe(302);
    const user = getUserByUsernameCI(harness.db, "accountonly");
    expect(user).not.toBeNull();
    expect(user?.assignedVaults).toEqual([]);
    // No vault provisioning shell-out for an account-only invite.
    expect(stub.calls.length).toBe(0);
    // Invite consumed.
    expect(findInviteByRawToken(harness.db, rawToken)?.usedAt).not.toBeNull();
  });
});
