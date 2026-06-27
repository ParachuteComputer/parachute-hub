/**
 * `parachute vault remove <name>` — route the CLI vault-delete verb through the
 * hub's identity cascade instead of the mechanics-only `parachute-vault remove`.
 *
 * ## Why this command exists (B3)
 *
 * The transparent `parachute vault <args>` passthrough (`commands/vault.ts`)
 * forwards `remove <name>` verbatim to `parachute-vault remove` — which only
 * does the MECHANICS of destruction (`rmSync` the vault dir + rewrite the vault
 * module's own config). That path BYPASSES every hub-side identity artifact tied
 * to the vault: live `vault:<name>:*` access tokens stay valid (and reachable
 * via the polled revocation list), `user_vaults` rows linger, grants keep their
 * `vault:<name>:*` entries, unredeemed invites pinned to the vault stay
 * redeemable, and Connections that source/provision the vault keep their
 * long-lived mints. Deleting a vault that way orphans all of it.
 *
 * The hub ALREADY ships the correct path: `DELETE /vaults/<name>`
 * (`admin-vaults.ts:handleDeleteVault`) runs the full 7-step identity cascade
 * (revoke tokens → rewrite grants → drop user_vaults → revoke invites → tear
 * down connections → shell `parachute-vault remove` → restart vault) and is
 * exactly what the vault-admin SPA drives. This command routes the CLI verb
 * through that SAME endpoint over loopback, so `parachute vault remove` and the
 * SPA delete are one code path.
 *
 * ## Credential + transport (reused from module-ops-client.ts)
 *
 * We drive the RUNNING hub over loopback — never open hub.db's vault registry
 * directly (the daemon holds it). The bearer is the on-disk
 * `~/.parachute/operator.token`, read (never minted) via
 * `useOperatorTokenWithAutoRotate`. Its default `admin` scope-set carries
 * `parachute:host:admin` — exactly the scope the endpoint gates on. This is the
 * same read-never-mint credential path `parachute start/stop/restart <svc>` use.
 *
 * ## Last-vault handling (#678)
 *
 * The last/only vault is deleted IDENTICALLY to any other vault: the endpoint
 * runs the full cascade-then-delete and returns 200. There is no special-case
 * here. (Older builds refused the last vault with a `409 last_vault` and steered
 * the operator to the raw `parachute-vault remove --yes` — but that escape hatch
 * SKIPS the cascade, orphaning the very identity artifacts B3 set out to clean
 * up. hub#678 removed that refusal: vault's boot can no longer silently
 * resurrect a fresh first vault because vault's CLI writes an
 * `auto_create: false` marker on last-vault removal and the boot gate honors
 * it.) This command therefore needs no 409 branch — the 200 path renders the
 * cascade summary for the last vault just like every other delete.
 */

import { CONFIG_DIR } from "../config.ts";
import { readExposeState } from "../expose-state.ts";
import { readHubPort } from "../hub-control.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { HUB_UNIT_DEFAULT_PORT } from "../hub-unit.ts";
import {
  DEFAULT_HUB_BASE_URL,
  ModuleOpHttpError,
  NoOperatorTokenError,
  OperatorTokenExpiredError,
  resolveOperatorBearer,
} from "../module-ops-client.ts";

/**
 * Injectable seams. Production wires the real operator-token bearer resolver +
 * the global `fetch`; tests inject fakes to assert the request shape + that
 * destruction always goes through the hub endpoint (never a direct
 * `parachute-vault` spawn) without a live hub or a real socket.
 */
export interface VaultRemoveDeps {
  /**
   * Resolve the operator-token bearer to present to the loopback hub. Default
   * opens hub.db, reads `~/.parachute/operator.token` (auto-rotating if near
   * expiry), and returns the JWT. Throws {@link NoOperatorTokenError} /
   * {@link OperatorTokenExpiredError} with already-actionable messages.
   */
  readonly resolveBearer?: () => Promise<string>;
  /** fetch seam — `globalThis.fetch` in production; a recorder in tests. */
  readonly fetch?: typeof fetch;
  /** Loopback hub base URL. Defaults to {@link DEFAULT_HUB_BASE_URL}. */
  readonly baseUrl?: string;
  /** Output sink. Defaults to `console.log`. */
  readonly log?: (line: string) => void;
  /** Error sink. Defaults to `console.error`. */
  readonly logError?: (line: string) => void;
}

