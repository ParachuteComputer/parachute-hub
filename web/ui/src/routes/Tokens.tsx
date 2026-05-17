/**
 * /hub/tokens — admin UI over the hub's token registry.
 *
 * Three actions:
 *   1. List rows from `GET /api/auth/tokens` with status filter (all /
 *      live / revoked) and "Load more" cursor pagination.
 *   2. Mint a new token via `POST /api/auth/mint-token` (inline form;
 *      reveals the JWT once via a mint-banner with copy-to-clipboard).
 *   3. Revoke per-row via `POST /api/auth/revoke-token` with a confirm
 *      step (mirrors Permissions' revoke flow).
 *
 * Auth is the shared `parachute_hub_session` cookie → host-admin JWT
 * dance from `lib/auth.ts`. The page itself only needs to render — the
 * lib helpers handle the redirect-to-login on session expiry.
 *
 * `permissions` arrives parsed (object, not raw JSON string) thanks to
 * the hub-side parsing introduced in hub#226 F1; the form input is a
 * textarea that the operator types as JSON, validated client-side
 * before posting.
 */
import { type FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  type AdminTokenCreatedVia,
  type AdminTokenListing,
  HttpError,
  type ListTokensOpts,
  type MintedToken,
  listTokens,
  mintToken,
  revokeToken,
} from "../lib/api.ts";

type FilterValue = "all" | "live" | "revoked";

/** Source filter values. `all` is the default; the other three map 1:1 to
 * `created_via` on the wire. */
type SourceFilter = "all" | AdminTokenCreatedVia;

type ListState =
  | { kind: "loading" }
  | { kind: "ok"; tokens: AdminTokenListing[]; nextCursor: string | null }
  | { kind: "error"; message: string };

type MintState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "minted"; token: MintedToken }
  | { kind: "error"; message: string };

type RevokeState =
  | { kind: "idle" }
  | { kind: "confirming"; jti: string }
  | { kind: "revoking"; jti: string }
  | { kind: "error"; jti: string; message: string };

interface MintFormFields {
  scope: string;
  audience: string;
  expiresIn: string;
  subject: string;
  permissions: string;
}

const EMPTY_FORM: MintFormFields = {
  scope: "",
  audience: "",
  expiresIn: "",
  subject: "",
  permissions: "",
};

