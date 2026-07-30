/**
 * The RFC 6750 §3 `scope` parameter on an insufficient-scope challenge.
 *
 * This is the standard discovery path for a scope that isn't advertised.
 * Parachute deliberately keeps `account:*` out of `scopes_supported` — RFC 8414
 * §2 and RFC 9728 §2 both permit exactly that, and MCP's 2025-11-25
 * authorization spec goes further, saying `scopes_supported` should be the
 * MINIMAL set with more obtained through step-up.
 *
 * The cost was that an unattended agent had no mechanical way to learn those
 * scopes exist: the missing scope's name was only in `error_description`, which
 * is prose. Naming it in the `scope` parameter is what GitHub
 * (`X-Accepted-OAuth-Scopes`), Slack (`needed`), and the MCP spec all do —
 * discovery at the point of refusal rather than from the catalog.
 */

import { describe, expect, test } from "bun:test";
import { AdminAuthError, adminAuthErrorResponse } from "../admin-auth.ts";

function challengeOf(err: unknown): string {
  return adminAuthErrorResponse(err).headers.get("www-authenticate") ?? "";
}

describe("insufficient-scope challenge", () => {
  test("names the missing scope in the RFC 6750 `scope` parameter", () => {
    // The whole point: a client parses `scope=`, not the prose description.
    const c = challengeOf(
      new AdminAuthError(
        403,
        "token missing required scope: account:self:admin",
        "account:self:admin",
      ),
    );
    expect(c).toContain('error="insufficient_scope"');
    expect(c).toContain('scope="account:self:admin"');
  });

  test("still carries the human-readable description", () => {
    // The prose stays — it's what a person reading a log sees.
    const c = challengeOf(new AdminAuthError(403, "token missing required scope: x", "x"));
    expect(c).toContain("error_description=");
  });

  test("a 401 gets invalid_token and NO scope parameter", () => {
    // `scope` answers "which permission would have worked". On a broken or
    // absent token that question has no answer, and asserting one would send a
    // client to request a scope that wasn't the problem.
    const c = challengeOf(new AdminAuthError(401, "token missing required `sub` claim"));
    expect(c).toContain('error="invalid_token"');
    expect(c).not.toContain("scope=");
  });

  test("a 403 without a known scope omits the parameter rather than inventing one", () => {
    const c = challengeOf(new AdminAuthError(403, "forbidden"));
    expect(c).toContain('error="insufficient_scope"');
    expect(c).not.toContain("scope=");
  });

  test("a quote in the message can't break the header's quoted-string", () => {
    // A malformed challenge is worse than a vague one — clients drop the whole
    // header rather than parse half of it.
    const c = challengeOf(new AdminAuthError(403, 'bad "quoted" thing', "vault:read"));
    // The description's own quotes are downgraded to apostrophes, so the
    // quoted-string stays well-formed and the parameters after it survive.
    expect(c).toContain("error_description=\"bad 'quoted' thing\"");
    expect(c).toContain('scope="vault:read"');
  });
});
