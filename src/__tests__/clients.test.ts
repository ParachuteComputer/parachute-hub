import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueAuthCode } from "../auth-codes.ts";
import {
  InvalidRedirectUriError,
  approveClient,
  deleteClient,
  expandRedirectUrisForHubOrigins,
  findReapableClients,
  getClient,
  isValidRedirectUri,
  listClientsByStatus,
  reapClient,
  registerClient,
  requireRegisteredRedirectUri,
  verifyClientSecret,
} from "../clients.ts";
import { findGrant, recordGrant } from "../grants.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { createUser } from "../users.ts";

function makeDb() {
  const configDir = mkdtempSync(join(tmpdir(), "phub-clients-"));
  const db = openHubDb(hubDbPath(configDir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

describe("registerClient", () => {
  test("public client has no client_secret", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, {
        redirectUris: ["https://example.com/cb"],
        scopes: ["vault.read"],
        clientName: "test",
      });
      expect(r.clientSecret).toBeNull();
      expect(r.client.clientSecretHash).toBeNull();
      expect(r.client.clientId.length).toBeGreaterThan(0);
      expect(r.client.redirectUris).toEqual(["https://example.com/cb"]);
      expect(r.client.scopes).toEqual(["vault.read"]);
      expect(r.client.clientName).toBe("test");
    } finally {
      cleanup();
    }
  });

  test("confidential client returns plaintext secret once and stores hash", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, {
        redirectUris: ["https://example.com/cb"],
        confidential: true,
      });
      expect(r.clientSecret).not.toBeNull();
      expect(r.clientSecret?.length).toBeGreaterThan(20);
      // Hash is sha256 hex (64 chars).
      expect(r.client.clientSecretHash).toMatch(/^[0-9a-f]{64}$/);
      // The plaintext is not recoverable from the row.
      const fetched = getClient(db, r.client.clientId);
      expect(fetched?.clientSecretHash).toBe(r.client.clientSecretHash);
    } finally {
      cleanup();
    }
  });

  test("rejects empty redirect_uris", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(() => registerClient(db, { redirectUris: [] })).toThrow(/redirect_uri/);
    } finally {
      cleanup();
    }
  });

  test("rejects non-http(s) redirect_uri", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(() => registerClient(db, { redirectUris: ["javascript:alert(1)"] })).toThrow(
        /invalid redirect_uri/,
      );
      expect(() => registerClient(db, { redirectUris: ["/relative/path"] })).toThrow(
        /invalid redirect_uri/,
      );
    } finally {
      cleanup();
    }
  });
});

describe("getClient", () => {
  test("returns null for unknown clientId", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(getClient(db, "nope")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("round-trips a registered client", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, {
        redirectUris: ["https://a.example/cb", "https://b.example/cb"],
        scopes: ["vault.read", "vault.write"],
      });
      const fetched = getClient(db, r.client.clientId);
      expect(fetched?.redirectUris).toEqual(["https://a.example/cb", "https://b.example/cb"]);
      expect(fetched?.scopes).toEqual(["vault.read", "vault.write"]);
    } finally {
      cleanup();
    }
  });
});

describe("requireRegisteredRedirectUri", () => {
  test("returns the matched URI on exact match", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, { redirectUris: ["https://example.com/cb"] });
      expect(requireRegisteredRedirectUri(r.client, "https://example.com/cb")).toBe(
        "https://example.com/cb",
      );
    } finally {
      cleanup();
    }
  });

  test("throws on prefix-only / loose match (open-redirect guard)", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, { redirectUris: ["https://example.com/cb"] });
      expect(() => requireRegisteredRedirectUri(r.client, "https://example.com/cb/extra")).toThrow(
        InvalidRedirectUriError,
      );
      expect(() => requireRegisteredRedirectUri(r.client, "https://evil.com/cb")).toThrow(
        InvalidRedirectUriError,
      );
    } finally {
      cleanup();
    }
  });
});

