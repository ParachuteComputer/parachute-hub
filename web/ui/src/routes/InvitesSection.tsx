/**
 * Invite-links section for the Users admin view (design §7 + pre-named
 * invites). An admin generates a one-time, expiring link; the recipient opens
 * it, picks a password (and a username, unless the invite pre-names one), and
 * gets vault access per the invite:
 *
 *   - "Create a new vault" (default) — the redeemer becomes owner of a
 *     freshly-provisioned vault (optionally pre-named by the admin).
 *   - "Share an existing vault" — the redeemer is assigned to one of this
 *     hub's existing vaults at the chosen role (read-only or read & write).
 *     This is the "give Jonathan read-only access to the vault I built for
 *     him" flow.
 *
 * The optional username field pre-names the account: the redemption form
 * shows it read-only and the server enforces it, so the link is a named
 * deliverable ("Jonathan's link"), not a generic one.
 *
 * The raw token + URL come back ONCE on create — the hub stores only its
 * sha256 — so the create result is surfaced with a copy-URL affordance and is
 * gone on the next render. List rows show status + a revoke button for
 * pending invites.
 *
 * Self-contained (own state, own load) so it doesn't thread through the big
 * Users component. Reuses the cached host-admin bearer (via the api client)
 * and the confirm-before-revoke discipline the rest of the admin SPA uses.
 */
