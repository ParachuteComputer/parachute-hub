/**
 * Unit tests for the `/account/` per-vault backup (mirror) status fetch +
 * formatting (`account-mirror.ts`). The fetch mints an admin-scoped token + hits
 * the vault's loopback `/.parachute/mirror` endpoint; it must be fault-tolerant
 * (any failure → null) and shape-strict (a malformed body → null, not a render
 * of `undefined`). Mirrors `account-usage.test.ts`'s posture.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type VaultMirrorStat,
  derivePushState,
  fetchVaultMirrorStatus,
  formatMirrorLine,
  isMirrorHealthy,
} from "../account-mirror.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-account-mirror-"));
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

/** A stub signer — no real key needed; the fetch only carries the token string. */
const stubSign = async () => ({
  token: "stub.jwt.token",
  jti: "jti-1",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
});

function baseDeps(fetchImpl: typeof fetch) {
  return {
    db: harness.db,
    hubOrigin: "https://hub.test",
    vaultPort: 1940,
    userId: "user-1",
    fetchImpl,
    signToken: stubSign as never,
  };
}

describe("fetchVaultMirrorStatus", () => {
  test("returns enabled+not-pushing on a backed-up, local-only config", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          config: { enabled: true, location: "internal", auto_push: false },
          status: { enabled: true, last_commit_sha: "abc", last_error: null },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat).toEqual({ enabled: true, backedUpToRemote: false, remotePushState: "n/a" });
  });

  test("flags pushing when auto_push is configured", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ config: { enabled: true, location: "internal", auto_push: true } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat).toEqual({ enabled: true, backedUpToRemote: true, remotePushState: "ok" });
  });

  test("returns enabled:false when backup is off", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ config: { enabled: false, auto_push: false } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat).toEqual({ enabled: false, backedUpToRemote: false, remotePushState: "n/a" });
  });

  test("mints an ADMIN-scoped Bearer + hits the vault's loopback mirror endpoint", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenScope: string[] = [];
    const captureSign = (async (_db: unknown, opts: { scopes: string[] }) => {
      seenScope = opts.scopes;
      return { token: "stub.jwt.token", jti: "j", expiresAt: new Date().toISOString() };
    }) as never;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>)?.authorization ?? "";
      return new Response(JSON.stringify({ config: { enabled: true, auto_push: false } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await fetchVaultMirrorStatus("work", { ...baseDeps(fetchImpl), signToken: captureSign });
    expect(seenUrl).toBe("http://127.0.0.1:1940/vault/work/.parachute/mirror");
    expect(seenAuth).toBe("Bearer stub.jwt.token");
    expect(seenScope).toEqual(["vault:work:admin"]);
  });

  test("returns null on a non-2xx response (vault down / 403 / 404)", async () => {
    for (const status of [403, 404, 500]) {
      const fetchImpl = (async () => new Response("nope", { status })) as unknown as typeof fetch;
      const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
      expect(stat).toBeNull();
    }
  });

  test("returns null when the body is malformed (missing config.enabled)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ config: {} }), { status: 200 })) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat).toBeNull();
  });

  test("returns null when fetch throws (network error)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat).toBeNull();
  });
});

