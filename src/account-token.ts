/**
 * `POST /account/token` — exchange a valid admin session cookie for a
 * short-lived JWT carrying the ACCOUNT credential: the superset
 *
 *   { account:self:admin, parachute:host:admin, parachute:host:auth }
 *
 * with `aud="account"`. This is the self-host door's half of the Parachute App
 * campaign's `/account/*` contract (Phase 2, H1) — the same shape the cloud
 * door mints from its own session cookie.
 *
 * Why a SUPERSET (SCOPE-b). The account bearer must drive both the net-new
 * `/account/*` REST surface (H2, gated on `account:self:admin`) AND — on a
 * single-operator self-host box — the EXISTING hub admin endpoints it wraps
 * (`POST /vaults`, `/api/auth/*`, caps), all gated on `parachute:host:admin` /
 * `parachute:host:auth` via `requireScope`. Carrying all three scopes means no
 * existing hub endpoint needs rewiring: `requireScope` checks the scope claim +
 * signature + `iss` and does NOT pin `aud` (admin-auth.ts), so the `aud="account"`
 * token validates unchanged on the host-scoped surfaces. This is the "relabel a
 * semantics that ships" path — it reuses the `admin-host-admin-token.ts` mint
 * and adds the `account:self:admin` string on top of the host superset.
 *
 * Why `aud="account"` (SCOPE-a). The account token is minted with an explicit
 * `aud="account"` (not the `inferAudience` fallback) so the `/account/*`
 * validator can pin the audience and a vault RS's strict `aud=vault.<name>`
 * check refuses it outright — an account token can never be spent as a vault
 * token.
 *
 * Authorization — the same spine as `/admin/host-admin-token`:
 *   1. **Session.** A valid, unexpired `parachute_hub_session` cookie (set by
 *      `/login` after a password check). No session → 401.
 *   2. **CSRF.** Unlike the GET host-admin mint, this is a POST that performs a
 *      privileged mint, so it carries the double-submit CSRF token
 *      (`__csrf` in the JSON body, same `verifyCsrfToken` as `/api/account/*`).
 *      Missing/mismatched → 403. The hub-server dispatcher additionally applies
 *      the strict same-origin Origin belt (`assertSameOriginForCookieMutation`)
 *      before this handler runs — belt-and-suspenders on the cookie path.
 *   3. **First-admin gate.** A valid session is necessary but NOT sufficient: it
 *      must belong to the hub admin (earliest-created user row). Without this a
 *      signed-in friend account could mint a full host-admin superset — a
 *      privesc. On a single-operator box first-admin ≡ the account ≡ the box
 *      (the ratified "operator ≡ account ≡ box"), so the first-admin gate is the
 *      account gate. Non-first-admin session → 403.
 *   4. **Admin screen-lock.** When the optional idle-lock PIN is set and this
 *      session isn't in an unlock window, refuse (423) — same as the host-admin
 *      mint (the account token is at least as powerful, so it inherits the gate).
 *
 * Statelessness + revocation (SCOPE-d). Like the host-admin token, the account
 * token is deliberately NOT persisted in the `tokens` table — no registry row,
 * no per-jti revocation. It is short-lived (10 min) and re-minted from the live
 * session; revocation is by logout (kills the cookie → no re-mint) plus the
 * read-time session-expiry chokepoint. A stateless mint avoids a DB write on
 * every re-mint.
 */
import type { Database } from "bun:sqlite";
import { HOST_ADMIN_SCOPES } from "./admin-host-admin-token.ts";
import { lockedResponse, requireUnlocked } from "./admin-lock.ts";
import { CSRF_FIELD_NAME, verifyCsrfToken } from "./csrf.ts";
import { signAccessToken } from "./jwt-sign.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import { ACCOUNT_SELF_ADMIN_SCOPE } from "./scope-explanations.ts";
import {
  SESSION_TTL_MS,
  buildSessionCookie,
  findSession,
  parseSessionCookie,
  touchSession,
} from "./sessions.ts";
import { isFirstAdmin } from "./users.ts";

/** Short TTL — page-snapshot threats can't carry the token forever. Matches the
 * host-admin mint's 10-min window; the app re-mints when it's about to lapse. */
export const ACCOUNT_TOKEN_TTL_SECONDS = 10 * 60;
/** Explicit account audience (SCOPE-a) — pinned by the `/account/*` validator;
 * a vault RS's strict `aud=vault.<name>` check refuses it. */
export const ACCOUNT_TOKEN_AUDIENCE = "account";
/** First-party browser client id for the account credential (matches the
 * `parachute-account` id the friend vault-token mints already use). */
