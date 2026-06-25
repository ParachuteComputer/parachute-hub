/**
 * Multi-origin iss-set (onboarding-streamline 2026-06-25) — hub side.
 *
 * The hub publishes the SET of origins it legitimately answers on to its
 * supervised resource servers via `PARACHUTE_HUB_ORIGINS` (comma-separated),
 * alongside the single canonical `PARACHUTE_HUB_ORIGIN`. A resource server on
 * scope-guard ≥0.5.0 widens its accepted-`iss` check to this set so a token
 * minted under one URL of a multi-URL box validates via another URL of the
 * SAME box.
 *
 * These tests pin two things:
 *   1. The serialize/parse round-trip + the assembly from hub-controlled
 *      inputs (issuer ∪ loopback aliases ∪ expose-state ∪ platform).
 *   2. The SECURITY INVARIANT: the set is built ONLY from operator/hub config
 *      and on-disk state — never from an unvalidated request `Host` /
 *      `X-Forwarded-Host`. We feed an attacker-controlled "Host" through every
 *      input channel a request could plausibly reach and assert it never lands
 *      in the published set.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHubOrigins, serializeHubOrigins } from "../hub-origin.ts";
import { buildHubOriginsEnvValue } from "../vault-hub-origin-env.ts";

describe("serializeHubOrigins / parseHubOrigins round-trip", () => {
  test("serialize dedupes, drops empties, strips trailing slashes", () => {
    const v = serializeHubOrigins([
      "https://a.example/",
      "https://a.example",
      "",
      "https://b.example",
    ]);
    expect(v).toBe("https://a.example,https://b.example");
  });

  test("serialize returns undefined when nothing survives", () => {
    expect(serializeHubOrigins([])).toBeUndefined();
    expect(serializeHubOrigins(["", "  "])).toBeUndefined();
  });

  test("parse is the inverse — tolerant of whitespace + trailing slashes + empties", () => {
    expect(parseHubOrigins("https://a.example, https://b.example/ ,,")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  test("parse returns [] for absent/empty/garbage", () => {
    expect(parseHubOrigins(undefined)).toEqual([]);
    expect(parseHubOrigins("")).toEqual([]);
    expect(parseHubOrigins(" , , ")).toEqual([]);
  });

  test("round-trips a real set", () => {
    const origins = ["https://example.com", "http://127.0.0.1:1939", "http://localhost:1939"];
    const wire = serializeHubOrigins(origins)!;
    expect(parseHubOrigins(wire)).toEqual(origins);
  });
});

describe("buildHubOriginsEnvValue — assembles the hub's legitimate-origin set", () => {
  let dir: string;
  const EXPOSE = () => join(dir, "expose-state.json");

  /** Write a schema-valid expose-state.json carrying the given hubOrigin. */
  function writeExposeState(hubOrigin: string): void {
    writeFileSync(
      EXPOSE(),
      JSON.stringify({
        version: 1,
        layer: "public",
        mode: "path",
        canonicalFqdn: new URL(hubOrigin).host,
        port: 1939,
        funnel: true,
        entries: [],
        hubOrigin,
      }),
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-origins-set-"));
    // No hub.port file in this fresh configDir → readHubPort falls back to
    // HUB_UNIT_DEFAULT_PORT (1939), the deterministic value these cases assert.
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("issuer ∪ loopback aliases when no expose / platform origin", () => {
    const v = buildHubOriginsEnvValue(dir, "https://example.com", {}, EXPOSE());
    const set = parseHubOrigins(v);
    expect(set).toContain("https://example.com");
    expect(set).toContain("http://127.0.0.1:1939");
    expect(set).toContain("http://localhost:1939");
    expect(set).toHaveLength(3);
  });

  test("loopback aliases are ALWAYS present (the always-present invariant)", () => {
    // Even with a public issuer, loopback must be in the set so the co-located
    // CLI / loopback-proxied request path validates.
    const set = parseHubOrigins(buildHubOriginsEnvValue(dir, "https://example.com", {}, EXPOSE()));
    expect(set).toContain("http://127.0.0.1:1939");
    expect(set).toContain("http://localhost:1939");
  });

  test("folds in the expose-state public origin", () => {
    writeExposeState("https://box.sslip.io");
    const set = parseHubOrigins(buildHubOriginsEnvValue(dir, "https://example.com", {}, EXPOSE()));
    expect(set).toContain("https://example.com");
    expect(set).toContain("https://box.sslip.io");
  });

  test("folds in the platform origin (RENDER_EXTERNAL_URL)", () => {
    const set = parseHubOrigins(
      buildHubOriginsEnvValue(
        dir,
        "https://example.com",
        { RENDER_EXTERNAL_URL: "https://app.onrender.com" },
        EXPOSE(),
      ),
    );
    expect(set).toContain("https://app.onrender.com");
  });

  test("folds in the composed Fly default origin", () => {
    const set = parseHubOrigins(
      buildHubOriginsEnvValue(dir, "https://example.com", { FLY_APP_NAME: "myapp" }, EXPOSE()),
    );
    expect(set).toContain("https://myapp.fly.dev");
  });

  test("absent issuer → loopback-only set (still useful, never empty on a normal box)", () => {
    const set = parseHubOrigins(buildHubOriginsEnvValue(dir, undefined, {}, EXPOSE()));
    expect(set).toContain("http://127.0.0.1:1939");
    expect(set).toContain("http://localhost:1939");
    // The empty issuer "" is dropped by buildHubBoundOrigins' URL parse.
    expect(set).not.toContain("");
  });

  test("a malformed expose-state.json never throws — falls back to issuer + loopback", () => {
    writeFileSync(EXPOSE(), "{ not valid json");
    const set = parseHubOrigins(buildHubOriginsEnvValue(dir, "https://example.com", {}, EXPOSE()));
    expect(set).toContain("https://example.com");
    expect(set).toContain("http://127.0.0.1:1939");
  });

  describe("SECURITY INVARIANT — request Host never enters the set", () => {
    const ATTACKER = "https://attacker.evil";

    test("an attacker Host smuggled via expose-state IS honored ONLY because it's operator-written on-disk state — but a Host passed nowhere never appears", () => {
      // There is NO request input to buildHubOriginsEnvValue at all — it takes
      // configDir + issuer + env + expose-state-path. None of those is a
      // request header. We assert the function's surface offers no channel for
      // a request Host: feeding the attacker value to the only inputs an
      // attacker might influence (a stray env var, a header-shaped string)
      // never reaches the set unless it's a legitimate operator-config var.
      const set = parseHubOrigins(
        buildHubOriginsEnvValue(
          dir,
          "https://example.com",
          {
            // Header-shaped env vars an attacker might hope are read — none are
            // consulted by the assembler (only RENDER_EXTERNAL_URL / FLY_APP_NAME).
            HTTP_HOST: ATTACKER,
            HTTP_X_FORWARDED_HOST: ATTACKER,
            X_FORWARDED_HOST: ATTACKER,
            HOST: ATTACKER,
          } as NodeJS.ProcessEnv,
          EXPOSE(),
        ),
      );
      expect(set).not.toContain(ATTACKER);
      expect(set.some((o) => o.includes("attacker"))).toBe(false);
    });

    test("the set is exactly issuer ∪ loopback ∪ expose ∪ platform — no other source", () => {
      writeExposeState("https://box.sslip.io");
      const set = parseHubOrigins(
        buildHubOriginsEnvValue(
          dir,
          "https://example.com",
          { RENDER_EXTERNAL_URL: "https://app.onrender.com" },
          EXPOSE(),
        ),
      );
      // Every member is one of the four sanctioned sources; nothing else.
      const sanctioned = new Set([
        "https://example.com",
        "http://127.0.0.1:1939",
        "http://localhost:1939",
        "https://box.sslip.io",
        "https://app.onrender.com",
      ]);
      for (const o of set) expect(sanctioned.has(o)).toBe(true);
    });
  });
});