describe("expandRedirectUrisForHubOrigins (surface#118 cross-hub-origin DCR expansion)", () => {
  const LOOPBACK = "http://127.0.0.1:1939";
  const PUBLIC = "https://box.taildf9ce2.ts.net";
  const hubOrigins = [LOOPBACK, "http://localhost:1939", PUBLIC];

  test("expands a loopback-rooted URI onto every other hub origin", () => {
    const out = expandRedirectUrisForHubOrigins(
      [`${LOOPBACK}/surface/notes/oauth/callback`],
      hubOrigins,
    );
    // Original is preserved + the public + localhost variants are added.
    expect(out).toContain(`${LOOPBACK}/surface/notes/oauth/callback`);
    expect(out).toContain(`${PUBLIC}/surface/notes/oauth/callback`);
    expect(out).toContain("http://localhost:1939/surface/notes/oauth/callback");
    // The submitted URI comes first (order-preserving).
    expect(out[0]).toBe(`${LOOPBACK}/surface/notes/oauth/callback`);
  });

  test("INVARIANT: a foreign-origin URI is stored verbatim — not expanded, not dropped", () => {
    const foreign = "https://my-vault-ui.example/oauth/callback";
    const out = expandRedirectUrisForHubOrigins([foreign], hubOrigins);
    // Stored exactly as submitted...
    expect(out).toContain(foreign);
    // ...and NOTHING was minted on any hub origin from it (no open redirect).
    expect(out).toEqual([foreign]);
    for (const o of hubOrigins) {
      expect(out).not.toContain(`${o}/oauth/callback`);
    }
  });

  test("mixed submit: hub-origin URI expands, foreign URI rides verbatim alongside", () => {
    const foreign = "https://evil.example/cb";
    const out = expandRedirectUrisForHubOrigins(
      [`${LOOPBACK}/surface/notes/`, foreign],
      hubOrigins,
    );
    // Hub-origin URI fanned out to the public origin.
    expect(out).toContain(`${PUBLIC}/surface/notes/`);
    // Foreign URI present, but no hub-origin variant of it exists.
    expect(out).toContain(foreign);
    for (const o of hubOrigins) {
      expect(out).not.toContain(`${o}/cb`);
    }
  });

  test("single known hub origin → no expansion (submitted set returned as-is)", () => {
    const out = expandRedirectUrisForHubOrigins([`${LOOPBACK}/surface/notes/`], [LOOPBACK]);
    expect(out).toEqual([`${LOOPBACK}/surface/notes/`]);
  });

  test("dedupes — already-public + loopback submit doesn't double-register", () => {
    const out = expandRedirectUrisForHubOrigins(
      [`${LOOPBACK}/surface/notes/`, `${PUBLIC}/surface/notes/`],
      hubOrigins,
    );
    const publicCount = out.filter((u) => u === `${PUBLIC}/surface/notes/`).length;
    expect(publicCount).toBe(1);
  });

  test("path + query + hash are preserved across origins", () => {
    const out = expandRedirectUrisForHubOrigins(
      [`${LOOPBACK}/surface/notes/oauth-callback?foo=bar`],
      hubOrigins,
    );
    expect(out).toContain(`${PUBLIC}/surface/notes/oauth-callback?foo=bar`);
  });

  test("expanded URIs survive registerClient → requireRegisteredRedirectUri strict match", () => {
    const { db, cleanup } = makeDb();
    try {
      const expanded = expandRedirectUrisForHubOrigins(
        [`${LOOPBACK}/surface/notes/oauth/callback`],
        hubOrigins,
      );
      const r = registerClient(db, { redirectUris: expanded });
      // The public-origin variant now matches exactly at authorize time — the
      // off-localhost sign-in that surface#118 broke.
      expect(requireRegisteredRedirectUri(r.client, `${PUBLIC}/surface/notes/oauth/callback`)).toBe(
        `${PUBLIC}/surface/notes/oauth/callback`,
      );
      // A truly-unregistered URI is still rejected — strict match unchanged.
      expect(() =>
        requireRegisteredRedirectUri(r.client, "https://evil.example/surface/notes/oauth/callback"),
      ).toThrow(InvalidRedirectUriError);
    } finally {
      cleanup();
    }
  });
});

