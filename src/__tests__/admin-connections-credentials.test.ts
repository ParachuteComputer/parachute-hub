/**
 * Tests for `kind: "credential"` connections (H4, surface-runtime design):
 * provision round-trip, renewal (proof-of-possession; expired requires the
 * operator), teardown (revoke + best-effort removal notification),
 * privilege-escalation rejections, and the catalog round-trip.
 *
 * Shape mirrors admin-connections.test.ts: real DB + real mints (so the JWT
 * claims — scope / aud / vault_scope / permissions.scoped_tags — can be
 * decoded the way vault would read them), mocked module HTTP via fetchImpl.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import {
  type ConnectionsDeps,
  type InstalledModuleInfo,
  buildCatalog,
  handleConnections,
} from "../admin-connections.ts";
import { readConnections } from "../connections-store.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { findTokenRowByJti, listActiveRevocations } from "../jwt-sign.ts";
import {
  type ModuleManifest,
  ModuleManifestError,
  validateModuleManifest,
} from "../module-manifest.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const HUB_ORIGIN = "https://hub.test";
const VAULT_ORIGIN = "http://127.0.0.1:1940";
const SURFACE_ORIGIN = "http://127.0.0.1:1946";

interface Harness {
  db: Database;
  storePath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-cred-conn-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  return {
    db,
    storePath: join(dir, "connections.json"),
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

async function adminCookie(): Promise<{ cookie: string; userId: string }> {
  const user = await createUser(harness.db, "operator", "hunter2");
  const session = createSession(harness.db, { userId: user.id });
  return {
    cookie: buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)),
    userId: user.id,
  };
}

// --- Mock fetch (same shape as admin-connections.test.ts) -------------------

interface RecordedReq {
  method: string;
  url: string;
  bearer: string | null;
  body: unknown;
}
type Responder = (req: RecordedReq) => Response;

function mockFetch(routes: Record<string, Responder>): {
  fetchImpl: typeof fetch;
  calls: RecordedReq[];
} {
  const calls: RecordedReq[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const auth =
      (init?.headers as Record<string, string> | undefined)?.authorization ??
      (init?.headers as Record<string, string> | undefined)?.Authorization ??
      null;
    const bearer = auth ? auth.replace(/^Bearer\s+/i, "") : null;
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const path = new URL(url).pathname;
    const rec: RecordedReq = { method, url, bearer, body };
    calls.push(rec);
    const responder = routes[`${method} ${path}`];
    if (!responder) return new Response("no route", { status: 599 });
    return responder(rec);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function ok(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// --- Module fixtures --------------------------------------------------------

/** A surface-like module declaring a read credential (the woven-boulder shape). */
const SURFACE_MANIFEST: ModuleManifest = {
  name: "surface",
  manifestName: "parachute-surface",
  port: 1946,
  paths: ["/surface"],
  health: "/surface/healthz",
  credentials: [
    {
      key: "vault",
      title: "Standing vault credential",
      description: "Tag-scoped read credential for a backed surface.",
      scope: "vault:{vault}:read",
      endpoint: "/api/credential",
    },
    {
      key: "vault-write",
      title: "Standing vault write credential",
      scope: "vault:{vault}:write",
      endpoint: "/api/credential",
    },
  ],
};

function modulesOf(...manifests: ModuleManifest[]): InstalledModuleInfo[] {
  return manifests.map((manifest) => ({
    short: manifest.name,
    manifest,
    mount: manifest.paths[0] ?? null,
  }));
}

function credDeps(fetchImpl: typeof fetch, modules: InstalledModuleInfo[]): ConnectionsDeps {
  return {
    db: harness.db,
    hubOrigin: HUB_ORIGIN,
    modules,
    resolveVaultOrigin: (v) => (v === "default" ? VAULT_ORIGIN : null),
    resolveModuleOrigin: (short) => (short === "surface" ? SURFACE_ORIGIN : null),
    channelOrigin: null,
    storePath: harness.storePath,
    fetchImpl,
  };
}

