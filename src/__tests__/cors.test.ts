import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClient, registerClient } from "../clients.ts";
import {
  CORS_PREFLIGHT_HEADERS,
  CORS_RESPONSE_HEADERS,
  applyCorsHeaders,
  corsPreflightResponse,
  isCorsAllowedRoute,
} from "../cors.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { writeManifest } from "../services-manifest.ts";
import { createUser } from "../users.ts";

const GITCOIN_BRAIN_ORIGIN = "https://unforced-dev.github.io";
const EXAMPLE_ORIGIN = "https://example.com";
const ISSUER = "https://parachute.taildf9ce2.ts.net";

function preflight(path: string, origin: string | null = GITCOIN_BRAIN_ORIGIN): Request {
  const headers: Record<string, string> = {
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  };
  if (origin !== null) headers.origin = origin;
  return new Request(`http://127.0.0.1${path}`, { method: "OPTIONS", headers });
}

interface Harness {
  dir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-cors-"));
  return {
    dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("cors helper module", () => {
  test("CORS_RESPONSE_HEADERS exposes WWW-Authenticate (always-on, request-independent)", () => {
    // Expose-Headers surfaces RFC 6750 WWW-Authenticate so cross-origin SPAs
    // can read OAuth error responses. The dynamic Origin/Credentials/Vary
    // triple is no longer static — it's computed per-request in
    // applyCorsHeaders + corsPreflightResponse from the request's Origin
    // header (echo-origin posture, not wildcard).
    expect(CORS_RESPONSE_HEADERS["access-control-expose-headers"]).toContain("WWW-Authenticate");
  });

  test("CORS_PREFLIGHT_HEADERS announces GET + POST + DELETE + OPTIONS and standard request headers", () => {
    const methods = CORS_PREFLIGHT_HEADERS["access-control-allow-methods"] ?? "";
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    // DELETE for RFC 7592 client deregistration (hub#640).
    expect(methods).toContain("DELETE");
    expect(methods).toContain("OPTIONS");
    const headers = CORS_PREFLIGHT_HEADERS["access-control-allow-headers"] ?? "";
    expect(headers).toContain("Authorization");
    expect(headers).toContain("Content-Type");
    expect(CORS_PREFLIGHT_HEADERS["access-control-max-age"]).toBe("86400");
  });

  test("isCorsAllowedRoute matches /oauth/* and nothing else", () => {
    expect(isCorsAllowedRoute("/oauth/register")).toBe(true);
    expect(isCorsAllowedRoute("/oauth/token")).toBe(true);
    expect(isCorsAllowedRoute("/oauth/authorize")).toBe(true);
    expect(isCorsAllowedRoute("/oauth/authorize/approve")).toBe(true);
    expect(isCorsAllowedRoute("/oauth/revoke")).toBe(true);
    // Out-of-scope surfaces. /.well-known/* handlers carry their own inline
    // CORS posture in hub-server.ts — see the comment in cors.ts on why
    // they're intentionally excluded from this predicate.
    expect(isCorsAllowedRoute("/.well-known/oauth-authorization-server")).toBe(false);
    expect(isCorsAllowedRoute("/.well-known/parachute.json")).toBe(false);
    expect(isCorsAllowedRoute("/.well-known/jwks.json")).toBe(false);
    expect(isCorsAllowedRoute("/api/me")).toBe(false);
    expect(isCorsAllowedRoute("/api/users")).toBe(false);
    expect(isCorsAllowedRoute("/admin/vaults")).toBe(false);
    expect(isCorsAllowedRoute("/admin/host-admin-token")).toBe(false);
    expect(isCorsAllowedRoute("/login")).toBe(false);
    expect(isCorsAllowedRoute("/logout")).toBe(false);
    expect(isCorsAllowedRoute("/account/change-password")).toBe(false);
    expect(isCorsAllowedRoute("/vault/default")).toBe(false);
    expect(isCorsAllowedRoute("/")).toBe(false);
    // Bare /oauth doesn't match — there's no route there and the prefix
    // intentionally requires the trailing slash so it doesn't silently widen.
    expect(isCorsAllowedRoute("/oauth")).toBe(false);
  });

  test("corsPreflightResponse with Origin echoes origin + credentials:true + Vary:Origin", async () => {
    const res = corsPreflightResponse(
      new Request("http://127.0.0.1/oauth/register", {
        method: "OPTIONS",
        headers: { origin: EXAMPLE_ORIGIN },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(EXAMPLE_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    // Vary: Origin is critical — without it a browser/CDN can cache a
    // response for one origin and reuse it for a different origin. Pin its
    // presence as a regression guard.
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
    // 204 = no body. Reading it returns the empty string.
    expect(await res.text()).toBe("");
  });

  test("corsPreflightResponse without Origin falls back to wildcard + credentials:false", async () => {
    // Non-browser caller (curl, server-side fetch). No Origin → safe wildcard
    // fallback with credentials:false (the only legal pairing per CORS spec
    // when ACAO is `*`).
    const res = corsPreflightResponse(
      new Request("http://127.0.0.1/oauth/register", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBe("false");
    // No Vary needed on a wildcard response — it doesn't vary by origin.
    expect(res.headers.get("vary")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("applyCorsHeaders with Origin echoes origin + credentials:true + Vary:Origin", async () => {
    const original = Response.json({ ok: true }, { status: 201 });
    const wrapped = applyCorsHeaders(
      new Request("http://127.0.0.1/oauth/register", {
        method: "POST",
        headers: { origin: EXAMPLE_ORIGIN },
      }),
      original,
    );
    expect(wrapped.status).toBe(201);
    expect(wrapped.headers.get("access-control-allow-origin")).toBe(EXAMPLE_ORIGIN);
    expect(wrapped.headers.get("access-control-allow-credentials")).toBe("true");
    expect(wrapped.headers.get("vary")).toBe("Origin");
    expect(wrapped.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect((await wrapped.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  test("applyCorsHeaders without Origin falls back to wildcard + credentials:false", async () => {
    const original = Response.json({ ok: true }, { status: 201 });
    const wrapped = applyCorsHeaders(
      new Request("http://127.0.0.1/oauth/register", { method: "POST" }),
      original,
    );
    expect(wrapped.headers.get("access-control-allow-origin")).toBe("*");
    expect(wrapped.headers.get("access-control-allow-credentials")).toBe("false");
    expect(wrapped.headers.get("vary")).toBeNull();
  });

  test("applyCorsHeaders preserves a handler's existing CORS header (no overwrite)", () => {
    // If a handler already set Access-Control-Allow-Origin (e.g. a different
    // posture for a specific route), we don't clobber it. Defensive; no
    // current caller does this, but the contract should be additive.
    const original = new Response("hi", {
      status: 200,
      headers: { "access-control-allow-origin": "https://specific.example" },
    });
    const wrapped = applyCorsHeaders(
      new Request("http://127.0.0.1/oauth/register", {
        method: "POST",
        headers: { origin: EXAMPLE_ORIGIN },
      }),
      original,
    );
    expect(wrapped.headers.get("access-control-allow-origin")).toBe("https://specific.example");
  });
});

describe("hubFetch CORS on /oauth/* — echo origin (credentials:'include' SPAs)", () => {
  // rc.17 used a static `Access-Control-Allow-Origin: *` + Allow-Credentials:
  // false. That works for SPAs that fetch with `credentials: 'omit'`, but the
  // Gitcoin Brain UI (and most SPA frameworks by default) fetches with
  // `credentials: 'include'`, which the browser rejects against a wildcard
  // ACAO. rc.18 echoes the request Origin + sets Allow-Credentials: true so
  // both SPA postures work. These tests pin the echo-origin behavior.

  test("OPTIONS preflight on /oauth/register from a third-party origin echoes that origin", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/oauth/register", EXAMPLE_ORIGIN),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(EXAMPLE_ORIGIN);
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
        expect(res.headers.get("vary")).toBe("Origin");
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
        expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
        expect(res.headers.get("access-control-max-age")).toBe("86400");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on /oauth/register with no Origin falls back to wildcard + credentials:false", async () => {
    // Server-shaped `curl` without `-H Origin: …`. Wildcard + credentials:
    // false is the safe shape — non-browser callers don't enforce CORS, but
    // the response should still be well-formed for diagnostic probes.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/oauth/register", null),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-credentials")).toBe("false");
        expect(res.headers.get("vary")).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("POST /oauth/register response with Origin echoes that origin + credentials:true (the actual bug)", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [] }, h.manifestPath);
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, {
          getDb: () => db,
          issuer: ISSUER,
          manifestPath: h.manifestPath,
        })(
          new Request(`${ISSUER}/oauth/register`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: EXAMPLE_ORIGIN },
            body: JSON.stringify({
              client_name: "example-spa",
              redirect_uris: [`${EXAMPLE_ORIGIN}/callback`],
            }),
          }),
        );
        // Status is whatever DCR produces (typically 201 created on the
        // public-DCR path); the CORS headers are the load-bearing assertion.
        expect(res.headers.get("access-control-allow-origin")).toBe(EXAMPLE_ORIGIN);
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
        expect(res.headers.get("vary")).toBe("Origin");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("POST /oauth/register response with no Origin falls back to wildcard + credentials:false", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [] }, h.manifestPath);
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, {
          getDb: () => db,
          issuer: ISSUER,
          manifestPath: h.manifestPath,
        })(
          new Request(`${ISSUER}/oauth/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_name: "server-side-caller",
              redirect_uris: [`${EXAMPLE_ORIGIN}/callback`],
            }),
          }),
        );
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-credentials")).toBe("false");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on /oauth/authorize echoes origin", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/oauth/authorize"),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(GITCOIN_BRAIN_ORIGIN);
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
        expect(res.headers.get("vary")).toBe("Origin");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("GET /oauth/authorize response carries echo-origin CORS (the sync-handler branch)", async () => {
    // The other oauth handlers are async (`Promise<Response>`); only
    // `handleAuthorizeGet` is sync. Folding `applyCorsHeaders` over a sync
    // return is exercised here so a future refactor that breaks the
    // sync-vs-async distinction (e.g. dropping the wrapper, double-wrapping,
    // accidentally awaiting a non-Promise into a hang) is caught.
    //
    // 400 branch — missing required PKCE params triggers the htmlError
    // path inside parseAuthorizeFormParams. Cleanest no-DB-seeding fixture
    // since the params fail validation before the client lookup runs.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          new Request(
            `${ISSUER}/oauth/authorize?client_id=test&redirect_uri=${EXAMPLE_ORIGIN}/cb&response_type=code&state=foo`,
            { method: "GET", headers: { origin: EXAMPLE_ORIGIN } },
          ),
        );
        expect(res.status).toBe(400);
        expect(res.headers.get("access-control-allow-origin")).toBe(EXAMPLE_ORIGIN);
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
        expect(res.headers.get("vary")).toBe("Origin");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on /oauth/token echoes origin", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/oauth/token"),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(GITCOIN_BRAIN_ORIGIN);
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
        expect(res.headers.get("vary")).toBe("Origin");
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on /oauth/revoke echoes origin", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/oauth/revoke"),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(GITCOIN_BRAIN_ORIGIN);
        expect(res.headers.get("vary")).toBe("Origin");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on /oauth/authorize/approve echoes origin", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/oauth/authorize/approve"),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(GITCOIN_BRAIN_ORIGIN);
        expect(res.headers.get("vary")).toBe("Origin");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("POST /oauth/token method-not-allowed branch still carries echo-origin CORS", async () => {
    // Bad-method on an in-scope path still has to ship CORS so the SPA can
    // *read* the error response. Without it, the browser drops the response
    // body and the SPA sees an opaque network failure instead of a clear
    // 405.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          new Request(`${ISSUER}/oauth/token`, {
            method: "GET",
            headers: { origin: EXAMPLE_ORIGIN },
          }),
        );
        expect(res.status).toBe(405);
        expect(res.headers.get("access-control-allow-origin")).toBe(EXAMPLE_ORIGIN);
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("503 dbNotConfigured response on an oauth route still carries echo-origin CORS", async () => {
    // No getDb → service_unavailable. Same as method-not-allowed: the SPA
    // needs to be able to read the error.
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir, { issuer: ISSUER })(
        new Request(`${ISSUER}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: EXAMPLE_ORIGIN },
          body: "{}",
        }),
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("access-control-allow-origin")).toBe(EXAMPLE_ORIGIN);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      h.cleanup();
    }
  });

  test("the exact bug Aaron hit — preflight from unforced-dev.github.io to /oauth/register echoes that origin", async () => {
    // Reproduces the exact request shape from the browser console error in
    // the rc.17 follow-up PR brief. The Gitcoin Brain UI on
    // https://unforced-dev.github.io fetches with `credentials: 'include'`;
    // the browser preflights and requires the response to specify an
    // explicit origin (not `*`) AND set `Allow-Credentials: true`. This is
    // the canonical regression test for the rc.17→rc.18 fix.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          new Request(`${ISSUER}/oauth/register`, {
            method: "OPTIONS",
            headers: {
              origin: GITCOIN_BRAIN_ORIGIN,
              "access-control-request-method": "POST",
              "access-control-request-headers": "content-type",
            },
          }),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(GITCOIN_BRAIN_ORIGIN);
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
        expect(res.headers.get("vary")).toBe("Origin");
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
        expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("hubFetch CORS scope discipline — out-of-scope routes stay same-origin", () => {
  // Sanity: this PR is supposed to be tightly scoped to /oauth/*. Lock in
  // that the admin / API / login / account surfaces still respond same-
  // origin (no wildcard CORS header). Catches any future regression where
  // someone broadens isCorsAllowedRoute to "all /api/*" or similar.

  test("OPTIONS on /api/me does not return a CORS preflight echo response", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/api/me"),
        );
        // Whatever the API surface does with OPTIONS, it must not be the
        // CORS preflight echo-origin shape.
        const acao = res.headers.get("access-control-allow-origin");
        expect(acao).not.toBe(GITCOIN_BRAIN_ORIGIN);
        expect(acao).not.toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS on /admin/host-admin-token does not return a CORS preflight echo response", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/admin/host-admin-token"),
        );
        const acao = res.headers.get("access-control-allow-origin");
        expect(acao).not.toBe(GITCOIN_BRAIN_ORIGIN);
        expect(acao).not.toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS on /login does not return a CORS preflight echo response", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(preflight("/login"));
        const acao = res.headers.get("access-control-allow-origin");
        expect(acao).not.toBe(GITCOIN_BRAIN_ORIGIN);
        expect(acao).not.toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS on /account/change-password does not return a CORS preflight echo response", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/account/change-password"),
        );
        const acao = res.headers.get("access-control-allow-origin");
        expect(acao).not.toBe(GITCOIN_BRAIN_ORIGIN);
        expect(acao).not.toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS on /vault/default content proxy is not a CORS preflight echo response", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [] }, h.manifestPath);
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, {
          getDb: () => db,
          issuer: ISSUER,
          manifestPath: h.manifestPath,
        })(preflight("/vault/default"));
        const acao = res.headers.get("access-control-allow-origin");
        expect(acao).not.toBe(GITCOIN_BRAIN_ORIGIN);
        expect(acao).not.toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

// hub#640 — confirm the TOP-LEVEL DELETE /oauth/clients/<id> route is wired
// into the real dispatch (not just the handler in isolation). This is the
// load-bearing "right prefix" check: the surface remove-flow fires DELETE at
// exactly this path, and before this route the hub 404'd it. Goes through
// hubFetch so the dispatch order + the path-prefix branch are exercised.
describe("hub#640 DELETE /oauth/clients/<id> dispatch (RFC 7592)", () => {
  async function operatorBearer(db: ReturnType<typeof openHubDb>): Promise<string> {
    const user = await createUser(db, "owner", "pw");
    const minted = await signAccessToken(db, {
      sub: user.id,
      scopes: ["parachute:host:admin"],
      audience: "hub",
      clientId: "parachute-hub-spa",
      issuer: ISSUER,
      ttlSeconds: 600,
    });
    return minted.token;
  }

  test("204 + row gone with a valid operator Bearer (the surface remove-flow path)", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [] }, h.manifestPath);
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const bearer = await operatorBearer(db);
        const id = registerClient(db, {
          redirectUris: ["https://app.example/cb"],
          clientName: "Notes",
        }).client.clientId;

        const res = await hubFetch(h.dir, {
          getDb: () => db,
          issuer: ISSUER,
          manifestPath: h.manifestPath,
        })(
          new Request(`${ISSUER}/oauth/clients/${encodeURIComponent(id)}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${bearer}` },
          }),
        );
        expect(res.status).toBe(204);
        expect(getClient(db, id)).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("401 without a Bearer — the route is auth-gated, not open", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [] }, h.manifestPath);
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const id = registerClient(db, {
          redirectUris: ["https://app.example/cb"],
        }).client.clientId;
        const res = await hubFetch(h.dir, {
          getDb: () => db,
          issuer: ISSUER,
          manifestPath: h.manifestPath,
        })(
          new Request(`${ISSUER}/oauth/clients/${encodeURIComponent(id)}`, {
            method: "DELETE",
          }),
        );
        expect(res.status).toBe(401);
        // Row survives an unauthenticated DELETE.
        expect(getClient(db, id)).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("404 for an absent client_id through dispatch (matches surface 'not_found')", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [] }, h.manifestPath);
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const bearer = await operatorBearer(db);
        const res = await hubFetch(h.dir, {
          getDb: () => db,
          issuer: ISSUER,
          manifestPath: h.manifestPath,
        })(
          new Request(`${ISSUER}/oauth/clients/no-such-client`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${bearer}` },
          }),
        );
        expect(res.status).toBe(404);
        // The surface keys off a JSON 404 → hubDeleteStatus "not_found".
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe("not_found");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on the DELETE path advertises DELETE in Allow-Methods", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [] }, h.manifestPath);
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, {
          getDb: () => db,
          issuer: ISSUER,
          manifestPath: h.manifestPath,
        })(preflight("/oauth/clients/some-id", EXAMPLE_ORIGIN));
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
        expect(res.headers.get("access-control-allow-origin")).toBe(EXAMPLE_ORIGIN);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