describe("verifyClientSecret", () => {
  test("matches the issued secret, rejects others", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, {
        redirectUris: ["https://example.com/cb"],
        confidential: true,
      });
      expect(r.clientSecret).not.toBeNull();
      expect(verifyClientSecret(r.client, r.clientSecret ?? "")).toBe(true);
      expect(verifyClientSecret(r.client, "wrong")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("returns false for public clients regardless of presented secret", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, { redirectUris: ["https://example.com/cb"] });
      expect(verifyClientSecret(r.client, "anything")).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("approval gate (#74)", () => {
  test("registerClient defaults status to approved (direct callers)", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, { redirectUris: ["https://example.com/cb"] });
      expect(r.client.status).toBe("approved");
    } finally {
      cleanup();
    }
  });

  test("registerClient honors explicit status: pending (DCR path)", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, {
        redirectUris: ["https://example.com/cb"],
        status: "pending",
      });
      expect(r.client.status).toBe("pending");
      expect(getClient(db, r.client.clientId)?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("approveClient promotes pending → approved and is idempotent", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, {
        redirectUris: ["https://example.com/cb"],
        status: "pending",
      });
      expect(approveClient(db, r.client.clientId)).toBe(true);
      expect(getClient(db, r.client.clientId)?.status).toBe("approved");
      // Second call is a no-op but still returns true.
      expect(approveClient(db, r.client.clientId)).toBe(true);
      expect(getClient(db, r.client.clientId)?.status).toBe("approved");
    } finally {
      cleanup();
    }
  });

  test("approveClient returns false for unknown client", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(approveClient(db, "no-such-client")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("listClientsByStatus filters and orders by registered_at", () => {
    const { db, cleanup } = makeDb();
    try {
      const a = registerClient(db, {
        redirectUris: ["https://a.example/cb"],
        status: "pending",
        now: () => new Date("2026-01-01T00:00:00Z"),
      });
      const b = registerClient(db, {
        redirectUris: ["https://b.example/cb"],
        status: "approved",
        now: () => new Date("2026-01-02T00:00:00Z"),
      });
      const c = registerClient(db, {
        redirectUris: ["https://c.example/cb"],
        status: "pending",
        now: () => new Date("2026-01-03T00:00:00Z"),
      });
      const pending = listClientsByStatus(db, "pending").map((r) => r.clientId);
      expect(pending).toEqual([a.client.clientId, c.client.clientId]);
      const approved = listClientsByStatus(db, "approved").map((r) => r.clientId);
      expect(approved).toEqual([b.client.clientId]);
    } finally {
      cleanup();
    }
  });
});

