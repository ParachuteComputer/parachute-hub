/**
 * /vaults/new — create a new vault.
 *
 * Two-stage UI:
 *   1. Form: ask for a name. Mirrors the CLI's validation (regex +
 *      "list" reserved) client-side so the operator gets immediate
 *      feedback, but the server is still authoritative — see admin-
 *      vaults.ts for the canonical list.
 *   2. Result, branched on `created` (HTTP 201 vs 200), NOT on token
 *      truthiness:
 *        - created + token present → show the one-shot ACCESS-token banner
 *          (a hub-issued JWT scoped `vault:<name>:admin`) with copy + a
 *          "Done" dismiss. Shown ONCE — the hub captured it from the
 *          create JSON and doesn't re-emit it. We block navigation away
 *          while the banner is live so an accidental Back doesn't strand
 *          the operator.
 *        - created + NO token (HTTP 201, `token: ""`) → the vault exists
 *          but the bootstrap mint was unavailable (e.g. a loopback origin
 *          the hub can't mint against). Render a "created, but no token
 *          minted" state with the vault's `token_guidance` reason and
 *          point at the real mint path. Pre-fix this wrongly rendered
 *          "already existed" because the empty string read as falsy.
 *        - NOT created (HTTP 200, idempotent re-POST) → "already existed"
 *          state. Nothing was minted.
 *
 * Recovery story (all branches): the created-view mounts the per-vault
 * `<McpConnectCard>` (same component the Vaults list uses). Its OAuth-first
 * `claude mcp add` command needs NO token — that's the canonical connect
 * path. For a header-auth token, mint a scope-narrow one via the card's
 * "Use a token instead" disclosure, or from the CLI with
 * `parachute auth mint-token --scope vault:<name>:read`. There is NO
 * "mint from the vault directly" path — that mental model is gone post-DROP.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { McpConnectCard } from "../components/McpConnectCard.tsx";
import { type CreateVaultResult, HttpError, createVault } from "../lib/api.ts";

const VAULT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const RESERVED_VAULT_NAMES = new Set(["list"]);

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "created"; result: CreateVaultResult }
  | { kind: "error"; message: string };

export function NewVault() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  // Block accidental navigation while a one-shot access token is on-screen.
  // The browser's "leave this page?" dialog is the cheapest belt-and-
  // braces — react-router won't intercept window.close, but it covers
  // refresh + tab-close, which are the realistic mistakes here. Guard on a
  // non-empty token: a 201 with `token: ""` (mint unavailable) has nothing
  // to lose, so don't nag the operator.
  const hasUnsavedToken = state.kind === "created" && !!state.result.token;
  useEffect(() => {
    if (!hasUnsavedToken) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedToken]);

  const validation = validateName(name);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (validation) return;
    setState({ kind: "submitting" });
    try {
      const result = await createVault({ name });
      setState({ kind: "created", result });
    } catch (err) {
      const message =
        err instanceof HttpError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setState({ kind: "error", message });
    }
  };

  if (state.kind === "created") {
    // Dismiss → vaults list. There is no per-vault detail route in the
    // SPA (App.tsx routes are /, /vaults, /vaults/new, /modules, …); the
    // old `/${name}` target resolved to e.g. `/work` and fell through to
    // the catch-all "404 — back to vaults". `/vaults` is the real,
    // existing post-create landing surface. Caught during team onboarding
    // — "Done — I've saved the token" 404'd after every vault create.
    return <CreatedView result={state.result} onDone={() => navigate("/vaults")} />;
  }

  return (
    <div>
      <h2>Create a vault</h2>
      <p className="muted">
        A vault stores tokens, secrets, and notes scoped to this hub. The hub provisions it via{" "}
        <code>parachute-vault create</code> on the host filesystem and registers it in{" "}
        <code>services.json</code>.
      </p>

      {state.kind === "error" && (
        <div className="error-banner">
          Couldn't create vault: <code>{state.message}</code>
        </div>
      )}

      <form onSubmit={onSubmit} className="section">
        <div className="row">
          <label htmlFor="vault-name">Vault name</label>
          <input
            id="vault-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. work, home, scratch"
            disabled={state.kind === "submitting"}
          />
          {validation ? (
            <div className="field-error">{validation}</div>
          ) : (
            <div className="field-hint">
              Letters, numbers, hyphens, and underscores. Becomes the path under{" "}
              <code>/vault/&lt;name&gt;</code>.
            </div>
          )}
        </div>
        <div className="actions">
          <button
            type="submit"
            disabled={name.length === 0 || !!validation || state.kind === "submitting"}
          >
            {state.kind === "submitting" ? "Creating…" : "Create vault"}
          </button>
          <Link to="/vaults" className="muted">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

function CreatedView({
  result,
  onDone,
}: {
  result: CreateVaultResult;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!result.token) return;
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can fail in non-secure contexts; the token is still
      // visible in the codebox for manual copy. Don't block the flow.
    }
  };

  return (
    <div>
      <h2>Vault created</h2>

      {result.token ? (
        <div className="mint-banner">
          <h3>Your access token (shown once)</h3>
          <p className="muted">
            This is a hub-issued access token (a JWT scoped <code>vault:{result.name}:admin</code>)
            — not a vault password. It's the only time the hub will show it. Copy it and store it
            somewhere safe — a password manager, the operator's notes. If you lose it, you don't
            need it for the OAuth connect path below; for a header-auth token, mint a fresh
            scope-narrow one with{" "}
            <code>parachute auth mint-token --scope vault:{result.name}:read</code> (or the connect
            card's "Use a token instead" option).
          </p>
          <div className="token-box">
            <code>{result.token}</code>
            <button type="button" onClick={onCopy} className="secondary">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="warn">⚠ Don't navigate away until you've saved this token.</p>
          <div className="actions">
            <button type="button" onClick={onDone}>
              Done — I've saved the token
            </button>
          </div>
        </div>
      ) : result.created ? (
        // HTTP 201, but no token came back (`token: ""`). The vault WAS
        // created — the bootstrap mint just wasn't available (e.g. a
        // loopback origin the hub can't mint a JWT against). Don't render
        // "already existed" — that's the empty-token-wrong-branch bug.
        // Steer the operator at the real connect path (the OAuth command in
        // the card below needs no token) + the CLI mint path.
        <div className="section">
          <p>
            Vault <code>{result.name}</code> was created, but no access token was minted
            {result.tokenGuidance ? (
              <>
                {" "}
                — <span className="muted">{result.tokenGuidance}</span>
              </>
            ) : (
              <span className="muted">
                {" "}
                (the hub couldn't mint one at create time — common on a loopback origin)
              </span>
            )}
            . You don't need a token for the OAuth connect command below. For a header-auth token,
            mint a scope-narrow one with{" "}
            <code>parachute auth mint-token --scope vault:{result.name}:read</code>.
          </p>
          <div className="actions">
            <button type="button" onClick={onDone}>
              Done
            </button>
          </div>
        </div>
      ) : (
        // HTTP 200 — idempotent re-POST against an existing vault. Nothing
        // was created or minted.
        <div className="section">
          <p>
            Vault <code>{result.name}</code> already existed; nothing new was created. Connect to it
            with the command below (OAuth, no token needed), or mint a scope-narrow header-auth
            token with <code>parachute auth mint-token --scope vault:{result.name}:read</code>.
          </p>
          <div className="actions">
            {/* No per-vault detail route exists — land on the vaults list
                (same fix as the 201 "Done" path above). */}
            <Link to="/vaults">
              <button type="button">Continue</button>
            </Link>
          </div>
        </div>
      )}

      {/* The per-vault MCP connect card — same component the Vaults list
          renders. Gives the freshly-minted token a clear purpose and
          surfaces the OAuth-first connect snippet right where the operator
          lands after creating a vault (team-onboarding gap #1). */}
      <div className="section">
        <McpConnectCard vaultName={result.name} vaultUrl={result.url} />
      </div>

      <div className="kv section">
        <div>Name</div>
        <div>
          <code>{result.name}</code>
        </div>
        <div>URL</div>
        <div>
          <code>{result.url}</code>
        </div>
        <div>Version</div>
        <div>
          <code>{result.version}</code>
        </div>
        {result.paths && (
          <>
            <div>Vault dir</div>
            <div>
              <code>{result.paths.vault_dir}</code>
            </div>
            <div>Database</div>
            <div>
              <code>{result.paths.vault_db}</code>
            </div>
            <div>Config</div>
            <div>
              <code>{result.paths.vault_config}</code>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function validateName(name: string): string | null {
  if (name.length === 0) return null;
  if (!VAULT_NAME_PATTERN.test(name)) {
    return "Letters, numbers, hyphens, and underscores only.";
  }
  if (RESERVED_VAULT_NAMES.has(name)) {
    return `"${name}" is a reserved name.`;
  }
  return null;
}
