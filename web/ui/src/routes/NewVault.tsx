/**
 * /vaults/new — create a new vault.
 *
 * Two-stage UI:
 *   1. Form: ask for a name. Mirrors the CLI's validation (regex +
 *      "list" reserved) client-side so the operator gets immediate
 *      feedback, but the server is still authoritative — see admin-
 *      vaults.ts for the canonical list.
 *   2. Result: on 201 with `token`, render the single-emit `pvt_*`
 *      banner with copy + a "Done" dismiss. The token is shown ONCE,
 *      ever — refreshing the page or navigating away loses it; the hub
 *      can't re-emit it. We block navigation away while the banner is
 *      live so an accidental Back doesn't strand the operator.
 *
 * 200 (idempotent re-POST against an existing vault) is treated as
 * success but renders without a token banner — there's nothing to copy
 * because the original token was already emitted.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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

  // Block accidental navigation while a single-emit token is on-screen.
  // The browser's "leave this page?" dialog is the cheapest belt-and-
  // braces — react-router won't intercept window.close, but it covers
  // refresh + tab-close, which are the realistic mistakes here.
  const hasUnsavedToken = state.kind === "created" && state.result.token != null;
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
    return (
      <CreatedView
        result={state.result}
        onDone={() => navigate(`/${encodeURIComponent(state.result.name)}`)}
      />
    );
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
          <Link to="/" className="muted">
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
          <h3>Your vault token (shown once)</h3>
          <p className="muted">
            This is the only time the hub will show this token. Copy it and store it somewhere safe
            — a password manager, the operator's notes, parachute-agent's secrets store. If you lose it,
            you'll need to mint a new one from the vault directly.
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
      ) : (
        <div className="section">
          <p>
            Vault <code>{result.name}</code> already existed; nothing new was minted. Use the
            existing token, or mint a fresh one from the vault directly with{" "}
            <code>parachute-vault mint-token</code>.
          </p>
          <div className="actions">
            <Link to={`/${encodeURIComponent(result.name)}`}>
              <button type="button">Continue</button>
            </Link>
          </div>
        </div>
      )}

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