describe("deleteClient cascade (hub#640 RFC 7592 deregistration)", () => {
  test("returns false for an unknown client_id (nothing to delete)", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(deleteClient(db, "no-such-client")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("deletes the client row and reports true", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      expect(getClient(db, r.client.clientId)).not.toBeNull();
      expect(deleteClient(db, r.client.clientId)).toBe(true);
      expect(getClient(db, r.client.clientId)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("cascades dependent grants + auth_codes (FK ON, no ON DELETE CASCADE)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const r = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        scopes: ["vault:work:read"],
      });
      const clientId = r.client.clientId;

      // Plant a live grant + auth_code that reference the client. Without the
      // cascade, the bare DELETE FROM clients would throw a FK violation while
      // these rows exist (PRAGMA foreign_keys = ON).
      recordGrant(db, user.id, clientId, ["vault:work:read"]);
      const ac = issueAuthCode(db, {
        clientId,
        userId: user.id,
        redirectUri: "https://app.example/cb",
        scopes: ["vault:work:read"],
        codeChallenge: "x".repeat(43),
        codeChallengeMethod: "S256",
      });
      // Sanity: the dependents are present before the delete.
      expect(findGrant(db, user.id, clientId)).not.toBeNull();
      expect(db.query("SELECT code FROM auth_codes WHERE code = ?").get(ac.code)).not.toBeNull();

      // Delete cascades — no FK throw, true returned.
      expect(deleteClient(db, clientId)).toBe(true);

      // Client + both dependents are gone.
      expect(getClient(db, clientId)).toBeNull();
      expect(findGrant(db, user.id, clientId)).toBeNull();
      expect(db.query("SELECT code FROM auth_codes WHERE code = ?").get(ac.code)).toBeNull();
      // The user row is untouched — only client-keyed rows cascade.
      expect(db.query("SELECT id FROM users WHERE id = ?").get(user.id)).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("transactional: deleting one client leaves a sibling client's grants intact", async () => {
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const keep = registerClient(db, { redirectUris: ["https://keep.example/cb"] });
      const drop = registerClient(db, { redirectUris: ["https://drop.example/cb"] });
      recordGrant(db, user.id, keep.client.clientId, ["vault:work:read"]);
      recordGrant(db, user.id, drop.client.clientId, ["vault:work:read"]);

      expect(deleteClient(db, drop.client.clientId)).toBe(true);

      // The kept client + its grant survive; only the dropped client's
      // grant cascaded.
      expect(getClient(db, keep.client.clientId)).not.toBeNull();
      expect(findGrant(db, user.id, keep.client.clientId)).not.toBeNull();
      expect(getClient(db, drop.client.clientId)).toBeNull();
      expect(findGrant(db, user.id, drop.client.clientId)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("findReapableClients / reapClient — the GC safety gate (hub#640)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // A fixed "now" so age math is deterministic. All planted clients register
  // 60 days before this unless a test overrides.
  const NOW = new Date("2026-06-27T00:00:00Z");
  const now = () => NOW;
  const OLD = new Date(NOW.getTime() - 60 * DAY_MS); // 60d old → past 30d floor
  const oldNow = () => OLD;

  /** Plant a `tokens` row with precise expiry/revocation for a client. */
  function plantToken(
    db: ReturnType<typeof openHubDb>,
    opts: {
      clientId: string;
      userId: string;
      jti: string;
      expiresAt: string;
      revokedAt?: string | null;
    },
  ): void {
    db.prepare(
      `INSERT INTO tokens
       (jti, user_id, client_id, scopes, refresh_token_hash, family_id,
        expires_at, revoked_at, created_at, created_via, subject)
       VALUES (?, ?, ?, '', NULL, NULL, ?, ?, ?, 'oauth_refresh', NULL)`,
    ).run(
      opts.jti,
      opts.userId,
      opts.clientId,
      opts.expiresAt,
      opts.revokedAt ?? null,
      OLD.toISOString(),
    );
  }

  test("a genuinely-dead old client IS reaped (no grants, only expired/revoked tokens, no live codes)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const dead = registerClient(db, { redirectUris: ["https://dead.example/cb"], now: oldNow });
      const id = dead.client.clientId;
      // An expired token + a revoked token — both dead.
      plantToken(db, {
        clientId: id,
        userId: user.id,
        jti: "jti-expired",
        expiresAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
      });
      plantToken(db, {
        clientId: id,
        userId: user.id,
        jti: "jti-revoked",
        expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString(), // unexpired...
        revokedAt: new Date(NOW.getTime() - DAY_MS).toISOString(), // ...but revoked → dead
      });

      const reapable = findReapableClients(db, { now });
      expect(reapable.map((c) => c.clientId)).toEqual([id]);
      expect(reapable[0]?.ageDays).toBe(60);

      // reapClient removes the client AND its dead token rows.
      expect(reapClient(db, id)).toBe(true);
      expect(getClient(db, id)).toBeNull();
      expect(db.query("SELECT jti FROM tokens WHERE client_id = ?").all(id)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("a client WITH a live grant is NEVER reaped, even when old", async () => {
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const c = registerClient(db, { redirectUris: ["https://granted.example/cb"], now: oldNow });
      recordGrant(db, user.id, c.client.clientId, ["vault:work:read"]);
      const reapable = findReapableClients(db, { now });
      expect(reapable.map((x) => x.clientId)).not.toContain(c.client.clientId);
    } finally {
      cleanup();
    }
  });

  test("a client with a live (unexpired, unrevoked) token is NEVER reaped, even when old", async () => {
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const c = registerClient(db, { redirectUris: ["https://live.example/cb"], now: oldNow });
      plantToken(db, {
        clientId: c.client.clientId,
        userId: user.id,
        jti: "jti-live",
        expiresAt: new Date(NOW.getTime() + 7 * DAY_MS).toISOString(),
        revokedAt: null,
      });
      const reapable = findReapableClients(db, { now });
      expect(reapable.map((x) => x.clientId)).not.toContain(c.client.clientId);
    } finally {
      cleanup();
    }
  });

  test("a client with an unexpired auth_code is NEVER reaped (in-flight OAuth)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const c = registerClient(db, { redirectUris: ["https://inflight.example/cb"], now: oldNow });
      // issueAuthCode mints a code expiring AUTH_CODE_TTL after `now` → unexpired.
      issueAuthCode(db, {
        clientId: c.client.clientId,
        userId: user.id,
        redirectUri: "https://inflight.example/cb",
        scopes: ["vault:work:read"],
        codeChallenge: "x".repeat(43),
        codeChallengeMethod: "S256",
        now,
      });
      const reapable = findReapableClients(db, { now });
      expect(reapable.map((x) => x.clientId)).not.toContain(c.client.clientId);
    } finally {
      cleanup();
    }
  });

  test("a freshly-registered client is NEVER reaped, even with zero grants/tokens/codes", () => {
    const { db, cleanup } = makeDb();
    try {
      // Registered 5 days ago — inside the default 30d floor.
      const fresh = registerClient(db, {
        redirectUris: ["https://fresh.example/cb"],
        now: () => new Date(NOW.getTime() - 5 * DAY_MS),
      });
      const reapable = findReapableClients(db, { now });
      expect(reapable.map((x) => x.clientId)).not.toContain(fresh.client.clientId);
    } finally {
      cleanup();
    }
  });

  test("an expired auth_code does NOT protect a client (only LIVE codes do)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const c = registerClient(db, { redirectUris: ["https://stale.example/cb"], now: oldNow });
      // Code issued 60d ago → long expired.
      issueAuthCode(db, {
        clientId: c.client.clientId,
        userId: user.id,
        redirectUri: "https://stale.example/cb",
        scopes: ["vault:work:read"],
        codeChallenge: "x".repeat(43),
        codeChallengeMethod: "S256",
        now: oldNow,
      });
      const reapable = findReapableClients(db, { now });
      expect(reapable.map((x) => x.clientId)).toContain(c.client.clientId);
    } finally {
      cleanup();
    }
  });

  test("--older-than threshold is honored (a 20d-old client falls under a 10d floor but not 30d)", () => {
    const { db, cleanup } = makeDb();
    try {
      const c = registerClient(db, {
        redirectUris: ["https://midage.example/cb"],
        now: () => new Date(NOW.getTime() - 20 * DAY_MS),
      });
      // Default 30d floor → not yet reapable.
      expect(findReapableClients(db, { now }).map((x) => x.clientId)).not.toContain(
        c.client.clientId,
      );
      // 10d floor → now reapable.
      expect(
        findReapableClients(db, { now, olderThanMs: 10 * DAY_MS }).map((x) => x.clientId),
      ).toContain(c.client.clientId);
    } finally {
      cleanup();
    }
  });

  test("reapClient on a still-protected client deletes nothing the gate excluded (callers pass only gated ids)", async () => {
    // Belt-and-suspenders: reapClient itself doesn't re-check the gate (the
    // caller is contractually responsible). This asserts the realistic flow —
    // a live client is simply NOT in the findReapableClients output, so the
    // apply loop never calls reapClient on it.
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const live = registerClient(db, { redirectUris: ["https://keep.example/cb"], now: oldNow });
      recordGrant(db, user.id, live.client.clientId, ["vault:work:read"]);
      const dead = registerClient(db, { redirectUris: ["https://gone.example/cb"], now: oldNow });

      const reapable = findReapableClients(db, { now });
      const ids = reapable.map((x) => x.clientId);
      expect(ids).toEqual([dead.client.clientId]);
      for (const c of reapable) reapClient(db, c.clientId);

      // Live client + its grant survive; only the dead one is gone.
      expect(getClient(db, live.client.clientId)).not.toBeNull();
      expect(findGrant(db, user.id, live.client.clientId)).not.toBeNull();
      expect(getClient(db, dead.client.clientId)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("isValidRedirectUri", () => {
  test("accepts http and https", () => {
    expect(isValidRedirectUri("http://localhost:3000/cb")).toBe(true);
    expect(isValidRedirectUri("https://example.com/cb")).toBe(true);
  });
  test("rejects javascript:, data:, relative paths, garbage", () => {
    expect(isValidRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isValidRedirectUri("data:text/html,x")).toBe(false);
    expect(isValidRedirectUri("/relative")).toBe(false);
    expect(isValidRedirectUri("not a url")).toBe(false);
  });
  // hub#663: spec-forbidden shapes that the protocol allowlist alone passed.
  test("rejects userinfo-bearing redirect URIs (hub#663)", () => {
    expect(isValidRedirectUri("https://x@evil.com/cb")).toBe(false);
    expect(isValidRedirectUri("https://user:pass@evil.com/cb")).toBe(false);
    expect(isValidRedirectUri("http://attacker@127.0.0.1:3000/cb")).toBe(false);
  });
  test("rejects control chars in the raw input (hub#663)", () => {
    // Control chars must be caught on the RAW string — URL parsing would
    // otherwise strip a trailing \r\n and the smuggled value would pass.
    expect(isValidRedirectUri("https://example.com/cb\r\nSet-Cookie: x")).toBe(false);
    expect(isValidRedirectUri("https://example.com/\x00cb")).toBe(false);
    expect(isValidRedirectUri("https://example.com/cb\x7f")).toBe(false);
  });
  test("still accepts clean http(s) with ports, paths, and queries (regression guard)", () => {
    // Legitimate clients (hub modules, self-built surfaces, Notes, Claude DCR)
    // all register clean URIs — these must keep passing.
    expect(isValidRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isValidRedirectUri("http://localhost:1939/admin/oauth/callback")).toBe(true);
    expect(isValidRedirectUri("https://my-surface.github.io/cb?x=1")).toBe(true);
  });
});
