/**
 * Tests for the per-UI audience gate (H3, surface-runtime design §12 —
 * fixes parachute-surface#88).
 *
 * The full matrix: each audience value × (anonymous, hub-user session,
 * Bearer, first-admin session), plus the legacy boolean `public` mapping,
 * fail-closed handling of malformed metadata, the document-vs-API deny
 * shapes, the not-a-UI-path pass-through, and the gate running BEFORE a
 * WebSocket upgrade.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUiMount, scopeMatchesPattern, scopesSatisfyRequirement } from "../audience-gate.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { type ServiceEntry, writeManifest } from "../services-manifest.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

// The request origin the test fetch fn sees — minted Bearers carry it as iss.
const REQ_ORIGIN = "http://127.0.0.1";

interface Harness {
  dir: string;
  manifestPath: string;
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-audience-gate-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  return {
    dir,
    manifestPath: join(dir, "services.json"),
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

function req(path: string, init?: RequestInit): Request {
  return new Request(`${REQ_ORIGIN}${path}`, init);
}

const fakeServer = (address: string) => ({ requestIP: () => ({ address }) });

async function adminSession(): Promise<string> {
  const user = await createUser(h.db, "operator", "hunter2");
  const session = createSession(h.db, { userId: user.id });
  return buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
}

/** A non-admin (friend) session — requires the admin to exist first. */
async function friendSession(): Promise<{ adminCookie: string; friendCookie: string }> {
  const admin = await createUser(h.db, "operator", "hunter2");
  const adminSess = createSession(h.db, { userId: admin.id });
  const friend = await createUser(h.db, "alice", "alice-passphrase", { allowMulti: true });
  const friendSess = createSession(h.db, { userId: friend.id });
  return {
    adminCookie: buildSessionCookie(adminSess.id, Math.floor(SESSION_TTL_MS / 1000)),
    friendCookie: buildSessionCookie(friendSess.id, Math.floor(SESSION_TTL_MS / 1000)),
  };
}

async function mintBearer(scopes: string[]): Promise<string> {
  const signed = await signAccessToken(h.db, {
    sub: "pwa-user",
    scopes,
    audience: "vault.default",
    clientId: "test-pwa",
    issuer: REQ_ORIGIN,
  });
  return signed.token;
}

function startEchoUpstream(): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (r) =>
      new Response(JSON.stringify({ reached: true, path: new URL(r.url).pathname }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  return { port: server.port as number, stop: () => server.stop(true) };
}

function surfaceEntry(
  port: number,
  uiOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "parachute-surface",
    port,
    paths: ["/surface"],
    health: "/surface/healthz",
    version: "0.3.0",
    uis: {
      notes: {
        displayName: "Notes",
        path: "/surface/notes",
        scopes_required: ["vault:*:read"],
        ...uiOverrides,
      },
    },
  };
}

function writeServices(entry: Record<string, unknown>): void {
  // Raw write (not writeManifest) so malformed-metadata tests can plant
  // values the validator would reject.
  writeFileSync(h.manifestPath, `${JSON.stringify({ services: [entry] }, null, 2)}\n`);
}

function fetcher() {
  return hubFetch(h.dir, {
    getDb: () => h.db,
    manifestPath: h.manifestPath,
    // Deterministic issuer: never read the developer box's real
    // ~/.parachute/expose-state.json — the per-request origin (REQ_ORIGIN)
    // is then both the resolved issuer and the minted Bearers' iss.
    loadExposeHubOrigin: () => undefined,
  });
}

// ===========================================================================
// The audience × caller matrix
// ===========================================================================