describe("formatMirrorLine", () => {
  test("warm plain-language line; GitHub variant when pushing", () => {
    expect(
      formatMirrorLine({ enabled: true, backedUpToRemote: false, remotePushState: "n/a" }),
    ).toBe("Backed up — full version history");
    expect(formatMirrorLine({ enabled: true, backedUpToRemote: true, remotePushState: "ok" })).toBe(
      "Backed up — version history + GitHub",
    );
  });

  test("returns null when backup is off (the tile omits the line, never nags)", () => {
    expect(
      formatMirrorLine({ enabled: false, backedUpToRemote: false, remotePushState: "n/a" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// vault#822 — a configured remote is not a working one.
//
// Field report: a vault's mirror had rejected 122 consecutive pushes since
// 2026-07-28 (remote created against unrelated history → every push refused as
// non-fast-forward). The vault logged each failure `(non-fatal)` and carried
// on; `/account/` rendered "Backed up — version history + GitHub" because
// `config.auto_push` was true. Five days, no off-site copy, nothing surfaced.
//
// These tests pin the two properties that were missing: the line must follow
// the last push OUTCOME, and "never worked" must be louder than "failed once".
// ---------------------------------------------------------------------------

describe("derivePushState", () => {
  test("no remote configured → n/a regardless of status", () => {
    expect(derivePushState(false, undefined)).toBe("n/a");
    expect(derivePushState(false, { last_push_at: null, last_push_error: "boom" })).toBe("n/a");
  });

  test("error with no prior success → never (a setup bug, not a blip)", () => {
    expect(
      derivePushState(true, {
        last_push_at: null,
        last_push_error: "! [rejected] main -> main (non-fast-forward)",
      }),
    ).toBe("never");
  });

  test("error after a prior success → failing", () => {
    expect(
      derivePushState(true, {
        last_push_at: "2026-07-28T04:00:00.000Z",
        last_push_error: "! [rejected] main -> main (non-fast-forward)",
      }),
    ).toBe("failing");
  });

  test("no error → ok", () => {
    expect(
      derivePushState(true, { last_push_at: "2026-08-03T04:00:00.000Z", last_push_error: null }),
    ).toBe("ok");
  });

  test("nothing attempted yet → ok, not a false alarm", () => {
    expect(derivePushState(true, { last_push_at: null, last_push_error: null })).toBe("ok");
  });

  test("a vault too old to report push fields → ok (can't tell ≠ failing)", () => {
    expect(derivePushState(true, undefined)).toBe("ok");
    expect(derivePushState(true, {})).toBe("ok");
  });

  test("empty-string error is not an error", () => {
    expect(derivePushState(true, { last_push_at: null, last_push_error: "" })).toBe("ok");
  });
});

describe("vault#822 — the field report, end to end", () => {
  const AARONS_BODY = {
    config: { enabled: true, location: "internal", auto_push: true },
    status: {
      enabled: true,
      last_commit_sha: "deadbee",
      last_error: null,
      last_push_at: null,
      last_push_sha: null,
      last_push_error: "! [rejected]        main -> main (non-fast-forward)",
      commits_unpushed: 122,
    },
  };

  test("the exact reported state does NOT render as backed up", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(AARONS_BODY), { status: 200 })) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat).not.toBeNull();
    expect(stat?.remotePushState).toBe("never");

    const line = formatMirrorLine(stat as VaultMirrorStat);
    // The regression, stated as the thing that must not happen again.
    expect(line).not.toBe("Backed up — version history + GitHub");
    expect(line).toBe("Version history saved here — GitHub backup has never worked");
    expect(isMirrorHealthy(stat as VaultMirrorStat)).toBe(false);
  });

  test("mutate the fixture to a landed push and the healthy line comes back", async () => {
    // The guard has to distinguish, not just always say "broken" — mutate the
    // one field that matters and confirm the verdict flips.
    const healthyBody = {
      ...AARONS_BODY,
      status: {
        ...AARONS_BODY.status,
        last_push_at: "2026-08-03T04:00:00.000Z",
        last_push_error: null,
        commits_unpushed: 0,
      },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(healthyBody), { status: 200 })) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat?.remotePushState).toBe("ok");
    expect(formatMirrorLine(stat as VaultMirrorStat)).toBe("Backed up — version history + GitHub");
    expect(isMirrorHealthy(stat as VaultMirrorStat)).toBe(true);
  });

  test("failed-once reads differently from never-worked", () => {
    const failing: VaultMirrorStat = {
      enabled: true,
      backedUpToRemote: true,
      remotePushState: "failing",
    };
    const never: VaultMirrorStat = {
      enabled: true,
      backedUpToRemote: true,
      remotePushState: "never",
    };
    expect(formatMirrorLine(failing)).not.toBe(formatMirrorLine(never));
    expect(formatMirrorLine(never)).toContain("never");
    expect(isMirrorHealthy(failing)).toBe(false);
    expect(isMirrorHealthy(never)).toBe(false);
  });

  test("local-only backup is unaffected — still the warm line, still healthy", () => {
    const localOnly: VaultMirrorStat = {
      enabled: true,
      backedUpToRemote: false,
      remotePushState: "n/a",
    };
    expect(formatMirrorLine(localOnly)).toBe("Backed up — full version history");
    expect(isMirrorHealthy(localOnly)).toBe(true);
  });
});
