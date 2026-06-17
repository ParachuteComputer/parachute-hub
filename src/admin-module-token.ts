/**
 * `GET /admin/module-token/<short>` — exchange a valid admin session cookie for
 * a short-lived JWT carrying `<short>:admin` (audience = the bare module short).
 *
 * Why this exists (2026-06-09 modular-UI architecture, P3): modules now own
 * their config/admin UIs and declare `configUiUrl` in `module.json` (scribe
 * `/scribe/admin`, runner `/runner/admin`, surface `/surface/admin/`, …). The
 * hub frames/links those surfaces consistently (the Modules page "Configure"
 * action). Each module-owned config UI, served behind the hub proxy to a
 * logged-in portal operator, needs an admin-scoped hub Bearer to call its own
 * `<short>:admin`-gated endpoints — the same shape the channel config UI gets
 * from `/admin/channel-token` and the vault admin SPA gets from
 * `/admin/vault-admin-token/<name>`. This is the GENERIC mint that covers every
 * other self-registered single-audience module, so the hub doesn't grow a
 * bespoke per-module mint endpoint as each module ships a config UI.
 *
 * Scope + audience: `<short>:admin`, audience = `<short>` (the bare service
 * prefix). Modules validate the JWT's `aud` against their literal short name
 * (`scribe`, `runner`, `surface`, `channel`) — the same shape `inferAudience`
 * stamps for the public OAuth flow, so a hub-minted and an OAuth-minted admin
 * token are indistinguishable to the module. This mirrors the per-request
 * `<short>:admin` proxy token `api-modules-config.ts` used to mint; the
 * difference is this endpoint hands the token to the module's OWN UI rather
 * than proxying a hub-side config form.
 *
 * Multi-vault note: VAULT is excluded here. Vault's admin scope is per-instance
 * (`vault:<name>:admin`, audience `vault.<name>`), which needs a vault-name
 * parameter and a known-vault check — that lives in `/admin/vault-admin-token/
 * <name>` (`admin-vault-admin-token.ts`). A request for `vault` here returns a
 * 400 pointing at that endpoint, so a caller can't accidentally mint a useless
 * bare `vault:admin`.
 *
 * Gate: the session must belong to the first admin (the single hub admin under
 * the Phase 1 multi-user model — `users.ts:isFirstAdmin`), exactly like
 * host-admin-token / vault-admin-token / channel-token. A friend account holds
 * a valid session but must not mint a module admin Bearer.
 *
 * Tokens are short-lived (10 min — matches the sibling admin-token mints); the
 * config UI re-fetches on near-expiry.
 */
import type { Database } from "bun:sqlite";
import { lockedResponse, requireUnlocked } from "./admin-lock.ts";
import { signAccessToken } from "./jwt-sign.ts";
import {
  type ModuleManifest,
  readModuleManifest as defaultReadModuleManifest,
} from "./module-manifest.ts";
import { findServiceByShort, isKnownModuleShort } from "./service-spec.ts";
import type { ServiceEntry } from "./services-manifest.ts";
import { findSession, parseSessionCookie } from "./sessions.ts";
import { isFirstAdmin } from "./users.ts";

/** Short TTL — matches host/vault/channel admin-token. UI re-fetches on near-expiry. */
export const MODULE_TOKEN_TTL_SECONDS = 10 * 60;
const MODULE_TOKEN_CLIENT_ID = "parachute-hub-spa";

/** Lowercase short-name charset, matching the module-name rule + path parsing. */
const MODULE_SHORT_RE = /^[a-z][a-z0-9-]*$/;

export interface MintModuleTokenDeps {
  db: Database;
  /** Hub origin — written into JWT `iss`. */
  issuer: string;
  /**
   * Snapshot of services.json rows, read at request time so a module that
   * self-registered since hub boot is mintable without a restart. Used by the
   * self-registration gate (boundary C5) — see {@link isSelfRegisteredModule}.
   */
  readServices: () => readonly ServiceEntry[];
  /** Test seam — defaults to the real `readModuleManifest` (disk read). */
  readModuleManifest?: (installDir: string) => Promise<ModuleManifest | null>;
}

/**
 * The self-registration gate (C5 of the 2026-06-09 hub-module-boundary
 * migration): a short is mintable when it resolves to a services.json row
 * whose `installDir` carries a readable `.parachute/module.json`.
 *
 * Resolution mirrors the rest of the hub (`/api/modules`,
 * `collectInstalledModules`): first-party rows resolve through
 * `findServiceByShort` (manifest name ↔ short map); a genuinely third-party
 * row matches by its literal services.json `name` — the same
 * `shortNameForManifest(name) ?? name` convention the catalog uses.
 *
 * Why this is enough against a forged short: services.json is written only by
 * same-disk modules, which the charter's trust statement already covers — an
 * installed module runs a daemon on the operator's machine, strictly more
 * power than an admin Bearer. Requiring the registered row AND a readable
 * manifest still keeps a typo'd short from minting `<anything>:admin` and
 * masquerading as a real (but unusable) credential.
 */
