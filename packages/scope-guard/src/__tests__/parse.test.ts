import { describe, expect, test } from "bun:test";
import { extractBearer, looksLikeJwt, parseScopes } from "../parse";

describe("parseScopes", () => {
  test("null / undefined / empty → []", () => {
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
  });

  test("whitespace-only → []", () => {
    expect(parseScopes("   ")).toEqual([]);
    expect(parseScopes("\t\n  ")).toEqual([]);
  });

  test("single scope", () => {
    expect(parseScopes("vault:read")).toEqual(["vault:read"]);
  });

  test("multi-scope, single space", () => {
    expect(parseScopes("vault:read vault:write")).toEqual(["vault:read", "vault:write"]);
  });

  test("multi-scope, mixed whitespace", () => {
    expect(parseScopes("  vault:read \t vault:write\n vault:admin  ")).toEqual([
      "vault:read",
      "vault:write",
      "vault:admin",
    ]);
  });

  test("preserves unrecognized scopes verbatim — vocabulary is the consumer's job", () => {
    expect(parseScopes("foo:bar baz")).toEqual(["foo:bar", "baz"]);
  });
});

describe("looksLikeJwt", () => {
  test("`eyJ` prefix → true", () => {
    expect(looksLikeJwt("eyJhbGciOiJSUzI1NiJ9.body.sig")).toBe(true);
  });

  test("pvt_ token → false", () => {
    expect(looksLikeJwt("pvt_abcdef0123456789")).toBe(false);
  });

  test("empty / bare string → false", () => {
    expect(looksLikeJwt("")).toBe(false);
    expect(looksLikeJwt("hello")).toBe(false);
  });
});

describe("extractBearer", () => {
  test("standard Bearer header", () => {
    expect(extractBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  test("case-insensitive scheme", () => {
    expect(extractBearer("bearer abc")).toBe("abc");
    expect(extractBearer("BEARER abc")).toBe("abc");
  });

  test("tolerant of extra whitespace", () => {
    expect(extractBearer("Bearer    abc.def")).toBe("abc.def");
    expect(extractBearer("Bearer abc.def   ")).toBe("abc.def");
  });

  test("missing / null / undefined → undefined", () => {
    expect(extractBearer(null)).toBeUndefined();
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer("")).toBeUndefined();
  });

  test("non-Bearer scheme → undefined", () => {
    expect(extractBearer("Basic dXNlcjpwYXNz")).toBeUndefined();
    expect(extractBearer("Token abc")).toBeUndefined();
  });

  test("empty token after Bearer → undefined", () => {
    // Regex requires at least one non-whitespace char so this matches the
    // "no token" branch via failed regex match, not the trim-empty branch.
    expect(extractBearer("Bearer ")).toBeUndefined();
  });
});