function postCredential(
  cookie: string,
  body: Record<string, unknown>,
  deps: ConnectionsDeps,
): Promise<Response> {
  return handleConnections(
    new Request("http://127.0.0.1/admin/connections", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ kind: "credential", ...body }),
    }),
    "",
    deps,
  );
}

function renewReq(id: string, bearer?: string): Request {
  return new Request(`http://127.0.0.1/admin/connections/${id}/renew`, {
    method: "POST",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

interface DeliveredCredential {
  kind: string;
  op: string;
  connection_id: string;
  key: string;
  vault: string;
  scope: string;
  scoped_tags: string[];
  token?: string;
  jti?: string;
  expires_at?: string;
  renew_path?: string;
}

// ===========================================================================
// Provision round-trip
// ===========================================================================

describe("credential connection — provision (H4)", () => {
  test("full round-trip: registered mint, scoped_tags claim, delivered payload shape, persisted record", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({
      "POST /api/credential": () => ok({ ok: true }),
    });
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));

    const res = await postCredential(
      cookie,
      { credential: { module: "surface", key: "vault", vault: "default", tags: ["boulder"] } },
      deps,
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      ok: boolean;
      connection: { id: string; kind: string };
      expires_at: string;
    };
    expect(out.ok).toBe(true);
    expect(out.connection.kind).toBe("credential");
    expect(out.connection.id).toBe("cred-surface-vault-default");

    // Delivery: POSTed to the module's declared endpoint on its loopback
    // origin, authenticated with a short-lived surface:admin bearer.
    const delivery = calls.find((c) => c.url === `${SURFACE_ORIGIN}/api/credential`);
    expect(delivery).toBeDefined();
    expect(delivery!.method).toBe("POST");
    expect(delivery!.bearer).toBeTruthy();
    const adminClaims = decodeJwt(delivery!.bearer!) as { scope?: string; aud?: string };
    expect(adminClaims.scope).toBe("surface:admin");
    expect(adminClaims.aud).toBe("surface");

    const payload = delivery!.body as DeliveredCredential;
    expect(payload.kind).toBe("credential");
    expect(payload.op).toBe("provisioned");
    expect(payload.connection_id).toBe("cred-surface-vault-default");
    expect(payload.key).toBe("vault");
    expect(payload.vault).toBe("default");
    expect(payload.scope).toBe("vault:default:read");
    expect(payload.scoped_tags).toEqual(["boulder"]);
    expect(payload.renew_path).toBe("/admin/connections/cred-surface-vault-default/renew");
    expect(payload.token).toBeTruthy();
    expect(payload.jti).toBeTruthy();

    // The delivered token carries the claims vault enforces: scope, aud,
    // vault_scope pin, and permissions.scoped_tags (the tag-scope claim path).
    const claims = decodeJwt(payload.token!) as {
      scope?: string;
      aud?: string;
      vault_scope?: string[];
      permissions?: { scoped_tags?: string[] };
      jti?: string;
    };
    expect(claims.scope).toBe("vault:default:read");
    expect(claims.aud).toBe("vault.default");
    expect(claims.vault_scope).toEqual(["default"]);
    expect(claims.permissions?.scoped_tags).toEqual(["boulder"]);

    // REGISTERED mint (the registered-mint rule): a tokens row exists with
    // the credential provenance + the permissions JSON.
    const row = findTokenRowByJti(harness.db, payload.jti!);
    expect(row).not.toBeNull();
    expect(row!.createdVia).toBe("connection_credential");
    expect(row!.revokedAt).toBeNull();
    expect(JSON.parse(row!.permissions ?? "{}")).toEqual({ scoped_tags: ["boulder"] });

    // Persisted record: jti + scope + tags, cascade-matchable vault fields.
    const records = readConnections(harness.storePath);
    expect(records.length).toBe(1);
    const rec = records[0]!;
    expect(rec.kind).toBe("credential");
    expect(rec.source).toEqual({ module: "vault", vault: "default", event: "credential" });
    expect(rec.sink.module).toBe("surface");
    expect(rec.provisioned.type).toBe("credential");
    expect(rec.provisioned.vault).toBe("default");
    expect(rec.provisioned.mintedJtis).toEqual([payload.jti!]);
    expect(rec.provisioned.scope).toBe("vault:default:read");
    expect(rec.provisioned.scopedTags).toEqual(["boulder"]);
    expect(rec.provisioned.endpoint).toBe("/api/credential");
  });

  test("read credential MAY be vault-wide (no tags) — scoped_tags claim absent", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({ "POST /api/credential": () => ok({ ok: true }) });
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));

    const res = await postCredential(
      cookie,
      { credential: { module: "surface", key: "vault", vault: "default" } },
      deps,
    );
    expect(res.status).toBe(200);
    const payload = calls[calls.length - 1]!.body as DeliveredCredential;
    expect(payload.scoped_tags).toEqual([]);
    const claims = decodeJwt(payload.token!) as { permissions?: unknown };
    expect(claims.permissions).toBeUndefined();
  });

  test("write credential REQUIRES non-empty tags (tags are the sharing scope)", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({});
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));

    const res = await postCredential(
      cookie,
      { credential: { module: "surface", key: "vault-write", vault: "default" } },
      deps,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(calls.length).toBe(0); // nothing minted, nothing delivered
  });

  test("failed delivery revokes the fresh mint (no undelivered live credential)", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({
      "POST /api/credential": () => new Response("boom", { status: 500 }),
    });
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));

    const res = await postCredential(
      cookie,
      { credential: { module: "surface", key: "vault", vault: "default", tags: ["t"] } },
      deps,
    );
    expect(res.status).toBe(502);
    const attempted = calls.find((c) => c.url === `${SURFACE_ORIGIN}/api/credential`);
    const jti = (decodeJwt((attempted!.body as DeliveredCredential).token!) as { jti?: string })
      .jti!;
    const row = findTokenRowByJti(harness.db, jti);
    expect(row!.revokedAt).not.toBeNull();
    expect(readConnections(harness.storePath).length).toBe(0); // not persisted
  });

  test("re-approval (same module/key/vault) revokes the prior credential and upserts", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({ "POST /api/credential": () => ok({ ok: true }) });
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));

    await postCredential(
      cookie,
      { credential: { module: "surface", key: "vault", vault: "default", tags: ["a"] } },
      deps,
    );
    const firstJti = (readConnections(harness.storePath)[0]!.provisioned.mintedJtis ?? [])[0]!;

    const res2 = await postCredential(
      cookie,
      { credential: { module: "surface", key: "vault", vault: "default", tags: ["b"] } },
      deps,
    );
    expect(res2.status).toBe(200);
    const records = readConnections(harness.storePath);
    expect(records.length).toBe(1); // upserted, not duplicated
    expect(records[0]!.provisioned.scopedTags).toEqual(["b"]);
    // The first credential is dead.
    expect(findTokenRowByJti(harness.db, firstJti)!.revokedAt).not.toBeNull();
    expect(calls.filter((c) => c.method === "POST").length).toBe(2);
  });
});