async function isSelfRegisteredModule(short: string, deps: MintModuleTokenDeps): Promise<boolean> {
  const services = deps.readServices();
  const row =
    findServiceByShort(services, short) ?? services.find((s): boolean => s.name === short);
  if (!row?.installDir) return false;
  const readManifest = deps.readModuleManifest ?? defaultReadModuleManifest;
  try {
    const manifest = await readManifest(row.installDir);
    return manifest !== null;
  } catch {
    // Malformed manifest — treat as not-a-module rather than 500ing the mint.
    return false;
  }
}

export async function handleModuleToken(
  req: Request,
  short: string,
  deps: MintModuleTokenDeps,
): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }
  if (!MODULE_SHORT_RE.test(short)) {
    return jsonError(400, "invalid_request", `module short "${short}" is not a valid identifier`);
  }
  // Vault is per-instance — its admin scope needs a vault name. Route the caller
  // to the dedicated per-vault endpoint rather than minting a useless bare
  // `vault:admin` (no vault validates that audience).
  if (short === "vault") {
    return jsonError(
      400,
      "use_vault_admin_token",
      "vault admin tokens are per-instance — use GET /admin/vault-admin-token/<name>",
    );
  }
  // Only mint for modules the hub can verify exist. Two paths (boundary C5 —
  // closes the charter's third-party-test gap, where this endpoint used to
  // require bootstrap-registry presence):
  //   1. SELF-REGISTERED: the short resolves to a services.json row whose
  //      installDir carries a readable module.json. This is the canonical
  //      gate — any module (first- or third-party) that completed
  //      self-registration mints with zero hub code changes, per
  //      `parachute-patterns/patterns/hub-module-boundary.md` (the seam,
  //      mechanism 1).
  //   2. KNOWN bootstrap short (KNOWN_MODULES ∪ FIRST_PARTY_FALLBACKS): kept
  //      as a fallback so a first-party module mid-install (row not yet
  //      written) still mints.
  // Either way a forged/typo'd short can't mint `<anything>:admin` and mask
  // itself as a real (but unusable) credential.
  if (!isKnownModuleShort(short) && !(await isSelfRegisteredModule(short, deps))) {
    return jsonError(404, "not_found", `no module "${short}" known to this hub`);
  }
  const sid = parseSessionCookie(req.headers.get("cookie"));
  const session = sid ? findSession(deps.db, sid) : null;
  if (!session || !sid) {
    return jsonError(401, "unauthenticated", "no admin session — sign in at /login first");
  }
  // First-admin gate (mirrors host/vault/channel-admin-token). A friend account
  // (non-first-admin user) holds a valid session but must not mint a module
  // admin Bearer.
  if (!isFirstAdmin(deps.db, session.userId)) {
    return jsonError(
      403,
      "not_admin",
      "module admin token mint is restricted to the hub admin — your account home is at /account/",
    );
  }
  // Admin screen-lock gate (see admin-host-admin-token.ts). A locked admin
  // session can't mint a module admin Bearer, so every module-owned config UI
  // fails closed until the operator unlocks. This is what makes the lock
  // cascade to ALL modules with zero per-module changes. Off by default.
  if (!requireUnlocked(deps.db, sid).ok) {
    return lockedResponse();
  }
  const scope = `${short}:admin`;
  const minted = await signAccessToken(deps.db, {
    sub: session.userId,
    scopes: [scope],
    // Bare service audience — modules validate `aud === <short>`, the same
    // shape `inferAudience` stamps for the OAuth flow.
    audience: short,
    clientId: MODULE_TOKEN_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds: MODULE_TOKEN_TTL_SECONDS,
    // No per-user vault pin — this Bearer talks to a module-scoped endpoint,
    // not a single vault. Empty `vault_scope` is the "no per-user restriction"
    // sentinel, matching host-admin / channel tokens.
    vaultScope: [],
  });
  return new Response(
    JSON.stringify({
      token: minted.token,
      expires_at: minted.expiresAt,
      scopes: [scope],
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        // No browser cache — token rotates per-fetch, and a stale 200 from a
        // back/forward navigation could hand the UI a long-expired JWT.
        "cache-control": "no-store",
      },
    },
  );
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
