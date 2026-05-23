/**
 * `GET /api/hub` — hub version + uptime + install-source surface for the
 * admin SPA's version badge.
 *
 * Tests assert the contract:
 *   - 405 on non-GET (matches the shape of other /api/* read endpoints).
 *   - 401/403 on missing or under-scoped bearer (host:admin required).
 *   - Happy path returns the expected shape + uptime increments between
 *     calls.
 *   - PARACHUTE_HOME=/parachute (the Render Blueprint pin) overrides
 *     `source` to "container".
 *   - PARACHUTE_BUILD_TIME passes through as `container_build_time`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type HubStatusResponse, handleApiHub } from "../api-hub.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { mintOperatorToken } from "../operator-token.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-hub-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ISSUER = "http://127.0.0.1:1939";

// `hubSrcDir` defaults to `dirname(import.meta.url)` of api-hub.ts — but in
// tests we drive it explicitly so test-side test-double dirs don't accidentally
// pick up the real package.json. Point it at this file's dir (under __tests__/)
// so the climb-to-package.json loop walks up to the repo root and finds the
// real hub package.json.
const HUB_SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function bootstrap(
  dir: string,
): Promise<{ db: ReturnType<typeof openHubDb>; userId: string }> {
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const u = await createUser(db, "owner", "pw");
  return { db, userId: u.id };
}

function getRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/hub", {
    method: "GET",
    headers,
  });
}

describe("GET /api/hub (hub version + uptime badge surface)", () => {
  test("405 on non-GET", async () => {
    const h = makeHarness();
    try {
      const { db } = await bootstrap(h.dir);
      try {
        const req = new Request("http://localhost/api/hub", { method: "POST" });
        const resp = await handleApiHub(req, { db, issuer: ISSUER });
        expect(resp.status).toBe(405);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("401 when no Authorization header", async () => {
    const h = makeHarness();
    try {
      const { db } = await bootstrap(h.dir);
      try {
        const resp = await handleApiHub(getRequest(), { db, issuer: ISSUER });
        expect(resp.status).toBe(401);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("403 when bearer scope lacks parachute:host:admin", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const narrow = await signAccessToken(db, {
          sub: userId,
          // Adjacent host scope but NOT host:admin — host:auth is the
          // tokens-registry scope, not the admin one. Confirms the gate
          // checks the exact scope, not any host:* membership.
          scopes: ["parachute:host:auth"],
          audience: "hub",
          clientId: "parachute-hub",
          issuer: ISSUER,
          ttlSeconds: 3600,
        });
        const resp = await handleApiHub(getRequest({ authorization: `Bearer ${narrow.token}` }), {
          db,
          issuer: ISSUER,
        });
        expect(resp.status).toBe(403);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("happy path: returns version + started_at + uptime_ms + source", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const startedAt = new Date(Date.now() - 5000); // started 5s ago
        const resp = await handleApiHub(getRequest({ authorization: `Bearer ${op.token}` }), {
          db,
          issuer: ISSUER,
          hubSrcDir: HUB_SRC_DIR,
          startedAt,
          // Override env so we're not at the mercy of the host's
          // PARACHUTE_HOME (or PARACHUTE_BUILD_TIME) when the test runs.
          env: {},
        });
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as HubStatusResponse;
        // Version pulled from the real hub package.json — assert SemVer
        // shape rather than pinning a specific number (otherwise this test
        // breaks on every rc bump).
        expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(body.started_at).toBe(startedAt.toISOString());
        expect(body.uptime_ms).toBeGreaterThanOrEqual(5000);
        // hubSrcDir points at the real repo's src/, so install-source
        // classification will report bun-linked OR npm OR unknown — never
        // "container" because we cleared PARACHUTE_HOME.
        expect(body.source).not.toBe("container");
        expect(body.container_build_time).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("uptime_ms increments between calls", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const startedAt = new Date("2026-05-23T14:00:00.000Z");
        // Drive "now" so the assertion isn't a flaky timing test.
        const first = await handleApiHub(getRequest({ authorization: `Bearer ${op.token}` }), {
          db,
          issuer: ISSUER,
          hubSrcDir: HUB_SRC_DIR,
          startedAt,
          now: () => new Date("2026-05-23T14:00:05.000Z"),
          env: {},
        });
        const second = await handleApiHub(getRequest({ authorization: `Bearer ${op.token}` }), {
          db,
          issuer: ISSUER,
          hubSrcDir: HUB_SRC_DIR,
          startedAt,
          now: () => new Date("2026-05-23T14:00:08.000Z"),
          env: {},
        });
        const firstBody = (await first.json()) as HubStatusResponse;
        const secondBody = (await second.json()) as HubStatusResponse;
        expect(firstBody.uptime_ms).toBe(5000);
        expect(secondBody.uptime_ms).toBe(8000);
        expect(secondBody.uptime_ms).toBeGreaterThan(firstBody.uptime_ms);
        // started_at stays stable across calls (captured once at process
        // start, not per-request).
        expect(secondBody.started_at).toBe(firstBody.started_at);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("PARACHUTE_HOME=/parachute overrides source to 'container'", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiHub(getRequest({ authorization: `Bearer ${op.token}` }), {
          db,
          issuer: ISSUER,
          hubSrcDir: HUB_SRC_DIR,
          env: { PARACHUTE_HOME: "/parachute" },
        });
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as HubStatusResponse;
        expect(body.source).toBe("container");
        // bun_linked_path is suppressed under container source — operators
        // on Render don't have a meaningful "checkout path" to surface.
        expect(body.bun_linked_path).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("PARACHUTE_BUILD_TIME passes through as container_build_time", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiHub(getRequest({ authorization: `Bearer ${op.token}` }), {
          db,
          issuer: ISSUER,
          hubSrcDir: HUB_SRC_DIR,
          env: {
            PARACHUTE_HOME: "/parachute",
            PARACHUTE_BUILD_TIME: "2026-05-23T14:21:00.000Z",
          },
        });
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as HubStatusResponse;
        expect(body.container_build_time).toBe("2026-05-23T14:21:00.000Z");
        expect(body.source).toBe("container");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
