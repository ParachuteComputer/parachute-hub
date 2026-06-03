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

/**
 * Stub the expose-state reader to "no exposure recorded" so these
 * settings/env/request-tier tests are isolated from the host's real
 * `~/.parachute/expose-state.json`. Without this, the default reader picks
 * up a live exposure on the dev box and the expose tier shadows the
 * request-origin fallback these tests assert. (The expose tier itself is
 * exercised in the dedicated describe blocks below with its own injected
 * origins.)
 */
const noExpose = (): string | undefined => undefined;

describe("resolveIssuer — precedence chain", () => {
  test("falls back to request origin when no settings + no env", () => {
    const got = resolveIssuer(req("http://127.0.0.1:1939/oauth/token"), db, undefined, noExpose);
    expect(got).toBe("http://127.0.0.1:1939");
  });

  test("env wins over request origin (deploy-time setting)", () => {
    const got = resolveIssuer(
      req("http://127.0.0.1:1939/oauth/token"),
      db,
      "https://hub.from-env.example",
      noExpose,
    );
    expect(got).toBe("https://hub.from-env.example");
  });

  test("hub_settings wins over env (operator override)", () => {
    setHubOrigin(db, "https://hub.from-settings.example");
    const got = resolveIssuer(
      req("http://127.0.0.1:1939/oauth/token"),
      db,
      "https://hub.from-env.example",
      noExpose,
    );
    expect(got).toBe("https://hub.from-settings.example");
  });

  test("hub_settings wins over request origin (no env)", () => {
    setHubOrigin(db, "https://hub.from-settings.example");
    const got = resolveIssuer(req("http://127.0.0.1:1939/oauth/token"), db, undefined, noExpose);
    expect(got).toBe("https://hub.from-settings.example");
  });

  test("clearing hub_settings reverts to env precedence", () => {
    setHubOrigin(db, "https://hub.from-settings.example");
    setHubOrigin(db, null);
    const got = resolveIssuer(
      req("http://127.0.0.1:1939/oauth/token"),
      db,
      "https://hub.from-env.example",
      noExpose,
    );
    expect(got).toBe("https://hub.from-env.example");
  });

  test("clearing hub_settings + no env reverts to request origin", () => {
    setHubOrigin(db, "https://hub.from-settings.example");
    setHubOrigin(db, null);
    const got = resolveIssuer(req("http://127.0.0.1:1939/oauth/token"), db, undefined, noExpose);
    expect(got).toBe("http://127.0.0.1:1939");
  });

  test("undefined db (pre-config gate) falls through to env then request", () => {
    // The wellknown / discovery surfaces may hit oauthDeps before a DB
    // is wired; resolveIssuer must not throw — just skip the settings
    // layer.
    const got = resolveIssuer(req("http://127.0.0.1:1939/"), undefined, undefined, noExpose);
    expect(got).toBe("http://127.0.0.1:1939");

    const gotEnv = resolveIssuer(
      req("http://127.0.0.1:1939/"),
      undefined,
      "https://hub.from-env.example",
      noExpose,
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
    expect(resolveIssuer(req(baseUrl), db, undefined, noExpose)).toBe("http://127.0.0.1:1939");

    // Mid-flight write.
    setHubOrigin(db, "https://hub.example.com");

    // Pass 2 — settings wins immediately.
    expect(resolveIssuer(req(baseUrl), db, undefined, noExpose)).toBe("https://hub.example.com");

    // Mid-flight clear.
    setHubOrigin(db, null);

    // Pass 3 — back to request origin.
    expect(resolveIssuer(req(baseUrl), db, undefined, noExpose)).toBe("http://127.0.0.1:1939");
  });

  test("X-Forwarded-Proto: https upgrades the request-origin fallback", () => {
    // Render / Tailscale Funnel / cloudflared terminate TLS at the edge
    // and forward plain HTTP. Without honoring the header, hub publishes
    // `http://...` in OAuth discovery — mixed-content blocked when the
    // page loaded over https://. See hub#355 (the notes app's
    // /oauth/register call surfaced this).
    const r = new Request(
      "http://parachute-hub.onrender.com/.well-known/oauth-authorization-server",
      {
        method: "GET",
        headers: { "X-Forwarded-Proto": "https" },
      },
    );
    expect(resolveIssuer(r, db, undefined, noExpose)).toBe("https://parachute-hub.onrender.com");
  });

  test("X-Forwarded-Proto with comma-separated values takes the first", () => {
    // Multi-hop proxies append; the leftmost is the original client → edge
    // hop. RFC-style parsing (consistent with isHttpsRequest).
    const r = new Request("http://hub.internal/oauth/token", {
      method: "GET",
      headers: { "X-Forwarded-Proto": "https, http" },
    });
    expect(resolveIssuer(r, db, undefined, noExpose)).toBe("https://hub.internal");
  });

  test("missing X-Forwarded-Proto leaves the URL scheme as-is (localhost dev)", () => {
    // No reverse proxy → no header → keep http for the local-dev shape.
    // Operators on plain HTTP localhost depend on this.
    const r = new Request("http://127.0.0.1:1939/oauth/token", { method: "GET" });
    expect(resolveIssuer(r, db, undefined, noExpose)).toBe("http://127.0.0.1:1939");
  });

  test("X-Forwarded-Proto is IGNORED when hub_settings or env wins", () => {
    // Precedence guard: X-Forwarded-Proto should only affect the
    // request-origin fallback branch. Explicit operator config
    // (settings row, env var) always wins as-is, including its scheme.
    // Without this guard, a future refactor could accidentally let the
    // header override an operator's deliberate choice.
    const r = new Request("http://hub.internal/oauth/token", {
      method: "GET",
      headers: { "X-Forwarded-Proto": "https" },
    });

    // Env layer wins, even though the header says https — the env value
    // is returned verbatim (preserving whatever scheme the operator set).
    expect(resolveIssuer(r, db, "http://configured.example", noExpose)).toBe(
      "http://configured.example",
    );

    // Settings layer wins above env, also verbatim.
    setHubOrigin(db, "http://settings.example");
    expect(resolveIssuer(r, db, "https://env.example", noExpose)).toBe("http://settings.example");
  });
});

describe("resolveIssuerSource — attribution for SPA", () => {
  test('"request" when nothing is configured', () => {
    expect(resolveIssuerSource(db, undefined, noExpose)).toBe("request");
  });

  test('"env" when configuredIssuer is set + no settings row', () => {
    expect(resolveIssuerSource(db, "https://hub.from-env.example", noExpose)).toBe("env");
  });

  test('"settings" when hub_settings row is set, even if env is also set', () => {
    setHubOrigin(db, "https://hub.from-settings.example");
    expect(resolveIssuerSource(db, "https://hub.from-env.example", noExpose)).toBe("settings");
  });

  test("attribution matches resolved value across the chain", () => {
    // Pair them up so a future change to one without the other gets
    // caught — the SPA helper text says "from settings" iff the
    // settings layer is what got returned.
    setHubOrigin(db, "https://hub.example.com");
    const r1 = req("http://127.0.0.1:1939/oauth/token");
    expect(resolveIssuer(r1, db, "https://hub.from-env.example", noExpose)).toBe(
      "https://hub.example.com",
    );
    expect(resolveIssuerSource(db, "https://hub.from-env.example", noExpose)).toBe("settings");

    setHubOrigin(db, null);
    expect(resolveIssuer(r1, db, "https://hub.from-env.example", noExpose)).toBe(
      "https://hub.from-env.example",
    );
    expect(resolveIssuerSource(db, "https://hub.from-env.example", noExpose)).toBe("env");

    expect(resolveIssuer(r1, db, undefined, noExpose)).toBe("http://127.0.0.1:1939");
    expect(resolveIssuerSource(db, undefined, noExpose)).toBe("request");
  });
});

/**
 * The expose-state tier (#531). On the reboot-persistent owner-operated
 * path the launchd plist / systemd unit carries no PARACHUTE_HUB_ORIGIN, so
 * the hub boots with no `configuredIssuer`. Without this tier it would stamp
 * `iss` from the per-request origin (loopback) and exposed resource servers
 * (vault) reject the token with `unexpected "iss" claim value`. The exposed
 * origin recorded in expose-state.json's hubOrigin is consulted between the
 * env tier and the request-origin fallback. The `readExpose` seam (4th /
 * 3rd param) drives this without touching the real ~/.parachute.
 */
describe("resolveIssuer — expose-state tier (#531)", () => {
  const EXPOSED = "https://parachute.taildf9ce2.ts.net";
  // Simulates the reported bug: token minted under loopback, request arrives
  // at loopback, but the canonical exposed origin lives in expose-state.
  const loopbackReq = () => req("http://127.0.0.1:1939/oauth/token");

  test("REGRESSION: expose origin used (NOT request origin) when settings+env both absent", () => {
    const got = resolveIssuer(loopbackReq(), db, undefined, () => EXPOSED);
    expect(got).toBe(EXPOSED);
    expect(got).not.toBe("http://127.0.0.1:1939");
  });

  test("settings wins over expose", () => {
    setHubOrigin(db, "https://hub.from-settings.example");
    const got = resolveIssuer(loopbackReq(), db, undefined, () => EXPOSED);
    expect(got).toBe("https://hub.from-settings.example");
  });

  test("env wins over expose", () => {
    const got = resolveIssuer(loopbackReq(), db, "https://hub.from-env.example", () => EXPOSED);
    expect(got).toBe("https://hub.from-env.example");
  });

  test("expose wins over request origin", () => {
    // settings + env both absent → expose beats the per-request loopback origin.
    const got = resolveIssuer(loopbackReq(), db, undefined, () => EXPOSED);
    expect(got).toBe(EXPOSED);
  });

  test("full precedence: settings > env > expose > request", () => {
    // request-only
    expect(resolveIssuer(loopbackReq(), db, undefined, () => undefined)).toBe(
      "http://127.0.0.1:1939",
    );
    // expose beats request
    expect(resolveIssuer(loopbackReq(), db, undefined, () => EXPOSED)).toBe(EXPOSED);
    // env beats expose
    expect(resolveIssuer(loopbackReq(), db, "https://env.example", () => EXPOSED)).toBe(
      "https://env.example",
    );
    // settings beats env (and expose)
    setHubOrigin(db, "https://settings.example");
    expect(resolveIssuer(loopbackReq(), db, "https://env.example", () => EXPOSED)).toBe(
      "https://settings.example",
    );
  });

  test("malformed expose-state falls through to request without throwing", () => {
    // A reader that throws simulates a corrupt expose-state.json. The
    // `exposeIssuerOrigin` wrapper guards the `readExpose()` call itself in
    // try/catch, so even an injected non-swallowing reader can NEVER
    // propagate into the request path — resolveIssuer falls through to the
    // request origin instead of 500ing the hub.
    const throwing = () => {
      throw new Error("malformed expose-state.json");
    };
    expect(() => resolveIssuer(loopbackReq(), db, undefined, throwing)).not.toThrow();
    expect(resolveIssuer(loopbackReq(), db, undefined, throwing)).toBe("http://127.0.0.1:1939");
    // A reader that returns undefined (the default's post-swallow shape) also
    // yields the request origin.
    expect(resolveIssuer(loopbackReq(), db, undefined, () => undefined)).toBe(
      "http://127.0.0.1:1939",
    );
  });

  test("loopback expose origin ignored (never re-pin the degraded mode)", () => {
    expect(resolveIssuer(loopbackReq(), db, undefined, () => "http://127.0.0.1:1939")).toBe(
      "http://127.0.0.1:1939",
    );
    expect(resolveIssuer(loopbackReq(), db, undefined, () => "http://localhost:1939")).toBe(
      "http://127.0.0.1:1939",
    );
    expect(resolveIssuer(loopbackReq(), db, undefined, () => "http://0.0.0.0:1939")).toBe(
      "http://127.0.0.1:1939",
    );
  });

  test("non-http(s) / empty expose origin ignored", () => {
    expect(resolveIssuer(loopbackReq(), db, undefined, () => "ftp://x.example")).toBe(
      "http://127.0.0.1:1939",
    );
    expect(resolveIssuer(loopbackReq(), db, undefined, () => "")).toBe("http://127.0.0.1:1939");
    expect(resolveIssuer(loopbackReq(), db, undefined, () => "not-a-url")).toBe(
      "http://127.0.0.1:1939",
    );
  });

  test("undefined db (pre-config gate) still consults expose before request", () => {
    const got = resolveIssuer(loopbackReq(), undefined, undefined, () => EXPOSED);
    expect(got).toBe(EXPOSED);
  });
});

describe("resolveIssuerSource — expose attribution (#531)", () => {
  const EXPOSED = "https://parachute.taildf9ce2.ts.net";

  test('"expose" when resolved from expose-state (settings+env absent)', () => {
    expect(resolveIssuerSource(db, undefined, () => EXPOSED)).toBe("expose");
  });

  test('"settings" wins over expose', () => {
    setHubOrigin(db, "https://settings.example");
    expect(resolveIssuerSource(db, undefined, () => EXPOSED)).toBe("settings");
  });

  test('"env" wins over expose', () => {
    expect(resolveIssuerSource(db, "https://env.example", () => EXPOSED)).toBe("env");
  });

  test('"request" when no settings/env and no (valid) expose origin', () => {
    expect(resolveIssuerSource(db, undefined, () => undefined)).toBe("request");
    expect(resolveIssuerSource(db, undefined, () => "http://127.0.0.1:1939")).toBe("request");
  });

  test("attribution matches resolved value for the expose tier", () => {
    // Pair the source label with the resolved value so they can't drift.
    const r = req("http://127.0.0.1:1939/oauth/token");
    expect(resolveIssuer(r, db, undefined, () => EXPOSED)).toBe(EXPOSED);
    expect(resolveIssuerSource(db, undefined, () => EXPOSED)).toBe("expose");
  });
});
