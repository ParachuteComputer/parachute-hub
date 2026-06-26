import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvalidRedirectUriError,
  approveClient,
  expandRedirectUrisForHubOrigins,
  getClient,
  isValidRedirectUri,
  listClientsByStatus,
  registerClient,
  requireRegisteredRedirectUri,
  verifyClientSecret,
} from "../clients.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";

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