describe("audience gate matrix (H3)", () => {
  test("audience: public — anon, hub-user, Bearer, first-admin ALL pass", async () => {
    const upstream = startEchoUpstream();
    try {
      writeServices(surfaceEntry(upstream.port, { audience: "public" }));
      const f = fetcher();
      const { adminCookie, friendCookie } = await friendSession();
      const bearer = await mintBearer(["vault:default:read"]);

      const callers: Record<string, string>[] = [
        {},
        { cookie: friendCookie },
        { authorization: `Bearer ${bearer}` },
        { cookie: adminCookie },
      ];
      for (const headers of callers) {
        const res = await f(req("/surface/notes/index.html", { headers }), fakeServer("127.0.0.1"));
        expect(res?.status).toBe(200);
      }
    } finally {
      upstream.stop();
    }
  });

  test("audience: hub-users — anon 401 JSON (API) / 302 login (document); session + Bearer + admin pass", async () => {
    const upstream = startEchoUpstream();
    try {
      writeServices(surfaceEntry(upstream.port, { audience: "hub-users" }));
      const f = fetcher();
      const { adminCookie, friendCookie } = await friendSession();
      const bearer = await mintBearer(["vault:default:read", "vault:default:write"]);

      // anon, API-shaped → 401 JSON.
      const anonApi = await f(req("/surface/notes/api-ish"), fakeServer("127.0.0.1"));
      expect(anonApi?.status).toBe(401);
      expect(((await anonApi?.json()) as { error: string }).error).toBe("unauthenticated");

      // anon, document → 302 to /login with next=.
      const anonDoc = await f(
        req("/surface/notes/", { headers: { accept: "text/html" } }),
        fakeServer("127.0.0.1"),
      );
      expect(anonDoc?.status).toBe(302);
      expect(anonDoc?.headers.get("location")).toBe(
        `/login?next=${encodeURIComponent("/surface/notes/")}`,
      );

      // hub-user session passes.
      const asFriend = await f(
        req("/surface/notes/x", { headers: { cookie: friendCookie } }),
        fakeServer("127.0.0.1"),
      );
      expect(asFriend?.status).toBe(200);

      // Bearer with satisfying scopes passes (the PWA path).
      const asPwa = await f(
        req("/surface/notes/x", { headers: { authorization: `Bearer ${bearer}` } }),
        fakeServer("127.0.0.1"),
      );
      expect(asPwa?.status).toBe(200);

      // First-admin session passes (an admin is a hub user).
      const asAdmin = await f(
        req("/surface/notes/x", { headers: { cookie: adminCookie } }),
        fakeServer("127.0.0.1"),
      );
      expect(asAdmin?.status).toBe(200);
    } finally {
      upstream.stop();
    }
  });

  test("audience: hub-users — Bearer with NON-satisfying scopes → 403; garbage Bearer → 401", async () => {
    const upstream = startEchoUpstream();
    try {
      writeServices(surfaceEntry(upstream.port, { audience: "hub-users" }));
      const f = fetcher();
      await adminSession(); // a user must exist for sessions, not used here

      const wrongScope = await mintBearer(["scribe:admin"]);
      const denied = await f(
        req("/surface/notes/x", { headers: { authorization: `Bearer ${wrongScope}` } }),
        fakeServer("127.0.0.1"),
      );
      expect(denied?.status).toBe(403);
      expect(((await denied?.json()) as { error: string }).error).toBe("insufficient_scope");

      const garbage = await f(
        req("/surface/notes/x", { headers: { authorization: "Bearer not-a-jwt" } }),
        fakeServer("127.0.0.1"),
      );
      expect(garbage?.status).toBe(401);
    } finally {
      upstream.stop();
    }
  });

  test("audience: operator — only the first-admin session passes; friend 403; Bearer 401; anon 302/401", async () => {
    const upstream = startEchoUpstream();
    try {
      writeServices(surfaceEntry(upstream.port, { audience: "operator" }));
      const f = fetcher();
      const { adminCookie, friendCookie } = await friendSession();
      // Even a powerful bearer doesn't open an operator surface — the tier is
      // about the operator's interactive presence, not token authority.
      const bearer = await mintBearer(["vault:default:read"]);

      const asAdmin = await f(
        req("/surface/notes/x", { headers: { cookie: adminCookie } }),
        fakeServer("127.0.0.1"),
      );
      expect(asAdmin?.status).toBe(200);

      const asFriend = await f(
        req("/surface/notes/x", { headers: { cookie: friendCookie } }),
        fakeServer("127.0.0.1"),
      );
      expect(asFriend?.status).toBe(403);
      expect(((await asFriend?.json()) as { error: string }).error).toBe("not_admin");

      const asBearer = await f(
        req("/surface/notes/x", { headers: { authorization: `Bearer ${bearer}` } }),
        fakeServer("127.0.0.1"),
      );
      expect(asBearer?.status).toBe(401);

      const anonDoc = await f(
        req("/surface/notes/", { headers: { accept: "text/html" } }),
        fakeServer("127.0.0.1"),
      );
      expect(anonDoc?.status).toBe(302);

      const anonApi = await f(req("/surface/notes/x"), fakeServer("127.0.0.1"));
      expect(anonApi?.status).toBe(401);
    } finally {
      upstream.stop();
    }
  });

  test("absent audience defaults to hub-users (anon denied)", async () => {
    const upstream = startEchoUpstream();
    try {
      writeServices(surfaceEntry(upstream.port)); // no audience field
      const res = await fetcher()(req("/surface/notes/x"), fakeServer("127.0.0.1"));
      expect(res?.status).toBe(401);
    } finally {
      upstream.stop();
    }
  });

  test("legacy boolean public: true maps to 'public' (anon passes); public: false maps to the default (anon denied)", async () => {
    const upstream = startEchoUpstream();
    try {
      writeServices(surfaceEntry(upstream.port, { public: true }));
      const open = await fetcher()(req("/surface/notes/x"), fakeServer("127.0.0.1"));
      expect(open?.status).toBe(200);

      writeServices(surfaceEntry(upstream.port, { public: false }));
      const closed = await fetcher()(req("/surface/notes/x"), fakeServer("127.0.0.1"));
      expect(closed?.status).toBe(401);
    } finally {
      upstream.stop();
    }
  });

  test("fail-closed: malformed audience value drops the row (404 — never accidentally public)", async () => {
    const upstream = startEchoUpstream();
    try {
      writeServices(surfaceEntry(upstream.port, { audience: "everyone" }));
      // The validator rejects the row; the lenient read drops the whole
      // service entry, so the mount doesn't exist — 404, not an open door.
      const res = await fetcher()(req("/surface/notes/x"), fakeServer("127.0.0.1"));
      expect(res?.status).toBe(404);
    } finally {
      upstream.stop();
    }
  });

  test("module paths OUTSIDE any uis entry are NOT gated (module APIs keep their own auth)", async () => {
    const upstream = startEchoUpstream();
    try {
      writeServices(surfaceEntry(upstream.port, { audience: "operator" }));
      // /surface/healthz is on the module mount but under no uis path.
      const res = await fetcher()(req("/surface/healthz"), fakeServer("127.0.0.1"));
      expect(res?.status).toBe(200);
    } finally {
      upstream.stop();
    }
  });

  test("loopback-cloaked row: 404 cloak wins over the gate (no 401 route-existence leak)", async () => {
    const upstream = startEchoUpstream();
    try {
      writeServices({
        ...surfaceEntry(upstream.port, { audience: "hub-users" }),
        publicExposure: "loopback",
      });
      // Public-layer caller: the cloak must answer 404, not the gate's 401.
      const res = await fetcher()(
        req("/surface/notes/x", { headers: { "cf-ray": "1" } }),
        fakeServer("127.0.0.1"),
      );
      expect(res?.status).toBe(404);
    } finally {
      upstream.stop();
    }
  });

  test("gate runs BEFORE a WebSocket upgrade (anon upgrade on a hub-users surface → 401, no socket)", async () => {
    const upstream = startEchoUpstream();
    try {
      writeServices({
        ...surfaceEntry(upstream.port, { audience: "hub-users" }),
        websocket: true,
      });
      let upgradeCalls = 0;
      const spy = {
        requestIP: () => ({ address: "127.0.0.1" }),
        upgrade: () => {
          upgradeCalls++;
          return true;
        },
      };
      const res = await fetcher()(
        req("/surface/notes/ws", {
          headers: { upgrade: "websocket", connection: "Upgrade" },
        }),
        spy,
      );
      expect(res?.status).toBe(401);
      expect(upgradeCalls).toBe(0);

      // …and a session-holding caller upgrades.
      const cookie = await adminSession();
      const ok = await fetcher()(
        req("/surface/notes/ws", {
          headers: { upgrade: "websocket", connection: "Upgrade", cookie },
        }),
        spy,
      );
      expect(ok).toBeUndefined();
      expect(upgradeCalls).toBe(1);
    } finally {
      upstream.stop();
    }
  });
});

