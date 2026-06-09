/**
 * /admin/channels — vault-backed channel provisioning (the front door).
 *
 * Most users never touch the CLI, so setting up a channel — "chat with a
 * Claude Code session through your vault" — has to be a UI action. This view
 * drives the cookie-gated `/admin/channels` orchestration endpoint
 * (src/admin-channels.ts): one POST provisions everything (vault token,
 * channel config, vault trigger) and hands back the copy-paste connect lines.
 *
 * Surface (modeled on Users.tsx + McpConnectCard.tsx):
 *
 *   1. **Channels list.** Name · Vault · Remove (confirm-then-DELETE inline,
 *      mirroring the Users delete dialog).
 *   2. **Add a channel.** A vault picker (sourced from `listVaults()`, the same
 *      well-known doc the rest of the SPA reads) + a channel-name input → one
 *      "Add channel" button. On success, a "Connect a session" panel renders the
 *      returned `connect.mcpAdd` + `connect.launch` lines, each in a
 *      copy-to-clipboard code block (the `.token-box` shape from McpConnectCard).
 *   3. **Empty state** when no channels exist yet.
 *
 * Auth: `/admin/channels` is session-cookie-gated (first-admin only) — not the
 * `/api/*` host-admin Bearer path. The `lib/api.ts` helpers redirect to login
 * on 401; errors surface the server's `error_description` verbatim.
 */
import { type FormEvent, useEffect, useState } from "react";
import {
  type ChannelListing,
  HttpError,
  type ProvisionedChannel,
  type VaultListing,
  deleteChannel,
  listChannels,
  listVaults,
  provisionChannel,
} from "../lib/api.ts";

/**
 * Channel-name charset. Mirrors `CHANNEL_NAME_RE` in src/admin-channels.ts —
 * the name lands in a services.json key, a vault trigger name, a URL path
 * segment, and an MCP server name, so it stays a conservative slug. Server is
 * authoritative; this is fast-feedback only.
 */
const CHANNEL_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*$/i;

interface ChannelsData {
  channels: ChannelListing[];
  vaults: VaultListing[];
}

type ListState =
  | { kind: "loading" }
  | { kind: "ok"; data: ChannelsData }
  | { kind: "error"; message: string };

type AddState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "provisioned"; result: ProvisionedChannel }
  | { kind: "error"; message: string };

type RemoveState =
  | { kind: "idle" }
  | { kind: "confirming"; channel: ChannelListing }
  | { kind: "removing"; name: string }
  | { kind: "error"; name: string; message: string };

