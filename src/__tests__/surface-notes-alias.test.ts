/**
 * W2-12 — `/surface/notes` → `/surface/parachute` conditional alias.
 *
 * The condition is decided on `uis{}` MOUNT PATHS (the values
 * `resolveUiMount` routes on), not map keys: fire only when no sub-unit
 * resolves at/under `/surface/notes` AND one is mounted at exactly
 * `/surface/parachute`. Unit tests pin the helper's condition + target
 * shape; the integration tests drive `hubFetch` end-to-end to prove the
 * dispatch placement (before the generic services proxy) and — the
 * load-bearing half — that an EXISTING notes-ui install (a `/surface/notes`
 * uis mount) passes through to its upstream untouched.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubFetch } from "../hub-server.ts";
import { clearNotesRedirectLogState } from "../notes-redirect.ts";
import { type ServiceEntry, writeManifest } from "../services-manifest.ts";
import { isSurfaceNotesPath, maybeRedirectSurfaceNotes } from "../surface-notes-alias.ts";

// ---------------------------------------------------------------------------
// Manifest fixtures
// ---------------------------------------------------------------------------

/** A surface-host row carrying the given uis map (or none). */
function surfaceRow(uis: ServiceEntry["uis"] | undefined, port = 1946): ServiceEntry {
  const entry: ServiceEntry = {
    name: "parachute-surface",
    port,
    paths: ["/surface"],
    health: "/surface/healthz",
    version: "0.4.0",
  };
  if (uis !== undefined) entry.uis = uis;
  return entry;
}

/** Post-rename install: the app surface registered at /surface/parachute. */
const PARACHUTE_UIS: ServiceEntry["uis"] = {
  parachute: { displayName: "Parachute", path: "/surface/parachute", audience: "public" },
};

/** Existing install: notes-ui still registered at /surface/notes. */
const NOTES_UIS: ServiceEntry["uis"] = {
  notes: { displayName: "Notes", path: "/surface/notes", audience: "public" },
};

// ---------------------------------------------------------------------------
// isSurfaceNotesPath — boundary shape
// ---------------------------------------------------------------------------

