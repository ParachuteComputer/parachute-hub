import { describe, expect, test } from "bun:test";
import { narrowResourceVaultScopes, resolveResourceVault } from "../resource-binding.ts";

const ORIGIN = "https://hub.example";
const BOUND = [ORIGIN, "http://127.0.0.1:1939"];

describe("resolveResourceVault", () => {
  test("resolves a per-vault MCP resource to the vault name", () => {
    expect(resolveResourceVault(`${ORIGIN}/vault/jon/mcp`, BOUND)).toBe("jon");
  });

  test("tolerates a trailing slash on the MCP path", () => {
    expect(resolveResourceVault(`${ORIGIN}/vault/jon/mcp/`, BOUND)).toBe("jon");
  });

  test("ignores query string + fragment", () => {
    expect(resolveResourceVault(`${ORIGIN}/vault/jon/mcp?x=1#y`, BOUND)).toBe("jon");
  });

  test("resolves the PRM document URL to the vault name", () => {
    expect(
      resolveResourceVault(`${ORIGIN}/vault/jon/.well-known/oauth-protected-resource`, BOUND),
    ).toBe("jon");
  });

  test("resolves against a non-issuer bound origin (loopback)", () => {
    expect(resolveResourceVault("http://127.0.0.1:1939/vault/work/mcp", BOUND)).toBe("work");
  });

  test("returns null for an off-origin resource (not one we front)", () => {
    expect(resolveResourceVault("https://evil.example/vault/jon/mcp", BOUND)).toBeNull();
  });

  test("returns null for a non-vault path", () => {
    expect(resolveResourceVault(`${ORIGIN}/scribe/mcp`, BOUND)).toBeNull();
    expect(resolveResourceVault(`${ORIGIN}/vault/jon`, BOUND)).toBeNull();
    expect(resolveResourceVault(`${ORIGIN}/vault/jon/notes`, BOUND)).toBeNull();
  });

  test("returns null for absent / empty / malformed resource", () => {
    expect(resolveResourceVault(null, BOUND)).toBeNull();
    expect(resolveResourceVault(undefined, BOUND)).toBeNull();
    expect(resolveResourceVault("", BOUND)).toBeNull();
    expect(resolveResourceVault("not a url", BOUND)).toBeNull();
  });

  test("does not collapse a deeper vault sub-path into the MCP shape", () => {
    // `/vault/jon/mcp/extra` is not the canonical MCP endpoint.
    expect(resolveResourceVault(`${ORIGIN}/vault/jon/mcp/extra`, BOUND)).toBeNull();
  });

  test("rejects a vault segment that isn't a well-formed vault name (no junk mint)", () => {
    // A crafted `resource=…/vault/%2F..%2Fadmin/mcp` decodes to `/../admin`,
    // which is not `[a-zA-Z0-9_-]+`. Returning null falls through to the
    // unbound flow — no narrowing, no token stamped `aud=vault./../admin`.
    expect(resolveResourceVault(`${ORIGIN}/vault/%2F..%2Fadmin/mcp`, BOUND)).toBeNull();
    // Spaces / dots / slashes in the decoded name are all out of shape.
    expect(resolveResourceVault(`${ORIGIN}/vault/a.b/mcp`, BOUND)).toBeNull();
  });

  test("returns null for a malformed percent-escape in the vault segment (safeDecode catch path)", () => {
    // `%GG` is not a valid percent-escape — `decodeURIComponent` throws; the
    // helper must degrade to null rather than 500 the authorize handler.
    expect(resolveResourceVault(`${ORIGIN}/vault/%GG/mcp`, BOUND)).toBeNull();
  });
});

describe("narrowResourceVaultScopes", () => {
  test("narrows unnamed vault verbs to the named form", () => {
    expect(narrowResourceVaultScopes(["vault:read", "vault:write"], "jon")).toEqual([
      "vault:jon:read",
      "vault:jon:write",
    ]);
  });

  test("leaves already-named scopes for other vaults untouched", () => {
    expect(narrowResourceVaultScopes(["vault:other:read"], "jon")).toEqual(["vault:other:read"]);
  });

  test("passes non-vault scopes through unchanged", () => {
    expect(narrowResourceVaultScopes(["scribe:transcribe", "vault:read"], "jon")).toEqual([
      "scribe:transcribe",
      "vault:jon:read",
    ]);
  });

  test("narrows the admin verb too (gate happens downstream)", () => {
    // narrowResourceVaultScopes only rewrites shape; the non-requestable gate
    // (`vault:<name>:admin`) blocks it afterward.
    expect(narrowResourceVaultScopes(["vault:admin"], "jon")).toEqual(["vault:jon:admin"]);
  });

  test("is idempotent over an already-narrowed list", () => {
    const once = narrowResourceVaultScopes(["vault:read"], "jon");
    expect(narrowResourceVaultScopes(once, "jon")).toEqual(once);
  });
});
