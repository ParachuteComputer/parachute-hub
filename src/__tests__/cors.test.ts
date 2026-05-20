import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORS_PREFLIGHT_HEADERS,
  CORS_RESPONSE_HEADERS,
  applyCorsHeaders,
  corsPreflightResponse,
  isCorsAllowedRoute,
} from "../cors.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { writeManifest } from "../services-manifest.ts";

const GITCOIN_BRAIN_ORIGIN = "https://unforced-dev.github.io";
const ISSUER = "https://parachute.taildf9ce2.ts.net";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init);
}

function preflight(path: string, origin = GITCOIN_BRAIN_ORIGIN): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
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
  test("CORS_RESPONSE_HEADERS use wildcard origin and credentials=false", () => {
    expect(CORS_RESPONSE_HEADERS["access-control-allow-origin"]).toBe("*");
    expect(CORS_RESPONSE_HEADERS["access-control-allow-credentials"]).toBe("false");
    // Expose-Headers surfaces RFC 6750 WWW-Authenticate so cross-origin SPAs
    // can read OAuth error responses.
    expect(CORS_RESPONSE_HEADERS["access-control-expose-headers"]).toContain("WWW-Authenticate");
  });

  test("CORS_PREFLIGHT_HEADERS announces GET + POST + OPTIONS and standard request headers", () => {
    const methods = CORS_PREFLIGHT_HEADERS["access-control-allow-methods"] ?? "";
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
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

  test("corsPreflightResponse is 204 with the preflight headers and empty body", async () => {
    const res = corsPreflightResponse();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
    // 204 = no body. body should be null per the spec; reading it returns
    // the empty string.
    expect(await res.text()).toBe("");
  });

  test("applyCorsHeaders folds wildcard origin onto an existing JSON response", async () => {
    const original = Response.json({ ok: true }, { status: 201 });
    const wrapped = applyCorsHeaders(original);
    expect(wrapped.status).toBe(201);
    expect(wrapped.headers.get("access-control-allow-origin")).toBe("*");
    expect(wrapped.headers.get("access-control-allow-credentials")).toBe("false");
    expect(wrapped.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect((await wrapped.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  test("applyCorsHeaders preserves a handler's existing CORS header (no overwrite)", () => {
    // If a handler already set Access-Control-Allow-Origin (e.g. a different
    // posture for a specific route), we don't clobber it. Defensive; no
    // current caller does this, but the contract should be additive.
    const original = new Response("hi", {
      status: 200,
      headers: { "access-control-allow-origin": "https://specific.example" },
    });
    const wrapped = applyCorsHeaders(original);
    expect(wrapped.headers.get("access-control-allow-origin")).toBe("https://specific.example");
    expect(wrapped.headers.get("access-control-allow-credentials")).toBe("false");
  });
});

describe("hubFetch CORS on /oauth/*", () => {
  // The original bug: Aaron's Gitcoin Brain SPA at GITCOIN_BRAIN_ORIGIN tried
  // to fetch /oauth/register on his hub at ISSUER. Browser preflighted with
  // OPTIONS; preflight returned 405 (method-not-allowed from the
  // POST-only handler) with no CORS headers, so the browser blocked the
  // subsequent POST. These tests pin both halves of the fix.

  test("OPTIONS preflight on /oauth/register from a third-party origin returns 204 + CORS", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/oauth/register"),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
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

  test("POST /oauth/register response carries Access-Control-Allow-Origin: * (the actual bug)", async () => {
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
            headers: { "content-type": "application/json", origin: GITCOIN_BRAIN_ORIGIN },
            body: JSON.stringify({
              client_name: "gitcoin-brain",
              redirect_uris: [`${GITCOIN_BRAIN_ORIGIN}/callback`],
            }),
          }),
        );
        // Status is whatever DCR produces (typically 201 created on the
        // public-DCR path); the CORS header is the load-bearing assertion.
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-credentials")).toBe("false");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on /oauth/authorize returns 204 + CORS", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/oauth/authorize"),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("GET /oauth/authorize response carries Access-Control-Allow-Origin: * (the sync-handler branch)", async () => {
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
            `${ISSUER}/oauth/authorize?client_id=test&redirect_uri=https://example.com/cb&response_type=code&state=foo`,
            { method: "GET", headers: { origin: "https://example.com" } },
          ),
        );
        expect(res.status).toBe(400);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-credentials")).toBe("false");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on /oauth/token returns 204 + CORS", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/oauth/token"),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on /oauth/revoke returns 204 + CORS", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/oauth/revoke"),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on /oauth/authorize/approve returns 204 + CORS", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/oauth/authorize/approve"),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("POST /oauth/token method-not-allowed branch still carries CORS headers", async () => {
    // Bad-method on an in-scope path still has to ship CORS so the SPA can
    // *read* the error response. Without it, the browser drops the response
    // body and the SPA sees an opaque network failure instead of a clear
    // 405.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          new Request(`${ISSUER}/oauth/token`, { method: "GET" }),
        );
        expect(res.status).toBe(405);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("503 dbNotConfigured response on an oauth route still carries CORS headers", async () => {
    // No getDb → service_unavailable. Same as method-not-allowed: the SPA
    // needs to be able to read the error.
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir, { issuer: ISSUER })(
        new Request(`${ISSUER}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
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

  test("OPTIONS on /api/me does not return CORS preflight 204", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/api/me"),
        );
        // Whatever the API surface does with OPTIONS, it must not be the
        // CORS preflight 204+wildcard shape.
        const acao = res.headers.get("access-control-allow-origin");
        expect(acao).not.toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS on /admin/host-admin-token does not return CORS preflight 204", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/admin/host-admin-token"),
        );
        const acao = res.headers.get("access-control-allow-origin");
        expect(acao).not.toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS on /login does not return CORS preflight 204", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(preflight("/login"));
        const acao = res.headers.get("access-control-allow-origin");
        expect(acao).not.toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS on /account/change-password does not return CORS preflight 204", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          preflight("/account/change-password"),
        );
        const acao = res.headers.get("access-control-allow-origin");
        expect(acao).not.toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS on /vault/default content proxy is not a CORS preflight 204", async () => {
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
        expect(acao).not.toBe("*");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("the exact bug Aaron hit — preflight from unforced-dev.github.io to /oauth/register", async () => {
    // Reproduces the exact request shape from the browser console error in
    // the PR brief. This is the canonical regression test for the bug.
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db, issuer: ISSUER })(
          new Request(`${ISSUER}/oauth/register`, {
            method: "OPTIONS",
            headers: {
              origin: "https://unforced-dev.github.io",
              "access-control-request-method": "POST",
              "access-control-request-headers": "content-type",
            },
          }),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
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