import { type FormEvent, useEffect, useState } from "react";
import {
  type CreateInviteInput,
  type CreatedInvite,
  type InviteListing,
  createInvite,
  listInvites,
  listUserVaults,
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

type AccessMode = "provision" | "share";

/** Human label for an invite row's access shape. */
function accessLabel(inv: InviteListing): string {
  if (inv.provision_vault) return "owner (new vault)";
  if (inv.vault_name === null) return "account only";
  return inv.role === "read" ? "read-only (shared)" : "read & write (shared)";
}

/** The fields that prefigure what a link does — shared by the live form preview and minted rows. */
interface Prefiguration {
  username: string | null;
  vault_name: string | null;
  role: string;
  provision_vault: boolean;
}

/**
 * Admin-facing, one-line answer to "what will this link do when clicked?" —
 * the prefiguration summary. Shown live under the form (before mint), on the
 * created banner (after mint), and reused for the paste-ready message.
 */
function prefigSummary(p: Prefiguration): string {
  const who =
    p.username !== null ? `an account for "${p.username}"` : "an account (they pick the username)";
  if (p.provision_vault) {
    const vault =
      p.vault_name !== null
        ? `their own new vault "${p.vault_name}"`
        : "their own new vault (they name it)";
    return `Creates ${who} + ${vault}, as owner.`;
  }
  if (p.vault_name === null) return `Creates ${who} with no vault access yet.`;
  const access = p.role === "read" ? "read-only" : "read & write";
  return `Creates ${who} with ${access} access to your existing vault "${p.vault_name}".`;
}

/**
 * Recipient-facing, paste-ready message: what the link does + the link
 * itself. The "Copy message" affordance — so how an invite was sent is never
 * a mystery to either side.
 */
function inviteMessage(p: Prefiguration, url: string, expiresAt: string): string {
  const who = p.username !== null ? ` Your username will be "${p.username}".` : "";
  const access = p.provision_vault
    ? p.vault_name !== null
      ? ` You'll get your own new vault ("${p.vault_name}").`
      : " You'll get your own new vault."
    : p.vault_name !== null
      ? ` You'll get ${p.role === "read" ? "read-only" : "read & write"} access to the vault "${p.vault_name}".`
      : "";
  const expires = new Date(expiresAt).toLocaleDateString();
  return `You're invited to my Parachute. Open this link to set your password and claim your account.${who}${access} The link works once and expires ${expires}: ${url}`;
}

export function InvitesSection({ hubOrigin }: { hubOrigin: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [username, setUsername] = useState("");
  const [mode, setMode] = useState<AccessMode>("provision");
  const [vaultName, setVaultName] = useState("");
  const [shareVault, setShareVault] = useState("");
  const [shareRole, setShareRole] = useState<"read" | "write">("read");
  const [knownVaults, setKnownVaults] = useState<string[]>([]);
  const [expiresDays, setExpiresDays] = useState("7");
  const [createSt, setCreateSt] = useState<CreateState>({ kind: "idle" });
  const [copied, setCopied] = useState<"link" | "message" | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  // What the link being configured will do when clicked — recomputed live
  // from the form state so the admin sees the prefiguration BEFORE minting.
  const formPrefig: Prefiguration = {
    username: username.trim() !== "" ? username.trim() : null,
    vault_name:
      mode === "share"
        ? shareVault !== ""
          ? shareVault
          : null
        : vaultName.trim() !== ""
          ? vaultName.trim()
          : null,
    role: mode === "share" ? shareRole : "write",
    provision_vault: mode === "provision",
  };

  useEffect(() => {
    void reload;
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([listInvites(), listUserVaults()])
      .then(([invites, vaults]) => {
        if (!cancelled) {
          setState({ kind: "ok", invites });
          setKnownVaults(vaults);
        }
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
    if (mode === "share" && shareVault === "") {
      setCreateSt({
        kind: "error",
        message: "Pick which existing vault to share before creating the invite.",
      });
      return;
    }
    setCreateSt({ kind: "submitting" });
    setCopied(null);
    const days = Number.parseInt(expiresDays, 10);
    const input: CreateInviteInput = {
      ...(username.trim() !== "" ? { username: username.trim() } : {}),
      ...(Number.isFinite(days) && days > 0 ? { expires_in: days * DAY_SECONDS } : {}),
      ...(mode === "share"
        ? { vault_name: shareVault, provision_vault: false, role: shareRole }
        : {
            // Pin the vault name when the admin typed one; otherwise the
            // redeemer names their own vault at redeem time.
            ...(vaultName.trim() !== "" ? { vault_name: vaultName.trim() } : {}),
            provision_vault: true,
          }),
    };
    try {
      const result = await createInvite(input);
      setCreateSt({ kind: "created", result });
      setUsername("");
      setVaultName("");
      setShareVault("");
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

  function copyText(text: string, which: "link" | "message") {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <section style={{ marginTop: "2rem" }} data-testid="invites-section">
      <div className="list-header">
        <h2>Invite links</h2>
      </div>
      <p className="muted">
        Generate a one-time, expiring link. The recipient opens it and picks their password — no
        admin-typed default password. Either provision them a new vault of their own, or share an
        existing vault read-only or read &amp; write. Pre-naming the username makes the link a named
        deliverable (the recipient can't change it).
      </p>

      <form onSubmit={(e) => void onSubmit(e)} style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ flex: "1 1 10rem" }}>
            <span className="field-label">Username (optional)</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="leave blank → they choose"
              pattern="[a-z0-9_-]*"
              minLength={2}
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field" style={{ flex: "0 0 14rem" }}>
            <span className="field-label">Vault access</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value === "share" ? "share" : "provision")}
            >
              <option value="provision">Create a new vault for them</option>
              <option value="share">Share an existing vault</option>
            </select>
          </label>
          {mode === "provision" ? (
            <label className="field" style={{ flex: "1 1 12rem" }}>
              <span className="field-label">New vault name (optional)</span>
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
          ) : (
            <>
              <label className="field" style={{ flex: "1 1 10rem" }}>
                <span className="field-label">Vault</span>
                <select value={shareVault} onChange={(e) => setShareVault(e.target.value)} required>
                  <option value="">Pick a vault…</option>
                  {knownVaults.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ flex: "0 0 9rem" }}>
                <span className="field-label">Role</span>
                <select
                  value={shareRole}
                  onChange={(e) => setShareRole(e.target.value === "write" ? "write" : "read")}
                >
                  <option value="read">Read-only</option>
                  <option value="write">Read &amp; write</option>
                </select>
              </label>
            </>
          )}
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
        <p className="muted" style={{ marginTop: "0.5rem" }} data-testid="invite-preview">
          {mode === "share" && shareVault === ""
            ? "Pick the existing vault to share to finish configuring this link."
            : prefigSummary(formPrefig)}
        </p>
      </form>

      {createSt.kind === "error" && (
        <div className="error-banner" style={{ marginBottom: "1rem" }}>
          {createSt.message}
        </div>
      )}

      {createSt.kind === "created" && (
        <output className="success-banner" style={{ display: "block", marginBottom: "1rem" }}>
          <strong>Invite created.</strong> {prefigSummary(createSt.result.invite)}
          <br />
          Copy it now — the link is shown only once and can't be retrieved later (the hub stores
          only a hash). "Copy message" includes a ready-to-send note telling the recipient what the
          link does.
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
              onClick={() => copyText(createSt.result.url, "link")}
            >
              {copied === "link" ? "Copied!" : "Copy link"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                copyText(
                  inviteMessage(
                    createSt.result.invite,
                    createSt.result.url,
                    createSt.result.invite.expires_at,
                  ),
                  "message",
                )
              }
            >
              {copied === "message" ? "Copied!" : "Copy message"}
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
                <th>For</th>
                <th>Vault</th>
                <th>Access</th>
                <th>Status</th>
                <th>Expires</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.invites.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.username ?? <span className="muted">they choose</span>}</td>
                  <td>{inv.vault_name ?? <span className="muted">redeemer chooses</span>}</td>
                  <td>{accessLabel(inv)}</td>
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
