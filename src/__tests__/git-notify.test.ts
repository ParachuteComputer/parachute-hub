import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifySurfacePushed } from "../git-notify.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";

const ISSUER = "http://127.0.0.1:1939";

interface Harness {
  db: ReturnType<typeof openHubDb>;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-notify-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fetch spy that records the last call and returns a canned response. */
function fetchSpy(status = 200, body = '{"ok":true}') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("notifySurfacePushed", () => {
  test("no surface module installed → no-op, no fetch", async () => {
    const h = makeHarness();
    const spy = fetchSpy();
    try {
      const out = await notifySurfacePushed("brain", {
        db: h.db,
        issuer: ISSUER,
        resolveModuleOrigin: () => null,
        cloneBaseOrigin: ISSUER,
        fetchImpl: spy.impl,
        log: { warn() {}, info() {} },
      });
      expect(out.notified).toBe(false);
      expect(out.reason).toBe("surface-module-not-installed");
      expect(spy.calls.length).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("posts to /surface/api/git-pushed with a surface:admin bearer + surface:<name>:read pull token", async () => {
    const h = makeHarness();
    const spy = fetchSpy();
    try {
      const out = await notifySurfacePushed("brain", {
        db: h.db,
        issuer: ISSUER,
        resolveModuleOrigin: (short) => (short === "surface" ? "http://127.0.0.1:1946" : null),
        cloneBaseOrigin: ISSUER,
        fetchImpl: spy.impl,
        log: { warn() {}, info() {} },
      });
      expect(out.notified).toBe(true);
      expect(spy.calls.length).toBe(1);

      const call = spy.calls[0]!;
      expect(call.url).toBe("http://127.0.0.1:1946/surface/api/git-pushed");
      expect(call.init.method).toBe("POST");

      const headers = new Headers(call.init.headers as Record<string, string>);
      const auth = headers.get("authorization") ?? "";
      expect(auth.startsWith("Bearer ")).toBe(true);

      // notify-auth bearer validates as surface:admin, aud "surface".
      const notifyTok = auth.slice("Bearer ".length);
      const notifyClaims = await validateAccessToken(h.db, notifyTok, [ISSUER]);
      expect((notifyClaims.payload as { scope?: string }).scope).toBe("surface:admin");
      expect(notifyClaims.payload.aud).toBe("surface");

      // Body carries the surface name, a loopback clone_url, and a pull token
      // scoped to exactly surface:brain:read.
      const body = JSON.parse(String(call.init.body)) as {
        surface: string;
        clone_url: string;
        pull_token: string;
      };
      expect(body.surface).toBe("brain");
      expect(body.clone_url).toBe("http://127.0.0.1:1939/git/brain");
      const pullClaims = await validateAccessToken(h.db, body.pull_token, [ISSUER]);
      expect((pullClaims.payload as { scope?: string }).scope).toBe("surface:brain:read");
      expect(pullClaims.payload.aud).toBe("surface");
    } finally {
      h.cleanup();
    }
  });

  test("surface-host rejection is reported, never thrown", async () => {
    const h = makeHarness();
    const spy = fetchSpy(403, "forbidden");
    try {
      const out = await notifySurfacePushed("brain", {
        db: h.db,
        issuer: ISSUER,
        resolveModuleOrigin: () => "http://127.0.0.1:1946",
        cloneBaseOrigin: ISSUER,
        fetchImpl: spy.impl,
        log: { warn() {}, info() {} },
      });
      expect(out.notified).toBe(false);
      expect(out.reason).toBe("notify-rejected:403");
    } finally {
      h.cleanup();
    }
  });

  test("a fetch throw is swallowed (best-effort)", async () => {
    const h = makeHarness();
    const throwing = (() => Promise.reject(new Error("econnrefused"))) as unknown as typeof fetch;
    try {
      const out = await notifySurfacePushed("brain", {
        db: h.db,
        issuer: ISSUER,
        resolveModuleOrigin: () => "http://127.0.0.1:1946",
        cloneBaseOrigin: ISSUER,
        fetchImpl: throwing,
        log: { warn() {}, info() {} },
      });
      expect(out.notified).toBe(false);
      expect(out.reason).toBe("notify-error");
    } finally {
      h.cleanup();
    }
  });
});