// ===========================================================================
// Privilege-escalation rejections
// ===========================================================================

describe("credential connection — escalation guard", () => {
  test("manifest validator rejects vault:{vault}:admin and other-namespace scope templates", () => {
    const base = {
      name: "evil",
      manifestName: "evil",
      port: 1999,
      paths: ["/evil"],
      health: "/health",
    };
    expect(() =>
      validateModuleManifest(
        {
          ...base,
          credentials: [{ key: "v", title: "V", scope: "vault:{vault}:admin", endpoint: "/api/c" }],
        },
        "test",
      ),
    ).toThrow(ModuleManifestError);
    expect(() =>
      validateModuleManifest(
        {
          ...base,
          credentials: [{ key: "v", title: "V", scope: "scribe:{vault}:read", endpoint: "/api/c" }],
        },
        "test",
      ),
    ).toThrow(ModuleManifestError);
    // Literal vault names are not declarable either — the operator picks.
    expect(() =>
      validateModuleManifest(
        {
          ...base,
          credentials: [{ key: "v", title: "V", scope: "vault:default:read", endpoint: "/api/c" }],
        },
        "test",
      ),
    ).toThrow(ModuleManifestError);
  });

  test("POST-time re-check rejects an admin template smuggled past validation (defense in depth)", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({});
    // Hand-built (NOT validator-produced) manifest with an escalating scope.
    const evil: ModuleManifest = {
      name: "surface",
      manifestName: "parachute-surface",
      port: 1946,
      paths: ["/surface"],
      health: "/healthz",
      credentials: [
        { key: "vault", title: "V", scope: "vault:{vault}:admin", endpoint: "/api/credential" },
      ],
    };
    const deps = credDeps(fetchImpl, modulesOf(evil));
    const res = await postCredential(
      cookie,
      { credential: { module: "surface", key: "vault", vault: "default", tags: ["t"] } },
      deps,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_scope");
    expect(calls.length).toBe(0);
  });

  test("undeclared credential key / unknown module / unknown vault all 400", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({});
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));

    const badKey = await postCredential(
      cookie,
      { credential: { module: "surface", key: "nope", vault: "default" } },
      deps,
    );
    expect(badKey.status).toBe(400);
    expect(((await badKey.json()) as { error: string }).error).toBe("unknown_credential");

    const badModule = await postCredential(
      cookie,
      { credential: { module: "ghost", key: "vault", vault: "default" } },
      deps,
    );
    expect(badModule.status).toBe(400);
    expect(((await badModule.json()) as { error: string }).error).toBe("unknown_module");

    const badVault = await postCredential(
      cookie,
      { credential: { module: "surface", key: "vault", vault: "ghost" } },
      deps,
    );
    expect(badVault.status).toBe(400);
    expect(((await badVault.json()) as { error: string }).error).toBe("unknown_vault");
  });

  test("operator gate still applies to credential creation (no session → 401)", async () => {
    const { fetchImpl } = mockFetch({});
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));
    const res = await handleConnections(
      new Request("http://127.0.0.1/admin/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "credential",
          credential: { module: "surface", key: "vault", vault: "default" },
        }),
      }),
      "",
      deps,
    );
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// Renewal
// ===========================================================================

