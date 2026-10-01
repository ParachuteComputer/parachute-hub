import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import { type DeleteVaultDeps, handleRenameVault, provisionVault } from "../admin-vaults.ts";
import { issueAuthCode } from "../auth-codes.ts";
import { upsertChannelVault } from "../channel-vaults.ts";
import { approveClient, registerClient } from "../clients.ts";
import { vaultRename } from "../commands/vault-rename.ts";
import { putConnection, readConnections } from "../connections-store.ts";
import { recordGrant } from "../grants.ts";
import { openHubDb } from "../hub-db.ts";
import { issueInvite } from "../invites.ts";
import {
  VaultNameReservedError,
  findTokenRowByJti,
  recordTokenMint,
  signAccessToken,
  signRefreshToken,
} from "../jwt-sign.ts";
import { handleToken } from "../oauth-handlers.ts";
import { writeManifest } from "../services-manifest.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser, setUserVaults } from "../users.ts";
import { setVaultCap } from "../vault-caps.ts";

const issuer = "http://127.0.0.1:1939";
let dir: string;
let db: ReturnType<typeof openHubDb>;
let deps: DeleteVaultDeps;
let commands: string[][];
let restarted: number;
let events: string[];
let bearer: string;
function manifest(names: string[]) {
  writeManifest(
    {
      services: [
        {
          name: "parachute-vault",
          version: "1.0.0",
          port: 1940,
          paths: names.map((n) => `/vault/${n}`),
          health: "/health",
        },
      ],
    },
    deps.manifestPath!,
  );
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hub-rename-"));
  db = openHubDb(join(dir, "hub.db"));
  rotateSigningKey(db);
  commands = [];
  events = [];
  restarted = 0;
  deps = {
    db,
    issuer,
    manifestPath: join(dir, "services.json"),
    connectionsStorePath: join(dir, "connections.json"),
    agentOrigin: null,
    resolveVaultOrigin: () => null,
    stopVaultModule: async () => {
      events.push("stop");
    },
    restartVaultModule: async () => {
      events.push("restart");
      restarted++;
    },
    runCommand: async (cmd) => {
      events.push(`CLI ${cmd[2]} → ${cmd[3]}`);
      commands.push([...cmd]);
      manifest([cmd[3]!, "ab", "axb"]);
      return {
        exitCode: 0,
        stdout: "Backup: /tmp/vault/.rename-backups/snapshot.db\nVault renamed.\n",
        stderr: "",
      };
    },
  };
  manifest(["a_b", "ab", "axb"]);
  bearer = (
    await signAccessToken(db, {
      sub: "operator",
      scopes: ["parachute:host:admin"],
      audience: "operator",
      clientId: "test",
      issuer,
    })
  ).token;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function rename(old = "a_b", name: unknown = "renamed", token: string | null = bearer) {
  return handleRenameVault(
    new Request(`${issuer}/vaults/${old}/rename`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ new_name: name }),
    }),
    old,
    deps,
  );
}
async function seed() {
  const user = await createUser(db, "alice", "a-safe-test-password");
  const client = registerClient(db, { redirectUris: ["https://client.example/cb"] }).client;
  approveClient(db, client.clientId);
  recordGrant(db, user.id, client.clientId, [
    "vault:ab:read",
    "vault:a_b:read",
    "vault:axb:write",
    "account:self:read",
  ]);
  db.prepare("UPDATE grants SET scopes = ?").run(
    "vault:ab:read vault:a_b:read vault:axb:write account:self:read",
  );
  setUserVaults(db, user.id, ["a_b", "ab", "axb"]);
  issueInvite(db, { createdBy: user.id, vaultName: "a_b" });
  setVaultCap(db, "a_b", 1234);
  upsertChannelVault(db, { relayHost: "relay.example", channelId: "channel", vault: "a_b" });
  const access = await signAccessToken(db, {
    sub: user.id,
    scopes: ["vault:a_b:read"],
    audience: "vault.a_b",
    clientId: client.clientId,
    issuer,
  });
  const refresh = signRefreshToken(db, {
    jti: access.jti,
    userId: user.id,
    clientId: client.clientId,
    scopes: ["vault:a_b:read"],
  });
  recordTokenMint(db, {
    jti: "operator-old",
    subject: "operator",
    createdVia: "cli_mint",
    clientId: "test",
    scopes: ["vault:a_b:admin"],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  recordTokenMint(db, {
    jti: "unrelated",
    subject: "operator",
    createdVia: "cli_mint",
    clientId: "test",
    scopes: ["vault:axb:admin"],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  putConnection(deps.connectionsStorePath, {
    id: "connection",
    kind: "credential",
    source: { module: "vault", vault: "a_b", event: "credential" },
    sink: { module: "agent", action: "credential" },
    provisioned: { type: "credential", vault: "a_b", scope: "vault:a_b:read" },
    createdAt: new Date().toISOString(),
  });
  return { user, client, access, refresh };
}

describe("POST /vaults/<name>/rename", () => {
  test("rewrites all identities exactly, preserves refresh family and mints the new scope/audience", async () => {
    const { client, access, refresh } = await seed();
    const restart = deps.restartVaultModule!;
    deps.restartVaultModule = async () => {
      expect(db.query("SELECT vault FROM channel_vaults").get()).toEqual({ vault: "renamed" });
      events.push("cascade");
      await restart();
    };
    const response = await rename();
    expect(events).toEqual(["stop", "CLI a_b → renamed", "cascade", "restart"]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      warnings: string[];
      error: string;
      error_description: string;
    };
    expect(body.warnings).toContain(
      "Every vault on the host was briefly offline during the rename.",
    );
    expect(body).toMatchObject({
      old: "a_b",
      new: "renamed",
      backup_path: "/tmp/vault/.rename-backups/snapshot.db",
      grants_rewritten: 1,
      user_vaults_renamed: 1,
      invites_renamed: 1,
      vault_cap_renamed: 1,
      channel_vaults_renamed: 1,
      tokens_rescoped: 1,
      tokens_revoked: ["operator-old"],
      tokens_revoked_count: 1,
      mounts: { mcp: "/vault/renamed/mcp", rest: "/vault/renamed" },
    });
    expect(commands).toEqual([["parachute-vault", "rename", "a_b", "renamed", "--yes"]]);
    expect(restarted).toBe(1);
    expect(db.query("SELECT scopes FROM grants").get()).toEqual({
      scopes: "vault:ab:read vault:renamed:read vault:axb:write account:self:read",
    });
    for (const table of ["user_vaults", "invites", "vault_caps"]) {
      expect(
        db.query(`SELECT count(*) AS n FROM ${table} WHERE vault_name = 'renamed'`).get(),
      ).toEqual({ n: 1 });
      expect(db.query(`SELECT count(*) AS n FROM ${table} WHERE vault_name = 'a_b'`).get()).toEqual(
        { n: 0 },
      );
    }
    expect(db.query("SELECT vault FROM channel_vaults").get()).toEqual({ vault: "renamed" });
    expect(readConnections(deps.connectionsStorePath)[0]).toMatchObject({
      source: { vault: "renamed" },
      provisioned: { vault: "renamed", scope: "vault:renamed:read" },
    });
    expect(findTokenRowByJti(db, "operator-old")?.revokedAt).not.toBeNull();
    expect(findTokenRowByJti(db, "unrelated")?.revokedAt).toBeNull();
    expect(findTokenRowByJti(db, access.jti)?.familyId).toBe(refresh.familyId);
    expect(findTokenRowByJti(db, access.jti)?.revokedAt).toBeNull();
    const renewed = await handleToken(
      db,
      new Request(`${issuer}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refresh.token,
          client_id: client.clientId,
        }),
      }),
      { issuer, loadServicesManifest: () => ({ services: [] }) },
    );
    expect(renewed.status).toBe(200);
    const tokens = (await renewed.json()) as { access_token: string };
    expect(decodeJwt(tokens.access_token)).toMatchObject({
      scope: "vault:renamed:read",
      aud: "vault.renamed",
    });
    expect(decodeJwt(access.token)).toMatchObject({ scope: "vault:a_b:read", aud: "vault.a_b" });
    const recreate = await provisionVault("a_b", {
      db,
      issuer,
      manifestPath: deps.manifestPath,
      runCommand: deps.runCommand,
    });
    expect(recreate).toMatchObject({ ok: false, status: 409 });
    expect(commands).toHaveLength(1);
    // A rename into the reserved name is also blocked.
    expect((await rename("renamed", "a_b")).status).toBe(409);
    expect(events).toEqual(["stop", "CLI a_b → renamed", "cascade", "restart"]);
    await expect(
      signAccessToken(db, {
        sub: "operator",
        scopes: ["vault:a_b:read"],
        audience: "vault.a_b",
        issuer,
        clientId: "test",
      }),
    ).rejects.toBeInstanceOf(VaultNameReservedError);
  });
  test("401/403 auth gate", async () => {
    expect((await rename("a_b", "renamed", null)).status).toBe(401);
    const read = (
      await signAccessToken(db, {
        sub: "reader",
        scopes: ["vault:a_b:read"],
        audience: "vault.a_b",
        issuer,
        clientId: "test",
      })
    ).token;
    expect((await rename("a_b", "renamed", read)).status).toBe(403);
    expect(commands).toHaveLength(0);
    expect(events).toEqual([]);
  });
  test("missing, collision, invalid and reserved names", async () => {
    expect((await rename("missing")).status).toBe(404);
    expect((await rename("a_b", "ab")).status).toBe(409);
    for (const name of ["admin", "Bad", "a", "a/b", "", 12, null, "x".repeat(33)])
      expect((await rename("a_b", name)).status).toBe(400);
    expect((await rename("admin")).status).toBe(400);
    expect(commands).toHaveLength(0);
    expect(events).toEqual([]);
  });
  test("CLI failure leaves identity tables untouched", async () => {
    const { access } = await seed();
    deps.runCommand = async () => {
      events.push("CLI");
      return { exitCode: 1, stdout: "", stderr: "disk full" };
    };
    const response = await rename();
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error_description: string }).error_description).toContain(
      "disk full",
    );
    expect(findTokenRowByJti(db, access.jti)?.scopes).toEqual(["vault:a_b:read"]);
    expect(findTokenRowByJti(db, "operator-old")?.revokedAt).toBeNull();
    expect(db.query("SELECT vault FROM channel_vaults").get()).toEqual({ vault: "a_b" });
    expect(restarted).toBe(1);
    expect(events).toEqual(["stop", "CLI", "restart"]);
  });
  test.each([false, true])(
    "cascade failure rolls back the DB and reports reverse CLI outcome (failure=%s)",
    async (reverseFails) => {
      const { access } = await seed();
      db.exec(
        "CREATE TRIGGER fail_rename BEFORE UPDATE ON channel_vaults BEGIN SELECT RAISE(ABORT, 'injected cascade failure'); END",
      );
      const run = deps.runCommand!;
      deps.runCommand = async (cmd) => {
        if (cmd[2] === "renamed" && reverseFails) {
          events.push(`CLI ${cmd[2]} → ${cmd[3]}`);
          commands.push([...cmd]);
          return { exitCode: 2, stdout: "", stderr: "reverse blocked" };
        }
        return run(cmd);
      };
      const response = await rename();
      expect(response.status).toBe(500);
      expect(
        ((await response.json()) as { error_description: string }).error_description,
      ).toContain(
        reverseFails
          ? "reverse CLI rename failed (2): reverse blocked"
          : "reverse CLI rename succeeded",
      );
      expect(events).toEqual(["stop", "CLI a_b → renamed", "CLI renamed → a_b", "restart"]);
      expect(commands[1]).toEqual(["parachute-vault", "rename", "renamed", "a_b", "--yes"]);
      expect(findTokenRowByJti(db, "operator-old")?.revokedAt).toBeNull();
      expect(findTokenRowByJti(db, access.jti)?.scopes).toEqual(["vault:a_b:read"]);
      expect(db.query("SELECT scopes FROM grants").get()).toEqual({
        scopes: "vault:ab:read vault:a_b:read vault:axb:write account:self:read",
      });
      expect(db.query("SELECT vault_name FROM vault_caps").get()).toEqual({ vault_name: "a_b" });
      expect(readConnections(deps.connectionsStorePath)[0]?.source.vault).toBe("a_b");
    },
  );
  test("invalidates old authorization codes and releases the tombstone after the access TTL", async () => {
    const { user, client } = await seed();
    const code = issueAuthCode(db, {
      userId: user.id,
      clientId: client.clientId,
      redirectUri: "https://client.example/cb",
      scopes: ["vault:a_b:read"],
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
    });
    const response = await rename();
    const body = (await response.json()) as { old_name_reserved_until: string };
    expect(db.query("SELECT code FROM auth_codes WHERE code = ?").get(code.code)).toBeNull();
    const future = new Date(Date.parse(body.old_name_reserved_until) + 1);
    const recreated = await provisionVault("a_b", {
      db,
      issuer,
      manifestPath: deps.manifestPath,
      now: () => future,
      runCommand: async () => {
        manifest(["a_b", "renamed"]);
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ name: "a_b", token: "", paths: { vault_dir: "/tmp/test" } }),
        };
      },
    });
    expect(recreated).toMatchObject({ ok: true, created: true });
  });
  test("commit failure restores connections and every DB write before reversing mechanics", async () => {
    await seed();
    db.exec(
      "CREATE TABLE deferred_failure (user_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)",
    );
    db.exec(
      "CREATE TRIGGER fail_commit AFTER INSERT ON hub_settings BEGIN INSERT INTO deferred_failure VALUES ('missing-user'); END",
    );
    const response = await rename();
    expect(response.status).toBe(500);
    expect(readConnections(deps.connectionsStorePath)[0]?.source.vault).toBe("a_b");
    expect(findTokenRowByJti(db, "operator-old")?.revokedAt).toBeNull();
    expect(db.query("SELECT vault FROM channel_vaults").get()).toEqual({ vault: "a_b" });
    expect(commands).toHaveLength(2);
  });
  test("JSON backup output", async () => {
    deps.runCommand = async () => {
      manifest(["renamed"]);
      return { exitCode: 0, stderr: "", stdout: JSON.stringify({ backup_path: "/tmp/backup.db" }) };
    };
    const response = await rename();
    const body = (await response.json()) as { backup_path: string; warnings: string[] };
    expect(body.backup_path).toBe("/tmp/backup.db");
    expect(response.status).toBe(200);
  });
  test("no supervisor refuses before CLI", async () => {
    deps.stopVaultModule = undefined;
    deps.restartVaultModule = undefined;
    const response = await rename();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "supervisor_unavailable" });
    expect(commands).toEqual([]);
    expect(events).toEqual([]);
  });
  test.each([false, true])("stop failure attempts restart (restart fails=%s)", async (fails) => {
    deps.stopVaultModule = async () => {
      events.push("stop");
      throw new Error("stop broke");
    };
    if (fails)
      deps.restartVaultModule = async () => {
        events.push("restart");
        throw new Error("start broke");
      };
    const response = await rename();
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      warnings: string[];
      error: string;
      error_description: string;
    };
    expect(body.error).toBe("stop_failed");
    expect(body.error_description).toContain("stop broke");
    if (fails) expect(body.error_description).toContain("start broke");
    expect(commands).toEqual([]);
    expect(events).toEqual(["stop", "restart"]);
  });
  test.each([false, true])("CLI throw restarts (restart fails=%s)", async (fails) => {
    deps.runCommand = async () => {
      events.push("CLI");
      throw new Error("spawn broke");
    };
    if (fails)
      deps.restartVaultModule = async () => {
        events.push("restart");
        throw new Error("start broke");
      };
    const response = await rename();
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      warnings: string[];
      error: string;
      error_description: string;
    };
    expect(body.error).toBe("rename_failed");
    expect(body.error_description).toContain("spawn broke");
    if (fails) expect(body.error_description).toContain("start broke");
    expect(events).toEqual(["stop", "CLI", "restart"]);
  });
  test.each([false, true])(
    "reserved-name refresh returns invalid_grant (inside transaction=%s)",
    async (insideTransaction) => {
      const { client, access, refresh } = await seed();
      const reserve = () =>
        db
          .prepare("INSERT OR REPLACE INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?)")
          .run(
            "vault_rename_reserved:a_b",
            new Date(Date.now() + 960000).toISOString(),
            new Date().toISOString(),
          );
      if (!insideTransaction) reserve();
      let clockCalls = 0;
      const response = await handleToken(
        db,
        new Request(`${issuer}/oauth/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refresh.token,
            client_id: client.clientId,
          }),
        }),
        {
          issuer,
          now: () => {
            if (++clockCalls === 4 && insideTransaction) {
              expect(db.inTransaction).toBe(true);
              expect(findTokenRowByJti(db, access.jti)?.revokedAt).not.toBeNull();
              reserve();
            }
            return new Date();
          },
          loadServicesManifest: () => ({ services: [] }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
      expect(findTokenRowByJti(db, access.jti)?.revokedAt).toBeNull();
      expect(findTokenRowByJti(db, access.jti)?.rotatedTo).toBeNull();
    },
  );
  test("reserved-name authorization code returns invalid_grant", async () => {
    const { user, client } = await seed();
    const verifier = "v".repeat(43);
    const code = issueAuthCode(db, {
      userId: user.id,
      clientId: client.clientId,
      redirectUri: "https://client.example/cb",
      scopes: ["vault:a_b:read"],
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
    });
    db.prepare("INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "vault_rename_reserved:a_b",
      new Date(Date.now() + 960000).toISOString(),
      new Date().toISOString(),
    );
    const response = await handleToken(
      db,
      new Request(`${issuer}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code.code,
          client_id: client.clientId,
          redirect_uri: "https://client.example/cb",
          code_verifier: verifier,
        }),
      }),
      { issuer, loadServicesManifest: () => ({ services: [] }) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });
  test("restart failure reports committed rename with a warning", async () => {
    deps.restartVaultModule = async () => {
      throw new Error("restart unavailable");
    };
    const response = await rename();
    expect(response.status).toBe(200);
    expect(((await response.json()) as { warnings: string[] }).warnings.join(" ")).toContain(
      "restart unavailable",
    );
  });
});

test("CLI uses the authenticated hub route and prints revocation details", async () => {
  const lines: string[] = [];
  const code = await vaultRename(["a_b", "renamed"], {
    resolveBearer: async () => "operator-bearer",
    log: (line) => lines.push(line),
    fetch: (async (url, init) => {
      expect(String(url)).toBe(`${issuer}/vaults/a_b/rename`);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ authorization: "Bearer operator-bearer" });
      expect(JSON.parse(String(init?.body))).toEqual({ new_name: "renamed" });
      return Response.json({ tokens_revoked: ["remint-this"] });
    }) as typeof fetch,
  });
  expect(code).toBe(0);
  expect(lines.join(" ")).toContain("remint-this");
});
