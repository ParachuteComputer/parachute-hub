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

  test("drops non-vault scopes — unusable in a vault-audience token", () => {
    // A vault-bound flow mints `aud=vault.jon`; scribe/channel/hub scopes
    // inside that token are dead weight, so they're removed rather than shown
    // on the consent screen.
    expect(
      narrowResourceVaultScopes(
        ["scribe:transcribe", "channel:send", "hub:admin", "vault:read"],
        "jon",
      ),
    ).toEqual(["vault:jon:read"]);
  });

  test("a one-vault connection drops the whole-hub catalog claude.ai over-requests", () => {
    // claude.ai reads the hub AS-metadata `scopes_supported` (the full
    // catalog) and requests all of it. Bound to one vault, only that vault's
    // verbs survive — no scribe (uninstalled) or channel:send on the consent.
    // Regression lock for the "scary consent" bug.
    expect(
      narrowResourceVaultScopes(
        [
          "vault:read",
          "vault:write",
          "vault:admin",
          "scribe:admin",
          "scribe:transcribe",
          "channel:send",
          "hub:admin",
        ],
        "default",
      ),
    ).toEqual(["vault:default:read", "vault:default:write", "vault:default:admin"]);
  });

  test("narrows the admin verb too (requestable-scope gate decides downstream)", () => {
    // narrowResourceVaultScopes only rewrites shape; `vault:<name>:admin` is
    // requestable post-#484, so this named form survives the downstream gate.
    expect(narrowResourceVaultScopes(["vault:admin"], "jon")).toEqual(["vault:jon:admin"]);
  });

  test("is idempotent over an already-narrowed list", () => {
    const once = narrowResourceVaultScopes(["vault:read"], "jon");
    expect(narrowResourceVaultScopes(once, "jon")).toEqual(once);
  });
});
