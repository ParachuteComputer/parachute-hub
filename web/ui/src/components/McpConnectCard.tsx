/**
 * Per-vault "MCP connection" card.
 *
 * The canonical in-product affordance for "how do I connect an MCP client
 * (Claude Code, Claude.ai, …) to THIS vault?" — surfaced on every vault,
 * any time, not just on the first-boot wizard's done screen.
 *
 * It's the SPA twin of the server-rendered `renderMcpTile` in
 * `src/setup-wizard.ts` — same command shape, same OAuth-first framing,
 * same one-time-reveal posture for the optional header-auth token. Two
 * mount points consume it:
 *
 *   1. The Vaults list — a per-row "Connect" toggle (VaultsList.tsx).
 *   2. The NewVault created-view — replaces the bare "here's your token"
 *      display so the freshly-minted token has a clear, in-context purpose
 *      (NewVault.tsx CreatedView).
 *
 * Why two auth paths, OAuth-first:
 *   - **OAuth (default).** `claude mcp add --transport http …` with NO
 *     token in the command. On first use the client opens a browser, the
 *     operator signs in to the hub + approves the scope, and the client
 *     caches its own OAuth tokens. This is the path we lead with — nothing
 *     secret ends up pasted into a shell history.
 *   - **Header auth (secondary, optional).** For clients that can't do the
 *     browser OAuth dance (headless / CI / some hosted clients), mint a
 *     scope-narrow hub JWT (`vault:<name>:read vault:<name>:write`, NOT
 *     admin) via the existing tokens-page mint chain and append
 *     `--header "Authorization: Bearer <jwt>"`. Shown once, copy-only,
 *     never persisted — same posture as the Tokens page mint banner.
 *
 * Origin source: the MCP endpoint is derived from the vault's own
 * well-known `url` (which the hub publishes as `<canonical-origin>/vault/
 * <name>` — see src/well-known.ts), so the card never has to re-resolve
 * the hub origin and never hardcodes the :1940 vault loopback. We just
 * append `/mcp` to the vault URL.
 */
import { useState } from "react";
import { HttpError, type MintedToken, mintToken } from "../lib/api.ts";

const CONNECT_DOCS_URL = "https://parachute.computer/install#connect-mcp-clients";

/**
 * Build `<hub-origin>/vault/<name>/mcp` from the vault's published URL.
 * `vaultUrl` is the well-known `url` field — already origin-absolute and
 * pointing at the vault's mount (`<origin>/vault/<name>`, possibly with a
 * trailing slash). Strip any trailing slash before appending `/mcp` so we
 * never emit `…/vault/work//mcp`.
 *
 * Exported for direct unit testing.
 */
export function mcpEndpointFor(vaultUrl: string): string {
  return `${vaultUrl.replace(/\/+$/, "")}/mcp`;
}

/**
 * The OAuth-path `claude mcp add` command — no token, triggers browser
 * OAuth on first use. The server name is `parachute-<vault>` to match the
 * wizard's `renderMcpTile`. Exported for direct unit testing.
 */
export function claudeMcpAddCommand(vaultName: string, vaultUrl: string): string {
  return `claude mcp add --transport http parachute-${vaultName} ${mcpEndpointFor(vaultUrl)}`;
}

/**
 * Header-auth variant of the command, for clients that can't do browser
 * OAuth. Appends the Bearer header carrying a freshly-minted hub JWT.
 * Exported for direct unit testing.
 */
export function claudeMcpAddCommandWithToken(
  vaultName: string,
  vaultUrl: string,
  token: string,
): string {
  return `${claudeMcpAddCommand(vaultName, vaultUrl)} --header "Authorization: Bearer ${token}"`;
}

type MintState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "minted"; token: MintedToken }
  | { kind: "error"; message: string };

interface McpConnectCardProps {
  /** Vault short name — drives the server name + scope. */
  vaultName: string;
  /**
   * Vault's published URL (`<hub-origin>/vault/<name>`), from the
   * well-known doc / create response. The MCP endpoint is this + `/mcp`.
   */
  vaultUrl: string;
  /**
   * Render without the outer `.mcp-connect-card` chrome — used inside the
   * NewVault created-view where the card already sits in a surrounding
   * banner. Defaults to false (standalone card with its own border).
   */
  embedded?: boolean;
}

