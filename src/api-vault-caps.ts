/**
 * `/api/vault-caps*` — admin visibility + edit for per-vault storage caps
 * (DEMO-PREP-2026-06-25 Workstream B5 / D-slice).
 *
 * PR #686 shipped the `vault_caps` table + `setVaultCap`/`getVaultCapBytes`
 * (provision-time persistence) and a separate Phase-2 PR reads + ENFORCES the
 * cap at upload time. This file is the OPERATOR-FACING seam in between: the
 * admin SPA needs to SEE who has what cap and EDIT a cap live in the demo.
 *
 * Surfaces:
 *
 *   GET /api/vault-caps          list every vault (from services.json) joined
 *                                with its persisted cap (host:admin)
 *   PUT /api/vault-caps/:name    set/update a vault's cap to N bytes (host:admin)
 *
 * The list is the JOIN of "what vaults exist" (services.json, the canonical
 * vault-name source) and "what caps are persisted" (`vault_caps`). A vault
 * with no cap row appears with `cap_bytes: null` (uncapped) — the same
 * "uncapped = no row" contract the Phase-2 enforcement reader relies on.
 *
 * Wire shape is snake_case (matches `/api/users`, `/api/invites`). Auth: same
 * `parachute:host:admin` Bearer gate as every other `/api/*` admin surface;
 * the SPA mints it from the session cookie via `/admin/host-admin-token`.
 *
 * Scope discipline: PUT only sets a cap on a vault that is REGISTERED in
 * services.json (rejects a stale / typo name with 400 `vault_not_found`) so an
 * operator can't seed a cap row for a vault that doesn't exist. Additive only —
 * this never changes the provision-time cap-persistence from #686; it's a
 * read + targeted-edit layer on the same table.
 */
import type { Database } from "bun:sqlite";
import { type AdminAuthError, adminAuthErrorResponse, requireScope } from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { getVaultCap, setVaultCap } from "./vault-caps.ts";
import { listVaultNamesFromPath } from "./vault-names.ts";

export interface ApiVaultCapsDeps {
  db: Database;
  /** Hub origin — JWT `iss` validation. */
  issuer: string;
  /**
   * SET of origins the hub answers on (loopback ∪ expose-state ∪ platform ∪
   * per-request `issuer`), built via `buildHubBoundOrigins`. The bearer's
   * `iss` is validated against THIS set rather than the single `issuer`, so a
   * credential minted under a still-valid prior origin keeps working across an
   * origin switch (hub#516 parity). Absent → falls back to `[issuer]` (the
   * prior strict per-request behavior; tests/non-HTTP callers unaffected).
   */
  knownIssuers?: readonly string[];
  /** Override services.json path. Defaults to `~/.parachute/services.json`. */
  manifestPath?: string;
}

/**
 * One row in the `GET /api/vault-caps` response: a vault name + its cap. A
 * vault with no persisted cap carries `cap_bytes: null` (uncapped); `created_at`
 * / `updated_at` are null too in that case.
 */
export interface VaultCapWireShape {
  vault_name: string;
  cap_bytes: number | null;
  created_at: string | null;
  updated_at: string | null;
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * GET /api/vault-caps — every vault registered in services.json, joined with
 * its persisted cap (null = uncapped). Ordered by vault name.
 */
export async function handleListVaultCaps(req: Request, deps: ApiVaultCapsDeps): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const names = listVaultNamesFromPath(manifestPath);
  const caps: VaultCapWireShape[] = names.map((vaultName) => {
    const cap = getVaultCap(deps.db, vaultName);
    return {
      vault_name: vaultName,
      cap_bytes: cap?.capBytes ?? null,
      created_at: cap?.createdAt ?? null,
      updated_at: cap?.updatedAt ?? null,
    };
  });
  return new Response(JSON.stringify({ vault_caps: caps }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

interface SetCapBody {
  cap_bytes: number;
}

interface ParseErr {
  ok: false;
  status: number;
  error: string;
  description: string;
}

async function parseSetCapBody(req: Request): Promise<{ ok: true; body: SetCapBody } | ParseErr> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: "Content-Type must be application/json",
    };
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: `invalid JSON body: ${msg}`,
    };
  }
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: "request body must be a JSON object",
    };
  }
  const obj = raw as Record<string, unknown>;
  const capBytes = obj.cap_bytes;
  // Positive integer only — the table's CHECK (cap_bytes > 0) is the at-rest
  // backstop; this is the edge validation so the operator gets a clean 400
  // instead of a sqlite constraint error. A fractional byte count (which a byte
  // count can never be) is rejected rather than silently floored downstream.
  if (typeof capBytes !== "number" || !Number.isInteger(capBytes) || capBytes <= 0) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: '"cap_bytes" must be a positive integer number of bytes',
    };
  }
  return { ok: true, body: { cap_bytes: capBytes } };
}

/**
 * PUT /api/vault-caps/:name — set or update a vault's storage cap.
 *
 * Order of checks (mirrors the /api/users handlers):
 *
 *   1. Method gate (405 on non-PUT).
 *   2. Bearer carries `parachute:host:admin` (401 / 403 via `requireScope`).
 *   3. Parse + validate body (400 on shape / non-positive cap).
 *   4. Vault is registered in services.json (400 `vault_not_found`) — refuse
 *      to seed a cap for a vault that doesn't exist.
 *   5. `setVaultCap` (upsert) — overwrites the cap, bumps `updated_at`,
 *      preserves the original `created_at`.
 *
 * Response on success: `200 { vault_cap: <wire shape> }`.
 */
export async function handleSetVaultCap(
  req: Request,
  vaultName: string,
  deps: ApiVaultCapsDeps,
): Promise<Response> {
  if (req.method !== "PUT") {
    return jsonError(405, "method_not_allowed", "use PUT");
  }
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const parsed = await parseSetCapBody(req);
  if (!parsed.ok) {
    return jsonError(parsed.status, parsed.error, parsed.description);
  }
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const known = new Set(listVaultNamesFromPath(manifestPath));
  if (!known.has(vaultName)) {
    return jsonError(
      400,
      "vault_not_found",
      `vault "${vaultName}" is not registered in services.json`,
    );
  }
  const cap = setVaultCap(deps.db, vaultName, parsed.body.cap_bytes);
  console.log(`vault cap set: vault=${vaultName} cap_bytes=${cap.capBytes}`);
  const wire: VaultCapWireShape = {
    vault_name: cap.vaultName,
    cap_bytes: cap.capBytes,
    created_at: cap.createdAt,
    updated_at: cap.updatedAt,
  };
  return new Response(JSON.stringify({ vault_cap: wire }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
