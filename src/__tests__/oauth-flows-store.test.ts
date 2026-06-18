/**
 * Tests for the in-flight OAuth consent-flow store (`oauth-flows-store.ts`, 4b-2).
 *
 * put / get-by-state / delete-on-use / round-trip / TTL prune / 0600 perms / the
 * lenient-read posture. The file holds PKCE verifiers (secrets) → 0600.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLOW_TTL_MS,
  type PendingFlow,
  deleteFlow,
  getFlowByState,
  pruneExpiredFlows,
  putFlow,
} from "../oauth-flows-store.ts";

let dir: string;
let storePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phub-oauth-flows-"));
  storePath = join(dir, "agent-oauth-flows.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function flow(over: Partial<PendingFlow> = {}): PendingFlow {
  return {
    state: over.state ?? "state-1",
    grantId: over.grantId ?? "grant-1",
    issuer: over.issuer ?? "https://issuer.test",
    clientId: over.clientId ?? "cid-1",
    tokenEndpoint: over.tokenEndpoint ?? "https://issuer.test/oauth/token",
    verifier: over.verifier ?? "pkce-verifier-secret",
    mcpUrl: over.mcpUrl ?? "https://remote.test/mcp",
    redirectUri: over.redirectUri ?? "https://hub.test/oauth/agent-grant/callback",
    createdAt: over.createdAt ?? new Date().toISOString(),
    ...(over.revocationEndpoint ? { revocationEndpoint: over.revocationEndpoint } : {}),
    ...(over.scope ? { scope: over.scope } : {}),
  };
}

describe("round-trip", () => {
  test("a missing file returns null for any state", () => {
    expect(getFlowByState(storePath, "anything")).toBeNull();
  });

  test("put → get by state", () => {
    const f = flow();
    putFlow(storePath, f);
    const back = getFlowByState(storePath, "state-1");
    expect(back).toEqual(f);
  });

  test("put upserts by state (no duplicate)", () => {
    putFlow(storePath, flow({ clientId: "old" }));
    putFlow(storePath, flow({ clientId: "new" }));
    expect(getFlowByState(storePath, "state-1")?.clientId).toBe("new");
  });

  test("delete-on-use removes the flow (single-use)", () => {
    putFlow(storePath, flow());
    const removed = deleteFlow(storePath, "state-1");
    expect(removed?.state).toBe("state-1");
    expect(getFlowByState(storePath, "state-1")).toBeNull();
    // second delete is a no-op
    expect(deleteFlow(storePath, "state-1")).toBeNull();
  });

  test("distinct states coexist", () => {
    putFlow(storePath, flow({ state: "a" }));
    putFlow(storePath, flow({ state: "b", grantId: "grant-2" }));
    expect(getFlowByState(storePath, "a")?.grantId).toBe("grant-1");
    expect(getFlowByState(storePath, "b")?.grantId).toBe("grant-2");
  });
});

describe("TTL prune", () => {
  test("an expired flow is pruned on read (returns null)", () => {
    const old = new Date(Date.now() - (FLOW_TTL_MS + 60_000)).toISOString();
    putFlow(storePath, flow({ createdAt: old }));
    // The default-now read prunes it.
    expect(getFlowByState(storePath, "state-1")).toBeNull();
  });

  test("pruneExpiredFlows drops the expired and keeps the live", () => {
    const now = Date.now();
    putFlow(storePath, flow({ state: "fresh", createdAt: new Date(now).toISOString() }), now);
    putFlow(
      storePath,
      flow({ state: "stale", createdAt: new Date(now - FLOW_TTL_MS - 1).toISOString() }),
      now,
    );
    const live = pruneExpiredFlows(storePath, now);
    expect(live.map((f) => f.state).sort()).toEqual(["fresh"]);
  });

  test("put prunes expired flows before persisting", () => {
    const now = Date.now();
    // Seed an expired flow directly.
    writeFileSync(
      storePath,
      JSON.stringify({
        flows: [flow({ state: "stale", createdAt: new Date(now - FLOW_TTL_MS - 1).toISOString() })],
      }),
    );
    putFlow(storePath, flow({ state: "fresh", createdAt: new Date(now).toISOString() }), now);
    expect(getFlowByState(storePath, "stale", now)).toBeNull();
    expect(getFlowByState(storePath, "fresh", now)).not.toBeNull();
  });
});

describe("0600 perms (holds PKCE verifiers)", () => {
  test("the store file is created mode 0600", () => {
    putFlow(storePath, flow());
    const mode = statSync(storePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("lenient read", () => {
  test("garbage JSON reads as empty", () => {
    writeFileSync(storePath, "not json {{{");
    expect(getFlowByState(storePath, "x")).toBeNull();
  });

  test("a malformed row is dropped, valid rows survive", () => {
    const valid = flow({ state: "ok" });
    writeFileSync(
      storePath,
      JSON.stringify({
        flows: [valid, { state: "bad" /* missing required fields */ }],
      }),
    );
    expect(getFlowByState(storePath, "ok")).not.toBeNull();
    expect(getFlowByState(storePath, "bad")).toBeNull();
  });
});