// ===========================================================================
// Units — scope matching + mount resolution
// ===========================================================================

describe("scopeMatchesPattern / scopesSatisfyRequirement", () => {
  test("wildcard segment matches any vault name", () => {
    expect(scopeMatchesPattern("vault:*:read", "vault:default:read")).toBe(true);
    expect(scopeMatchesPattern("vault:*:read", "vault:work:read")).toBe(true);
    expect(scopeMatchesPattern("vault:*:read", "vault:default:write")).toBe(false);
    expect(scopeMatchesPattern("vault:*:read", "scribe:default:read")).toBe(false);
  });

  test("broad unnamed form satisfies the wildcard pattern (wider-than-required)", () => {
    expect(scopeMatchesPattern("vault:*:read", "vault:read")).toBe(true);
    expect(scopeMatchesPattern("vault:*:write", "vault:read")).toBe(false);
  });

  test("exact patterns require exact scopes", () => {
    expect(scopeMatchesPattern("surface:admin", "surface:admin")).toBe(true);
    expect(scopeMatchesPattern("surface:admin", "surface:read")).toBe(false);
  });

  test("EVERY required pattern must be satisfied; empty requirement admits any bearer", () => {
    expect(
      scopesSatisfyRequirement(
        ["vault:*:read", "vault:*:write"],
        ["vault:default:read", "vault:default:write"],
      ),
    ).toBe(true);
    expect(
      scopesSatisfyRequirement(["vault:*:read", "vault:*:write"], ["vault:default:read"]),
    ).toBe(false);
    expect(scopesSatisfyRequirement([], ["anything:at-all"])).toBe(true);
    expect(scopesSatisfyRequirement(undefined, [])).toBe(true);
  });
});

