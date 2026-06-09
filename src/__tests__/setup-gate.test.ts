/**
 * Pre-admin setup gate (hub#258). When the hub boots with no admin row
 * (the fresh container case), admin-onboarding-coupled surfaces 503
 * with `{error: "setup_required", setup_url: "/admin/setup"}` so
 * callers can branch on the shape rather than scrape an HTML page.
 *
 * Gated routes (require an admin to be useful): `/login`, `/logout`,
 * `/admin/*` (except `/admin/setup`), `/api/*`.
 *
 * Routes that pass through (platform health, public discovery, OAuth
 * third-party flows, content proxies, the setup page itself):
 *
 *   /health, /, /hub.html, /.well-known/*, /admin/setup,
 *   /oauth/*, /vault/*, /<service>/*
 *
 * Once an admin row exists, the gate is a no-op — the rest of dispatch
 * runs as normal. The `/admin/setup` route 301s to /login at that
 * point so a stale bookmark still lands somewhere.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { writeManifest } from "../services-manifest.ts";
import { createUser } from "../users.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "setup-gate-"));
  // Minimal hub.html so the `/` route resolves without a 404.
  writeFileSync(join(dir, "hub.html"), "<html>discovery</html>");
  writeManifest({ services: [] }, join(dir, "services.json"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:1939${path}`, init);
}

describe("setup gate (no admin yet)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  test("503s gated admin/api routes with setup_required body", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      // `/api/me` is a representative gated route — admin SPA bootstrap
      // can't function without an operator identity behind it.
      const res = await hubFetch(h.dir, { getDb: () => db })(req("/api/me"));
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("setup_required");
      expect(body.setup_url).toBe("/admin/setup");
      expect(typeof body.error_description).toBe("string");
    } finally {
      db.close();
    }
  });

  test("503s /login when no admin exists", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = await hubFetch(h.dir, { getDb: () => db })(req("/login"));
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("setup_required");
    } finally {
      db.close();
    }
  });

  test("/oauth/register passes through the gate (third-party DCR doesn't need admin)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = await hubFetch(h.dir, {
        getDb: () => db,
        issuer: "https://hub.example",
      })(
        req("/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
        }),
      );
      // Either 201 (registered) or 4xx (validation rejection) — the
      // point is NOT 503-setup_required. OAuth surfaces operate
      // independently of the admin-onboarding state.
      expect(res.status).not.toBe(503);
    } finally {
      db.close();
    }
  });

  test("/health passes through the gate", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = await hubFetch(h.dir, { getDb: () => db })(req("/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
    } finally {
      db.close();
    }
  });

  test("/.well-known/jwks.json passes through the gate", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = await hubFetch(h.dir, { getDb: () => db })(req("/.well-known/jwks.json"));
      // Empty keys array is the no-rotation-yet shape, but the route is
      // reachable — not gated to 503.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { keys: unknown[] };
      expect(Array.isArray(body.keys)).toBe(true);
    } finally {
      db.close();
    }
  });

  // Bug 2 (rc.5 → rc.6) regression: on a fresh hub, GET `/` should
  // funnel straight to the wizard rather than render the static
  // portal — the operator otherwise has to manually navigate to
  // `/admin/setup`. The portal pre-setup carries no usable signal
  // (no installed services to discover, no admin to sign in as).
  test("/ 302s to /admin/setup when no admin exists (fresh-hub funnel)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = await hubFetch(h.dir, { getDb: () => db })(req("/"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/admin/setup");
    } finally {
      db.close();
    }
  });

  test("/hub.html 302s to /admin/setup when no admin exists", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = await hubFetch(h.dir, { getDb: () => db })(req("/hub.html"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/admin/setup");
    } finally {
      db.close();
    }
  });

  test("/admin/setup renders the wizard (account step) when no admin exists", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = await hubFetch(h.dir, { getDb: () => db })(req("/admin/setup"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      // Spot-check the wizard is rendering its account-step form (hub#259
      // replaced the env-var-only placeholder with a real wizard, but the
      // env-var path is still surfaced as the "alt-path" disclosure).
      expect(html).toContain('action="/admin/setup/account"');
      expect(html).toContain("PARACHUTE_INITIAL_ADMIN_USERNAME");
      expect(html).toContain("PARACHUTE_INITIAL_ADMIN_PASSWORD");
    } finally {
      db.close();
    }
  });
});

describe("setup gate (admin exists)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  test("no-ops once an admin row exists — operator routes resume normal dispatch", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      // /oauth/token rejects GET with 405 in normal dispatch (it's a
      // POST-only endpoint). If the gate were still firing this would
      // come back 503; the 405 confirms regular dispatch resumed.
      const res = await hubFetch(h.dir, { getDb: () => db })(
        req("/oauth/token", { method: "GET" }),
      );
      expect(res.status).toBe(405);
    } finally {
      db.close();
    }
  });

  test("/admin/setup resumes at the vault step when admin exists but vault doesn't (hub#259)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      const res = await hubFetch(h.dir, {
        getDb: () => db,
        manifestPath: join(h.dir, "services.json"),
      })(req("/admin/setup"));
      // With admin in place but no vault entry in services.json, the
      // wizard's GET resumes at step 3 — the vault-name form — rather
      // than 301-ing to /login. The 301-to-/login fires only once BOTH
      // admin and vault are in place; that case is exercised in the
      // setup-wizard suite where the manifest is seeded.
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('action="/admin/setup/vault"');
    } finally {
      db.close();
    }
  });

  // Issue 2 (first-boot-path hardening): the auto-redirect on `/` and
  // `/hub.html` fires whenever the wizard still has work to do — not just
  // when the admin row is missing. Pre-fix, an env-seeded admin with no
  // vault landed on the static discovery portal and had to hand-find
  // `/admin/modules` + `/admin/vaults`. Post-fix, `/` funnels them
  // straight to the wizard's vault step.
  test("/ 302s to /admin/setup when env-seeded admin has no vault (Issue 2)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      // Simulate env-seed: admin row exists, services.json is empty.
      await createUser(db, "env-seeded-admin", "pw");
      const res = await hubFetch(h.dir, {
        getDb: () => db,
        manifestPath: join(h.dir, "services.json"),
      })(req("/"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/admin/setup");
    } finally {
      db.close();
    }
  });

  test("/hub.html 302s to /admin/setup when env-seeded admin has no vault (Issue 2)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "env-seeded-admin", "pw");
      const res = await hubFetch(h.dir, {
        getDb: () => db,
        manifestPath: join(h.dir, "services.json"),
      })(req("/hub.html"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/admin/setup");
    } finally {
      db.close();
    }
  });

  test("/ redirects to the admin shell (NOT the setup funnel) when admin + vault both exist", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        join(h.dir, "services.json"),
      );
      const handler = hubFetch(h.dir, {
        getDb: () => db,
        manifestPath: join(h.dir, "services.json"),
      });
      // Setup complete: bare `/` lands on the admin shell (302 → /admin), NOT
      // the wizard funnel (302 → /admin/setup) and NOT the old 200-discovery.
      // The discovery content moved into the shell's Home overview (R1).
      const res = await handler(req("/"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/admin");
      // The discovery page itself still lives at /hub.html.
      const hubHtmlRes = await handler(req("/hub.html"));
      expect(hubHtmlRes.status).toBe(200);
      expect(hubHtmlRes.headers.get("content-type")).toContain("text/html");
    } finally {
      db.close();
    }
  });

  test("wizard at /admin/setup with env-seeded admin + no vault renders vault step (Issue 2)", async () => {
    // Mirror the wizard's resume-at-vault-step shape for the env-seed
    // path. Same as the existing test above, but explicitly named to
    // document the Issue 2 expectation: the wizard handles env-seeded
    // admins correctly.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "env-seeded-admin", "pw");
      const res = await hubFetch(h.dir, {
        getDb: () => db,
        manifestPath: join(h.dir, "services.json"),
      })(req("/admin/setup"));
      expect(res.status).toBe(200);
      const html = await res.text();
      // Vault step is rendered (the form action gives it away).
      expect(html).toContain('action="/admin/setup/vault"');
      // Account step is NOT rendered — no username field, no bootstrap
      // token field.
      expect(html).not.toContain('name="bootstrap_token"');
      expect(html).not.toContain('name="password_confirm"');
    } finally {
      db.close();
    }
  });
});
