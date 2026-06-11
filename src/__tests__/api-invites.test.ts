/**
 * Admin API tests for `/api/invites*` (`api-invites.ts`).
 *
 *   - host:admin gate (403 without the scope)
 *   - POST create → 201 with single-emit token + URL; defaults applied
 *   - GET list → status-annotated, raw token NEVER present
 *   - DELETE /:id → revoke; 409 when already terminal; 404 unknown
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCreateInvite, handleListInvites, handleRevokeInvite } from "../api-invites.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";
const HOST_ADMIN_SCOPE = "parachute:host:admin";

interface Harness {
  db: Database;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-invites-"));
  const db = openHubDb(hubDbPath(dir));
  const manifestPath = join(dir, "services.json");
  writeFileSync(manifestPath, JSON.stringify({ services: [] }));
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
});
afterEach(() => {
  harness.cleanup();
});

async function makeAdminBearer(scopes = [HOST_ADMIN_SCOPE]): Promise<string> {
  const user = await createUser(harness.db, "operator", "operator-password-1", {
    allowMulti: true,
    passwordChanged: true,
  });
  const minted = await signAccessToken(harness.db, {
    sub: user.id,
    scopes,
    audience: "hub",
    clientId: "parachute-hub-spa",
    issuer: ISSUER,
    ttlSeconds: 600,
  });
  return minted.token;
}

function deps() {
  return { db: harness.db, issuer: ISSUER, manifestPath: harness.manifestPath };
}

/** Register an existing vault in the harness manifest (for shared-vault invites). */
function seedVaultInManifest(name: string) {
  writeFileSync(
    harness.manifestPath,
    JSON.stringify({
      services: [
        {
          name: "parachute-vault",
          port: 4101,
          paths: [`/vault/${name}`],
          health: "/health",
          version: "0.0.0-test",
        },
      ],
    }),
  );
}

function withBearer(path: string, bearer: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", `Bearer ${bearer}`);
  return new Request(`${ISSUER}${path}`, { ...init, headers });
}

describe("/api/invites auth", () => {
  test("403 without host:admin scope", async () => {
    const bearer = await makeAdminBearer(["other:scope"]);
    const res = await handleListInvites(withBearer("/api/invites", bearer), deps());
    expect(res.status).toBe(403);
  });
});

describe("POST /api/invites", () => {
  test("201 with single-emit token + URL; defaults (write/provision/7d)", async () => {
    const bearer = await makeAdminBearer();
    const res = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      deps(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invite: { id: string; status: string; role: string; provision_vault: boolean };
      token: string;
      url: string;
    };
    expect(body.token.length).toBeGreaterThan(40);
    expect(body.url).toBe(`${ISSUER}/account/setup/${body.token}`);
    expect(body.invite.role).toBe("write");
    expect(body.invite.provision_vault).toBe(true);
    expect(body.invite.status).toBe("pending");
    // The id is the sha256 hash — never the raw token.
    expect(body.invite.id).not.toBe(body.token);
  });

  test("400 on a bad role", async () => {
    const bearer = await makeAdminBearer();
    const res = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  test("shared-vault invite (provision_vault=false + EXISTING vault_name) → 201 at the given role", async () => {
    // The Adam/Jonathan shape: read-only access to a vault the admin already
    // built. Issuing is host:admin-gated — the same authority that can assign
    // any user to any vault via POST /api/users.
    seedVaultInManifest("jonathan-vault");
    const bearer = await makeAdminBearer();
    const res = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provision_vault: false,
          vault_name: "jonathan-vault",
          role: "read",
        }),
      }),
      deps(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invite: { vault_name: string | null; role: string; provision_vault: boolean };
    };
    expect(body.invite.vault_name).toBe("jonathan-vault");
    expect(body.invite.role).toBe("read");
    expect(body.invite.provision_vault).toBe(false);
  });

  test("400 vault_not_found when the shared vault doesn't exist on this hub", async () => {
    // A pinned-but-nonexistent name is a typo, not a future reservation —
    // fail at mint, not at the invitee's redeem.
    const bearer = await makeAdminBearer();
    const res = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provision_vault: false, vault_name: "nosuchvault", role: "read" }),
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("vault_not_found");
  });

  test("400 rejects role=read with provision_vault=true (sole user of a new vault must hold write)", async () => {
    const bearer = await makeAdminBearer();
    const res = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provision_vault: true, role: "read" }),
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("write");
  });

  test("account-only invite (provision_vault=false, NO vault_name) is still allowed", async () => {
    const bearer = await makeAdminBearer();
    const res = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provision_vault: false }),
      }),
      deps(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invite: { provision_vault: boolean; vault_name: string | null };
    };
    expect(body.invite.provision_vault).toBe(false);
    expect(body.invite.vault_name).toBeNull();
  });
});