function errMessage(err: unknown, verb: string): string {
  if (err instanceof HttpError) return `${verb} failed (${err.status}): ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Copy-to-clipboard button that flips its label to "Copied ✓" for 2s.
 * Mirrors `McpConnectCard.tsx`'s CopyButton — same copy affordance vocabulary
 * across the SPA. Clipboard is unavailable in insecure contexts; we no-op
 * gracefully (the command is still selectable in the `.token-box` codebox).
 */
function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => {
        if (typeof navigator === "undefined" || !navigator.clipboard) return;
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

export function Channels() {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [channelName, setChannelName] = useState("");
  const [vault, setVault] = useState("");
  const [addState, setAddState] = useState<AddState>({ kind: "idle" });
  const [removeSt, setRemoveSt] = useState<RemoveState>({ kind: "idle" });

  useEffect(() => {
    void reload;
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([listChannels(), listVaults()])
      .then(([channels, vaultsResult]) => {
        if (cancelled) return;
        setState({ kind: "ok", data: { channels, vaults: vaultsResult.vaults } });
        // Pre-select the first vault so the picker isn't a blank required field
        // on a single-vault hub (the common case). Only seed when nothing's
        // chosen yet, so a reload after an add doesn't stomp the operator's pick.
        setVault((cur) => cur || vaultsResult.vaults[0]?.name || "");
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function onSubmitAdd(e: FormEvent): Promise<void> {
    e.preventDefault();
    const name = channelName.trim();
    if (!CHANNEL_NAME_REGEX.test(name)) {
      setAddState({
        kind: "error",
        message:
          "Channel name must start with a letter or digit and contain only letters, digits, hyphens, and underscores.",
      });
      return;
    }
    if (!vault) {
      setAddState({ kind: "error", message: "Pick a vault to back this channel." });
      return;
    }
    setAddState({ kind: "submitting" });
    try {
      const result = await provisionChannel({ channelName: name, vault });
      setAddState({ kind: "provisioned", result });
      setChannelName("");
      // Refresh the list so the new channel appears (the POST doesn't return
      // the full row; the well-known/list is the source of truth).
      setReload((n) => n + 1);
    } catch (err) {
      setAddState({ kind: "error", message: errMessage(err, "Add") });
    }
  }

  async function onConfirmRemove(channel: ChannelListing): Promise<void> {
    setRemoveSt({ kind: "removing", name: channel.name });
    try {
      await deleteChannel(channel.name);
      setRemoveSt({ kind: "idle" });
      setReload((n) => n + 1);
    } catch (err) {
      setRemoveSt({ kind: "error", name: channel.name, message: errMessage(err, "Remove") });
    }
  }

  return (
    <div data-route-content="true">
      <div className="list-header">
        <h1>Channels</h1>
      </div>

      <p className="muted">
        A channel lets you chat with a Claude Code session <em>through</em> a vault — messages land
        as notes, and the session replies the same way. Adding one provisions everything (a scoped
        vault token, the channel config, and the vault trigger) in a single step — no tokens to
        mint, no YAML to edit.
      </p>

      {renderList(state, removeSt, setRemoveSt, onConfirmRemove, () => setReload((n) => n + 1))}

      {state.kind === "ok" && (
        <AddChannelSection
          vaults={state.data.vaults}
          channelName={channelName}
          setChannelName={setChannelName}
          vault={vault}
          setVault={setVault}
          addState={addState}
          setAddState={setAddState}
          onSubmit={onSubmitAdd}
        />
      )}
    </div>
  );
}

function renderList(
  state: ListState,
  removeSt: RemoveState,
  setRemoveSt: (s: RemoveState) => void,
  onConfirmRemove: (channel: ChannelListing) => Promise<void>,
  onRetry: () => void,
): React.ReactNode {
  if (state.kind === "loading") {
    return <p className="muted">Loading channels…</p>;
  }
  if (state.kind === "error") {
    return (
      <>
        <div className="error-banner">
          Couldn't load channels: <code>{state.message}</code>
        </div>
        <button type="button" onClick={onRetry} className="secondary">
          Retry
        </button>
      </>
    );
  }
  const { channels } = state.data;
  if (channels.length === 0) {
    return (
      <div className="empty empty-rich">
        <p className="empty-headline">No channels yet.</p>
        <p className="muted">
          Add one below to chat with a Claude Code session through your vault.
        </p>
      </div>
    );
  }
  return (
    <ChannelTable
      channels={channels}
      removeSt={removeSt}
      setRemoveSt={setRemoveSt}
      onConfirmRemove={onConfirmRemove}
    />
  );
}

function ChannelTable({
  channels,
  removeSt,
  setRemoveSt,
  onConfirmRemove,
}: {
  channels: ChannelListing[];
  removeSt: RemoveState;
  setRemoveSt: (s: RemoveState) => void;
  onConfirmRemove: (channel: ChannelListing) => Promise<void>;
}): React.ReactNode {
  return (
    <div className="channel-list" style={{ marginTop: "1rem" }}>
      <div className="table-scroll">
        <table className="channel-table">
          <thead>
            <tr>
              <th scope="col">Channel</th>
              <th scope="col">Vault</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => {
              const isConfirming =
                removeSt.kind === "confirming" && removeSt.channel.name === c.name;
              const isRemoving = removeSt.kind === "removing" && removeSt.name === c.name;
              const rowError =
                removeSt.kind === "error" && removeSt.name === c.name ? removeSt.message : null;
              return (
                <tr key={c.name} data-channel-name={c.name}>
                  <td>
                    <code>{c.name}</code>
                  </td>
                  <td>
                    <code>{c.vault}</code>
                  </td>
                  <td>
                    {isConfirming ? (
                      <dialog
                        open
                        className="error-banner"
                        style={{ marginTop: "0.25rem", background: "var(--bg-warn, #fffbe6)" }}
                        aria-label={`Confirm remove ${c.name}`}
                      >
                        <p>
                          Remove channel <code>{c.name}</code>? This tears down the channel config
                          and the vault's inbound trigger. Existing notes stay; new messages stop
                          flowing.
                        </p>
                        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                          <button
                            type="button"
                            className="destructive"
                            onClick={() => {
                              void onConfirmRemove(c);
                            }}
                            disabled={isRemoving}
                          >
                            {isRemoving ? "Removing…" : "Remove"}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setRemoveSt({ kind: "idle" })}
                            disabled={isRemoving}
                          >
                            Cancel
                          </button>
                        </div>
                      </dialog>
                    ) : (
                      <button
                        type="button"
                        className="secondary"
                        disabled={isRemoving}
                        onClick={() => setRemoveSt({ kind: "confirming", channel: c })}
                        aria-label={`Remove ${c.name}`}
                      >
                        {isRemoving ? "Removing…" : "Remove"}
                      </button>
                    )}
                    {rowError && (
                      <div className="error-banner" style={{ marginTop: "0.25rem" }}>
                        <code>{rowError}</code>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddChannelSection({
  vaults,
  channelName,
  setChannelName,
  vault,
  setVault,
  addState,
  setAddState,
  onSubmit,
}: {
  vaults: VaultListing[];
  channelName: string;
  setChannelName: (s: string) => void;
  vault: string;
  setVault: (s: string) => void;
  addState: AddState;
  setAddState: (s: AddState) => void;
  onSubmit: (e: FormEvent) => Promise<void>;
}): React.ReactNode {
  const submitting = addState.kind === "submitting";
  const noVaults = vaults.length === 0;
  return (
    <section style={{ marginTop: "1.5rem" }}>
      <form onSubmit={(e) => void onSubmit(e)} aria-label="Add a channel">
        <h3>Add a channel</h3>

        {noVaults ? (
          <p className="muted">
            No vaults on this hub yet. Create a vault first — a channel has to be backed by one.
          </p>
        ) : (
          <>
            <p>
              <label htmlFor="new-channel-vault">Vault</label>
              <br />
              <select
                id="new-channel-vault"
                value={vault}
                onChange={(e) => setVault(e.target.value)}
                disabled={submitting}
                style={{ minWidth: "12rem" }}
              >
                {vaults.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>
            </p>
            <p>
              <label htmlFor="new-channel-name">
                Channel name <span className="muted">(letters, digits, hyphens, underscores)</span>
              </label>
              <br />
              <input
                id="new-channel-name"
                type="text"
                required
                autoComplete="off"
                placeholder="eng"
                value={channelName}
                pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
                onChange={(e) => setChannelName(e.target.value)}
                disabled={submitting}
              />
            </p>

            {addState.kind === "error" && (
              <div className="error-banner">
                <code>{addState.message}</code>
              </div>
            )}

            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
              <button type="submit" disabled={submitting}>
                {submitting ? "Adding…" : "Add channel"}
              </button>
            </div>
          </>
        )}
      </form>

      {addState.kind === "provisioned" && (
        <ConnectPanel result={addState.result} onDismiss={() => setAddState({ kind: "idle" })} />
      )}
    </section>
  );
}

/**
 * "Connect a session" panel shown after a successful provision. Reuses the
 * `.mcp-connect-card` + `.token-box` chrome from McpConnectCard so the
 * copy-to-clipboard code blocks read identically to the vault MCP-connect card.
 */
function ConnectPanel({
  result,
  onDismiss,
}: {
  result: ProvisionedChannel;
  onDismiss: () => void;
}): React.ReactNode {
  return (
    <div
      className="mcp-connect-card"
      style={{ marginTop: "1rem" }}
      data-testid="channel-connect-panel"
    >
      <h3>Connect a session</h3>
      <p className="muted">
        Channel <code>{result.channel}</code> is live on the <code>{result.vault}</code> vault. Run
        these where your Claude Code session will live; authorize in the browser when prompted.
      </p>

      <div className="mcp-field">
        <span className="mcp-field-label">1 · Register the channel (MCP)</span>
        <div className="token-box">
          <code data-testid="channel-mcp-add">{result.connect.mcpAdd}</code>
          <CopyButton value={result.connect.mcpAdd} />
        </div>
      </div>

      <div className="mcp-field">
        <span className="mcp-field-label">2 · Launch a session on the channel</span>
        <div className="token-box">
          <code data-testid="channel-launch">{result.connect.launch}</code>
          <CopyButton value={result.connect.launch} />
        </div>
      </div>

      <div style={{ marginTop: "0.75rem" }}>
        <button type="button" className="secondary" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
