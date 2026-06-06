import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerClient } from "../clients.ts";
import {
  findGrant,
  findGrantByClientName,
  isCoveredByGrant,
  isCoveredByGrantForClientName,
  isFirstPartyBrowserClient,
  listGrantsForUser,
  recordGrant,
  revokeGrant,
  userHasExternalAiGrant,
  userHasVaultGrant,
} from "../grants.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { createUser } from "../users.ts";

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "phub-grants-"));
  const db = openHubDb(hubDbPath(dir));
  const user = await createUser(db, "owner", "pw");
  const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
  return {
    db,
    userId: user.id,
    clientId: reg.client.clientId,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("grants module (#75)", () => {
  test("findGrant returns null when no row exists", async () => {
    const h = await harness();
    try {
      expect(findGrant(h.db, h.userId, h.clientId)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("recordGrant inserts a row with sorted scopes", async () => {
    const h = await harness();
    try {
      const grant = recordGrant(h.db, h.userId, h.clientId, ["b", "a", "c"]);
      // Sorted to keep on-disk order deterministic; test pins the contract.
      expect(grant.scopes).toEqual(["a", "b", "c"]);
      const fromDb = findGrant(h.db, h.userId, h.clientId);
      expect(fromDb?.scopes).toEqual(["a", "b", "c"]);
    } finally {
      h.cleanup();
    }
  });

  test("recordGrant unions new scopes into existing grant", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["a", "b", "c"]);
      recordGrant(h.db, h.userId, h.clientId, ["a", "d"]);
      const grant = findGrant(h.db, h.userId, h.clientId);
      expect(new Set(grant?.scopes)).toEqual(new Set(["a", "b", "c", "d"]));
    } finally {
      h.cleanup();
    }
  });

  test("recordGrant skips empty strings inside the scope list", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["", "a", ""]);
      const grant = findGrant(h.db, h.userId, h.clientId);
      expect(grant?.scopes).toEqual(["a"]);
    } finally {
      h.cleanup();
    }
  });

  test("isCoveredByGrant: false when no grant exists", async () => {
    const h = await harness();
    try {
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["a"])).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("isCoveredByGrant: true for exact match and subset, false for superset", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["a", "b", "c"]);
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["a", "b", "c"])).toBe(true);
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["a"])).toBe(true);
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["a", "b"])).toBe(true);
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["a", "d"])).toBe(false);
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["d"])).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("isCoveredByGrant: empty request returns false (no auto-approve for empty)", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["a"]);
      // Empty scope flow is suspicious — surface it through consent rather
      // than silently auto-approving.
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, [])).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("revokeGrant returns true when a row was removed, false when none existed", async () => {
    const h = await harness();
    try {
      expect(revokeGrant(h.db, h.userId, h.clientId)).toBe(false);
      recordGrant(h.db, h.userId, h.clientId, ["a"]);
      expect(revokeGrant(h.db, h.userId, h.clientId)).toBe(true);
      expect(findGrant(h.db, h.userId, h.clientId)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("recordGrant: concurrent calls produce one row with the union of scopes (#119)", async () => {
    const h = await harness();
    try {
      // Fire two recordGrant calls "concurrently" via Promise.all. The
      // transaction wrapper means the read-merge-write is atomic, so the
      // second writer always sees the first writer's scopes — neither set
      // gets dropped.
      await Promise.all([
        Promise.resolve().then(() => recordGrant(h.db, h.userId, h.clientId, ["a", "b"])),
        Promise.resolve().then(() => recordGrant(h.db, h.userId, h.clientId, ["c", "d"])),
      ]);
      const rowCount = (
        h.db
          .prepare("SELECT COUNT(*) AS n FROM grants WHERE user_id = ? AND client_id = ?")
          .get(h.userId, h.clientId) as { n: number }
      ).n;
      expect(rowCount).toBe(1);
      const grant = findGrant(h.db, h.userId, h.clientId);
      expect(new Set(grant?.scopes)).toEqual(new Set(["a", "b", "c", "d"]));
    } finally {
      h.cleanup();
    }
  });

  test("listGrantsForUser orders most-recent first", async () => {
    const h = await harness();
    try {
      const reg2 = registerClient(h.db, { redirectUris: ["https://other.example/cb"] });
      // Older grant first.
      recordGrant(h.db, h.userId, h.clientId, ["a"], new Date("2026-04-01T00:00:00Z"));
      recordGrant(h.db, h.userId, reg2.client.clientId, ["b"], new Date("2026-04-15T00:00:00Z"));
      const grants = listGrantsForUser(h.db, h.userId);
      expect(grants).toHaveLength(2);
      expect(grants[0]?.clientId).toBe(reg2.client.clientId);
      expect(grants[1]?.clientId).toBe(h.clientId);
    } finally {
      h.cleanup();
    }
  });
});

describe("findGrantByClientName / isCoveredByGrantForClientName (hub#409)", () => {
  test("returns the most recent grant across any client_id with the matching name", async () => {
    // Closes hub#409: CLI MCP clients re-DCR each session, each landing
    // fresh client_ids. Operator approves once by name; future DCRs of
    // the same name should auto-trust.
    const h = await harness();
    try {
      // First DCR: client_name="claude-code", scope a+b
      const reg1 = registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "claude-code",
      });
      recordGrant(
        h.db,
        h.userId,
        reg1.client.clientId,
        ["a", "b"],
        new Date("2026-04-10T00:00:00Z"),
      );
      // Second DCR: same client_name="claude-code", fresh client_id, no grant yet
      const reg2 = registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "claude-code",
      });
      // findGrantByClientName should return the prior grant
      const grant = findGrantByClientName(h.db, h.userId, "claude-code");
      expect(grant).not.toBeNull();
      expect(grant?.clientId).toBe(reg1.client.clientId);
      expect(grant?.scopes).toEqual(["a", "b"]);
    } finally {
      h.cleanup();
    }
  });

  test("returns null when no client with that name has any grant", async () => {
    const h = await harness();
    try {
      registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "claude-code",
      });
      // No grants recorded
      expect(findGrantByClientName(h.db, h.userId, "claude-code")).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("returns null when client_name is empty string", async () => {
    const h = await harness();
    try {
      expect(findGrantByClientName(h.db, h.userId, "")).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("returns null for a different user (per-user isolation)", async () => {
    const h = await harness();
    try {
      const reg = registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "claude-code",
      });
      recordGrant(h.db, h.userId, reg.client.clientId, ["a"]);
      // Another user — should NOT see the grant. (hub is single-user-by-
      // default; pass allowMulti for the test.)
      const other = await createUser(h.db, "other-user", "pw", { allowMulti: true });
      expect(findGrantByClientName(h.db, other.id, "claude-code")).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("picks the most recent when multiple clients share the name", async () => {
    const h = await harness();
    try {
      const reg1 = registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "claude-code",
      });
      const reg2 = registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "claude-code",
      });
      const reg3 = registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "claude-code",
      });
      recordGrant(h.db, h.userId, reg1.client.clientId, ["a"], new Date("2026-04-01T00:00:00Z"));
      recordGrant(
        h.db,
        h.userId,
        reg3.client.clientId,
        ["a", "c"],
        new Date("2026-04-15T00:00:00Z"),
      );
      recordGrant(
        h.db,
        h.userId,
        reg2.client.clientId,
        ["a", "b"],
        new Date("2026-04-10T00:00:00Z"),
      );
      const grant = findGrantByClientName(h.db, h.userId, "claude-code");
      // Most recent = reg3's grant (2026-04-15)
      expect(grant?.clientId).toBe(reg3.client.clientId);
      expect(grant?.scopes).toEqual(["a", "c"]);
    } finally {
      h.cleanup();
    }
  });

  test("isCoveredByGrantForClientName: subset of stored scopes → true", async () => {
    const h = await harness();
    try {
      const reg = registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "claude-code",
      });
      recordGrant(h.db, h.userId, reg.client.clientId, [
        "vault:default:read",
        "vault:default:write",
      ]);
      expect(
        isCoveredByGrantForClientName(h.db, h.userId, "claude-code", ["vault:default:read"]),
      ).toBe(true);
      expect(
        isCoveredByGrantForClientName(h.db, h.userId, "claude-code", [
          "vault:default:read",
          "vault:default:write",
        ]),
      ).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("isCoveredByGrantForClientName: superset of stored scopes → false", async () => {
    const h = await harness();
    try {
      const reg = registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "claude-code",
      });
      recordGrant(h.db, h.userId, reg.client.clientId, ["vault:default:read"]);
      // Asking for write — not previously granted
      expect(
        isCoveredByGrantForClientName(h.db, h.userId, "claude-code", ["vault:default:write"]),
      ).toBe(false);
      expect(
        isCoveredByGrantForClientName(h.db, h.userId, "claude-code", [
          "vault:default:read",
          "vault:default:write",
        ]),
      ).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("isCoveredByGrantForClientName: empty scopes → false (matches isCoveredByGrant contract)", async () => {
    const h = await harness();
    try {
      const reg = registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "claude-code",
      });
      recordGrant(h.db, h.userId, reg.client.clientId, ["a"]);
      expect(isCoveredByGrantForClientName(h.db, h.userId, "claude-code", [])).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  // --- userHasVaultGrant (onboarding "has connected an AI?" signal) --------

  test("userHasVaultGrant: false when the user has no grants at all", async () => {
    const h = await harness();
    try {
      expect(userHasVaultGrant(h.db, h.userId, "default")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("userHasVaultGrant: true when a grant's scopes touch the vault", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["vault:default:read", "vault:default:write"]);
      expect(userHasVaultGrant(h.db, h.userId, "default")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("userHasVaultGrant: false when the grant touches a DIFFERENT vault", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["vault:work:read"]);
      expect(userHasVaultGrant(h.db, h.userId, "default")).toBe(false);
      expect(userHasVaultGrant(h.db, h.userId, "work")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("userHasVaultGrant: non-vault scopes don't count as a connection", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["parachute:host:auth", "vault:read"]);
      // `vault:read` (no name segment) is a generic scope, not vault:<name>:.
      expect(userHasVaultGrant(h.db, h.userId, "default")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("userHasVaultGrant: prefix isn't substring-fooled (vault:default-2 ≠ default)", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["vault:default-2:read"]);
      expect(userHasVaultGrant(h.db, h.userId, "default")).toBe(false);
      expect(userHasVaultGrant(h.db, h.userId, "default-2")).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe("userHasExternalAiGrant / isFirstPartyBrowserClient (hub#583)", () => {
  test("isFirstPartyBrowserClient matches fixed first-party client_ids", () => {
    expect(isFirstPartyBrowserClient("parachute-hub-spa", null)).toBe(true);
    expect(isFirstPartyBrowserClient("parachute-account", null)).toBe(true);
    expect(isFirstPartyBrowserClient("some-random-dcr-id", null)).toBe(false);
  });

  test("isFirstPartyBrowserClient matches Notes by client_name (case-insensitive)", () => {
    expect(isFirstPartyBrowserClient("dcr-generated-id", "Notes")).toBe(true);
    expect(isFirstPartyBrowserClient("dcr-generated-id", "notes")).toBe(true);
    expect(isFirstPartyBrowserClient("dcr-generated-id", "Claude")).toBe(false);
    expect(isFirstPartyBrowserClient("dcr-generated-id", null)).toBe(false);
  });

  test("a first-party browser grant does NOT count as a connected AI", async () => {
    const h = await harness();
    try {
      // Notes signs in via DCR (generated client_id, client_name "Notes") and
      // writes a vault-scoped grant — the exact false-positive in hub#583.
      const notes = registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "Notes",
      });
      recordGrant(h.db, h.userId, notes.client.clientId, ["vault:default:read"]);
      // The coarse signal lights up...
      expect(userHasVaultGrant(h.db, h.userId, "default")).toBe(true);
      // ...but the AI-connection signal does NOT.
      expect(userHasExternalAiGrant(h.db, h.userId, "default")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("the fixed first-party SPA client_id does NOT count as a connected AI", async () => {
    const h = await harness();
    try {
      registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientId: "parachute-hub-spa",
      });
      recordGrant(h.db, h.userId, "parachute-hub-spa", ["vault:default:read"]);
      expect(userHasExternalAiGrant(h.db, h.userId, "default")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("an external AI/MCP client grant DOES count as connected", async () => {
    const h = await harness();
    try {
      // Claude Code: DCR-registered, ordinary client_name, vault scope.
      const claude = registerClient(h.db, {
        redirectUris: ["https://claude.ai/cb"],
        clientName: "Claude",
      });
      recordGrant(h.db, h.userId, claude.client.clientId, ["vault:default:read"]);
      expect(userHasExternalAiGrant(h.db, h.userId, "default")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("external grant is scoped to the named vault", async () => {
    const h = await harness();
    try {
      const claude = registerClient(h.db, {
        redirectUris: ["https://claude.ai/cb"],
        clientName: "Claude",
      });
      recordGrant(h.db, h.userId, claude.client.clientId, ["vault:other:read"]);
      expect(userHasExternalAiGrant(h.db, h.userId, "default")).toBe(false);
      expect(userHasExternalAiGrant(h.db, h.userId, "other")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("Notes + Claude both granted: still counts (the external one wins)", async () => {
    const h = await harness();
    try {
      const notes = registerClient(h.db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "Notes",
      });
      const claude = registerClient(h.db, {
        redirectUris: ["https://claude.ai/cb"],
        clientName: "Claude",
      });
      recordGrant(h.db, h.userId, notes.client.clientId, ["vault:default:read"]);
      recordGrant(h.db, h.userId, claude.client.clientId, ["vault:default:read"]);
      expect(userHasExternalAiGrant(h.db, h.userId, "default")).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});