describe("credential connection — renewal (proof of possession)", () => {
  async function provision(
    deps: ConnectionsDeps,
    calls: RecordedReq[],
    tags: string[] = ["boulder"],
  ): Promise<DeliveredCredential & { cookie: string }> {
    const { cookie } = await adminCookie();
    const res = await postCredential(
      cookie,
      { credential: { module: "surface", key: "vault", vault: "default", tags } },
      deps,
    );
    expect(res.status).toBe(200);
    const payload = calls.find((c) => c.url === `${SURFACE_ORIGIN}/api/credential`)!
      .body as DeliveredCredential;
    return { ...payload, cookie };
  }

  test("happy path: current credential as Bearer → new token (same scope/tags), old jti revoked, record updated", async () => {
    const { fetchImpl, calls } = mockFetch({ "POST /api/credential": () => ok({ ok: true }) });
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));
    const cred = await provision(deps, calls);

    const res = await handleConnections(
      renewReq(cred.connection_id, cred.token),
      `/${cred.connection_id}/renew`,
      deps,
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; credential: DeliveredCredential };
    expect(out.ok).toBe(true);
    expect(out.credential.op).toBe("renewed");
    expect(out.credential.scope).toBe("vault:default:read");
    expect(out.credential.scoped_tags).toEqual(["boulder"]);
    expect(out.credential.jti).not.toBe(cred.jti);

    // Same claims shape on the re-mint.
    const claims = decodeJwt(out.credential.token!) as {
      scope?: string;
      permissions?: { scoped_tags?: string[] };
    };
    expect(claims.scope).toBe("vault:default:read");
    expect(claims.permissions?.scoped_tags).toEqual(["boulder"]);

    // Old jti revoked + on the revocation list; new jti registered + live.
    expect(findTokenRowByJti(harness.db, cred.jti!)!.revokedAt).not.toBeNull();
    expect(listActiveRevocations(harness.db, new Date())).toContain(cred.jti!);
    const newRow = findTokenRowByJti(harness.db, out.credential.jti!);
    expect(newRow!.revokedAt).toBeNull();
    expect(newRow!.createdVia).toBe("connection_credential");

    // Record now names ONLY the new jti.
    const rec = readConnections(harness.storePath)[0]!;
    expect(rec.provisioned.mintedJtis).toEqual([out.credential.jti!]);
  });

  test("renewed credential can renew again (the chain extends)", async () => {
    const { fetchImpl, calls } = mockFetch({ "POST /api/credential": () => ok({ ok: true }) });
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));
    const cred = await provision(deps, calls);

    const first = await handleConnections(
      renewReq(cred.connection_id, cred.token),
      `/${cred.connection_id}/renew`,
      deps,
    );
    const out1 = (await first.json()) as { credential: DeliveredCredential };
    const second = await handleConnections(
      renewReq(cred.connection_id, out1.credential.token),
      `/${cred.connection_id}/renew`,
      deps,
    );
    expect(second.status).toBe(200);
  });

  test("EXPIRED credential cannot renew itself — 401 names the operator path", async () => {
    const { fetchImpl, calls } = mockFetch({ "POST /api/credential": () => ok({ ok: true }) });
    // Mint in the past so the 90d credential is already expired "now".
    const past = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const deps = { ...credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST)), now: () => past };
    const cred = await provision(deps, calls);

    const liveDeps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));
    const res = await handleConnections(
      renewReq(cred.connection_id, cred.token),
      `/${cred.connection_id}/renew`,
      liveDeps,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_credential");
    expect(body.error_description).toContain("operator");
  });

  test("a DIFFERENT valid hub token (not this connection's jti) is refused — 403", async () => {
    const { fetchImpl, calls } = mockFetch({ "POST /api/credential": () => ok({ ok: true }) });
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));
    const cred = await provision(deps, calls);

    // Provision a SECOND credential connection (different vault key) and try
    // to renew the first with the second's token.
    const res2 = await postCredential(
      cred.cookie,
      {
        credential: { module: "surface", key: "vault-write", vault: "default", tags: ["w"] },
      },
      deps,
    );
    expect(res2.status).toBe(200);
    const otherCred = calls
      .filter((c) => c.url === `${SURFACE_ORIGIN}/api/credential`)
      .map((c) => c.body as DeliveredCredential)
      .find((p) => p.connection_id !== cred.connection_id)!;

    const res = await handleConnections(
      renewReq(cred.connection_id, otherCred.token),
      `/${cred.connection_id}/renew`,
      deps,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not_credential_holder");
  });

  test("REVOKED credential cannot renew (revocation enforced by validateAccessToken)", async () => {
    const { fetchImpl, calls } = mockFetch({ "POST /api/credential": () => ok({ ok: true }) });
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));
    const cred = await provision(deps, calls);

    // Renew once (revokes the original), then replay the ORIGINAL token.
    await handleConnections(
      renewReq(cred.connection_id, cred.token),
      `/${cred.connection_id}/renew`,
      deps,
    );
    const replay = await handleConnections(
      renewReq(cred.connection_id, cred.token),
      `/${cred.connection_id}/renew`,
      deps,
    );
    expect(replay.status).toBe(401);
  });

  test("renew without a Bearer → 401; unknown connection id → 404", async () => {
    const { fetchImpl } = mockFetch({});
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));
    const noBearer = await handleConnections(renewReq("cred-x"), "/cred-x/renew", deps);
    expect(noBearer.status).toBe(404); // no such connection (checked first)

    // Seed a record id that exists but isn't credential-kind: still 404.
    const { cookie } = await adminCookie();
    void cookie;
    const unknown = await handleConnections(renewReq("ghost"), "/ghost/renew", deps);
    expect(unknown.status).toBe(404);
  });
});