describe("resolveUiMount", () => {
  const entries: ServiceEntry[] = [
    {
      name: "parachute-surface",
      port: 1946,
      paths: ["/surface"],
      health: "/surface/healthz",
      version: "0.3.0",
      uis: {
        notes: { displayName: "Notes", path: "/surface/notes", audience: "hub-users" },
        blog: { displayName: "Blog", path: "/surface/blog", audience: "public" },
        // Nested mount — longest prefix must win.
        "blog-admin": {
          displayName: "Blog Admin",
          path: "/surface/blog/admin",
          audience: "operator",
        },
      },
    },
  ];

  test("resolves the sub-unit by longest prefix; default audience applied", () => {
    expect(resolveUiMount(entries, "/surface/notes/sw.js")?.uiKey).toBe("notes");
    expect(resolveUiMount(entries, "/surface/blog/post-1")?.audience).toBe("public");
    expect(resolveUiMount(entries, "/surface/blog/admin/settings")?.uiKey).toBe("blog-admin");
    expect(resolveUiMount(entries, "/surface/blog/admin/settings")?.audience).toBe("operator");
  });

  test("exact mount path matches; sibling paths do not", () => {
    expect(resolveUiMount(entries, "/surface/notes")?.uiKey).toBe("notes");
    expect(resolveUiMount(entries, "/surface/notesy")).toBeUndefined();
    expect(resolveUiMount(entries, "/surface/healthz")).toBeUndefined();
    expect(resolveUiMount(entries, "/elsewhere")).toBeUndefined();
  });

  // writeManifest round-trip: the validator preserves audience +
  // scopes_required (it used to drop unknown uis fields on rewrite).
  test("validated round-trip preserves audience + scopes_required", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-uis-roundtrip-"));
    const p = join(dir, "services.json");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-surface",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
              version: "0.3.0",
              uis: {
                blog: {
                  displayName: "Blog",
                  path: "/surface/blog",
                  audience: "public",
                  scopes_required: ["vault:*:read"],
                },
              },
            },
          ],
        },
        p,
      );
      const raw = JSON.parse(require("node:fs").readFileSync(p, "utf8") as string) as {
        services: { uis: Record<string, { audience?: string; scopes_required?: string[] }> }[];
      };
      expect(raw.services[0]?.uis.blog?.audience).toBe("public");
      expect(raw.services[0]?.uis.blog?.scopes_required).toEqual(["vault:*:read"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// H5 — chrome-strip rides the gate
// ===========================================================================

describe("chrome strip × audience (H5)", () => {
  function startHtmlUpstream(): { port: number; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<html><head></head><body><h1>surface page</h1></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    return { port: server.port as number, stop: () => server.stop(true) };
  }

  test("audience: public → NO injected chrome on the HTML response", async () => {
    const upstream = startHtmlUpstream();
    try {
      writeServices(surfaceEntry(upstream.port, { audience: "public" }));
      const res = await fetcher()(
        req("/surface/notes/", { headers: { accept: "text/html" } }),
        fakeServer("127.0.0.1"),
      );
      expect(res?.status).toBe(200);
      const html = await res?.text();
      expect(html).toContain("surface page"); // upstream body intact
      expect(html).not.toContain("pc-chrome"); // identity chrome absent
    } finally {
      upstream.stop();
    }
  });

  test("audience: hub-users (session) → chrome injected as before", async () => {
    const upstream = startHtmlUpstream();
    try {
      // Mount OUTSIDE the static /surface/notes/ opt-out so the audience
      // mechanism (not the legacy hardcoded prefix) is what's exercised.
      writeServices({
        name: "parachute-surface",
        port: upstream.port,
        paths: ["/surface"],
        health: "/surface/healthz",
        version: "0.3.0",
        uis: {
          tasks: { displayName: "Tasks", path: "/surface/tasks", audience: "hub-users" },
        },
      });
      const cookie = await adminSession();
      const res = await fetcher()(
        req("/surface/tasks/", { headers: { accept: "text/html", cookie } }),
        fakeServer("127.0.0.1"),
      );
      expect(res?.status).toBe(200);
      const html = await res?.text();
      expect(html).toContain("pc-chrome"); // identity chrome present
      expect(html).toContain("surface page");
    } finally {
      upstream.stop();
    }
  });

  test("a PUBLIC mount outside the static opt-out list also strips chrome (the generalization)", async () => {
    const upstream = startHtmlUpstream();
    try {
      writeServices({
        name: "parachute-surface",
        port: upstream.port,
        paths: ["/surface"],
        health: "/surface/healthz",
        version: "0.3.0",
        uis: {
          blog: { displayName: "Blog", path: "/surface/blog", audience: "public" },
        },
      });
      const res = await fetcher()(
        req("/surface/blog/post-1", { headers: { accept: "text/html" } }),
        fakeServer("127.0.0.1"),
      );
      expect(res?.status).toBe(200);
      const html = await res?.text();
      expect(html).not.toContain("pc-chrome");
    } finally {
      upstream.stop();
    }
  });
});
