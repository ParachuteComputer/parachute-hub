/**
 * `GET /.well-known/parachute-revocation.json` — public list of revoked,
 * not-yet-expired token jtis. Resource servers (vault, scribe, agent)
 * fetch this on a 60s TTL and reject any presented JWT whose jti appears.
 *
 * Public endpoint (no auth). The list itself is harmless to expose: it's
 * a list of opaque IDs whose only utility is "this token shouldn't be
 * accepted." A leaked list doesn't enable any new attack — at worst, an
 * attacker learns which compromise the operator already cleaned up.
 *
 * Already-expired jtis are filtered out: every consumer checks `exp`
 * itself, so listing expired tokens just bloats the response. The
 * revocation list exists for *unexpired* tokens whose validity got cut
 * short. Once `exp` passes, a row falls off the list naturally.
 *
 * Caching: 60s `Cache-Control: max-age=60` matches the consumer's
 * polling cadence (Phase 4 wires the 60s TTL on the resource-server
 * side). Shorter cache = revocation propagates faster but burns more
 * CPU on this endpoint; 60s is the published convergence target.
 */
import type { Database } from "bun:sqlite";
import { listActiveRevocations } from "./jwt-sign.ts";

export const REVOCATION_LIST_MOUNT = "/.well-known/parachute-revocation.json";
/** Consumer cache TTL in seconds. Resource servers should poll on this cadence. */
export const REVOCATION_LIST_CACHE_SECONDS = 60;

export interface RevocationListDeps {
  db: Database;
  /** Test seam for time. */
  now?: () => Date;
}

interface RevocationListBody {
  generated_at: string;
  jtis: string[];
}

export function handleRevocationList(req: Request, deps: RevocationListDeps): Response {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  const now = deps.now?.() ?? new Date();
  const jtis = listActiveRevocations(deps.db, now);
  const body: RevocationListBody = {
    generated_at: now.toISOString(),
    jtis,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${REVOCATION_LIST_CACHE_SECONDS}`,
    },
  });
}