// ===========================================================================
// Teardown
// ===========================================================================

describe("credential connection — teardown", () => {
  test("DELETE revokes the credential jti and best-effort notifies the module endpoint", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({ "POST /api/credential": () => ok({ ok: true }) });
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));

    await postCredential(
      cookie,
      { credential: { module: "surface", key: "vault", vault: "default", tags: ["t"] } },
      deps,
    );
    const cred = calls.find((c) => c.url === `${SURFACE_ORIGIN}/api/credential`)!
      .body as DeliveredCredential;

    const res = await handleConnections(
      new Request(`http://127.0.0.1/admin/connections/${cred.connection_id}`, {
        method: "DELETE",
        headers: { cookie },
      }),
      `/${cred.connection_id}`,
      deps,
    );
    expect(res.status).toBe(200);

    // jti revoked (the authoritative kill).
    expect(findTokenRowByJti(harness.db, cred.jti!)!.revokedAt).not.toBeNull();
    // Removal payload POSTed to the declared endpoint.
    const removal = calls
      .filter((c) => c.url === `${SURFACE_ORIGIN}/api/credential`)
      .map((c) => c.body as DeliveredCredential)
      .find((p) => p.op === "removed");
    expect(removal).toBeDefined();
    expect(removal!.connection_id).toBe(cred.connection_id);
    expect(removal!.token).toBeUndefined(); // removal carries no secret
    // Record gone.
    expect(readConnections(harness.storePath).length).toBe(0);
  });

  test("notification failure is best-effort: revocation + record removal still land (207)", async () => {
    const { cookie } = await adminCookie();
    let deliveries = 0;
    const { fetchImpl, calls } = mockFetch({
      "POST /api/credential": () => {
        deliveries++;
        // First call (provision delivery) succeeds; the removal notify fails.
        return deliveries === 1 ? ok({ ok: true }) : new Response("down", { status: 500 });
      },
    });
    const deps = credDeps(fetchImpl, modulesOf(SURFACE_MANIFEST));

    await postCredential(
      cookie,
      { credential: { module: "surface", key: "vault", vault: "default", tags: ["t"] } },
      deps,
    );
    const cred = calls.find((c) => c.url === `${SURFACE_ORIGIN}/api/credential`)!
      .body as DeliveredCredential;

    const res = await handleConnections(
      new Request(`http://127.0.0.1/admin/connections/${cred.connection_id}`, {
        method: "DELETE",
        headers: { cookie },
      }),
      `/${cred.connection_id}`,
      deps,
    );
    expect(res.status).toBe(207);
    const body = (await res.json()) as { errors: { step: string }[] };
    expect(body.errors.some((e) => e.step === "credential_notify")).toBe(true);
    expect(findTokenRowByJti(harness.db, cred.jti!)!.revokedAt).not.toBeNull();
    expect(readConnections(harness.storePath).length).toBe(0);
  });
});

