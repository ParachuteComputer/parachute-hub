/**
 * /admin/approve-client/<client_id> — operator landing page for OAuth
 * client approval. Two distinct cases land here, distinguished by the
 * presence of the `return_to` query parameter (workstream D, see
 * AUDIT-UI-UX.md §5 row D and the
 * `parachute-patterns/patterns/oauth-dcr-approval.md` "SPA approve page
 * (two cases, one route)" section).
 *
 * **Case 1 — OAuth resume** (`?return_to=/oauth/authorize?...`). The
 * caller has a parked OAuth flow and wants the operator to approve the
 * client AND continue the flow in one click. On success the SPA leaves
 * itself via `window.location.assign(redirect_to)` to hub-server's
 * authorize handler, which finishes the OAuth dance against the
 * now-approved client.
 *
 * **Case 2 — share link / direct nav** (no `return_to`). Original shape
 * from before workstream D: the operator follows a deep-link surfaced by
 * `pendingClientJson()` on /oauth/token (or browses to the URL directly),
 * approves the client, then closes the tab and returns to the app that
 * sent them. Deliberately no auto-redirect — the operator opened this
 * from another tab / app, so "close this and go back" is the right goal.
 *
 * Validation: the `return_to` query param must be a hub-relative URL
 * starting with `/` and NOT starting with `//` (open-redirect defense,
 * mirroring `safeNext` in admin-handlers.ts). Off-origin values are
 * dropped (treated as "no return_to") rather than 4xx'd — the operator
 * shouldn't be locked out of a legitimate approve because of a malformed
 * deep link.
 *
 * Three-state UI (unchanged from pre-D):
 *   - **pending** → render details + Approve button.
 *   - **approved** (on load or after click) → either redirect (case 1)
 *     or render success message (case 2).
 *   - **unknown** (404 from the API) → render an error explaining the
 *     client_id wasn't found.
 */
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { type AdminClientView, HttpError, approveOauthClient, getOauthClient } from "../lib/api.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; client: AdminClientView }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

type ActionState =
  | { kind: "idle" }
  | { kind: "approving" }
  | { kind: "approved"; alreadyApproved: boolean }
  | { kind: "error"; message: string };

