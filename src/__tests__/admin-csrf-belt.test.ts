/**
 * CSRF belt on cookie-gated /admin/* JSON mutation endpoints (hub#632,
 * 2026-06-09 hub-module-boundary Phase C1).
 *
 * Two layers:
 *
 *   1. Unit — `assertSameOriginForCookieMutation` semantics: which requests
 *      the belt gates (cookie-authed mutations), which it waves through
 *      (reads, Bearer-authed, cookie-less), and the two rejection codes
 *      (`csrf_origin_required` / `csrf_origin_mismatch`).
 *   2. Integration — the wiring in hub-server.ts dispatch for
 *      `/admin/connections`: cross-origin cookie mutations 403 BEFORE the
 *      operator gate; same-origin mutations reach the handler; GETs are
 *      unaffected; Bearer-authed mutations skip the belt and land on the
 *      endpoint's own gate. (The legacy `/admin/channels` wiring was belted
 *      here too until boundary D1 retired the endpoint.)
 *
 * The canonical seam consumer is pinned here: the agent module's admin page POSTs
 * `/admin/connections` as a same-origin `fetch()` with
 * `credentials: "include"` (parachute-agent src/admin-ui.ts) — i.e.
 * session cookie + browser-sent matching Origin. That shape must keep
 * passing the belt without any token dance.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { assertSameOriginForCookieMutation } from "../origin-check.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { createUser } from "../users.ts";

const BOUND = ["https://hub.example", "http://localhost:1939", "http://127.0.0.1:1939"];
const SESSION_COOKIE = "parachute_hub_session=abc123";

function mutReq(opts: {
  method?: string;
  origin?: string;
  cookie?: string;
  authorization?: string;
  url?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  return new Request(opts.url ?? "https://hub.example/admin/connections", {
    method: opts.method ?? "POST",
    headers,
  });
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string };
  return body.error ?? "";
}

describe("assertSameOriginForCookieMutation (unit)", () => {
  test("cookie-authed POST with matching Origin passes", () => {
    const res = mutReq({ cookie: SESSION_COOKIE, origin: "https://hub.example" });
    expect(assertSameOriginForCookieMutation(res, BOUND)).toBeNull();
  });

  test("matching any bound origin passes (multi-origin hub: loopback alias)", () => {
    const res = mutReq({
      cookie: SESSION_COOKIE,
      origin: "http://127.0.0.1:1939",
      url: "http://127.0.0.1:1939/admin/connections",
    });
    expect(assertSameOriginForCookieMutation(res, BOUND)).toBeNull();
  });

  test("cookie-authed POST with cross-site Origin → 403 csrf_origin_mismatch", async () => {
    const rejected = assertSameOriginForCookieMutation(
      mutReq({ cookie: SESSION_COOKIE, origin: "https://evil.example" }),
      BOUND,
    );
    expect(rejected).not.toBeNull();
    expect(rejected?.status).toBe(403);
    expect(await errorCode(rejected as Response)).toBe("csrf_origin_mismatch");
  });

  test("cookie-authed POST with NO Origin → 403 csrf_origin_required", async () => {
    const rejected = assertSameOriginForCookieMutation(mutReq({ cookie: SESSION_COOKIE }), BOUND);
    expect(rejected?.status).toBe(403);
    expect(await errorCode(rejected as Response)).toBe("csrf_origin_required");
  });

  test("`Origin: null` (opaque origin) is a mismatch, NOT a pass — no Host fallback", async () => {
    // The attacker form-post shape: referrer-policy no-referrer makes the
    // browser send `Origin: null` on a navigation POST; Host always names
    // the target. isSameOriginRequest's Host fallback would pass this —
    // the belt must not (these JSON endpoints carry no double-submit token).
    const rejected = assertSameOriginForCookieMutation(
      mutReq({ cookie: SESSION_COOKIE, origin: "null" }),
      BOUND,
    );
    expect(rejected?.status).toBe(403);
    expect(await errorCode(rejected as Response)).toBe("csrf_origin_mismatch");
  });

  test("malformed Origin is a mismatch", async () => {
    const rejected = assertSameOriginForCookieMutation(
      mutReq({ cookie: SESSION_COOKIE, origin: "not a url" }),
      BOUND,
    );
    expect(rejected?.status).toBe(403);
    expect(await errorCode(rejected as Response)).toBe("csrf_origin_mismatch");
  });

  test("PUT / PATCH / DELETE are gated like POST", () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const rejected = assertSameOriginForCookieMutation(
        mutReq({ method, cookie: SESSION_COOKIE }),
        BOUND,
      );
      expect(rejected?.status).toBe(403);
    }
  });

  test("GET / HEAD / OPTIONS pass regardless of Origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const res = mutReq({ method, cookie: SESSION_COOKIE, origin: "https://evil.example" });
      expect(assertSameOriginForCookieMutation(res, BOUND)).toBeNull();
    }
  });

  test("Bearer-authed mutation without Origin passes (API clients are CSRF-immune)", () => {
    const res = mutReq({ authorization: "Bearer some-token" });
    expect(assertSameOriginForCookieMutation(res, BOUND)).toBeNull();
  });

  test("Authorization present + cookie present passes — a custom header cannot ride a CSRF", () => {
    // Cross-site pages cannot attach an Authorization header without a CORS
    // preflight these routes never approve, so its presence proves this is
    // not a browser-forged request. The endpoint's own gate still runs.
    const res = mutReq({ authorization: "Bearer some-token", cookie: SESSION_COOKIE });
    expect(assertSameOriginForCookieMutation(res, BOUND)).toBeNull();
  });

  test("no cookie + no Authorization passes through (endpoint's own 401 is the right answer)", () => {
    const res = mutReq({});
    expect(assertSameOriginForCookieMutation(res, BOUND)).toBeNull();
  });

  test("other cookies without the session cookie do not arm the belt", () => {
    const res = mutReq({ cookie: "parachute_hub_csrf=tok; theme=dark" });
    expect(assertSameOriginForCookieMutation(res, BOUND)).toBeNull();
  });

  test("empty bound-origin set fails closed for cookie-authed mutations", async () => {
    const rejected = assertSameOriginForCookieMutation(
      mutReq({ cookie: SESSION_COOKIE, origin: "https://hub.example" }),
      [],
    );
    expect(rejected?.status).toBe(403);
    expect(await errorCode(rejected as Response)).toBe("csrf_origin_mismatch");
  });
});

// ===========================================================================
// Integration — the dispatch wiring in hub-server.ts
// ===========================================================================

interface Harness {
  dir: string;
  db: Database;
  cookie: string;
  cleanup: () => void;
}

let h: Harness;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "phub-csrf-belt-"));
  const db = openHubDb(hubDbPath(dir));
  const user = await createUser(db, "operator", "hunter2");
  const session = createSession(db, { userId: user.id });
  h = {
    dir,
    db,
    cookie: buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
afterEach(() => h.cleanup());

/** hubFetch with bound origins pinned to the request-derived issuer (no
 * stored hub_origin, no configured issuer, no expose state). */
