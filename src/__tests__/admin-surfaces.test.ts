import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeAdminSurfaces } from "../admin-surfaces.ts";
import { isSurfaceRegistered, repoDirFor } from "../git-registry.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "http://127.0.0.1:1939";

interface Harness {
  gitRoot: string;
  db: ReturnType<typeof openHubDb>;
  userId: string;
  cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "phub-adminsurf-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const u = await createUser(db, "owner", "pw");
  return {
    gitRoot: join(dir, "git"),
    db,
    userId: u.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function mint(h: Harness, scopes: string[]): Promise<string> {
  const { token } = await signAccessToken(h.db, {
    sub: h.userId,
    scopes,
    audience: "operator",
    clientId: "test-operator",
    issuer: ISSUER,
  });
  return token;
}

function deps(h: Harness) {
  return { db: h.db, gitRoot: h.gitRoot, issuer: ISSUER, knownIssuers: [ISSUER] };
}

function req(method: string, headers?: Record<string, string>, body?: unknown): Request {
  return new Request("http://127.0.0.1/admin/surfaces", {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("routeAdminSurfaces — routing", () => {
  test("returns null for a non-/admin/surfaces path", async () => {
    const h = await makeHarness();
    try {
      const res = await routeAdminSurfaces(new Request("http://127.0.0.1/admin/other"), deps(h));
      expect(res).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("405 on an unsupported method", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["parachute:host:admin"]);
      const res = await routeAdminSurfaces(
        req("DELETE", { authorization: `Bearer ${token}` }),
        deps(h),
      );
      expect(res?.status).toBe(405);
    } finally {
      h.cleanup();
    }
  });
});

describe("routeAdminSurfaces — auth", () => {
  test("401 without a bearer", async () => {
    const h = await makeHarness();
    try {
      const res = await routeAdminSurfaces(req("POST", {}, { name: "foo" }), deps(h));
      expect(res?.status).toBe(401);
    } finally {
      h.cleanup();
    }
  });

  test("403 when the token lacks parachute:host:admin", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["surface:foo:write"]);
      const res = await routeAdminSurfaces(
        req("POST", { authorization: `Bearer ${token}` }, { name: "foo" }),
        deps(h),
      );
      expect(res?.status).toBe(403);
      // No provisioning happened on a rejected auth.
      expect(existsSync(repoDirFor(h.gitRoot, "foo"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("401 on a garbage token", async () => {
    const h = await makeHarness();
    try {
      const res = await routeAdminSurfaces(
        req("POST", { authorization: "Bearer not-a-jwt" }, { name: "foo" }),
        deps(h),
      );
      expect(res?.status).toBe(401);
    } finally {
      h.cleanup();
    }
  });
});

describe("routeAdminSurfaces — register + list", () => {
  test("POST registers a surface (provisions the repo + returns the entry)", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["parachute:host:admin"]);
      const res = await routeAdminSurfaces(
        req(
          "POST",
          { authorization: `Bearer ${token}`, "content-type": "application/json" },
          { name: "brain", mount: "/surface/brain", mode: "prod" },
        ),
        deps(h),
      );
      expect(res?.status).toBe(200);
      const body = (await res?.json()) as {
        ok: boolean;
        surface: { name: string; mount?: string };
      };
      expect(body.ok).toBe(true);
      expect(body.surface.name).toBe("brain");
      expect(body.surface.mount).toBe("/surface/brain");
      expect(isSurfaceRegistered(h.gitRoot, "brain")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("POST with a missing name → 400", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["parachute:host:admin"]);
      const res = await routeAdminSurfaces(
        req("POST", { authorization: `Bearer ${token}` }, { mount: "/surface/x" }),
        deps(h),
      );
      expect(res?.status).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  test("POST with an invalid name → 400 (no repo provisioned)", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["parachute:host:admin"]);
      const res = await routeAdminSurfaces(
        req("POST", { authorization: `Bearer ${token}` }, { name: "a/b" }),
        deps(h),
      );
      expect(res?.status).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  test("GET lists registered surfaces", async () => {
    const h = await makeHarness();
    try {
      const token = await mint(h, ["parachute:host:admin"]);
      await routeAdminSurfaces(
        req("POST", { authorization: `Bearer ${token}` }, { name: "alpha" }),
        deps(h),
      );
      await routeAdminSurfaces(
        req("POST", { authorization: `Bearer ${token}` }, { name: "zeta" }),
        deps(h),
      );
      const res = await routeAdminSurfaces(
        new Request("http://127.0.0.1/admin/surfaces", {
          headers: { authorization: `Bearer ${token}` },
        }),
        deps(h),
      );
      expect(res?.status).toBe(200);
      const body = (await res?.json()) as { surfaces: Array<{ name: string }> };
      expect(body.surfaces.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    } finally {
      h.cleanup();
    }
  });
});
