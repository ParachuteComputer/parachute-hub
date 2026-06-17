/**
 * Tests for the GENERIC per-module config-UI session→bearer mint endpoint
 * (`GET /admin/module-token/<short>`, 2026-06-09 modular-UI architecture P3).
 * Mirrors `admin-agent-token.test.ts` shape (single bare audience per
 * module). Covers:
 *   - 401 when no admin session cookie is present.
 *   - 401 when the cookie names a deleted session.
 *   - 405 on POST.
 *   - 200 + JWT carrying `aud: "<short>"` and `<short>:admin` for known modules
 *     (scribe / runner / surface).
 *   - 400 for `vault` (per-instance — points at /admin/vault-admin-token/<name>).
 *   - 404 for an unknown short.
 *   - First-admin gate: 403 for a signed-in non-first-admin (friend).
 *   - Self-registration gate (boundary C5): a genuinely third-party module
 *     with a services.json row + readable module.json mints; a registered row
 *     WITHOUT a readable manifest 404s.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODULE_TOKEN_TTL_SECONDS, handleModuleToken } from "../admin-module-token.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import type { ServiceEntry } from "../services-manifest.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession, deleteSession } from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-module-token-"));
  const db = openHubDb(hubDbPath(dir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

async function withSession(): Promise<{ cookie: string; userId: string }> {
  const user = await createUser(harness.db, "operator", "hunter2");
  const session = createSession(harness.db, { userId: user.id });
  const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
  return { cookie, userId: user.id };
}

async function withAdminAndFriend(): Promise<{ friendCookie: string }> {
  const admin = await createUser(harness.db, "admin", "admin-passphrase");
  const friend = await createUser(harness.db, "alice", "alice-passphrase", { allowMulti: true });
  createSession(harness.db, { userId: admin.id });
  const friendSession = createSession(harness.db, { userId: friend.id });
  return {
    friendCookie: buildSessionCookie(friendSession.id, Math.floor(SESSION_TTL_MS / 1000)),
  };
}

function urlFor(short: string): string {
  return `${ISSUER}/admin/module-token/${short}`;
}

/** Default deps — no services.json rows (registry-only resolution). */
function depsWith(services: ServiceEntry[] = []): {
  db: Database;
  issuer: string;
  readServices: () => readonly ServiceEntry[];
} {
  return { db: harness.db, issuer: ISSUER, readServices: () => services };
}