export const ACCOUNT_TOKEN_CLIENT_ID = "parachute-account";
/** The superset the account bearer carries (SCOPE-b): the account scope plus
 * the host superset, so the same token drives both the `/account/*` surface and
 * the host-scoped endpoints it wraps without rewiring any existing gate. */
export const ACCOUNT_TOKEN_SCOPES = [ACCOUNT_SELF_ADMIN_SCOPE, ...HOST_ADMIN_SCOPES] as const;

export interface MintAccountTokenDeps {
  db: Database;
  /** Hub origin — written into JWT `iss`. */
  issuer: string;
}

export async function handleAccountToken(
  req: Request,
  deps: MintAccountTokenDeps,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonError(405, "method_not_allowed", "use POST");
  }

  // Gate 1 — session. No identity, no mint.
  const sid = parseSessionCookie(req.headers.get("cookie"));
  const session = sid ? findSession(deps.db, sid) : null;
  if (!session || !sid) {
    return jsonError(401, "unauthenticated", "no admin session — sign in at /login first");
  }

  // Gate 2 — CSRF double-submit. This is a POST mint, so a cross-site forged
  // submission must be refused before any privileged work. The token rides the
  // JSON body's `__csrf` field, same shape + helper as `/api/account/*`. The
  // dispatcher's Origin belt already ran; this is the double-submit half.
  const csrfToken = await readCsrfToken(req);
  if (!verifyCsrfToken(req, csrfToken)) {
    return jsonError(403, "csrf_failed", "missing or invalid CSRF token");
  }

  // Gate 3 — first-admin. A friend account (non-first-admin) holds a valid
  // session but must not mint the account superset (host:admin + host:auth is a
  // full-admin privesc). On a single-operator box first-admin ≡ the account, so
  // this gate IS the account gate. Mirror the host-admin mint's 403 shape.
  if (!isFirstAdmin(deps.db, session.userId)) {
    return jsonError(
      403,
      "not_admin",
      "account token mint is restricted to the hub admin — your account home is at /account/",
    );
  }

  // Gate 4 — admin screen-lock (optional, off by default). When a lock PIN is
  // set AND this session isn't within an unlock window, refuse. Same PURE-CHECK
  // posture as the host-admin mint: it does NOT slide the idle window (sliding
  // is heartbeat-only), so a background re-mint can't keep an idle tab unlocked.
  if (!requireUnlocked(deps.db, sid).ok) {
    return lockedResponse();
  }

  const minted = await signAccessToken(deps.db, {
    sub: session.userId,
    scopes: [...ACCOUNT_TOKEN_SCOPES],
    audience: ACCOUNT_TOKEN_AUDIENCE,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds: ACCOUNT_TOKEN_TTL_SECONDS,
    // No per-user vault pin — the account bearer talks to hub-scoped account +
    // provisioning endpoints, not a single vault. Empty `vault_scope` is the
    // "no per-user restriction" sentinel, matching the host-admin mint.
    vaultScope: [],
  });

  // Sliding session renewal — a successful mint pushes the session's expiry
  // forward and re-issues the cookie with the EXACT attributes creation uses,
  // so an app re-minting ~every 10 min keeps the operator signed in without
  // broadening the cookie. Identical to the host-admin mint.
  touchSession(deps.db, sid);
  const sessionCookie = buildSessionCookie(sid, Math.floor(SESSION_TTL_MS / 1000), {
    secure: isHttpsRequest(req),
  });

  return new Response(
    JSON.stringify({
      token: minted.token,
      expires_at: minted.expiresAt,
      scopes: ACCOUNT_TOKEN_SCOPES,
      aud: ACCOUNT_TOKEN_AUDIENCE,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        // No browser cache — the token rotates per-mint; a stale 200 from a
        // back/forward navigation could hand the app a long-expired JWT.
        "cache-control": "no-store",
        "set-cookie": sessionCookie,
      },
    },
  );
}

/**
 * Pull the double-submit CSRF token from the JSON request body's `__csrf`
 * field. Tolerant of an absent/malformed body (returns null → the verify
 * fails closed with a 403), matching `readJsonBody` + `checkCsrf` in
 * `api-account-2fa.ts`.
 */
async function readCsrfToken(req: Request): Promise<string | null> {
  try {
    const body = (await req.json()) as unknown;
    if (body && typeof body === "object") {
      const token = (body as Record<string, unknown>)[CSRF_FIELD_NAME];
      return typeof token === "string" ? token : null;
    }
  } catch {
    // Empty or non-JSON body — no token.
  }
  return null;
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
