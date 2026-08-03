import { describe, expect, test } from "bun:test";
import {
  isRootMcpResource,
  narrowResourceVaultScopes,
  narrowRootMcpScopes,
  resolveResourceVault,
} from "../resource-binding.ts";

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

describe("isRootMcpResource", () => {
  test("recognises the root MCP endpoint", () => {
    expect(isRootMcpResource(`${ORIGIN}/mcp`, BOUND)).toBe(true);
    expect(isRootMcpResource(`${ORIGIN}/mcp/`, BOUND)).toBe(true);
    expect(isRootMcpResource(`${ORIGIN}/mcp?x=1#y`, BOUND)).toBe(true);
  });

  test("recognises the root PRM document URL", () => {
    // The path-suffixed shape the root 401 challenge advertises verbatim:
    // `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
    expect(isRootMcpResource(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`, BOUND)).toBe(
      true,
    );
  });

  test("resolves against a non-issuer bound origin (loopback)", () => {
    expect(isRootMcpResource("http://127.0.0.1:1939/mcp", BOUND)).toBe(true);
  });

  test("returns false off-origin — same gate as resolveResourceVault", () => {
    expect(isRootMcpResource("https://evil.example/mcp", BOUND)).toBe(false);
  });

  test("returns false for absent / malformed / non-root paths", () => {
    expect(isRootMcpResource(null, BOUND)).toBe(false);
    expect(isRootMcpResource(undefined, BOUND)).toBe(false);
    expect(isRootMcpResource("", BOUND)).toBe(false);
    expect(isRootMcpResource("not a url", BOUND)).toBe(false);
    expect(isRootMcpResource(`${ORIGIN}/mcp/extra`, BOUND)).toBe(false);
    expect(isRootMcpResource(`${ORIGIN}/scribe/mcp`, BOUND)).toBe(false);
    // The BARE PRM (no `/mcp` suffix) describes the hub as a resource, not the
    // root MCP door — a different document with a different `resource` field.
    expect(isRootMcpResource(`${ORIGIN}/.well-known/oauth-protected-resource`, BOUND)).toBe(false);
  });

  test("a per-vault resource is NOT root — the two branches are disjoint", () => {
    // The authorize handler tries `resolveResourceVault` first and only falls
    // through to this predicate. If both could answer for one resource, the
    // vault name would be silently dropped in favour of the weaker root
    // treatment on any reorder.
    for (const r of [
      `${ORIGIN}/vault/jon/mcp`,
      `${ORIGIN}/vault/jon/.well-known/oauth-protected-resource`,
    ]) {
      expect(resolveResourceVault(r, BOUND)).not.toBeNull();
      expect(isRootMcpResource(r, BOUND)).toBe(false);
    }
  });
});

describe("narrowRootMcpScopes", () => {
  test("drops non-vault scopes — the root door's scary-consent fix", () => {
    // Same catalog claude.ai over-requests in the per-vault test above. At the
    // root door it used to arrive at consent untouched, because
    // `resolveResourceVault` returned null and the whole binding path no-op'd.
    expect(
      narrowRootMcpScopes([
        "vault:read",
        "vault:write",
        "vault:admin",
        "scribe:admin",
        "scribe:transcribe",
        "channel:send",
        "hub:admin",
      ]),
    ).toEqual(["vault:read", "vault:write", "vault:admin"]);
  });

  test("does NOT name the vault scopes — there is no vault in the resource", () => {
    // The picker supplies the name; `vault:<name>:<verb>` is minted downstream.
    // Naming them here would require inventing a vault the client never asked
    // for. This is the whole reason root is a separate branch and not an entry
    // in the resolvable set.
    expect(narrowRootMcpScopes(["vault:read"])).toEqual(["vault:read"]);
  });

  test("leaves already-named vault scopes untouched", () => {
    expect(narrowRootMcpScopes(["vault:jon:read", "hub:admin"])).toEqual(["vault:jon:read"]);
  });

  test("a foreign-only request narrows to empty (authorize refuses invalid_scope)", () => {
    expect(narrowRootMcpScopes(["hub:admin", "scribe:admin"])).toEqual([]);
  });

  test("is idempotent", () => {
    const once = narrowRootMcpScopes(["vault:read", "hub:admin"]);
    expect(narrowRootMcpScopes(once)).toEqual(once);
  });
});