function handler() {
  return hubFetch(h.dir, {
    getDb: () => h.db,
    manifestPath: join(h.dir, "services.json"),
    connectionsStorePath: join(h.dir, "connections.json"),
    loadExposeHubOrigin: () => undefined,
  });
}

const ORIGIN = "http://hub.test";

function adminReq(
  path: string,
  opts: { method?: string; origin?: string; cookie?: string; auth?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${path}`, {
    method: opts.method ?? "POST",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("CSRF belt wiring — /admin/connections", () => {
  test("cross-origin cookie POST /admin/connections → 403 csrf_origin_mismatch (even with a valid admin session)", async () => {
    const res = await handler()(
      adminReq("/admin/connections", {
        cookie: h.cookie,
        origin: "https://evil.example",
        body: {},
      }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("csrf_origin_mismatch");
  });

  test("missing-Origin cookie POST /admin/connections → 403 csrf_origin_required", async () => {
    const res = await handler()(adminReq("/admin/connections", { cookie: h.cookie, body: {} }));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("csrf_origin_required");
  });

  test("same-origin cookie POST /admin/connections passes the belt and reaches handler validation", async () => {
    const res = await handler()(
      adminReq("/admin/connections", { cookie: h.cookie, origin: ORIGIN, body: {} }),
    );
    // Past the belt: the handler's own body validation answers (400), not a
    // csrf_* 403.
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
  });

  test("seam pin — the agent link-vault shape (cookie + correct Origin, requestedBy: agent) passes the belt", async () => {
    // parachute-agent/src/admin-ui.ts: fetch(window.location.origin +
    // "/admin/connections", { method: "POST", credentials: "include" }) —
    // same-origin fetch(), so the browser sends Origin = hub origin on the
    // POST. With no modules installed in this harness the engine answers
    // 400 unknown_module — i.e. the request cleared the belt AND the
    // operator gate and reached catalog validation. The full provision flow
    // is covered handler-level in admin-connections.test.ts.
    const res = await handler()(
      adminReq("/admin/connections", {
        cookie: h.cookie,
        origin: ORIGIN,
        body: {
          source: {
            module: "vault",
            vault: "main",
            event: "note.created",
            filter: { tags: ["agent-message/inbound"] },
          },
          sink: { module: "agent", action: "message.deliver", params: { channel: "tg" } },
          requestedBy: "agent",
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("unknown_module");
  });

  test("X-Forwarded-Proto public-origin case over the proxy passes", async () => {
    // TLS terminates at the edge; hub sees plain http with
    // X-Forwarded-Proto: https and the public Host preserved end-to-end.
    // resolveIssuer derives https://<host> — the browser's Origin on a
    // same-origin fetch is exactly that, so the belt matches.
    const req = new Request("http://pub.example/admin/connections", {
      method: "POST",
      headers: {
        cookie: h.cookie,
        origin: "https://pub.example",
        "x-forwarded-proto": "https",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const res = await handler()(req);
    expect(res.status).toBe(400); // handler validation, not the belt's 403
    expect(await errorCode(res)).toBe("invalid_request");
  });

  test("GET /admin/connections with cookie and no Origin is unaffected", async () => {
    const res = await handler()(
      adminReq("/admin/connections", { method: "GET", cookie: h.cookie }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; connections: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.connections).toEqual([]);
  });

  test("Bearer-authed POST /admin/connections without Origin skips the belt; the endpoint's own gate answers", async () => {
    const res = await handler()(
      adminReq("/admin/connections", { auth: "Bearer junk-token", body: {} }),
    );
    // Cookie-gated endpoint: the operator gate 401s the Bearer-only caller.
    // The point pinned here: NOT a 403 csrf_* rejection.
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthenticated");
  });

  test("cross-origin cookie DELETE /admin/connections/<id> → 403 csrf_origin_mismatch", async () => {
    const res = await handler()(
      adminReq("/admin/connections/some-id", {
        method: "DELETE",
        cookie: h.cookie,
        origin: "https://evil.example",
      }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("csrf_origin_mismatch");
  });

  // The legacy `/admin/channels` cases lived here until boundary D1 retired
  // the endpoint (superseded by /admin/connections, covered above). A POST
  // there now falls through dispatch to the generic `/admin/*` SPA mount,
  // which rejects non-GET (405) — the pin here is "no provisioning handler
  // answers anymore", not the precise fallthrough status.
  test("retired /admin/channels no longer provisions (D1) — falls through dispatch", async () => {
    const res = await handler()(
      adminReq("/admin/channels", {
        cookie: h.cookie,
        origin: ORIGIN,
        body: { channelName: "x", vault: "main" },
      }),
    );
    expect([404, 405]).toContain(res.status);
  });
});