describe("handleModuleToken", () => {
  test("401 when no session cookie is present", async () => {
    const req = new Request(urlFor("scribe"));
    const res = await handleModuleToken(req, "scribe", depsWith());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("401 when the cookie names a deleted session", async () => {
    const { cookie } = await withSession();
    const sid = cookie.match(/parachute_hub_session=([^;]+)/)?.[1] ?? "";
    deleteSession(harness.db, sid);
    const req = new Request(urlFor("scribe"), { headers: { cookie } });
    const res = await handleModuleToken(req, "scribe", depsWith());
    expect(res.status).toBe(401);
  });

  test("405 on POST", async () => {
    const { cookie } = await withSession();
    const req = new Request(urlFor("scribe"), { method: "POST", headers: { cookie } });
    const res = await handleModuleToken(req, "scribe", depsWith());
    expect(res.status).toBe(405);
  });

  // The known single-audience modules the generic mint serves. Each gets
  // `<short>:admin` with `aud: <short>`.
  for (const short of ["scribe", "runner", "surface", "agent"]) {
    test(`200 mints a JWT carrying aud:${short} + ${short}:admin`, async () => {
      const { cookie, userId } = await withSession();
      rotateSigningKey(harness.db);
      const req = new Request(urlFor(short), { headers: { cookie } });
      const res = await handleModuleToken(req, short, depsWith());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");

      const body = (await res.json()) as { token: string; expires_at: string; scopes: string[] };
      expect(body.scopes).toEqual([`${short}:admin`]);
      expect(body.token.length).toBeGreaterThan(20);

      const expMs = new Date(body.expires_at).getTime();
      const skew = expMs - Date.now();
      expect(skew).toBeGreaterThan((MODULE_TOKEN_TTL_SECONDS - 30) * 1000);
      expect(skew).toBeLessThan((MODULE_TOKEN_TTL_SECONDS + 30) * 1000);

      const validated = await validateAccessToken(harness.db, body.token, ISSUER);
      expect(validated.payload.sub).toBe(userId);
      expect(validated.payload.iss).toBe(ISSUER);
      // Bare service audience — modules validate `aud === <short>`.
      expect(validated.payload.aud).toBe(short);
      const scopeClaim = (validated.payload as { scope?: string }).scope ?? "";
      expect(scopeClaim.split(/\s+/)).toContain(`${short}:admin`);
    });
  }

  test("400 use_vault_admin_token for vault (per-instance)", async () => {
    const { cookie } = await withSession();
    const req = new Request(urlFor("vault"), { headers: { cookie } });
    const res = await handleModuleToken(req, "vault", depsWith());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("use_vault_admin_token");
  });

  test("404 for an unknown short", async () => {
    const { cookie } = await withSession();
    const req = new Request(urlFor("totally-made-up"), { headers: { cookie } });
    const res = await handleModuleToken(req, "totally-made-up", depsWith());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("400 for an invalid identifier", async () => {
    const { cookie } = await withSession();
    const req = new Request(`${ISSUER}/admin/module-token/Not%20Valid`, { headers: { cookie } });
    const res = await handleModuleToken(req, "Not Valid", depsWith());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("403 not_admin when a signed-in non-first-admin (friend) hits the endpoint", async () => {
    const { friendCookie } = await withAdminAndFriend();
    rotateSigningKey(harness.db);
    const req = new Request(urlFor("scribe"), { headers: { cookie: friendCookie } });
    const res = await handleModuleToken(req, "scribe", depsWith());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_admin");
  });

  // -------------------------------------------------------------------------
  // Self-registration gate (boundary C5). A genuinely third-party module —
  // NOT in KNOWN_MODULES / FIRST_PARTY_FALLBACKS — mints when its
  // services.json row's installDir carries a readable module.json. This is
  // the charter's third-party test: zero hub code changes to get the mint.
  // -------------------------------------------------------------------------

  /** Write a real `.parachute/module.json` into a temp install dir. */
  function writeManifestDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "phub-module-token-installdir-"));
    mkdirSync(join(dir, ".parachute"), { recursive: true });
    writeFileSync(
      join(dir, ".parachute", "module.json"),
      JSON.stringify({
        name,
        manifestName: name,
        port: 1947,
        paths: [`/${name}`],
        health: `/${name}/health`,
      }),
    );
    return dir;
  }

  test("200 mints for a self-registered third-party module (row + readable module.json)", async () => {
    const { cookie, userId } = await withSession();
    rotateSigningKey(harness.db);
    const installDir = writeManifestDir("widgets");
    try {
      const services: ServiceEntry[] = [
        {
          name: "widgets",
          port: 1947,
          paths: ["/widgets"],
          health: "/widgets/health",
          version: "1.0.0",
          installDir,
        },
      ];
      const req = new Request(urlFor("widgets"), { headers: { cookie } });
      const res = await handleModuleToken(req, "widgets", depsWith(services));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; scopes: string[] };
      expect(body.scopes).toEqual(["widgets:admin"]);
      const validated = await validateAccessToken(harness.db, body.token, ISSUER);
      expect(validated.payload.sub).toBe(userId);
      expect(validated.payload.aud).toBe("widgets");
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  test("404 for a registered row whose installDir has NO readable module.json", async () => {
    const { cookie } = await withSession();
    rotateSigningKey(harness.db);
    const emptyDir = mkdtempSync(join(tmpdir(), "phub-module-token-nomanifest-"));
    try {
      const services: ServiceEntry[] = [
        {
          name: "widgets",
          port: 1947,
          paths: ["/widgets"],
          health: "/widgets/health",
          version: "1.0.0",
          installDir: emptyDir,
        },
      ];
      const req = new Request(urlFor("widgets"), { headers: { cookie } });
      const res = await handleModuleToken(req, "widgets", depsWith(services));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("404 for a registered row with no installDir at all", async () => {
    const { cookie } = await withSession();
    rotateSigningKey(harness.db);
    const services: ServiceEntry[] = [
      { name: "widgets", port: 1947, paths: ["/widgets"], health: "/widgets/health", version: "1" },
    ];
    const req = new Request(urlFor("widgets"), { headers: { cookie } });
    const res = await handleModuleToken(req, "widgets", depsWith(services));
    expect(res.status).toBe(404);
  });

  test("vault still 400-redirects even when a vault row is registered", async () => {
    const { cookie } = await withSession();
    const services: ServiceEntry[] = [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.5.0",
        installDir: "/tmp/nope",
      },
    ];
    const req = new Request(urlFor("vault"), { headers: { cookie } });
    const res = await handleModuleToken(req, "vault", depsWith(services));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("use_vault_admin_token");
  });

  test("first-party row resolves through the manifest-name map (parachute-agent ↔ agent)", async () => {
    const { cookie } = await withSession();
    rotateSigningKey(harness.db);
    const installDir = writeManifestDir("agent");
    try {
      const services: ServiceEntry[] = [
        {
          name: "parachute-agent",
          port: 1941,
          paths: ["/agent"],
          health: "/health",
          version: "0.1.0",
          installDir,
        },
      ];
      const req = new Request(urlFor("agent"), { headers: { cookie } });
      const res = await handleModuleToken(req, "agent", depsWith(services));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { scopes: string[] };
      expect(body.scopes).toEqual(["agent:admin"]);
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  test("a legacy parachute-channel row still resolves to short `agent` (rename back-compat)", async () => {
    // Un-upgraded operators carry a `parachute-channel` services.json row;
    // LEGACY_MANIFEST_ALIASES maps it to short `agent` so the agent config UI
    // can still mint its admin Bearer until the daemon re-registers.
    const { cookie } = await withSession();
    rotateSigningKey(harness.db);
    const installDir = writeManifestDir("agent");
    try {
      const services: ServiceEntry[] = [
        {
          name: "parachute-channel",
          port: 1941,
          paths: ["/agent"],
          health: "/health",
          version: "0.1.0",
          installDir,
        },
      ];
      const req = new Request(urlFor("agent"), { headers: { cookie } });
      const res = await handleModuleToken(req, "agent", depsWith(services));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { scopes: string[] };
      expect(body.scopes).toEqual(["agent:admin"]);
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });
});
