/**
 * Tests for the agent-connector grant store (`grants-store.ts`, 4b-1).
 *
 * Distinct from `grants.test.ts` (the OAuth consent skip-list in SQLite). This
 * is the on-disk JSON store for approval-gated agent grants: round-trip, 0600
 * perms (the file holds the granted secrets), idempotency-key derivation, and
 * the lenient-read posture.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConnectionSpec,
  GRANTS_FILE_VERSION,
  type GrantRecord,
  connectionKey,
  getGrant,
  grantId,
  listGrantsForAgent,
  putGrant,
  readGrants,
  removeGrant,
} from "../grants-store.ts";

let dir: string;
let storePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phub-grants-store-"));
  storePath = join(dir, "agent-grants.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function vaultSpec(over: Partial<ConnectionSpec> = {}): ConnectionSpec {
  return { kind: "vault", target: "research", access: "read", ...over };
}

function rec(over: Partial<GrantRecord> = {}): GrantRecord {
  const connection = over.connection ?? vaultSpec();
  return {
    id: over.id ?? grantId("agent1", connection),
    agent: over.agent ?? "agent1",
    connection,
    status: over.status ?? "pending",
    createdAt: over.createdAt ?? "2026-06-17T00:00:00.000Z",
    ...(over.reason ? { reason: over.reason } : {}),
    ...(over.material ? { material: over.material } : {}),
    ...(over.approvedAt ? { approvedAt: over.approvedAt } : {}),
  };
}

describe("round-trip", () => {
  test("a missing file reads as empty", () => {
    expect(readGrants(storePath)).toEqual([]);
  });

  test("put → read returns the record", () => {
    const r = rec();
    putGrant(storePath, r);
    const back = readGrants(storePath);
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(r);
  });

  test("put upserts by id (no duplicate row)", () => {
    const r = rec();
    putGrant(storePath, r);
    putGrant(storePath, { ...r, status: "approved", approvedAt: "2026-06-18T00:00:00.000Z" });
    const back = readGrants(storePath);
    expect(back).toHaveLength(1);
    expect(back[0]?.status).toBe("approved");
  });

  test("getGrant + removeGrant", () => {
    const r = rec();
    putGrant(storePath, r);
    expect(getGrant(storePath, r.id)?.id).toBe(r.id);
    const removed = removeGrant(storePath, r.id);
    expect(removed?.id).toBe(r.id);
    expect(getGrant(storePath, r.id)).toBeNull();
  });

  test("listGrantsForAgent filters by agent (case-insensitive)", () => {
    putGrant(storePath, rec({ id: "a", agent: "AgentOne" }));
    putGrant(
      storePath,
      rec({ id: "b", agent: "agenttwo", connection: vaultSpec({ target: "x" }) }),
    );
    expect(listGrantsForAgent(storePath, "agentone")).toHaveLength(1);
    expect(listGrantsForAgent(storePath, "AGENTTWO")).toHaveLength(1);
    expect(listGrantsForAgent(storePath, "nope")).toHaveLength(0);
  });
});

describe("file versioning (2026-07-01 — future-migration seam)", () => {
  test("every write stamps version: 1 and a rewrite preserves it", () => {
    putGrant(storePath, rec());
    const first = JSON.parse(readFileSync(storePath, "utf8")) as { version?: unknown };
    expect(first.version).toBe(GRANTS_FILE_VERSION);
    expect(first.version).toBe(1);
    // Round-trip through the store API keeps stamping it.
    putGrant(storePath, rec({ id: "second", agent: "agent2" }));
    const second = JSON.parse(readFileSync(storePath, "utf8")) as { version?: unknown };
    expect(second.version).toBe(1);
    expect(readGrants(storePath)).toHaveLength(2);
  });

  test("a LEGACY file without version loads fine (treated as v1)", () => {
    const legacy = rec();
    writeFileSync(storePath, JSON.stringify({ grants: [legacy] }));
    const back = readGrants(storePath);
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(legacy);
    // First write-through upgrades the file to the versioned shape without
    // losing the legacy record.
    putGrant(storePath, rec({ id: "new-row", agent: "agent2" }));
    const upgraded = JSON.parse(readFileSync(storePath, "utf8")) as {
      version?: unknown;
      grants: unknown[];
    };
    expect(upgraded.version).toBe(1);
    expect(upgraded.grants).toHaveLength(2);
  });
});

describe("0600 perms (the file holds secrets)", () => {
  test("the store file is created mode 0600", () => {
    putGrant(
      storePath,
      rec({
        status: "approved",
        material: { kind: "service", token: "ghp_secret" },
        connection: { kind: "service", target: "github" },
      }),
    );
    const mode = statSync(storePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("lenient read", () => {
  test("garbage JSON reads as empty", () => {
    writeFileSync(storePath, "not json {{{");
    expect(readGrants(storePath)).toEqual([]);
  });

  test("a top-level array (wrong shape) reads as empty", () => {
    writeFileSync(storePath, JSON.stringify([{ id: "x" }]));
    expect(readGrants(storePath)).toEqual([]);
  });

  test("a malformed row is dropped, valid rows survive", () => {
    const valid = rec();
    writeFileSync(
      storePath,
      JSON.stringify({
        grants: [
          valid,
          { id: "missing-agent" }, // no agent/connection/status → dropped
          { id: "bad-status", agent: "a", connection: vaultSpec(), status: "weird" }, // bad status → dropped
        ],
      }),
    );
    const back = readGrants(storePath);
    expect(back).toHaveLength(1);
    expect(back[0]?.id).toBe(valid.id);
  });
});

describe("4b-2 mcp material + needs_consent (regression)", () => {
  test("mcp material round-trips (OAuth shape)", () => {
    const r = rec({
      status: "approved",
      connection: { kind: "mcp", target: "https://remote.test/mcp" },
      material: {
        kind: "mcp",
        access_token: "at-1",
        refresh_token: "rt-1",
        expiresAt: "2026-06-18T13:00:00.000Z",
        issuer: "https://issuer.test",
        clientId: "cid-1",
        tokenEndpoint: "https://issuer.test/oauth/token",
        revocationEndpoint: "https://issuer.test/oauth/revoke",
        mcpUrl: "https://remote.test/mcp",
      },
    });
    putGrant(storePath, r);
    const back = readGrants(storePath);
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(r);
  });

  test("mcp static-bearer material round-trips (no refresh)", () => {
    const r = rec({
      status: "approved",
      connection: { kind: "mcp", target: "https://remote.test/mcp" },
      material: { kind: "mcp", access_token: "static-paste", mcpUrl: "https://remote.test/mcp" },
    });
    putGrant(storePath, r);
    expect(readGrants(storePath)[0]).toEqual(r);
  });

  test("a needs_consent row SURVIVES readGrants (the 4b-2 blocker regression)", () => {
    const r = rec({
      status: "needs_consent",
      reason: "refresh failed: invalid_grant",
      connection: { kind: "mcp", target: "https://remote.test/mcp" },
    });
    putGrant(storePath, r);
    const back = readGrants(storePath);
    expect(back).toHaveLength(1);
    expect(back[0]?.status).toBe("needs_consent");
    expect(getGrant(storePath, r.id)?.status).toBe("needs_consent");
  });
});

describe("connectionKey / grantId derivation (idempotency)", () => {
  test("vault key includes access + sorted tags", () => {
    expect(connectionKey(vaultSpec())).toBe("vault:research:read");
    expect(connectionKey(vaultSpec({ access: "write" }))).toBe("vault:research:write");
    // tag order doesn't change the key
    const a = connectionKey(vaultSpec({ tags: ["#b", "#a"] }));
    const b = connectionKey(vaultSpec({ tags: ["#a", "#b"] }));
    expect(a).toBe(b);
    expect(a).toBe("vault:research:read##a,#b");
  });

  test("service key ignores inject (re-declare with new inject → same key)", () => {
    const k1 = connectionKey({ kind: "service", target: "github", inject: ["env"] });
    const k2 = connectionKey({ kind: "service", target: "github", inject: ["env", "mcp"] });
    expect(k1).toBe(k2);
    expect(k1).toBe("service:github");
  });

  test("surface key includes the access verb", () => {
    expect(connectionKey({ kind: "surface", target: "gitcoin-brain", access: "write" })).toBe(
      "surface:gitcoin-brain:write",
    );
    expect(connectionKey({ kind: "surface", target: "gitcoin-brain", access: "read" })).toBe(
      "surface:gitcoin-brain:read",
    );
    // access defaults to read (matches the vault default); target lowercased for the slug
    expect(connectionKey({ kind: "surface", target: "Gitcoin-Brain" })).toBe(
      "surface:gitcoin-brain:read",
    );
  });

  test("mcp key is the url target", () => {
    expect(connectionKey({ kind: "mcp", target: "https://x.test/mcp" })).toBe(
      "mcp:https://x.test/mcp",
    );
  });

  test("grantId is a stable URL-safe slug from agent + key", () => {
    const id = grantId("agent1", vaultSpec());
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    // deterministic
    expect(grantId("agent1", vaultSpec())).toBe(id);
    // different connection → different id
    expect(grantId("agent1", vaultSpec({ access: "write" }))).not.toBe(id);
  });
});
