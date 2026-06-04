/**
 * Invite-links section for the Users admin view (design §7). An admin
 * generates a one-time, expiring link; the recipient opens it, creates an
 * account, and gets their OWN newly-provisioned vault as owner.
 *
 * Defaults to "provision a new vault for them" (the primary flow). The raw
 * token + URL come back ONCE on create — the hub stores only its sha256 — so
 * the create result is surfaced with a copy-URL affordance and is gone on the
 * next render. List rows show status + a revoke button for pending invites.
 *
 * Self-contained (own state, own load) so it doesn't thread through the big
 * Users component. Reuses the cached host-admin bearer (via the api client)
 * and the confirm-before-revoke discipline the rest of the admin SPA uses.
 */
import { type FormEvent, useEffect, useState } from "react";
import {
  type CreatedInvite,
  type InviteListing,
  createInvite,
  listInvites,
  revokeInvite,
} from "../lib/api";

const DAY_SECONDS = 24 * 60 * 60;

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; invites: InviteListing[] };

type CreateState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "created"; result: CreatedInvite }
  | { kind: "error"; message: string };

export function InvitesSection({ hubOrigin }: { hubOrigin: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [vaultName, setVaultName] = useState("");
  const [expiresDays, setExpiresDays] = useState("7");
  const [createSt, setCreateSt] = useState<CreateState>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    void reload;
    let cancelled = false;
    setState({ kind: "loading" });
    listInvites()
      .then((invites) => {
        if (!cancelled) setState({ kind: "ok", invites });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (createSt.kind === "submitting") return;
    setCreateSt({ kind: "submitting" });
    setCopied(false);
    const days = Number.parseInt(expiresDays, 10);
    try {
      const result = await createInvite({
        // Pin the vault name when the admin typed one; otherwise the redeemer
        // names their own vault at redeem time.
        ...(vaultName.trim() !== "" ? { vault_name: vaultName.trim() } : {}),
        provision_vault: true,
        ...(Number.isFinite(days) && days > 0 ? { expires_in: days * DAY_SECONDS } : {}),
      });
      setCreateSt({ kind: "created", result });
      setVaultName("");
      setReload((n) => n + 1);
    } catch (err: unknown) {
      setCreateSt({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onRevoke(id: string) {
    if (revoking) return;
    setRevoking(id);
    try {
      await revokeInvite(id);
      setReload((n) => n + 1);
    } catch (err: unknown) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRevoking(null);
    }
  }

  function copyUrl(url: string) {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <section style={{ marginTop: "2rem" }} data-testid="invites-section">
      <div className="list-header">
        <h2>Invite links</h2>
      </div>
      <p className="muted">
        Generate a one-time, expiring link. The recipient opens it, picks a username and password,
        and gets their own newly-provisioned vault (they become its owner). No admin-typed default
        password. Leave the vault name blank to let them name it themselves.
      </p>

      <form onSubmit={(e) => void onSubmit(e)} style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ flex: "1 1 14rem" }}>
            <span className="field-label">Vault name (optional)</span>
            <input
              type="text"
              value={vaultName}
              onChange={(e) => setVaultName(e.target.value)}
              placeholder="leave blank → they choose"
              pattern="[a-z0-9_-]*"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field" style={{ flex: "0 0 8rem" }}>
            <span className="field-label">Expires (days)</span>
            <input
              type="number"
              min={1}
              max={90}
              value={expiresDays}
              onChange={(e) => setExpiresDays(e.target.value)}
            />
          </label>
          <button type="submit" disabled={createSt.kind === "submitting"}>
            {createSt.kind === "submitting" ? "Creating…" : "Create invite"}
          </button>
        </div>
      </form>

      {createSt.kind === "error" && (
        <div className="error-banner" style={{ marginBottom: "1rem" }}>
          {createSt.message}
        </div>
      )}

      {createSt.kind === "created" && (
        <output className="success-banner" style={{ display: "block", marginBottom: "1rem" }}>
          <strong>Invite created.</strong> Copy this link now — it's shown only once and can't be
          retrieved later. The hub stores only a hash.
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              marginTop: "0.5rem",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <code style={{ wordBreak: "break-all", flex: "1 1 16rem" }}>{createSt.result.url}</code>
            <button
              type="button"
              className="secondary"
              onClick={() => copyUrl(createSt.result.url)}
            >
              {copied ? "Copied!" : "Copy link"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setCreateSt({ kind: "idle" })}
            >
              Dismiss
            </button>
          </div>
        </output>
      )}

      {state.kind === "loading" && <p className="muted">Loading invites…</p>}
      {state.kind === "error" && (
        <div className="error-banner">
          {state.message}
          <div style={{ marginTop: "0.5rem" }}>
            <button type="button" className="secondary" onClick={() => setReload((n) => n + 1)}>
              Retry
            </button>
          </div>
        </div>
      )}
      {state.kind === "ok" && state.invites.length === 0 && (
        <p className="muted">No invites yet.</p>
      )}
      {state.kind === "ok" && state.invites.length > 0 && (
        <div className="table-scroll">
          <table className="user-table">
            <thead>
              <tr>
                <th>Vault</th>
                <th>Role</th>
                <th>Status</th>
                <th>Expires</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.invites.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.vault_name ?? <span className="muted">redeemer chooses</span>}</td>
                  <td>{inv.role === "write" ? "owner" : inv.role}</td>
                  <td>
                    <span className={`status status-${inv.status}`}>{inv.status}</span>
                  </td>
                  <td className="muted">{new Date(inv.expires_at).toLocaleDateString()}</td>
                  <td className="muted">{new Date(inv.created_at).toLocaleDateString()}</td>
                  <td>
                    {inv.status === "pending" ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={revoking === inv.id}
                        onClick={() => void onRevoke(inv.id)}
                      >
                        {revoking === inv.id ? "Revoking…" : "Revoke"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hubOrigin ? (
        <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.85em" }}>
          Redemption links are served from <code>{hubOrigin}/account/setup/&lt;token&gt;</code>.
        </p>
      ) : null}
    </section>
  );
}
