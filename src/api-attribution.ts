/**
 * `GET /api/auth/attribution?subject=<id>` — resolve a token subject to the
 * Nostr public key(s) that subject has proved possession of, together with the
 * stored proof (hub#833 phase 1b; team-vault design "2026-08-22 Multi-user
 * Parachute — draft for reaction" §3 phase 1b).
 *
 * ## Why this exists
 *
 * vault#298 already gives every note four attribution columns — `created_by`,
 * `created_via`, `last_updated_by`, `last_updated_via` — indexed and queryable.
 * `*_by` carries the JWT `sub`, which on this hub is a `users.id` UUID: an
 * opaque local identifier that means nothing off the box, that nobody signed,
 * and that no third party can check.
 *
 * Phase 1b does NOT change that column. It adds a resolution step a reader can
 * take at display time: `sub` → historically proved pubkey(s) → a portable,
 * checkable identity. The stored value stays opaque and stable; the identity
 * remains verifiable even if the live account link is later removed. This
 * endpoint is the hub's half of that step.
 *
 * ## What "verifiable" means here, precisely
 *
 * Each entry carries the VERBATIM NIP-01 event the subject signed during the
 * linkage ceremony. A reader does not have to trust the hub's assertion: it
 * can re-serialize the event, recompute the NIP-01 id, and check the BIP-340
 * signature itself. What that proves is *"the holder of this key asserted, at
 * this timestamp, against this hub's challenge, that they are this account."*
 *
 * What it does NOT prove, and the response must not be read as claiming: that
 * the request which produced any given write was itself signed by that key.
 * Nobody authenticates with a Nostr key in phase 1 — that is the doc's phase-1c
 * (signed writes), deliberately not built here.
 *
 * ## Auth + disclosure posture
 *
 * Bearer-gated on `parachute:host:auth`, matching the rest of `/api/auth/*`
 * (`mint-token`, `revoke-token`, `tokens`). This is a **directory of who has
 * proved possession of which key**, including historical proofs rather than a
 * claim about who holds the key now, so it is operator-level on purpose.
 *
 * That is also an acknowledged SEAM, not an oversight: the natural consumer of
 * phase-1b resolution is a resource server (the vault, rendering `created_by`),
 * and a vault token does not hold `parachute:host:auth`. Widening this
 * endpoint's audience is a question about who may read the identity directory
 * — squarely an ACL question (design doc seam S1/S1b, Jon's), so phase 1 leaves
 * it at the operator level rather than guessing.
 *
 * An unknown subject and a subject that never proved a key return the SAME
 * body shape with an empty list. There is no user-existence oracle here.
 */
import type { Database } from "bun:sqlite";
import { validateAccessToken } from "./jwt-sign.ts";
import { attributionProofsForSubject } from "./pubkey-links.ts";

/** Scope required on the bearer. Same gate as `GET /api/auth/tokens`. */
export const API_ATTRIBUTION_REQUIRED_SCOPE = "parachute:host:auth";

/**
 * Upper bound on the `subject` query parameter. A hub `sub` is a UUID (36) or
 * a short operator/service label; 128 is comfortably above any real value and
 * keeps a multi-kilobyte query string from reaching the DB layer.
 */
export const MAX_ATTRIBUTION_SUBJECT_LEN = 128;

export interface ApiAttributionDeps {
  db: Database;
  /** Hub origin — used to validate the bearer's `iss`. */
  issuer: string;
  /**
   * SET of origins the hub answers on (`buildHubBoundOrigins`). The bearer's
   * `iss` is validated against this rather than the single `issuer`, so a
   * credential minted under a still-valid prior origin keeps working across an
   * origin switch (hub#516 parity). Absent → falls back to `[issuer]`.
   */
  knownIssuers?: readonly string[];
}

export async function handleApiAttribution(
  req: Request,
  deps: ApiAttributionDeps,
): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }

  // 1. Bearer presence + parsing. Scheme is case-insensitive per RFC 7235.
  const auth = req.headers.get("authorization");
  if (!auth || !/^Bearer\s+/i.test(auth)) {
    return jsonError(401, "unauthenticated", "Authorization: Bearer <token> required");
  }
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer) return jsonError(401, "unauthenticated", "empty bearer token");

  // 2. Bearer validation (signature, issuer, expiry, revocation).
  let bearerScopes: string[];
  try {
    const validated = await validateAccessToken(
      deps.db,
      bearer,
      deps.knownIssuers ?? [deps.issuer],
    );
    if (typeof validated.payload.sub !== "string" || validated.payload.sub.length === 0) {
      return jsonError(401, "unauthenticated", "bearer token has no sub claim");
    }
    bearerScopes =
      typeof validated.payload.scope === "string"
        ? validated.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }

  // 3. Scope gate.
  if (!bearerScopes.includes(API_ATTRIBUTION_REQUIRED_SCOPE)) {
    return jsonError(
      403,
      "insufficient_scope",
      `bearer token lacks ${API_ATTRIBUTION_REQUIRED_SCOPE}`,
    );
  }

  // 4. Input. `subject` is the only parameter and is used solely as a bound
  //    parameter in an equality lookup — never interpolated, never a path.
  const raw = new URL(req.url).searchParams.get("subject");
  const subject = raw === null ? "" : raw.trim();
  if (subject.length === 0) {
    return jsonError(400, "invalid_request", "subject is required and must be non-empty");
  }
  if (subject.length > MAX_ATTRIBUTION_SUBJECT_LEN) {
    return jsonError(
      400,
      "invalid_request",
      `subject must be at most ${MAX_ATTRIBUTION_SUBJECT_LEN} characters`,
    );
  }

  // 5. Resolve from the durable proof archive. An unknown subject simply
  //    has no rows — same body as a subject that never established a proof.
  //    Deliberately include historical proofs whose live account link was
  //    removed: downstream attribution snapshots must stay independently
  //    verifiable after unlink or account deletion.
  const pubkeys = attributionProofsForSubject(deps.db, subject).map((link) => ({
    pubkey: link.pubkey,
    label: link.label,
    linked_at: link.linkedAt,
    last_verified_at: link.lastVerifiedAt,
    proof_event_id: link.proofEventId,
    // The stored proof, parsed back to an object so the consumer gets the same
    // native shape it would sign. Malformed JSON (impossible via the ceremony —
    // we store `JSON.stringify` of a parsed event — but defense in depth)
    // surfaces as null rather than crashing the response.
    proof_event: parseProof(link.proofEvent),
  }));

  return new Response(JSON.stringify({ subject, pubkeys }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function parseProof(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