export function Tokens() {
  // Filter state lives in the URL via react-router's `useSearchParams` so
  // refresh + share preserve the operator's view. Default value when the
  // param is absent (or unrecognized) is `all` for both dimensions —
  // matches the "show everything" UX from before this filter pair existed.
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = readStatusFilter(searchParams.get("status"));
  const sourceFilter = readSourceFilter(searchParams.get("source"));

  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [mint, setMint] = useState<MintState>({ kind: "idle" });
  const [form, setForm] = useState<MintFormFields>(EMPTY_FORM);
  const [revoke, setRevoke] = useState<RevokeState>({ kind: "idle" });
  const [showForm, setShowForm] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  /**
   * Update one filter dimension while preserving the other (and any
   * unrelated query params). Strips the param entirely when set to the
   * default `all` value — keeps the URL minimal in the common case.
   */
  function setFilterParam(key: "status" | "source", value: string): void {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "all") next.delete(key);
        else next.set(key, value);
        return next;
      },
      // `replace`, not push: filter changes shouldn't flood browser history.
      // Back-button from the table goes to the previous app route, not back
      // through every filter state the operator clicked through.
      { replace: true },
    );
  }

  useEffect(() => {
    void reload;
    let cancelled = false;
    setList({ kind: "loading" });
    listTokens(buildListOpts(filter, sourceFilter))
      .then((page) => {
        if (cancelled) return;
        setList({ kind: "ok", tokens: page.tokens, nextCursor: page.next_cursor });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setList({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [reload, filter, sourceFilter]);

  // Canonical "Load more" pattern for paginated admin surfaces. Future
  // paginated views (Permissions if it grows pagination, any next-chunk
  // admin route) should mirror this shape — see web/ui/CLAUDE.md §
  // Pagination convention. The pattern's three ingredients:
  //   1. `loadingMore` boolean state (useState) flipped true before fetch.
  //   2. `disabled={loadingMore}` on the button (primary double-click defense).
  //   3. Early `if (loadingMore) return` inside the handler
  //      (belt-and-suspenders for fast-finger keyboard activation, since
  //      `disabled` only blocks pointer events).
  // The button text also flips to "Loading…" so the state is visible to
  // the operator, not just enforced behind the disabled attribute.
  async function loadMore(): Promise<void> {
    if (list.kind !== "ok" || !list.nextCursor) return;
    // Guard against double-clicks: a second invocation while the first
    // request is in flight would close over the same `list.tokens` and
    // overwrite the first call's appended page on resolve. The `disabled`
    // attribute on the button is the primary defense; this state guard is
    // belt-and-suspenders for fast-finger keyboard activation.
    if (loadingMore) return;
    const opts: ListTokensOpts = {
      ...buildListOpts(filter, sourceFilter),
      cursor: list.nextCursor,
    };
    setLoadingMore(true);
    try {
      const page = await listTokens(opts);
      setList({
        kind: "ok",
        tokens: [...list.tokens, ...page.tokens],
        nextCursor: page.next_cursor,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setList({ kind: "error", message });
    } finally {
      setLoadingMore(false);
    }
  }

  async function onSubmitMint(e: FormEvent): Promise<void> {
    e.preventDefault();
    const scope = form.scope.trim();
    if (scope.length === 0) {
      setMint({ kind: "error", message: "scope is required" });
      return;
    }
    let permissions: Record<string, unknown> | undefined;
    if (form.permissions.trim().length > 0) {
      try {
        const parsed = JSON.parse(form.permissions) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setMint({
            kind: "error",
            message: 'permissions must be a JSON object (e.g. {"vault":{"default":...}})',
          });
          return;
        }
        permissions = parsed as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setMint({ kind: "error", message: `permissions is not valid JSON — ${msg}` });
        return;
      }
    }
    let expiresIn: number | undefined;
    if (form.expiresIn.trim().length > 0) {
      const n = Number(form.expiresIn);
      if (!Number.isInteger(n) || n <= 0) {
        setMint({ kind: "error", message: "expires_in must be a positive integer (seconds)" });
        return;
      }
      expiresIn = n;
    }

    setMint({ kind: "submitting" });
    try {
      const minted = await mintToken({
        scope,
        ...(form.audience.trim() ? { audience: form.audience.trim() } : {}),
        ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
        ...(form.subject.trim() ? { subject: form.subject.trim() } : {}),
        ...(permissions ? { permissions } : {}),
      });
      setMint({ kind: "minted", token: minted });
      setForm(EMPTY_FORM);
      setShowForm(false);
      setReload((n) => n + 1);
    } catch (err) {
      const message =
        err instanceof HttpError
          ? `mint failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setMint({ kind: "error", message });
    }
  }

  async function onConfirmRevoke(jti: string): Promise<void> {
    setRevoke({ kind: "revoking", jti });
    try {
      await revokeToken(jti);
      setRevoke({ kind: "idle" });
      setReload((n) => n + 1);
    } catch (err) {
      const message =
        err instanceof HttpError
          ? `revoke failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setRevoke({ kind: "error", jti, message });
    }
  }

  function copyTokenToClipboard(token: string): void {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(token);
    }
  }

  return (
    <div>
      <div className="list-header">
        <h2>Tokens</h2>
        <button type="button" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Hide form" : "Mint new token"}
        </button>
      </div>

      <p className="muted">
        The hub's token registry. Every CLI / OAuth / operator-mint writes a row here. Revoking
        flips <code>revoked_at</code>; resource servers on{" "}
        <code>@openparachute/scope-guard@^0.2.0</code> reject within ~60s of the next poll.
      </p>

      {mint.kind === "minted" ? (
        <div className="mint-banner">
          <h3>Minted</h3>
          <p>
            Your new access token (jti: <code>{mint.token.jti}</code>):
          </p>
          <div className="token-box">
            <code>{mint.token.token}</code>
          </div>
          <p className="warn">
            This is the only time the JWT is shown. Copy it now — there is no DB-side recovery.
          </p>
          <div className="actions">
            <button type="button" onClick={() => copyTokenToClipboard(mint.token.token)}>
              Copy
            </button>
            <button type="button" className="secondary" onClick={() => setMint({ kind: "idle" })}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {showForm ? (
        <div className="section">
          <form onSubmit={onSubmitMint}>
            <div className="row">
              <label htmlFor="mint-scope">Scope (space-separated)</label>
              <input
                id="mint-scope"
                type="text"
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value })}
                placeholder="e.g. scribe:transcribe vault:default:read"
                required
              />
              <div className="field-hint">
                Space-separated <code>resource:verb</code> or <code>resource:name:verb</code>{" "}
                tuples. The hub rejects non-requestable scopes (admin, host:*) per the
                privilege-diffusion guard.
              </div>
            </div>

            <div className="row">
              <label htmlFor="mint-audience">Audience (optional)</label>
              <input
                id="mint-audience"
                type="text"
                value={form.audience}
                onChange={(e) => setForm({ ...form, audience: e.target.value })}
                placeholder="inferred from scope when blank"
              />
              <div className="field-hint">
                Inferred from scope if omitted. <code>vault:&lt;name&gt;:&lt;verb&gt;</code> →{" "}
                <code>vault.&lt;name&gt;</code>; otherwise the first colon-prefixed scope's
                namespace; fallback <code>hub</code>.
              </div>
            </div>

            <div className="row">
              <label htmlFor="mint-expires-in">Expires in (seconds, optional)</label>
              <input
                id="mint-expires-in"
                type="text"
                inputMode="numeric"
                value={form.expiresIn}
                onChange={(e) => setForm({ ...form, expiresIn: e.target.value })}
                placeholder="default 90d (7776000)"
              />
            </div>

            <div className="row">
              <label htmlFor="mint-subject">Subject (optional)</label>
              <input
                id="mint-subject"
                type="text"
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                placeholder="defaults to operator's sub"
              />
            </div>

            <div className="row">
              <label htmlFor="mint-permissions">Permissions (JSON object, optional)</label>
              <textarea
                id="mint-permissions"
                value={form.permissions}
                onChange={(e) => setForm({ ...form, permissions: e.target.value })}
                placeholder='e.g. {"vault":{"default":{"write_tags":["health"]}}}'
                rows={3}
                style={{ width: "100%", fontFamily: "monospace", fontSize: "0.9rem" }}
              />
            </div>

            {mint.kind === "error" ? (
              <div className="field-error">
                <code>{mint.message}</code>
              </div>
            ) : null}

            <div className="actions">
              <button type="submit" disabled={mint.kind === "submitting"}>
                {mint.kind === "submitting" ? "Minting…" : "Mint"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setShowForm(false);
                  setForm(EMPTY_FORM);
                  setMint({ kind: "idle" });
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <div style={{ marginTop: "1rem", marginBottom: "0.5rem", display: "flex", gap: "0.5rem" }}>
        <span className="muted" style={{ marginRight: "0.5rem", minWidth: "4rem" }}>
          Status:
        </span>
        {(
          [
            { value: "all", label: "Show all" },
            { value: "live", label: "Live only" },
            { value: "revoked", label: "Revoked only" },
          ] as const
        ).map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setFilterParam("status", opt.value)}
            className={filter === opt.value ? undefined : "secondary"}
            aria-pressed={filter === opt.value}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem" }}>
        <span className="muted" style={{ marginRight: "0.5rem", minWidth: "4rem" }}>
          Source:
        </span>
        {(
          [
            { value: "all", label: "All sources" },
            { value: "oauth_refresh", label: "OAuth" },
            { value: "operator_mint", label: "Operator" },
            { value: "cli_mint", label: "CLI mint" },
          ] as const
        ).map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setFilterParam("source", opt.value)}
            className={sourceFilter === opt.value ? undefined : "secondary"}
            aria-pressed={sourceFilter === opt.value}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {renderList({
        list,
        revoke,
        setRevoke,
        onConfirm: onConfirmRevoke,
        onLoadMore: loadMore,
        onRetry: () => setReload((n) => n + 1),
        loadingMore,
        filtersActive: filter !== "all" || sourceFilter !== "all",
      })}
    </div>
  );
}

interface RenderListProps {
  list: ListState;
  revoke: RevokeState;
  setRevoke: (s: RevokeState) => void;
  onConfirm: (jti: string) => Promise<void>;
  onLoadMore: () => Promise<void>;
  onRetry: () => void;
  loadingMore: boolean;
  /** True when either filter dimension is narrowed; drives empty-state copy. */
  filtersActive: boolean;
}

function renderList({
  list,
  revoke,
  setRevoke,
  onConfirm,
  onLoadMore,
  onRetry,
  loadingMore,
  filtersActive,
}: RenderListProps) {
  if (list.kind === "loading") {
    return <p className="muted">Loading…</p>;
  }
  if (list.kind === "error") {
    return (
      <>
        <div className="error-banner">
          Couldn't load tokens: <code>{list.message}</code>
        </div>
        <button type="button" onClick={onRetry} className="secondary">
          Retry
        </button>
      </>
    );
  }
  if (list.tokens.length === 0) {
    if (filtersActive) {
      return (
        <div className="empty empty-rich">
          <p className="empty-headline">No tokens match the current filter.</p>
          <p className="muted">
            Try widening the Status or Source pills above. The default "Show all / All sources" view
            shows every registry row.
          </p>
        </div>
      );
    }
    return (
      <div className="empty empty-rich">
        <p className="empty-headline">No tokens.</p>
        <p className="muted">
          Every CLI mint, OAuth grant, and operator-token rotation lands here. Mint one with the
          form above, or via <code>parachute auth mint-token</code>.
        </p>
      </div>
    );
  }

  return (
    <div>
      {list.tokens.map((t) => {
        const status = tokenStatus(t);
        const isRevoking = revoke.kind === "revoking" && revoke.jti === t.jti;
        const isConfirming = revoke.kind === "confirming" && revoke.jti === t.jti;
        const rowError = revoke.kind === "error" && revoke.jti === t.jti ? revoke : null;
        const identity = t.user_id ?? t.subject ?? "(unknown)";
        return (
          <div key={t.jti} className="vault-row">
            <div className="body">
              <div className="name">
                <code title={t.jti}>{truncateJti(t.jti)}</code>
                <span className={`tag${status === "live" ? "" : " muted"}`}>{status}</span>
                <span
                  className={`tag source-${sourceClassFor(t.created_via)}`}
                  title={`created_via: ${t.created_via}`}
                >
                  {sourceLabelFor(t.created_via)}
                </span>
              </div>
              <div className="dim" style={{ marginTop: "0.25rem" }}>
                <span className="muted">identity: </span>
                <code>{identity}</code>
                {t.client_id ? (
                  <>
                    <span className="muted"> · client: </span>
                    <code>{t.client_id}</code>
                  </>
                ) : null}
              </div>
              <div className="dim" style={{ marginTop: "0.25rem" }}>
                <span className="muted">scope: </span>
                {t.scopes.map((s, i) => (
                  <span key={s}>
                    <code>{s}</code>
                    {i < t.scopes.length - 1 ? " " : null}
                  </span>
                ))}
              </div>
              <div className="dim" style={{ marginTop: "0.25rem", fontSize: "0.82rem" }}>
                <span className="muted">created </span>
                <code title={t.created_at}>{formatDate(t.created_at)}</code>
                <span className="muted"> · expires </span>
                <code title={t.expires_at}>{formatDate(t.expires_at)}</code>
                {t.revoked_at ? (
                  <>
                    <span className="muted"> · revoked </span>
                    <code title={t.revoked_at}>{formatDate(t.revoked_at)}</code>
                  </>
                ) : null}
              </div>
              {t.permissions ? (
                <details style={{ marginTop: "0.35rem" }}>
                  <summary className="muted" style={{ cursor: "pointer", fontSize: "0.85rem" }}>
                    permissions
                  </summary>
                  <pre style={{ fontSize: "0.82rem", marginTop: "0.25rem" }}>
                    {JSON.stringify(t.permissions, null, 2)}
                  </pre>
                </details>
              ) : null}
              {rowError ? (
                <div className="error-banner" style={{ marginTop: "0.5rem" }}>
                  <code>{rowError.message}</code>
                </div>
              ) : null}
              {isConfirming ? (
                <dialog
                  open
                  className="error-banner"
                  style={{ marginTop: "0.5rem", background: "var(--bg-warn, #fffbe6)" }}
                  aria-label={`Confirm revoke ${truncateJti(t.jti)}`}
                >
                  <p>
                    Revoke <code>{truncateJti(t.jti)}</code>? Resource servers reject within ~60s of
                    the next revocation-list poll. This cannot be undone.
                  </p>
                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                    <button
                      type="button"
                      onClick={() => {
                        void onConfirm(t.jti);
                      }}
                      disabled={isRevoking}
                    >
                      {isRevoking ? "Revoking…" : "Revoke"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setRevoke({ kind: "idle" })}
                      disabled={isRevoking}
                    >
                      Cancel
                    </button>
                  </div>
                </dialog>
              ) : null}
            </div>
            {!isConfirming && status === "live" ? (
              <button
                type="button"
                className="secondary"
                onClick={() => setRevoke({ kind: "confirming", jti: t.jti })}
                aria-label={`Revoke ${truncateJti(t.jti)}`}
              >
                Revoke
              </button>
            ) : null}
          </div>
        );
      })}

      {list.nextCursor ? (
        <div style={{ marginTop: "1rem" }}>
          <button
            type="button"
            className="secondary"
            disabled={loadingMore}
            onClick={() => {
              void onLoadMore();
            }}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function tokenStatus(t: AdminTokenListing): "live" | "expired" | "revoked" {
  if (t.revoked_at) return "revoked";
  const exp = new Date(t.expires_at).getTime();
  if (!Number.isNaN(exp) && exp < Date.now()) return "expired";
  return "live";
}

/** Status filter parser. Unknown / missing → `all`. */
function readStatusFilter(raw: string | null): FilterValue {
  if (raw === "live" || raw === "revoked" || raw === "all") return raw;
  return "all";
}

/** Source filter parser. Unknown / missing → `all`. */
function readSourceFilter(raw: string | null): SourceFilter {
  if (raw === "oauth_refresh" || raw === "operator_mint" || raw === "cli_mint" || raw === "all") {
    return raw;
  }
  return "all";
}

/** Translate the two filter dimensions into the wire-shape opts for `listTokens`. */
function buildListOpts(filter: FilterValue, sourceFilter: SourceFilter): ListTokensOpts {
  const opts: ListTokensOpts = {};
  if (filter === "live") opts.revoked = "false";
  else if (filter === "revoked") opts.revoked = "true";
  else opts.revoked = "all";
  if (sourceFilter !== "all") opts.createdVia = sourceFilter;
  return opts;
}

/** Short label for the per-row source chip. Falls back to the raw value
 * for any future created_via values not yet known here. */
function sourceLabelFor(createdVia: string): string {
  switch (createdVia) {
    case "oauth_refresh":
      return "OAuth";
    case "operator_mint":
      return "Operator";
    case "cli_mint":
      return "CLI";
    default:
      return createdVia;
  }
}

/** CSS class suffix for the per-row source chip — drives the colored
 * variant. Unknown values fall back to muted styling. */
function sourceClassFor(createdVia: string): string {
  switch (createdVia) {
    case "oauth_refresh":
      return "oauth";
    case "operator_mint":
      return "operator";
    case "cli_mint":
      return "cli";
    default:
      return "unknown";
  }
}

function truncateJti(jti: string): string {
  if (jti.length <= 14) return jti;
  return `${jti.slice(0, 8)}…${jti.slice(-4)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
