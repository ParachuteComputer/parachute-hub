/**
 * Bootstrap token (hub#TODO first-boot-path hardening).
 *
 * The module is a tiny in-memory state machine: generate / consume /
 * verify. These tests pin:
 *
 *   - format (prefix + length sanity)
 *   - constant-time verify across length-equal vs. length-mismatched
 *   - lifecycle: generate → verify true → consume → verify false
 *   - regeneration replaces the prior value
 *   - "no token active" path returns false from verify
 *
 * Lifecycle tests reset the module between cases via
 * `_resetBootstrapTokenForTests` so cross-test bleed is impossible.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  BOOTSTRAP_TOKEN_PREFIX,
  _resetBootstrapTokenForTests,
  _setBootstrapTokenForTests,
  consumeBootstrapToken,
  generateBootstrapToken,
  getBootstrapToken,
  verifyBootstrapToken,
} from "../bootstrap-token.ts";

afterEach(() => {
  _resetBootstrapTokenForTests();
});

describe("generateBootstrapToken", () => {
  test("returns a string with the canonical `parachute-bootstrap-` prefix", () => {
    const token = generateBootstrapToken();
    expect(token.startsWith(BOOTSTRAP_TOKEN_PREFIX)).toBe(true);
  });

  test("produces a long-enough tail (≥40 base64url chars after prefix)", () => {
    const token = generateBootstrapToken();
    const tail = token.slice(BOOTSTRAP_TOKEN_PREFIX.length);
    // 32 bytes of randomness → 43 base64url chars (no padding).
    expect(tail.length).toBeGreaterThanOrEqual(40);
    // base64url charset only — no `+/=` from un-translated base64.
    expect(tail).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("two consecutive generations produce different tokens", () => {
    const a = generateBootstrapToken();
    const b = generateBootstrapToken();
    expect(a).not.toEqual(b);
  });

  test("a second call replaces (not appends to) the in-memory value", () => {
    const a = generateBootstrapToken();
    expect(getBootstrapToken()).toBe(a);
    const b = generateBootstrapToken();
    expect(getBootstrapToken()).toBe(b);
    // The first token no longer verifies — it's been overwritten.
    expect(verifyBootstrapToken(a)).toBe(false);
    expect(verifyBootstrapToken(b)).toBe(true);
  });
});

describe("verifyBootstrapToken", () => {
  test("returns false when no token has been generated", () => {
    // Module reset by afterEach of prior test.
    expect(getBootstrapToken()).toBeUndefined();
    expect(verifyBootstrapToken("parachute-bootstrap-anything-at-all-here")).toBe(false);
  });

  test("returns true on exact match", () => {
    const token = generateBootstrapToken();
    expect(verifyBootstrapToken(token)).toBe(true);
  });

  test("returns false on wrong token of same length", () => {
    const token = generateBootstrapToken();
    // Flip the last char to produce a same-length-different-content string.
    const last = token.slice(-1);
    const flipped = last === "A" ? "B" : "A";
    const wrong = `${token.slice(0, -1)}${flipped}`;
    expect(wrong.length).toBe(token.length);
    expect(verifyBootstrapToken(wrong)).toBe(false);
  });

  test("returns false on length-mismatched input (short)", () => {
    generateBootstrapToken();
    expect(verifyBootstrapToken("parachute-bootstrap-xyz")).toBe(false);
  });

  test("returns false on length-mismatched input (long)", () => {
    const token = generateBootstrapToken();
    expect(verifyBootstrapToken(`${token}-trailing-garbage`)).toBe(false);
  });

  test("returns false on empty / null / undefined input", () => {
    generateBootstrapToken();
    expect(verifyBootstrapToken("")).toBe(false);
    expect(verifyBootstrapToken(null)).toBe(false);
    expect(verifyBootstrapToken(undefined)).toBe(false);
  });

  test("returns false on a token that lacks the `parachute-bootstrap-` prefix", () => {
    // Defense in depth: a constant-time compare against the active token
    // refuses anything that doesn't byte-equal. Even a base64url string
    // of identical length should reject when the prefix is gone.
    _setBootstrapTokenForTests("parachute-bootstrap-ABCDEF0123456789ABCDEF0123456789ABC");
    // Same length, swap the prefix for ATTACKER (matching length 9 chars
    // of `parachute`).
    expect(verifyBootstrapToken("ATTACKERxxxbootstrap-ABCDEF0123456789ABCDEF0123456789ABC")).toBe(
      false,
    );
  });
});

describe("consumeBootstrapToken", () => {
  test("clears the in-memory token so subsequent verifies fail", () => {
    const token = generateBootstrapToken();
    expect(verifyBootstrapToken(token)).toBe(true);
    consumeBootstrapToken();
    expect(verifyBootstrapToken(token)).toBe(false);
    expect(getBootstrapToken()).toBeUndefined();
  });

  test("idempotent: re-consuming after already cleared is a no-op", () => {
    generateBootstrapToken();
    consumeBootstrapToken();
    expect(() => consumeBootstrapToken()).not.toThrow();
    expect(getBootstrapToken()).toBeUndefined();
  });
});

describe("getBootstrapToken", () => {
  test("returns undefined before generation", () => {
    expect(getBootstrapToken()).toBeUndefined();
  });

  test("returns the active token after generation", () => {
    const token = generateBootstrapToken();
    expect(getBootstrapToken()).toBe(token);
  });

  test("returns undefined after consume", () => {
    generateBootstrapToken();
    consumeBootstrapToken();
    expect(getBootstrapToken()).toBeUndefined();
  });
});