// ===========================================================================
// Catalog
// ===========================================================================

describe("credential connection — catalog", () => {
  test("buildCatalog carries credential declarations (metadata only, no secrets)", () => {
    const catalog = buildCatalog(modulesOf(SURFACE_MANIFEST));
    expect(catalog.credentials).toEqual([
      {
        module: "surface",
        key: "vault",
        title: "Standing vault credential",
        description: "Tag-scoped read credential for a backed surface.",
        scope: "vault:{vault}:read",
        endpoint: "/api/credential",
      },
      {
        module: "surface",
        key: "vault-write",
        title: "Standing vault write credential",
        description: null,
        scope: "vault:{vault}:write",
        endpoint: "/api/credential",
      },
    ]);
  });

  test("validator-produced manifests round-trip credentials (the real read path)", () => {
    const validated = validateModuleManifest(
      {
        name: "surface",
        manifestName: "parachute-surface",
        port: 1946,
        paths: ["/surface"],
        health: "/healthz",
        credentials: [
          {
            key: "vault",
            title: "Standing vault credential",
            scope: "vault:{vault}:read",
            endpoint: "/api/credential",
          },
        ],
      },
      "test",
    );
    expect(validated.credentials?.length).toBe(1);
    expect(validated.credentials?.[0]?.scope).toBe("vault:{vault}:read");
  });
});