describe("POST /api/invites — pre-named username", () => {
  test("201 carries the username in the wire shape", async () => {
    seedVaultInManifest("jonathan-vault");
    const bearer = await makeAdminBearer();
    const res = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "jonathan",
          provision_vault: false,
          vault_name: "jonathan-vault",
          role: "read",
        }),
      }),
      deps(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invite: { username: string | null } };
    expect(body.invite.username).toBe("jonathan");
  });

  test("400 invalid_username on a name outside the /api/users vocabulary", async () => {
    const bearer = await makeAdminBearer();
    for (const bad of ["A", "Has Spaces", "admin"]) {
      const res = await handleCreateInvite(
        withBearer("/api/invites", bearer, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: bad }),
        }),
        deps(),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_username");
    }
  });

  test("409 username_taken when an existing user holds the name (case-insensitive)", async () => {
    const bearer = await makeAdminBearer(); // creates user "operator"
    const res = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "operator" }),
      }),
      deps(),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("username_taken");
  });

  test("409 username_reserved when another PENDING invite pre-names the same username", async () => {
    const bearer = await makeAdminBearer();
    const make = () =>
      handleCreateInvite(
        withBearer("/api/invites", bearer, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "jonathan" }),
        }),
        deps(),
      );
    const first = await make();
    expect(first.status).toBe(201);
    const second = await make();
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("username_reserved");
  });

  test("revoking the pending invite frees the reserved username", async () => {
    const bearer = await makeAdminBearer();
    const first = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "jonathan" }),
      }),
      deps(),
    );
    const { invite } = (await first.json()) as { invite: { id: string } };
    await handleRevokeInvite(
      withBearer(`/api/invites/${invite.id}`, bearer, { method: "DELETE" }),
      invite.id,
      deps(),
    );
    const second = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "jonathan" }),
      }),
      deps(),
    );
    expect(second.status).toBe(201);
  });
});

describe("GET /api/invites", () => {
  test("lists invites; raw token NEVER present in the wire shape", async () => {
    const bearer = await makeAdminBearer();
    const created = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vault_name: "maya" }),
      }),
      deps(),
    );
    const createdBody = (await created.json()) as { token: string };
    const list = await handleListInvites(withBearer("/api/invites", bearer), deps());
    const body = (await list.json()) as { invites: { id: string }[] };
    expect(body.invites.length).toBe(1);
    // The raw token must not be recoverable from the list.
    const json = JSON.stringify(body);
    expect(json).not.toContain(createdBody.token);
  });
});

describe("DELETE /api/invites/:id", () => {
  test("revokes a pending invite; 409 if already revoked; 404 unknown", async () => {
    const bearer = await makeAdminBearer();
    const created = await handleCreateInvite(
      withBearer("/api/invites", bearer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      deps(),
    );
    const { invite } = (await created.json()) as { invite: { id: string } };

    const ok = await handleRevokeInvite(
      withBearer(`/api/invites/${invite.id}`, bearer, { method: "DELETE" }),
      invite.id,
      deps(),
    );
    expect(ok.status).toBe(200);

    const again = await handleRevokeInvite(
      withBearer(`/api/invites/${invite.id}`, bearer, { method: "DELETE" }),
      invite.id,
      deps(),
    );
    expect(again.status).toBe(409);

    const unknown = await handleRevokeInvite(
      withBearer("/api/invites/deadbeef", bearer, { method: "DELETE" }),
      "deadbeef",
      deps(),
    );
    expect(unknown.status).toBe(404);
  });
});