export function ApproveClient() {
  const { clientId: rawClientId } = useParams<{ clientId: string }>();
  const clientId = rawClientId ?? "";
  const [searchParams] = useSearchParams();
  // Validate the `return_to` query param same-origin-style. Mirrors the
  // server-side gate (`isSafeAuthorizeReturnTo` in oauth-handlers.ts) and
  // `safeNext` in admin-handlers.ts — single shape across the codebase for
  // "is this a hub-relative URL we're willing to navigate to?" Off-origin
  // or malformed values are silently dropped (treated as "no return_to")
  // so the page falls back to the share-link / dead-end success state
  // rather than 4xx'ing.
  const returnTo = sanitizeReturnTo(searchParams.get("return_to"));
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    // `reload` is a trigger dep — re-running the effect is the whole
    // point of incrementing it. Same pattern as VaultsList / Permissions.
    void reload;
    if (!clientId) {
      setLoadState({ kind: "error", message: "missing client id in URL" });
      return;
    }
    let cancelled = false;
    setLoadState({ kind: "loading" });
    getOauthClient(clientId)
      .then((client) => {
        if (cancelled) return;
        setLoadState({ kind: "ok", client });
        // If the row was already approved before the operator arrived,
        // surface the success message rather than the "Approve" button —
        // no point asking them to re-confirm an action that's done.
        //
        // Special case for the OAuth-resume flow: if `return_to` is set
        // and the client is already approved, leave the SPA immediately
        // — the parked authorize URL can finish the flow with no further
        // operator action. Saves the operator a redundant manual click
        // back to the calling app.
        if (client.status === "approved") {
          // Set action state BEFORE triggering navigation so the
          // intermediate render (between assign() being called and the
          // browser actually navigating) doesn't show the pending Approve
          // button. Real browsers finish the navigation almost instantly
          // but the SPA must still be in a consistent state for the
          // intermediate frame.
          setAction({ kind: "approved", alreadyApproved: true });
          if (returnTo) {
            window.location.assign(returnTo);
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof HttpError && err.status === 404) {
          setLoadState({ kind: "not_found" });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setLoadState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, reload, returnTo]);

  async function onApprove(): Promise<void> {
    setAction({ kind: "approving" });
    try {
      const result = await approveOauthClient(clientId, returnTo || undefined);
      // OAuth-resume case (workstream D): server echoed the same-origin-
      // validated `return_to` back as `redirect_to`. Leave the SPA to
      // resume the parked authorize flow rather than dead-ending on the
      // success state. Re-validate same-origin client-side as belt-and-
      // suspenders — the server already gated this, but the redirect is
      // a sensitive surface and double-checking is cheap.
      if (result.redirect_to && isSafeReturnTo(result.redirect_to)) {
        window.location.assign(result.redirect_to);
        return;
      }
      setAction({ kind: "approved", alreadyApproved: result.already_approved });
    } catch (err) {
      const message =
        err instanceof HttpError
          ? `approve failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setAction({ kind: "error", message });
    }
  }

  return (
    <div>
      <div className="list-header">
        <h2>Approve app</h2>
      </div>
      {renderBody({ loadState, action, onApprove, onRetry: () => setReload((n) => n + 1) })}
    </div>
  );
}

/**
 * Validate a `return_to` value as a hub-relative URL we're willing to
 * navigate to. Must start with `/` and must NOT start with `//`
 * (otherwise it's a scheme-relative URL pointing off-origin). Mirrors
 * the server-side `isSafeAuthorizeReturnTo` shape (which additionally
 * requires `/oauth/authorize?` prefix — the SPA could match that too,
 * but keeping the SPA's gate slightly broader lets future flows wire
 * different resume targets without touching the SPA. The server is the
 * authoritative gate; the SPA's job is to refuse the obvious bad shapes
 * before round-tripping a useless value).
 */
function isSafeReturnTo(value: string): boolean {
  if (!value) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  return true;
}

/** Sanitize once at the URL-parse boundary; downstream consumers see `string | null`. */
function sanitizeReturnTo(raw: string | null): string | null {
  if (raw === null) return null;
  return isSafeReturnTo(raw) ? raw : null;
}

interface RenderBodyProps {
  loadState: LoadState;
  action: ActionState;
  onApprove: () => Promise<void>;
  onRetry: () => void;
}

function renderBody({ loadState, action, onApprove, onRetry }: RenderBodyProps) {
  if (loadState.kind === "loading") {
    return <p className="muted" data-loading="true">Loading…</p>;
  }
  if (loadState.kind === "not_found") {
    return (
      <div className="empty empty-rich">
        <p className="empty-headline">Unknown client.</p>
        <p className="muted">
          This client_id isn't registered with this hub. The deep link may be stale, or the
          requesting app may have been registered against a different hub.{" "}
          <Link to="/permissions">Back to permissions</Link>.
        </p>
      </div>
    );
  }
  if (loadState.kind === "error") {
    return (
      <>
        <div className="error-banner">
          Couldn't load the client: <code>{loadState.message}</code>
        </div>
        <button type="button" onClick={onRetry} className="secondary">
          Retry
        </button>
      </>
    );
  }
  const { client } = loadState;
  const displayName = client.client_name ?? client.client_id;

  if (action.kind === "approved") {
    return (
      <div className="empty empty-rich">
        <p className="empty-headline">
          {action.alreadyApproved ? "Already approved." : "Approved."}
        </p>
        <p className="muted">
          <code>{displayName}</code>{" "}
          {action.alreadyApproved
            ? "was already on this hub's approved list."
            : "can now run an OAuth flow with this hub."}{" "}
          Return to the app that sent you here and retry the action — the request will go through
          now.
        </p>
        <p className="muted" style={{ marginTop: "1rem" }}>
          <Link to="/permissions">View permissions</Link>
        </p>
      </div>
    );
  }

  const isApproving = action.kind === "approving";
  const errorMessage = action.kind === "error" ? action.message : null;

  return (
    <div>
      <p className="muted">
        An app is asking this hub to issue OAuth tokens. Review the details below and approve only
        if you recognize the app.
      </p>
      <div className="vault-row" style={{ marginTop: "1rem" }}>
        <div className="body">
          <div className="name">
            <code>{displayName}</code>
          </div>
          <div className="dim">
            <span className="muted">client_id: </span>
            <code>{client.client_id}</code>
          </div>
          <div className="dim" style={{ marginTop: "0.25rem" }}>
            <span className="muted">redirect_uris: </span>
            {client.redirect_uris.map((u, i) => (
              <span key={u}>
                <code>{u}</code>
                {i < client.redirect_uris.length - 1 ? " " : null}
              </span>
            ))}
          </div>
          {client.scopes.length > 0 ? (
            <div className="dim" style={{ marginTop: "0.25rem" }}>
              <span className="muted">requested scopes: </span>
              {client.scopes.map((s, i) => (
                <span key={s}>
                  <code>{resolveScopeForDisplay(s)}</code>
                  {i < client.scopes.length - 1 ? " " : null}
                </span>
              ))}
              {client.scopes.some(isUnnamedVaultScope) ? (
                <p
                  className="muted"
                  style={{ marginTop: "0.4rem", fontStyle: "italic", fontSize: "0.85rem" }}
                >
                  <code>*</code> — a specific vault is selected during sign-in via the consent
                  picker (or the user's assigned vault for multi-user setups).
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="dim" style={{ marginTop: "0.25rem" }}>
            <span className="muted">registered: </span>
            <code title={client.registered_at}>{client.registered_at}</code>
          </div>
          {errorMessage ? (
            <div className="error-banner" style={{ marginTop: "0.5rem" }}>
              <code>{errorMessage}</code>
            </div>
          ) : null}
        </div>
      </div>
      <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          onClick={() => {
            void onApprove();
          }}
          disabled={isApproving}
        >
          {isApproving ? "Approving…" : `Approve ${displayName}`}
        </button>
        <Link to="/permissions" className="secondary" style={{ alignSelf: "center" }}>
          Cancel
        </Link>
      </div>
    </div>
  );
}

/**
 * Render the scope's *resolved* shape so the operator sees what'll actually
 * appear in minted tokens, not the raw OAuth request. The hub narrows
 * unnamed `vault:<verb>` to `vault:<name>:<verb>` at token-mint via the
 * consent picker (or the user's assigned vault for multi-user hubs). At
 * approve time the vault isn't bound yet, so we render the wildcard
 * `vault:*:<verb>` form with the asterisk explained inline below the
 * scope list — clearer than showing the unnamed form which implied
 * vault-wide unrestricted access.
 *
 * Non-vault scopes (`scribe:transcribe`, `channel:send`, …) and
 * already-named vault scopes (`vault:work:read`) pass through unchanged.
 */
function resolveScopeForDisplay(scope: string): string {
  if (!isUnnamedVaultScope(scope)) return scope;
  const verb = scope.split(":")[1];
  return `vault:*:${verb}`;
}

function isUnnamedVaultScope(scope: string): boolean {
  const parts = scope.split(":");
  if (parts.length !== 2 || parts[0] !== "vault") return false;
  const verb = parts[1];
  return verb === "read" || verb === "write";
}
