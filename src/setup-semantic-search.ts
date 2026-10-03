/**
 * Semantic-search opt-in for the first-run setup wizard (hub#966).
 *
 * Since vault 0.7.3 semantic search is off by default. The only way to turn it
 * on was the vault admin's Semantic search page (or hand-editing
 * `~/.parachute/vault/config.yaml`), which a new operator won't find. The
 * wizard's vault step now offers a checkbox; when it's ticked, this module
 * does the two things the admin page leaves to the operator:
 *
 *   1. `PUT /vault/<name>/.parachute/embeddings {"enabled": true}` — the
 *      vault's own toggle (vault:<name>:admin). It persists
 *      `embeddings_enabled` to the vault's config.yaml and reports whether the
 *      running process still needs a restart to pick it up.
 *   2. When the vault says `restart_required`, restart it through the
 *      supervisor. The embedding provider is resolved once at vault boot, so
 *      the setting isn't live until then.
 *
 * Best-effort by contract: the function never throws, and a failure only ever
 * produces a message telling the operator how to finish by hand. Semantic
 * search is an optional extra; it must never fail setup.
 *
 * Lives outside setup-wizard.ts (like `postVaultImportImpl`'s job, but pure
 * over its injected fetch + restart) so it's testable without a supervisor or
 * a running vault.
 */

/** The subset of vault's `EmbeddingsSettingsSnapshot` the wizard reads. */
interface EmbeddingsSnapshot {
  enabled?: boolean;
  env_forced?: boolean;
  effective?: boolean;
  active?: boolean;
  restart_required?: boolean;
}

export interface EnableSemanticSearchArgs {
  vaultName: string;
  /** Vault's supervised loopback port. We talk to it directly, like the import follow-up. */
  vaultPort: number;
  /** Short-lived `vault:<name>:admin` Bearer, audience `vault.<name>`. */
  bearerToken: string;
  /**
   * Restart the vault module so the boot-time provider picks up the setting.
   * Resolves to `undefined` on success, or an error message. Must not throw
   * (a throw is caught and treated as a failure anyway).
   */
  restartVault: () => Promise<string | undefined>;
  fetcher?: typeof fetch;
  /** Test seam: delay between connection-refused retries. Default 1000ms. */
  retryDelayMs?: number;
}

export interface EnableSemanticSearchResult {
  /** The setting is saved AND in force (or will be after the restart we did). */
  ok: boolean;
  /** Whether we restarted the vault. */
  restarted: boolean;
  /** One operator-facing line for the op log / CLI output. */
  message: string;
}

/** How the operator finishes by hand when anything below fails. */
export const SEMANTIC_SEARCH_MANUAL_HINT =
  "turn it on later from the vault admin's Semantic search page, then `parachute restart vault`";

export async function enableSemanticSearch(
  args: EnableSemanticSearchArgs,
): Promise<EnableSemanticSearchResult> {
  const fetcher = args.fetcher ?? fetch;
  const retryDelayMs = args.retryDelayMs ?? 1000;
  const url = `http://127.0.0.1:${args.vaultPort}/vault/${encodeURIComponent(args.vaultName)}/.parachute/embeddings`;

  // Same boot-lag retry as `postVaultImportImpl`: the supervisor's `start`
  // returns before vault accepts traffic, so a refused connection right after
  // install is expected. Anything else fails fast.
  let snapshot: EmbeddingsSnapshot | undefined;
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetcher(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${args.bearerToken}`,
        },
        body: JSON.stringify({ enabled: true }),
      });
      if (res.status !== 200) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        // 404 is the one worth naming: a vault older than 0.7.3 has no toggle.
        const detail =
          res.status === 404
            ? "this vault version has no embeddings setting (needs vault 0.7.3+)"
            : (body.message ?? body.error ?? "unknown error");
        return {
          ok: false,
          restarted: false,
          message: `semantic search not enabled — vault returned ${res.status}: ${detail}; ${SEMANTIC_SEARCH_MANUAL_HINT}`,
        };
      }
      snapshot = (await res.json().catch(() => ({}))) as EmbeddingsSnapshot;
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (lastErr.includes("ECONNREFUSED") || lastErr.includes("Failed to fetch")) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      break;
    }
  }
  if (!snapshot) {
    return {
      ok: false,
      restarted: false,
      message: `semantic search not enabled — couldn't reach the vault (${lastErr || "no response"}); ${SEMANTIC_SEARCH_MANUAL_HINT}`,
    };
  }

  // The EMBEDDINGS_ENABLED env var wins over the persisted setting. When it's
  // forcing "off", restarting changes nothing — say so instead of pretending.
  if (snapshot.env_forced && snapshot.effective === false) {
    return {
      ok: false,
      restarted: false,
      message:
        "semantic search saved, but the EMBEDDINGS_ENABLED env var is forcing it off — remove it from the vault's environment, then `parachute restart vault`",
    };
  }

  if (!snapshot.restart_required) {
    return { ok: true, restarted: false, message: "semantic search on (already active)" };
  }

  let restartErr: string | undefined;
  try {
    restartErr = await args.restartVault();
  } catch (err) {
    restartErr = err instanceof Error ? err.message : String(err);
  }
  if (restartErr !== undefined) {
    return {
      ok: false,
      restarted: false,
      message: `semantic search saved, but restarting the vault failed (${restartErr}) — run \`parachute restart vault\` to apply`,
    };
  }
  return {
    ok: true,
    restarted: true,
    message:
      "semantic search on — vault restarted; the ~34 MB model downloads on first use and existing notes are indexed in the background",
  };
}

/**
 * Parse the wizard's checkbox / JSON field. The browser posts `on` (checkbox
 * default value) only when ticked; the CLI posts a JSON boolean, which
 * `readBodyFields` stringifies to `"true"` / `"false"`. Anything else is off —
 * the opt-in never turns itself on by accident.
 */
export function parseSemanticSearchField(raw: string | null): boolean {
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v === "on" || v === "true" || v === "1" || v === "yes";
}
