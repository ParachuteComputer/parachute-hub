/**
 * /admin/approve-client/<client_id> — operator landing page for the
 * pending-approval deep link surfaced by `pendingClientJson()` on
 * /oauth/token. An app like Notes gets the JSON error with `approve_url`
 * pointing here; the operator opens the link, sees the client details,
 * and one-click approves without dropping to a terminal.
 *
 * Three-state UI:
 *   - **pending** → render details + Approve button. Approve POSTs and
 *     transitions to "approved".
 *   - **approved** (on load or after click) → render success message
 *     telling the operator they can return to the requesting app and retry.
 *     Deliberately no auto-redirect: the operator opened this from another
 *     tab/app, so the goal is "close this and go back" rather than nav
 *     them around the SPA.
 *   - **unknown** (404 from the API) → render an error explaining the
 *     client_id wasn't found.
 *
 * Why one page instead of a modal in some other route: the OAuth client
 * sends the operator here from a different origin via `approve_url`, so
 * deep-linkable as a discrete route is the right shape.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
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
        if (client.status === "approved") {
          setAction({ kind: "approved", alreadyApproved: true });
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
  }, [clientId, reload]);

  async function onApprove(): Promise<void> {
    setAction({ kind: "approving" });
    try {
      const result = await approveOauthClient(clientId);
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

interface RenderBodyProps {
  loadState: LoadState;
  action: ActionState;
  onApprove: () => Promise<void>;
  onRetry: () => void;
}

function renderBody({ loadState, action, onApprove, onRetry }: RenderBodyProps) {
  if (loadState.kind === "loading") {
    return <p className="muted">Loading…</p>;
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
