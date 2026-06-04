import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvalidRedirectUriError,
  approveClient,
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

  test("rejects denylisted-scheme + relative redirect_uri", () => {
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

  test("accepts a private-use custom-scheme redirect_uri (RFC 8252 §7.1)", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, { redirectUris: ["pebblejs://close"] });
      expect(r.client.redirectUris).toEqual(["pebblejs://close"]);
      const r2 = registerClient(db, { redirectUris: ["com.example.myapp://callback"] });
      expect(r2.client.redirectUris).toEqual(["com.example.myapp://callback"]);
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
  test("accepts private-use custom schemes (RFC 8252 §7.1)", () => {
    // Native apps register a private-use URI scheme they control as the
    // redirect target — the Pebble watchapp uses pebblejs://close.
    expect(isValidRedirectUri("pebblejs://close")).toBe(true);
    expect(isValidRedirectUri("myapp://callback")).toBe(true);
    // Reverse-DNS scheme name (the RFC 8252 recommendation).
    expect(isValidRedirectUri("com.example.app://oauth/redirect")).toBe(true);
  });
  test("rejects denylisted schemes", () => {
    expect(isValidRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isValidRedirectUri("data:text/html,x")).toBe(false);
    expect(isValidRedirectUri("file:///etc/passwd")).toBe(false);
    expect(isValidRedirectUri("vbscript:msgbox(1)")).toBe(false);
    expect(isValidRedirectUri("blob:https://example.com/uuid")).toBe(false);
    expect(isValidRedirectUri("about:blank")).toBe(false);
  });
  test("rejects relative paths and garbage (unparseable)", () => {
    expect(isValidRedirectUri("/relative")).toBe(false);
    expect(isValidRedirectUri("not a url")).toBe(false);
  });
});
