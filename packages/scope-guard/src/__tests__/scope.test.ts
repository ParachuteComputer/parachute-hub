import { describe, expect, test } from "bun:test";
import { hasScope } from "../scope";

describe("hasScope — exact match", () => {
  test("exact string match → true", () => {
    expect(hasScope(["vault:read"], "vault:read")).toBe(true);
    expect(hasScope(["scribe:transcribe"], "scribe:transcribe")).toBe(true);
  });

  test("non-match → false", () => {
    expect(hasScope([], "vault:read")).toBe(false);
    expect(hasScope(["vault:read"], "vault:write")).toBe(false);
  });
});

describe("hasScope — broad inheritance (admin ⊇ write ⊇ read)", () => {
  test("admin satisfies write", () => {
    expect(hasScope(["vault:admin"], "vault:write")).toBe(true);
  });

  test("admin satisfies read", () => {
    expect(hasScope(["vault:admin"], "vault:read")).toBe(true);
  });

  test("write satisfies read", () => {
    expect(hasScope(["vault:write"], "vault:read")).toBe(true);
  });

  test("write does NOT satisfy admin", () => {
    expect(hasScope(["vault:write"], "vault:admin")).toBe(false);
  });

  test("read does NOT satisfy write", () => {
    expect(hasScope(["vault:read"], "vault:write")).toBe(false);
  });
});

describe("hasScope — narrowed inheritance", () => {
  test("narrowed admin satisfies same-name read query", () => {
    expect(hasScope(["vault:work:admin"], "vault:work:read")).toBe(true);
  });

  test("narrowed write satisfies same-name read", () => {
    expect(hasScope(["vault:work:write"], "vault:work:read")).toBe(true);
  });

  test("narrowed write does NOT satisfy same-name admin", () => {
    expect(hasScope(["vault:work:write"], "vault:work:admin")).toBe(false);
  });

  test("narrowed grant satisfies broad query (same resource)", () => {
    expect(hasScope(["vault:work:write"], "vault:write")).toBe(true);
    expect(hasScope(["vault:work:write"], "vault:read")).toBe(true);
  });

  test("narrowed grant does NOT cross to a different name", () => {
    expect(hasScope(["vault:work:write"], "vault:home:read")).toBe(false);
  });

  test("broad grant does NOT satisfy narrowed query (policy lives in consumer)", () => {
    // Per the design doc: broad grants do not satisfy narrowed queries
    // through this function. Consumers that want the reverse semantics
    // (e.g. "this URL names vault `work`; does the token authorize it?")
    // pass the narrowed form into `required` themselves.
    expect(hasScope(["vault:write"], "vault:work:read")).toBe(false);
  });
});

describe("hasScope — cross-resource never matches", () => {
  test("vault:admin does NOT satisfy claw:read", () => {
    expect(hasScope(["vault:admin"], "claw:read")).toBe(false);
  });

  test("vault:admin does NOT satisfy scribe:read", () => {
    expect(hasScope(["vault:admin"], "scribe:read")).toBe(false);
  });
});

describe("hasScope — non-ladder verbs are exact-match only", () => {
  test("scribe:admin does NOT imply scribe:transcribe", () => {
    expect(hasScope(["scribe:admin"], "scribe:transcribe")).toBe(false);
  });

  test("scribe:transcribe does NOT imply scribe:read", () => {
    // `transcribe` isn't part of the inheritance ladder; it doesn't decompose,
    // so it can only satisfy itself.
    expect(hasScope(["scribe:transcribe"], "scribe:read")).toBe(false);
  });

  test("scribe:transcribe satisfies itself (exact match)", () => {
    expect(hasScope(["scribe:transcribe"], "scribe:transcribe")).toBe(true);
  });
});

describe("hasScope — malformed inputs", () => {
  test("empty granted list → false", () => {
    expect(hasScope([], "vault:read")).toBe(false);
  });

  test("malformed required (1-part) → false", () => {
    expect(hasScope(["vault:admin"], "vault")).toBe(false);
  });

  test("malformed granted (4-part) is ignored", () => {
    expect(hasScope(["vault:work:foo:read"], "vault:read")).toBe(false);
  });

  test("empty resource segment in granted → ignored", () => {
    expect(hasScope([":read"], "vault:read")).toBe(false);
  });

  test("empty name segment in granted (vault::read) → ignored", () => {
    // A hand-crafted DB row with that shape must not satisfy any vault scope
    // check — matches vault's existing `decomposeVaultScope` rule.
    expect(hasScope(["vault::read"], "vault:read")).toBe(false);
  });
});

describe("hasScope — multiple grants, mixed shapes", () => {
  test("any one of multiple grants is enough", () => {
    expect(hasScope(["scribe:read", "vault:write"], "vault:read")).toBe(true);
  });

  test("narrowed alongside broad — narrowed satisfies broad query", () => {
    expect(hasScope(["vault:work:write", "vault:home:read"], "vault:read")).toBe(true);
  });
});