/** Wire shape of the cascade summary nested under `cascade` in the 200 body. */
interface CascadeSummaryWire {
  tokens_revoked?: number;
  grants_rewritten?: number;
  grants_dropped?: number;
  user_vaults_removed?: number;
  invites_invalidated?: number;
  vault_cap_removed?: boolean;
  connections_torn_down?: number;
  orphaned_channels?: unknown;
  vault_removed?: boolean;
  module_restarted?: boolean;
}

interface DeleteVaultSuccessWire {
  ok?: boolean;
  name?: string;
  cascade?: CascadeSummaryWire;
  warnings?: unknown;
}

/**
 * Resolve the hub origin the operator token's `iss` is validated against —
 * mirrors `lifecycle.ts:resolveOperatorTokenIssuer`. Unlike the spawn-env
 * derivation, the operator token always carries an `iss`, so we fall back to
 * the canonical loopback origin (never `undefined`). The known-issuer SET inside
 * `useOperatorTokenWithAutoRotate` also accepts the public `iss` from
 * expose-state, so a seed of loopback still validates an exposed-origin token.
 */
function resolveOperatorTokenIssuer(configDir: string): string {
  const state = readExposeState(`${configDir}/expose-state.json`);
  if (state?.hubOrigin) return state.hubOrigin;
  const port = readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * Default bearer resolver: open hub.db, read+auto-rotate the operator token,
 * return the JWT. Closes the db before returning. Read-never-mint — no second
 * SQLite writer racing the running hub.
 */
async function defaultResolveBearer(configDir: string): Promise<string> {
  const issuer = resolveOperatorTokenIssuer(configDir);
  const db = openHubDb(hubDbPath(configDir));
  try {
    return await resolveOperatorBearer({ db, issuer, configDir });
  } finally {
    db.close();
  }
}

function n(v: number | undefined): number {
  return typeof v === "number" ? v : 0;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Render the structured cascade summary the endpoint returns — the operator's
 * proof every identity artifact was revoked, not just the vault dir removed.
 */
function renderCascadeSummary(
  name: string,
  body: DeleteVaultSuccessWire,
  log: (line: string) => void,
): void {
  const c = body.cascade ?? {};
  log(`Removed vault "${name}" with the full identity cascade:`);
  log(`  tokens revoked:        ${n(c.tokens_revoked)}`);
  log(`  grants rewritten:      ${n(c.grants_rewritten)}`);
  log(`  grants dropped:        ${n(c.grants_dropped)}`);
  log(`  user_vaults removed:   ${n(c.user_vaults_removed)}`);
  log(`  invites invalidated:   ${n(c.invites_invalidated)}`);
  log(`  storage cap removed:   ${c.vault_cap_removed === true ? "yes" : "no"}`);
  log(`  connections torn down: ${n(c.connections_torn_down)}`);
  log(`  vault removed:         ${c.vault_removed === true ? "yes" : "no"}`);
  log(`  vault module restarted:${c.module_restarted === true ? " yes" : " no"}`);

  const orphaned = asStringArray(c.orphaned_channels);
  if (orphaned.length > 0) {
    log("");
    log(`WARNING: ${orphaned.length} vault-backed agent channel(s) still reference "${name}":`);
    for (const ch of orphaned) log(`  - ${ch}`);
    log("Remove them in the agent UI — the hub does not delete the agent's config.");
  }

  // Top-level warnings[] — each a { step, detail } the cascade recorded
  // (e.g. daemon-restart skipped, a partial connection teardown).
  const warnings = Array.isArray(body.warnings) ? body.warnings : [];
  if (warnings.length > 0) {
    log("");
    log("Warnings:");
    for (const w of warnings) {
      const rec = (w ?? {}) as { step?: unknown; detail?: unknown };
      const step = typeof rec.step === "string" ? rec.step : "warning";
      const detail = typeof rec.detail === "string" ? rec.detail : JSON.stringify(w);
      log(`  - [${step}] ${detail}`);
    }
  }
}

const USAGE = "usage: parachute vault remove <name> [--yes] [--hub-origin <url>]";

/**
 * Route `parachute vault remove <name>` (and the `rm` alias) through the hub's
 * `DELETE /vaults/<name>` identity cascade. Returns the process exit code.
 */
export async function vaultRemove(args: string[], deps: VaultRemoveDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const logError = deps.logError ?? ((line: string) => console.error(line));

  // --- Parse args: positional <name> + flags (--yes/-y, --hub-origin <url>). --
  let name: string | undefined;
  let baseUrlOverride: string | undefined = deps.baseUrl;
  // `--yes`/`-y` is accepted for parity with `parachute-vault remove --yes` and
  // to telegraph non-interactive intent; the endpoint's confirm guard is
  // satisfied from the name arg, so no extra prompt is shown either way. We
  // parse it so it isn't mistaken for a positional, but the behaviour is the
  // same with or without it (this is an admin op that already requires the
  // operator token + a deliberate name retype on the wire).
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yes" || a === "-y") continue;
    if (a === "--hub-origin") {
      const v = args[i + 1];
      if (!v) {
        logError("parachute vault remove: --hub-origin requires a URL argument");
        return 1;
      }
      baseUrlOverride = v;
      i++;
      continue;
    }
    if (a?.startsWith("--hub-origin=")) {
      baseUrlOverride = a.slice("--hub-origin=".length);
      continue;
    }
    if (a?.startsWith("-")) {
      logError(`parachute vault remove: unknown flag "${a}"`);
      logError(USAGE);
      return 1;
    }
    if (name === undefined) {
      name = a;
      continue;
    }
    logError(`parachute vault remove: unexpected argument "${a}"`);
    logError(USAGE);
    return 1;
  }

  if (!name) {
    logError("parachute vault remove: a vault name is required");
    logError(USAGE);
    return 1;
  }

  // --- Resolve the operator-token bearer (read, never mint). ------------------
  let bearer: string;
  try {
    bearer = deps.resolveBearer
      ? await deps.resolveBearer()
      : await defaultResolveBearer(CONFIG_DIR);
  } catch (err) {
    if (err instanceof NoOperatorTokenError || err instanceof OperatorTokenExpiredError) {
      // Already-actionable ("run `parachute auth rotate-operator`") — surface
      // verbatim, never a raw 401.
      logError(`parachute vault remove: ${err.message}`);
      return 1;
    }
    logError(`parachute vault remove: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // --- DELETE /vaults/<name> with the confirm body. --------------------------
  const doFetch = deps.fetch ?? fetch;
  const baseUrl = (baseUrlOverride ?? DEFAULT_HUB_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/vaults/${encodeURIComponent(name)}`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ confirm: name }),
    });
  } catch (err) {
    // Loopback connection refused → the hub isn't running. The cascade needs
    // the live hub; there's no DB-side fallback we'd take (that's the bug).
    const msg = err instanceof Error ? err.message : String(err);
    const refused = /econnrefused|connection refused|failed to fetch|unable to connect/i.test(msg);
    if (refused) {
      logError(
        "parachute vault remove: the hub must be running to delete a vault with the identity cascade.",
      );
      logError("Run `parachute start`, then retry.");
      logError(
        `(The raw escape hatch \`parachute-vault remove ${name} --yes\` deletes the vault dir but SKIPS the cascade, leaving orphaned tokens.)`,
      );
      return 1;
    }
    logError(`parachute vault remove: request failed: ${msg}`);
    return 1;
  }

  const body = await parseJsonSafe(res);

  // --- Success: render the cascade summary. ----------------------------------
  if (res.status === 200) {
    renderCascadeSummary(name, (body ?? {}) as DeleteVaultSuccessWire, log);
    return 0;
  }

  // --- Error mapping (actionable, never a raw status dump). -------------------
  const { error, error_description } = asErrorBody(body, res.status);

  if (res.status === 404 && error === "not_found") {
    // Idempotent: a re-run after a successful delete lands here. Not scary.
    log(`Vault "${name}" does not exist on this hub (already removed). Nothing to do.`);
    return 0;
  }

  if (res.status === 400 && error === "confirm_mismatch") {
    // Pass the hub's confirm message through.
    logError(`parachute vault remove: ${error_description}`);
    return 1;
  }

  if (res.status === 401 || res.status === 403) {
    // The operator token was rejected by the hub — guide to re-mint rather than
    // dumping the raw status (matches module-ops-client's posture).
    logError(`parachute vault remove: the hub rejected the operator token (${error_description}).`);
    logError("Run `parachute auth rotate-operator` to mint a fresh one, then retry.");
    return 1;
  }

  // Any other non-2xx — name the failure class without a raw dump.
  logError(`parachute vault remove: ${error}: ${error_description}`);
  return 1;
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function asErrorBody(body: unknown, status: number): { error: string; error_description: string } {
  const fallback = `hub returned HTTP ${status} with no error detail`;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const error = typeof b.error === "string" ? b.error : "error";
    const error_description =
      typeof b.error_description === "string" ? b.error_description : fallback;
    return { error, error_description };
  }
  return { error: "error", error_description: fallback };
}

// Re-export so the test (and future CLI callers) can catch the typed errors
// without a second import path.
export { ModuleOpHttpError, NoOperatorTokenError, OperatorTokenExpiredError };