/**
 * Copy-to-clipboard button that flips its label to "Copied ✓" for 2s.
 * Mirrors the Tokens page / wizard copy affordance. Clipboard can be
 * unavailable in insecure contexts; we no-op gracefully (the command is
 * still selectable in the codebox).
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

export function McpConnectCard({ vaultName, vaultUrl, embedded = false }: McpConnectCardProps) {
  const endpoint = mcpEndpointFor(vaultUrl);
  const oauthCmd = claudeMcpAddCommand(vaultName, vaultUrl);

  const [showTokenPath, setShowTokenPath] = useState(false);
  const [mint, setMint] = useState<MintState>({ kind: "idle" });

  async function onMintHeaderToken(): Promise<void> {
    if (mint.kind === "submitting") return;
    setMint({ kind: "submitting" });
    try {
      // Read+write, NOT admin — the header-auth path is for MCP clients
      // reading and writing vault data, not for vault administration.
      // Goes through the same operator-mint chain the Tokens page uses
      // (host-admin Bearer → POST /api/auth/mint-token), so it lands in
      // the registry and is revocable like any other token.
      const minted = await mintToken({
        scope: `vault:${vaultName}:read vault:${vaultName}:write`,
      });
      setMint({ kind: "minted", token: minted });
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

  const headerCmd =
    mint.kind === "minted"
      ? claudeMcpAddCommandWithToken(vaultName, vaultUrl, mint.token.token)
      : null;

  const inner = (
    <>
      <h3>Connect an MCP client (or connector)</h3>
      <p className="muted">
        Connect an MCP client — Claude Code, Claude.ai, etc. (sometimes called a connector in
        ChatGPT and other web UIs) — to the <code>{vaultName}</code> vault. The client signs in to
        this hub and reads/writes vault data over MCP.
      </p>

      <div className="mcp-field">
        <span className="mcp-field-label">Endpoint</span>
        <div className="token-box">
          <code data-testid="mcp-endpoint">{endpoint}</code>
          <CopyButton value={endpoint} />
        </div>
      </div>

      <div className="mcp-field">
        <span className="mcp-field-label">Claude Code</span>
        <div className="token-box">
          <code data-testid="mcp-add-command">{oauthCmd}</code>
          <CopyButton value={oauthCmd} />
        </div>
        <p className="dim">
          No token needed — the command triggers browser OAuth on first use (you sign in to this hub
          and approve access). For other clients, point them at the endpoint above.
        </p>
      </div>

      <details
        className="mcp-token-path"
        open={showTokenPath}
        onToggle={(e) => setShowTokenPath((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Use a token instead (headless / CI clients)</summary>
        <p className="dim">
          For clients that can't do browser OAuth, mint a scope-narrow hub token (
          <code>
            vault:{vaultName}:read vault:{vaultName}:write
          </code>{" "}
          — not admin) and pass it as a header. Revealed once; copy it now.
        </p>

        {mint.kind === "minted" && headerCmd ? (
          <div className="mint-banner" data-testid="mcp-header-banner">
            <h3>Token minted</h3>
            <p className="muted">
              This is the only time the hub shows this token. Copy the command below — it embeds the
              live token in the <code>Authorization</code> header.
            </p>
            <div className="token-box">
              <code data-testid="mcp-header-command">{headerCmd}</code>
              <CopyButton value={headerCmd} />
            </div>
            <p className="warn">
              ⚠ Manage and revoke this token at <code>/admin/tokens</code>.
            </p>
          </div>
        ) : (
          <div className="actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                void onMintHeaderToken();
              }}
              disabled={mint.kind === "submitting"}
            >
              {mint.kind === "submitting" ? "Minting…" : "Mint a token"}
            </button>
          </div>
        )}

        {mint.kind === "error" ? (
          <div className="error-banner" style={{ marginTop: "0.5rem" }}>
            <code>{mint.message}</code>
          </div>
        ) : null}
      </details>

      <p className="dim mcp-docs-link">
        <a href={CONNECT_DOCS_URL} target="_blank" rel="noreferrer">
          Full connect docs →
        </a>
      </p>
    </>
  );

  if (embedded) return <div className="mcp-connect-card mcp-connect-card-embedded">{inner}</div>;
  return <div className="mcp-connect-card">{inner}</div>;
}
