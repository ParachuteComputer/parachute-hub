/**
 * Tests for the issuer precedence chain introduced in hub#298:
 *
 *   hub_settings.hub_origin  →  configuredIssuer (env/flag)  →  request origin
 *
 * Both `resolveIssuer` (the canonical resolver) and `resolveIssuerSource`
 * (the SPA-facing attribution helper) are exercised together so a future
 * precedence drift can't surface in one without the other.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { resolveIssuer, resolveIssuerSource } from "../hub-server.ts";
import { setHubOrigin } from "../hub-settings.ts";

let dir: string;
let db: ReturnType<typeof openHubDb>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-issuer-resolve-"));
  db = openHubDb(hubDbPath(dir));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function req(url: string): Request {
  return new Request(url, { method: "GET" });
}

describe("resolveIssuer — precedence chain", () => {
  test("falls back to request origin when no settings + no env", () => {
    const got = resolveIssuer(req("http://127.0.0.1:1939/oauth/token"), db, undefined);
    expect(got).toBe("http://127.0.0.1:1939");
  });

  test("env wins over request origin (deploy-time setting)", () => {
    const got = resolveIssuer(
      req("http://127.0.0.1:1939/oauth/token"),
      db,
      "https://hub.from-env.example",
    );
    expect(got).toBe("https://hub.from-env.example");
  });

  test("hub_settings wins over env (operator override)", () => {
    setHubOrigin(db, "https://hub.from-settings.example");
    const got = resolveIssuer(
      req("http://127.0.0.1:1939/oauth/token"),
      db,
      "https://hub.from-env.example",
    );
    expect(got).toBe("https://hub.from-settings.example");
  });

  test("hub_settings wins over request origin (no env)", () => {
    setHubOrigin(db, "https://hub.from-settings.example");
    const got = resolveIssuer(req("http://127.0.0.1:1939/oauth/token"), db, undefined);
    expect(got).toBe("https://hub.from-settings.example");
  });

  test("clearing hub_settings reverts to env precedence", () => {
    setHubOrigin(db, "https://hub.from-settings.example");
    setHubOrigin(db, null);
    const got = resolveIssuer(
      req("http://127.0.0.1:1939/oauth/token"),
      db,
      "https://hub.from-env.example",
    );
    expect(got).toBe("https://hub.from-env.example");
  });

  test("clearing hub_settings + no env reverts to request origin", () => {
    setHubOrigin(db, "https://hub.from-settings.example");
    setHubOrigin(db, null);
    const got = resolveIssuer(req("http://127.0.0.1:1939/oauth/token"), db, undefined);
    expect(got).toBe("http://127.0.0.1:1939");
  });

  test("undefined db (pre-config gate) falls through to env then request", () => {
    // The wellknown / discovery surfaces may hit oauthDeps before a DB
    // is wired; resolveIssuer must not throw — just skip the settings
    // layer.
    const got = resolveIssuer(req("http://127.0.0.1:1939/"), undefined, undefined);
    expect(got).toBe("http://127.0.0.1:1939");

    const gotEnv = resolveIssuer(
      req("http://127.0.0.1:1939/"),
      undefined,
      "https://hub.from-env.example",
    );
    expect(gotEnv).toBe("https://hub.from-env.example");
  });

  test("change takes effect on the very next request (no caching)", () => {
    // Critical operator-facing behavior: the SPA save button must
    // affect token mints on the subsequent OAuth request without a
    // hub restart. Exercised by pulling resolveIssuer in sequence
    // around a mid-flight setHubOrigin call.
    const baseUrl = "http://127.0.0.1:1939/oauth/token";

    // Pass 1 — no settings, no env → request origin.
    expect(resolveIssuer(req(baseUrl), db, undefined)).toBe("http://127.0.0.1:1939");

    // Mid-flight write.
    setHubOrigin(db, "https://hub.example.com");

    // Pass 2 — settings wins immediately.
    expect(resolveIssuer(req(baseUrl), db, undefined)).toBe("https://hub.example.com");

    // Mid-flight clear.
    setHubOrigin(db, null);

    // Pass 3 — back to request origin.
    expect(resolveIssuer(req(baseUrl), db, undefined)).toBe("http://127.0.0.1:1939");
  });

  test("X-Forwarded-Proto: https upgrades the request-origin fallback", () => {
    // Render / Tailscale Funnel / cloudflared terminate TLS at the edge
    // and forward plain HTTP. Without honoring the header, hub publishes
    // `http://...` in OAuth discovery — mixed-content blocked when the
    // page loaded over https://. See hub#355 (the notes app's
    // /oauth/register call surfaced this).
    const r = new Request("http://parachute-hub.onrender.com/.well-known/oauth-authorization-server", {
      method: "GET",
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(resolveIssuer(r, db, undefined)).toBe("https://parachute-hub.onrender.com");
  });

  test("X-Forwarded-Proto with comma-separated values takes the first", () => {
    // Multi-hop proxies append; the leftmost is the original client → edge
    // hop. RFC-style parsing (consistent with isHttpsRequest).
    const r = new Request("http://hub.internal/oauth/token", {
      method: "GET",
      headers: { "X-Forwarded-Proto": "https, http" },
    });
    expect(resolveIssuer(r, db, undefined)).toBe("https://hub.internal");
  });

  test("missing X-Forwarded-Proto leaves the URL scheme as-is (localhost dev)", () => {
    // No reverse proxy → no header → keep http for the local-dev shape.
    // Operators on plain HTTP localhost depend on this.
    const r = new Request("http://127.0.0.1:1939/oauth/token", { method: "GET" });
    expect(resolveIssuer(r, db, undefined)).toBe("http://127.0.0.1:1939");
  });
});

describe("resolveIssuerSource — attribution for SPA", () => {
  test('"request" when nothing is configured', () => {
    expect(resolveIssuerSource(db, undefined)).toBe("request");
  });

  test('"env" when configuredIssuer is set + no settings row', () => {
    expect(resolveIssuerSource(db, "https://hub.from-env.example")).toBe("env");
  });

  test('"settings" when hub_settings row is set, even if env is also set', () => {
    setHubOrigin(db, "https://hub.from-settings.example");
    expect(resolveIssuerSource(db, "https://hub.from-env.example")).toBe("settings");
  });

  test("attribution matches resolved value across the chain", () => {
    // Pair them up so a future change to one without the other gets
    // caught — the SPA helper text says "from settings" iff the
    // settings layer is what got returned.
    setHubOrigin(db, "https://hub.example.com");
    const r1 = req("http://127.0.0.1:1939/oauth/token");
    expect(resolveIssuer(r1, db, "https://hub.from-env.example")).toBe("https://hub.example.com");
    expect(resolveIssuerSource(db, "https://hub.from-env.example")).toBe("settings");

    setHubOrigin(db, null);
    expect(resolveIssuer(r1, db, "https://hub.from-env.example")).toBe(
      "https://hub.from-env.example",
    );
    expect(resolveIssuerSource(db, "https://hub.from-env.example")).toBe("env");

    expect(resolveIssuer(r1, db, undefined)).toBe("http://127.0.0.1:1939");
    expect(resolveIssuerSource(db, undefined)).toBe("request");
  });
});