describe("isSurfaceNotesPath", () => {
  test("matches the bare mount, trailing slash, and sub-paths", () => {
    expect(isSurfaceNotesPath("/surface/notes")).toBe(true);
    expect(isSurfaceNotesPath("/surface/notes/")).toBe(true);
    expect(isSurfaceNotesPath("/surface/notes/index.html")).toBe(true);
    expect(isSurfaceNotesPath("/surface/notes/a/b?ignored-not-part-of-path")).toBe(true);
  });

  test("does NOT match sibling prefixes or other mounts", () => {
    expect(isSurfaceNotesPath("/surface/notesy")).toBe(false);
    expect(isSurfaceNotesPath("/surface/notes-archive/")).toBe(false);
    expect(isSurfaceNotesPath("/surface/parachute")).toBe(false);
    expect(isSurfaceNotesPath("/notes/")).toBe(false);
    expect(isSurfaceNotesPath("/surface")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maybeRedirectSurfaceNotes — the condition + target shape
// ---------------------------------------------------------------------------

describe("maybeRedirectSurfaceNotes", () => {
  test("fires when /surface/parachute is mounted and /surface/notes is not", () => {
    const services = [surfaceRow(PARACHUTE_UIS)];
    expect(maybeRedirectSurfaceNotes("/surface/notes", "", services)).toBe("/surface/parachute");
    expect(maybeRedirectSurfaceNotes("/surface/notes/", "", services)).toBe("/surface/parachute/");
    expect(maybeRedirectSurfaceNotes("/surface/notes/a/b.html", "", services)).toBe(
      "/surface/parachute/a/b.html",
    );
  });

  test("preserves the query string on the target", () => {
    const services = [surfaceRow(PARACHUTE_UIS)];
    expect(maybeRedirectSurfaceNotes("/surface/notes/x", "?q=1&n=2", services)).toBe(
      "/surface/parachute/x?q=1&n=2",
    );
  });

  test("INERT when a /surface/notes mount exists (existing notes-ui install)", () => {
    expect(maybeRedirectSurfaceNotes("/surface/notes/x", "", [surfaceRow(NOTES_UIS)])).toBe(
      undefined,
    );
    // ... even when a parachute mount ALSO exists (transitional both-present
    // install) — a live legacy mount is never preempted.
    const both = [surfaceRow({ ...NOTES_UIS, ...PARACHUTE_UIS })];
    expect(maybeRedirectSurfaceNotes("/surface/notes/x", "", both)).toBe(undefined);
  });

  test("INERT when no uis{} exist at all (pre-uis surface-host rows — today's live shape)", () => {
    expect(maybeRedirectSurfaceNotes("/surface/notes/x", "", [surfaceRow(undefined)])).toBe(
      undefined,
    );
    expect(maybeRedirectSurfaceNotes("/surface/notes/x", "", [])).toBe(undefined);
  });

  test("INERT when the target mount is absent — never redirects into a 404", () => {
    // A `parachute` KEY whose path was customized elsewhere does not count:
    // the redirect target is the literal /surface/parachute mount, so its
    // existence (by path) is part of the condition.
    const customized: ServiceEntry["uis"] = {
      parachute: { displayName: "Parachute", path: "/surface/app", audience: "public" },
    };
    expect(maybeRedirectSurfaceNotes("/surface/notes/x", "", [surfaceRow(customized)])).toBe(
      undefined,
    );
  });

  test("fires in the in-place-upgrade caveat: uis KEY still `notes`, PATH flipped to /surface/parachute", () => {
    // Re-adding the renamed package over the old instance with
    // `instance_name=notes` and no `mount_path` keeps the map key `notes`
    // while the mount flips — exactly the orphaned-bookmark scenario this
    // alias exists for. The path-based condition (not key-based) covers it.
    const upgraded: ServiceEntry["uis"] = {
      notes: { displayName: "Parachute", path: "/surface/parachute", audience: "public" },
    };
    expect(maybeRedirectSurfaceNotes("/surface/notes/x", "?a=1", [surfaceRow(upgraded)])).toBe(
      "/surface/parachute/x?a=1",
    );
  });

  test("a sub-unit mounted UNDER /surface/notes counts as the legacy identity resolving", () => {
    // A deeper mount like /surface/notes/foo still serves real content under
    // the legacy prefix; redirecting across it would hijack a live route.
    const deep: ServiceEntry["uis"] = {
      ...PARACHUTE_UIS,
      foo: { displayName: "Foo", path: "/surface/notes/foo", audience: "public" },
    };
    expect(maybeRedirectSurfaceNotes("/surface/notes/foo/x", "", [surfaceRow(deep)])).toBe(
      undefined,
    );
  });

  test("non-matching pathnames return undefined regardless of manifest state", () => {
    const services = [surfaceRow(PARACHUTE_UIS)];
    expect(maybeRedirectSurfaceNotes("/surface/notesy", "", services)).toBe(undefined);
    expect(maybeRedirectSurfaceNotes("/surface/parachute/x", "", services)).toBe(undefined);
    expect(maybeRedirectSurfaceNotes("/notes/x", "", services)).toBe(undefined);
  });

  test("normalizes trailing slashes on declared uis paths", () => {
    const slashed: ServiceEntry["uis"] = {
      parachute: { displayName: "Parachute", path: "/surface/parachute/", audience: "public" },
    };
    expect(maybeRedirectSurfaceNotes("/surface/notes/x", "", [surfaceRow(slashed)])).toBe(
      "/surface/parachute/x",
    );
  });
});

// ---------------------------------------------------------------------------
// hubFetch integration — dispatch placement + passthrough
// ---------------------------------------------------------------------------

interface Harness {
  dir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-surface-notes-alias-"));
  return {
    dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function req(path: string): Request {
  return new Request(`http://127.0.0.1${path}`);
}

// Loopback peer so the default publicExposure cloak never interferes —
// same shape audience-gate.test.ts uses.
const fakeServer = (address: string) => ({ requestIP: () => ({ address }) });

function startEchoUpstream(): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (r) =>
      new Response(JSON.stringify({ upstream: "notes-ui", path: new URL(r.url).pathname }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  return { port: server.port as number, stop: () => server.stop(true) };
}

describe("hubFetch × surface-notes alias (W2-12)", () => {
  test("301: /surface/notes/* → /surface/parachute/* when only the parachute mount exists (tail + query preserved)", async () => {
    clearNotesRedirectLogState();
    const h = makeHarness();
    try {
      writeManifest({ services: [surfaceRow(PARACHUTE_UIS)] }, h.manifestPath);
      const f = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await f(req("/surface/notes/some/path?q=1&n=2"), fakeServer("127.0.0.1"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/surface/parachute/some/path?q=1&n=2");
    } finally {
      h.cleanup();
    }
  });

  test("301: bare /surface/notes → /surface/parachute", async () => {
    clearNotesRedirectLogState();
    const h = makeHarness();
    try {
      writeManifest({ services: [surfaceRow(PARACHUTE_UIS)] }, h.manifestPath);
      const f = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await f(req("/surface/notes"), fakeServer("127.0.0.1"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/surface/parachute");
    } finally {
      h.cleanup();
    }
  });

  test("200 passthrough: an existing notes-ui install (notes uis mount) proxies to its upstream untouched", async () => {
    clearNotesRedirectLogState();
    const upstream = startEchoUpstream();
    const h = makeHarness();
    try {
      writeManifest({ services: [surfaceRow(NOTES_UIS, upstream.port)] }, h.manifestPath);
      const f = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await f(req("/surface/notes/index.html"), fakeServer("127.0.0.1"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { upstream: string; path: string };
      // The blind proxy forwarded the ORIGINAL path — no rewrite rode along.
      expect(body.upstream).toBe("notes-ui");
      expect(body.path).toBe("/surface/notes/index.html");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("404: /surface/notesy (sibling prefix) is untouched by the alias", async () => {
    clearNotesRedirectLogState();
    const h = makeHarness();
    try {
      // parachute-mount-only manifest, but NO row claims /surface/notesy —
      // the boundary check keeps the alias out of the way and the dispatch
      // falls through to the branded 404.
      writeManifest(
        {
          services: [
            {
              name: "parachute-app",
              port: 1944,
              paths: ["/app"],
              health: "/app",
              version: "0.5.0",
              uis: PARACHUTE_UIS,
            },
          ],
        },
        h.manifestPath,
      );
      const f = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await f(req("/surface/notesy"), fakeServer("127.0.0.1"));
      expect(res.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  test("404 (not 301): no uis at all — today's live shape stays inert end-to-end", async () => {
    clearNotesRedirectLogState();
    const h = makeHarness();
    try {
      // A pre-uis surface row would normally proxy /surface/* blind; with no
      // live upstream the proxy path yields a 502/404-class response — the
      // assertion here is only that NO 301 fires. Use an empty manifest so
      // the outcome is a deterministic 404.
      writeManifest({ services: [] }, h.manifestPath);
      const f = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await f(req("/surface/notes/"), fakeServer("127.0.0.1"));
      expect(res.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });
});
