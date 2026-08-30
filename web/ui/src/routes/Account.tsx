/**
 * /admin/account — "My account": self-service password, 2FA, my-tokens, and
 * pubkey-link for the signed-in user (hub#85 + hub#833 (b) + hub#880).
 *
 * The owner is NOT special here: `two_factor_enabled` comes from `/api/me`
 * (keyed off the session's own user), and every action POSTs to
 * `/api/account/*`, which act on `session.userId`. Same path for the first
 * admin and any friend user.
 *
 * ## Layout (hub#880)
 *
 * Summary-first. The page is four **disclosure cards**, each collapsed by
 * default and each showing a one-line status in its header ("Two-factor: On",
 * "3 API tokens", "1 linked key") so the operator can read their whole account
 * posture without expanding anything. Toggles are real `<button>`s with
 * `aria-expanded` / `aria-controls` (WAI-ARIA accordion shape), not
 * `<details>`, so the disclosure state is programmatically announced.
 *
 * A `location.hash` of `#password` / `#two-factor` / `#tokens` / `#keys` opens
 * that card on arrival — deep links from elsewhere in the shell land expanded.
 *
 * The four cards:
 *   - Password — current → new (+ confirm). 12-char floor mirrors the server
 *     validator; the server is authoritative (its 400/401 message surfaces).
 *   - Two-factor — status pill in the card header; when off, an enroll flow
 *     (QR + secret + verify a code → backup codes shown ONCE); when on, a
 *     password-gated disable.
 *   - API tokens — list / mint / revoke THIS user's tokens. Operator registry
 *     stays at `/admin/tokens`. JWT shown once. Cookie+CSRF, cannot mint
 *     `parachute:host:*`.
 *   - Nostr keys — list / link / unlink, driven by a three-step guided
 *     ceremony (see `PubkeysSection`). A linked key is an attribution label;
 *     it grants nothing. First-link is password-gated.
 *
 * ## Why the list fetches are hoisted
 *
 * `useAccountTokens` / `useAccountPubkeys` live on the *page*, not inside the
 * collapsed sections, because the card headers need the counts before anything
 * is expanded. Collapsing unmounts the body; hoisting the fetch keeps the
 * summary honest and stops a re-fetch on every expand/collapse.
 *
 * The CSRF token + 2FA status are read from `/api/me` (the single who-am-I
 * read App.tsx already does). We refetch it after a 2FA change so the status
 * pill + section swap without a full reload.
 */
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  type AccountPubkey,
  type AccountTokenListing,
  type MeResponse,
  type MintedAccountToken,
  type PubkeyChallenge,
  type SignedNostrEvent,
  type TwoFactorStart,
  changeAccountPassword,
  confirmTwoFactor,
  disableTwoFactor,
  getMe,
  listAccountPubkeys,
  listAccountTokens,
  mintAccountToken,
  revokeAccountToken,
  startPubkeyChallenge,
  startTwoFactor,
  unlinkAccountPubkey,
  verifyPubkeyLink,
} from "../lib/api.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "ok"; csrf: string; twoFactorEnabled: boolean };

/** `#password` → the password card, etc. Anything else opens nothing. */
const HASH_TARGETS: Record<string, string> = {
  "#password": "password",
  "#two-factor": "two-factor",
  "#2fa": "two-factor",
  "#tokens": "tokens",
  "#keys": "keys",
};

export function Account() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const { hash } = useLocation();
  const openTarget = HASH_TARGETS[hash] ?? null;

  const refresh = useCallback(async () => {
    try {
      const me: MeResponse = await getMe();
      if (!me.hasSession) {
        setState({ kind: "signed-out" });
        return;
      }
      setState({ kind: "ok", csrf: me.csrf, twoFactorEnabled: me.two_factor_enabled });
    } catch {
      setState({ kind: "signed-out" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Hoisted so the collapsed card headers can show counts. Both hooks fetch
  // once on mount regardless of the sign-in state resolving — the helpers
  // redirect to login on 401 themselves.
  const tokens = useAccountTokens();
  const pubkeys = useAccountPubkeys();

  if (state.kind === "loading") {
    return <div className="empty">Loading account…</div>;
  }
  if (state.kind === "signed-out") {
    return (
      <div className="empty">
        You're not signed in.{" "}
        <a href={`/login?next=${encodeURIComponent(window.location.pathname)}`}>Sign in</a> to
        manage your account.
      </div>
    );
  }

  return (
    <section className="settings account-page" data-testid="account-page">
      <h1>My account</h1>
      <p className="muted">
        Your sign-in credentials, API tokens, and linked Nostr keys. Changes here apply to your
        account only. The operator token registry is a separate page.
      </p>

      <div className="account-cards">
        <AccountCard
          cardId="password"
          title="Password"
          summary="Used to sign in to this hub"
          testId="account-password"
          openInitially={openTarget === "password"}
        >
          <PasswordSection csrf={state.csrf} />
        </AccountCard>

        <AccountCard
          cardId="two-factor"
          title="Two-factor authentication"
          summary={
            <span
              className={`lock-status-pill ${
                state.twoFactorEnabled ? "lock-status-on" : "lock-status-off"
              }`}
              data-testid="account-2fa-status"
            >
              {state.twoFactorEnabled ? "Enabled" : "Off"}
            </span>
          }
          testId="account-2fa"
          openInitially={openTarget === "two-factor"}
        >
          <TwoFactorSection
            csrf={state.csrf}
            enabled={state.twoFactorEnabled}
            onChanged={() => void refresh()}
          />
        </AccountCard>

        <AccountCard
          cardId="tokens"
          title="API tokens"
          summary={summarizeTokens(tokens.list)}
          testId="account-tokens"
          openInitially={openTarget === "tokens"}
        >
          <TokensSection csrf={state.csrf} tokens={tokens} />
        </AccountCard>

        <AccountCard
          cardId="keys"
          title="Nostr keys"
          summary={summarizePubkeys(pubkeys.list)}
          testId="account-pubkeys"
          openInitially={openTarget === "keys"}
        >
          <PubkeysSection csrf={state.csrf} pubkeys={pubkeys} />
        </AccountCard>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Disclosure card
// ---------------------------------------------------------------------------

/**
 * One collapsible settings card. WAI-ARIA accordion shape: a real `<button>`
 * inside the heading carries `aria-expanded` + `aria-controls`, and the panel
 * it points at exists in the DOM (empty + `hidden`) while collapsed so the
 * relationship stays resolvable.
 *
 * The body is *unmounted* while collapsed — the sections own transient form
 * state (a half-typed password, a mid-flight challenge) and collapsing should
 * discard it rather than keep it alive invisibly. List fetches that the header
 * summary depends on are hoisted to the page for exactly this reason.
 */
function AccountCard({
  cardId,
  title,
  summary,
  testId,
  openInitially = false,
  children,
}: {
  cardId: string;
  title: string;
  summary: ReactNode;
  testId: string;
  openInitially?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(openInitially);

  // A hash arriving after first paint (in-shell nav to `/account#keys`) should
  // still expand the targeted card. Never auto-*collapses*.
  useEffect(() => {
    if (openInitially) setOpen(true);
  }, [openInitially]);

  const titleId = `${cardId}-title`;
  const panelId = `${cardId}-panel`;

  return (
    <section
      className={`account-card${open ? " is-open" : ""}`}
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <h2 className="account-card-heading">
        <button
          type="button"
          className="account-card-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          data-testid={`${testId}-toggle`}
        >
          <span className="account-card-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="account-card-title" id={titleId}>
            {title}
          </span>
          <span className="account-card-summary" data-testid={`${testId}-summary`}>
            {summary}
          </span>
        </button>
      </h2>
      <div className="account-card-body" id={panelId} hidden={!open}>
        {open ? children : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Password change
// ---------------------------------------------------------------------------

function PasswordSection({ csrf }: { csrf: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    setNotice(null);
    if (!current || !next || !confirm) {
      setErr("All three fields are required.");
      return;
    }
    if (next.length < 12) {
      setErr("New password must be at least 12 characters (a passphrase is fine).");
      return;
    }
    if (next !== confirm) {
      setErr("New password and confirmation do not match.");
      return;
    }
    setBusy(true);
    try {
      await changeAccountPassword(csrf, current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setNotice("Password changed. Tokens minted under your old password were revoked.");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted">Change the password you use to sign in to this hub.</p>

      <form onSubmit={(e) => void onSubmit(e)} className="settings-form account-form">
        <label>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            disabled={busy}
            onChange={(e) => setCurrent(e.target.value)}
            data-testid="account-current-password"
          />
        </label>
        <label>
          New password (12+ characters)
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            disabled={busy}
            onChange={(e) => setNext(e.target.value)}
            data-testid="account-new-password"
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            disabled={busy}
            onChange={(e) => setConfirm(e.target.value)}
            data-testid="account-confirm-password"
          />
        </label>
        <div className="actions">
          <button type="submit" disabled={busy} data-testid="account-change-password">
            {busy ? "Saving…" : "Change password"}
          </button>
        </div>
      </form>

      {err && (
        <div className="error" data-testid="account-password-error">
          {err}
        </div>
      )}
      {notice && (
        <p className="muted" data-testid="account-password-notice">
          {notice}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Two-factor (TOTP)
// ---------------------------------------------------------------------------

type TwoFactorView =
  | { kind: "idle" }
  | { kind: "enrolling"; start: TwoFactorStart }
  | { kind: "backup-codes"; codes: string[] };

function TwoFactorSection({
  csrf,
  enabled,
  onChanged,
}: {
  csrf: string;
  enabled: boolean;
  onChanged: () => void;
}) {
  const [view, setView] = useState<TwoFactorView>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Enroll flow inputs.
  const [code, setCode] = useState("");
  // Disable flow input.
  const [disablePassword, setDisablePassword] = useState("");

  async function onStart() {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      const start = await startTwoFactor(csrf);
      setView({ kind: "enrolling", start });
      setCode("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    if (busy || view.kind !== "enrolling") return;
    setErr(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setErr("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    try {
      const res = await confirmTwoFactor(csrf, view.start.secret, code.trim());
      setView({ kind: "backup-codes", codes: res.backup_codes });
      setCode("");
      onChanged();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  function onCancelEnroll() {
    setView({ kind: "idle" });
    setCode("");
    setErr(null);
  }

  async function onDisable(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    if (!disablePassword) {
      setErr("Enter your current password to turn off two-factor.");
      return;
    }
    setBusy(true);
    try {
      await disableTwoFactor(csrf, disablePassword);
      setDisablePassword("");
      setView({ kind: "idle" });
      onChanged();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted">
        A time-based one-time code (TOTP) from an authenticator app, asked for as a second step at
        sign-in.
      </p>

      {/* Show the backup codes ONCE after a successful enrollment. */}
      {view.kind === "backup-codes" ? (
        <div data-testid="account-2fa-backup-codes">
          <p>
            <strong>Save these backup codes now.</strong> Each can be used once if you lose your
            authenticator. They won't be shown again.
          </p>
          <ul className="backup-codes">
            {view.codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button
              type="button"
              onClick={() => setView({ kind: "idle" })}
              data-testid="account-2fa-codes-done"
            >
              I've saved my codes
            </button>
          </div>
        </div>
      ) : enabled ? (
        // Enrolled → password-gated disable.
        <form onSubmit={(e) => void onDisable(e)} className="settings-form account-form">
          <p className="muted">Turning off two-factor requires your current password.</p>
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={disablePassword}
              disabled={busy}
              onChange={(e) => setDisablePassword(e.target.value)}
              data-testid="account-2fa-disable-password"
            />
          </label>
          <div className="actions">
            <button
              type="submit"
              className="destructive"
              disabled={busy}
              data-testid="account-2fa-disable"
            >
              {busy ? "Turning off…" : "Turn off two-factor"}
            </button>
          </div>
        </form>
      ) : view.kind === "enrolling" ? (
        // Mid-enroll → QR + secret + confirm a code.
        <form onSubmit={(e) => void onConfirm(e)} className="settings-form account-form">
          <p>
            Scan this QR code with your authenticator app, then enter the 6-digit code it shows to
            confirm.
          </p>
          <img
            src={view.start.qr_data_url}
            alt="Two-factor QR code"
            width={180}
            height={180}
            data-testid="account-2fa-qr"
          />
          <p className="muted">
            Can't scan? Enter this key manually:{" "}
            <code data-testid="account-2fa-secret">{view.start.secret}</code>
          </p>
          <label>
            6-digit code
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              disabled={busy}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
              data-testid="account-2fa-code"
            />
          </label>
          <div className="actions">
            <button type="submit" disabled={busy} data-testid="account-2fa-confirm">
              {busy ? "Verifying…" : "Verify and enable"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={onCancelEnroll}
              data-testid="account-2fa-cancel"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        // Off, idle → start enrollment.
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onStart()}
            data-testid="account-2fa-enroll"
          >
            {busy ? "Starting…" : "Set up two-factor"}
          </button>
        </div>
      )}

      {err && (
        <div className="error" data-testid="account-2fa-error">
          {err}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// API tokens (self-service)
// ---------------------------------------------------------------------------

type TokenListState =
  | { kind: "loading" }
  | { kind: "ok"; tokens: AccountTokenListing[]; nextCursor: string | null }
  | { kind: "error"; message: string };

type TokenMintState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "minted"; token: MintedAccountToken }
  | { kind: "error"; message: string };

type TokenRevokeState =
  | { kind: "idle" }
  | { kind: "confirming"; jti: string }
  | { kind: "revoking"; jti: string }
  | { kind: "error"; jti: string; message: string };

interface AccountTokensHandle {
  list: TokenListState;
  reload: () => void;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
}

/** Page-level tokens fetch — see the module docstring for why it's hoisted. */
function useAccountTokens(): AccountTokensHandle {
  const [list, setList] = useState<TokenListState>({ kind: "loading" });
  const [reloadN, setReloadN] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    void reloadN;
    let cancelled = false;
    setList({ kind: "loading" });
    listAccountTokens()
      .then((page) => {
        if (cancelled) return;
        setList({ kind: "ok", tokens: page.tokens, nextCursor: page.next_cursor });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setList({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadN]);

  // "Load more" cursor pagination — the three-ingredient shape from
  // web/ui/CLAUDE.md (flag + disabled + early return).
  async function loadMore(): Promise<void> {
    if (list.kind !== "ok" || !list.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listAccountTokens({ cursor: list.nextCursor });
      setList({
        kind: "ok",
        tokens: [...list.tokens, ...page.tokens],
        nextCursor: page.next_cursor,
      });
    } catch (err) {
      setList({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoadingMore(false);
    }
  }

  return { list, reload: () => setReloadN((n) => n + 1), loadingMore, loadMore };
}

function summarizeTokens(list: TokenListState): string {
  if (list.kind === "loading") return "Loading…";
  if (list.kind === "error") return "Couldn't load tokens";
  const n = list.tokens.length;
  if (n === 0) return "No API tokens";
  return `${n} API token${n === 1 ? "" : "s"}`;
}

function TokensSection({ csrf, tokens }: { csrf: string; tokens: AccountTokensHandle }) {
  const { list, reload, loadingMore, loadMore } = tokens;
  const [mint, setMint] = useState<TokenMintState>({ kind: "idle" });
  const [revoke, setRevoke] = useState<TokenRevokeState>({ kind: "idle" });
  const [showForm, setShowForm] = useState(false);
  const [scope, setScope] = useState("");
  const [label, setLabel] = useState("");
  const [expiresIn, setExpiresIn] = useState("");

  async function onSubmitMint(e: FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = scope.trim();
    if (trimmed.length === 0) {
      setMint({ kind: "error", message: "scope is required" });
      return;
    }
    let ttl: number | undefined;
    if (expiresIn.trim().length > 0) {
      const n = Number(expiresIn);
      if (!Number.isInteger(n) || n <= 0) {
        setMint({ kind: "error", message: "expires_in must be a positive integer (seconds)" });
        return;
      }
      ttl = n;
    }
    setMint({ kind: "submitting" });
    try {
      const minted = await mintAccountToken(csrf, {
        scope: trimmed,
        ...(ttl !== undefined ? { expires_in: ttl } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setMint({ kind: "minted", token: minted });
      setScope("");
      setLabel("");
      setExpiresIn("");
      setShowForm(false);
      reload();
    } catch (err) {
      setMint({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onConfirmRevoke(jti: string): Promise<void> {
    setRevoke({ kind: "revoking", jti });
    try {
      await revokeAccountToken(csrf, jti);
      setRevoke({ kind: "idle" });
      reload();
    } catch (err) {
      setRevoke({
        kind: "error",
        jti,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function copyToken(token: string): void {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(token);
    }
  }

  return (
    <>
      <p className="muted">
        Tokens minted as you. A friend can mint a subset of their own authority (assigned vaults);
        nobody mints <code>parachute:host:*</code> here. The operator registry — every CLI / OAuth /
        operator-mint on this hub — stays on <Link to="/tokens">Tokens</Link>.
      </p>

      {mint.kind === "minted" ? (
        <div className="mint-banner" data-testid="account-token-minted">
          <h3>Minted</h3>
          <p>
            Your new access token (jti: <code>{mint.token.jti}</code>):
          </p>
          <div className="token-box">
            <code data-testid="account-token-jwt">{mint.token.token}</code>
          </div>
          <p className="warn">This is the only time the JWT is shown. Copy it now.</p>
          <div className="actions">
            <button type="button" onClick={() => copyToken(mint.token.token)}>
              Copy
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setMint({ kind: "idle" })}
              data-testid="account-token-minted-dismiss"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <div className="account-subsection">
        <button
          type="button"
          className="secondary account-disclosure"
          aria-expanded={showForm}
          aria-controls="account-token-mint-form"
          onClick={() => setShowForm((s) => !s)}
          data-testid="account-token-mint-toggle"
        >
          <span aria-hidden="true">{showForm ? "▾" : "▸"}</span>{" "}
          {showForm ? "Hide form" : "Mint a token"}
        </button>

        <div id="account-token-mint-form" hidden={!showForm}>
          {showForm ? (
            <form onSubmit={(e) => void onSubmitMint(e)} className="settings-form account-form">
              <label>
                Scope (space-separated)
                <input
                  type="text"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  placeholder="e.g. vault:work:read"
                  data-testid="account-token-scope"
                />
              </label>
              <label>
                Label (optional)
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="laptop, backup, …"
                  data-testid="account-token-label"
                />
              </label>
              <label>
                Expires in (seconds, optional)
                <input
                  type="text"
                  inputMode="numeric"
                  value={expiresIn}
                  onChange={(e) => setExpiresIn(e.target.value)}
                  placeholder="default 90d"
                  data-testid="account-token-expires"
                />
              </label>
              {mint.kind === "error" ? (
                <div className="error" data-testid="account-token-mint-error">
                  {mint.message}
                </div>
              ) : null}
              <div className="actions">
                <button
                  type="submit"
                  disabled={mint.kind === "submitting"}
                  data-testid="account-token-mint"
                >
                  {mint.kind === "submitting" ? "Minting…" : "Mint"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setShowForm(false);
                    setMint({ kind: "idle" });
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
        </div>
      </div>

      {list.kind === "loading" ? (
        <p className="muted" data-loading="true">
          Loading tokens…
        </p>
      ) : list.kind === "error" ? (
        <div className="error" data-testid="account-tokens-error">
          {list.message}
        </div>
      ) : list.tokens.length === 0 ? (
        <p className="muted" data-testid="account-tokens-empty">
          No live tokens on this account yet.
        </p>
      ) : (
        <div data-testid="account-tokens-list">
          {list.tokens.map((t) => {
            const isConfirming = revoke.kind === "confirming" && revoke.jti === t.jti;
            const isRevoking = revoke.kind === "revoking" && revoke.jti === t.jti;
            const rowError = revoke.kind === "error" && revoke.jti === t.jti ? revoke : null;
            const live = !t.revoked_at;
            return (
              <div key={t.jti} className="vault-row" data-testid={`account-token-row-${t.jti}`}>
                <div className="body">
                  <div className="name">
                    <code title={t.jti}>{truncateJti(t.jti)}</code>
                    <span className={`tag${live ? "" : " muted"}`}>
                      {live ? "live" : "revoked"}
                    </span>
                    {t.subject ? (
                      <span className="tag muted" title="label">
                        {t.subject}
                      </span>
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
                    <span className="muted">expires </span>
                    <code>{formatDate(t.expires_at)}</code>
                  </div>
                  {rowError ? (
                    <div className="error" style={{ marginTop: "0.5rem" }}>
                      {rowError.message}
                    </div>
                  ) : null}
                  {isConfirming ? (
                    <div className="error-banner" style={{ marginTop: "0.5rem" }}>
                      <p>
                        Revoke <code>{truncateJti(t.jti)}</code>? This cannot be undone.
                      </p>
                      <div className="actions">
                        <button
                          type="button"
                          onClick={() => void onConfirmRevoke(t.jti)}
                          disabled={isRevoking}
                          data-testid={`account-token-revoke-confirm-${t.jti}`}
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
                    </div>
                  ) : null}
                </div>
                {!isConfirming && live ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setRevoke({ kind: "confirming", jti: t.jti })}
                    data-testid={`account-token-revoke-${t.jti}`}
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
                onClick={() => void loadMore()}
                data-testid="account-tokens-load-more"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

function truncateJti(jti: string): string {
  if (jti.length <= 14) return jti;
  return `${jti.slice(0, 8)}…${jti.slice(-4)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// ---------------------------------------------------------------------------
// Linked Nostr keys
// ---------------------------------------------------------------------------

type PubkeyListState =
  | { kind: "loading" }
  | { kind: "ok"; pubkeys: AccountPubkey[] }
  | { kind: "error"; message: string };

interface AccountPubkeysHandle {
  list: PubkeyListState;
  reload: () => void;
}

/** Page-level pubkeys fetch — see the module docstring for why it's hoisted. */
function useAccountPubkeys(): AccountPubkeysHandle {
  const [list, setList] = useState<PubkeyListState>({ kind: "loading" });
  const [reloadN, setReloadN] = useState(0);

  useEffect(() => {
    void reloadN;
    let cancelled = false;
    setList({ kind: "loading" });
    listAccountPubkeys()
      .then((pubkeys) => {
        if (cancelled) return;
        setList({ kind: "ok", pubkeys });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setList({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadN]);

  return { list, reload: () => setReloadN((n) => n + 1) };
}

function summarizePubkeys(list: PubkeyListState): string {
  if (list.kind === "loading") return "Loading…";
  if (list.kind === "error") return "Couldn't load keys";
  const n = list.pubkeys.length;
  if (n === 0) return "No linked keys";
  return `${n} linked key${n === 1 ? "" : "s"}`;
}

/**
 * The link ceremony, as three visible steps.
 *
 *   idle      → why you'd do this at all, and a single "Link a key" button.
 *   statement → the hub's one-time sentence, shown before anything is signed.
 *   sign      → NIP-07 extension (primary when present) or paste a signed
 *               event (primary when absent, tucked behind a disclosure when
 *               an extension is available).
 *   confirm   → optional label + first-link password step-up + submit.
 *
 * The wire protocol is unchanged (challenge → sign → verify); the steps are
 * purely how the same three moves are surfaced. Cancel from any step returns
 * to `idle` with every field cleared.
 */
type LinkState =
  | { kind: "idle" }
  | { kind: "statement"; challenge: PubkeyChallenge }
  | { kind: "sign"; challenge: PubkeyChallenge }
  | { kind: "confirm"; challenge: PubkeyChallenge; event: SignedNostrEvent };

type Nip07 = {
  signEvent: (event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => Promise<SignedNostrEvent>;
};

function hasNip07(): Nip07 | null {
  if (typeof window === "undefined") return null;
  const nostr = (window as unknown as { nostr?: Nip07 }).nostr;
  return nostr && typeof nostr.signEvent === "function" ? nostr : null;
}

/** Parse a pasted signed event. Returns the event or an operator-readable why-not. */
function parseSignedEvent(
  json: string,
): { ok: true; event: SignedNostrEvent } | { ok: false; message: string } {
  if (!json.trim()) {
    return { ok: false, message: "Paste the signed event before continuing." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, message: "Signed event is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "Paste a signed NIP-01 event object." };
  }
  return { ok: true, event: parsed as SignedNostrEvent };
}

const LINK_STEP_LABELS = ["Get the statement", "Sign it", "Confirm"] as const;

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="link-steps" data-testid="account-pubkey-steps">
      {LINK_STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const state = n === current ? "current" : n < current ? "done" : "todo";
        return (
          <li
            key={label}
            className={`link-step link-step-${state}`}
            {...(n === current ? { "aria-current": "step" as const } : {})}
          >
            <span className="link-step-num" aria-hidden="true">
              {n}
            </span>
            <span className="link-step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function PubkeysSection({ csrf, pubkeys }: { csrf: string; pubkeys: AccountPubkeysHandle }) {
  const { list, reload } = pubkeys;
  const [link, setLink] = useState<LinkState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [eventJson, setEventJson] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [unlink, setUnlink] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Password step-up is required on the FIRST link. Show the field unless we
  // already know this account holds a key; a failed list still shows it
  // (server ignores the extra password on a subsequent link).
  const firstLink = list.kind !== "ok" || list.pubkeys.length === 0;
  const nip07 = hasNip07();

  function resetFlow() {
    setLink({ kind: "idle" });
    setEventJson("");
    setShowPaste(false);
    setLabel("");
    setPassword("");
    setErr(null);
  }

  async function onStartLink(): Promise<void> {
    if (busy) return;
    setErr(null);
    setNotice(null);
    setBusy(true);
    try {
      const challenge = await startPubkeyChallenge(csrf);
      setLink({ kind: "statement", challenge });
      setEventJson("");
      // With no extension the paste path IS the path — open it by default.
      setShowPaste(!nip07);
      setLabel("");
      setPassword("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSignWithExtension(): Promise<void> {
    if (link.kind !== "sign") return;
    const nostr = hasNip07();
    if (!nostr) {
      setErr("No NIP-07 signer is available in this browser.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const tpl = link.challenge.event_template;
      const signed = await nostr.signEvent({
        kind: tpl.kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: tpl.tags,
        content: tpl.content,
      });
      setEventJson(JSON.stringify(signed, null, 2));
      setLink({ kind: "confirm", challenge: link.challenge, event: signed });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Step 2 → 3 on the paste path. Validates here so a typo fails early. */
  function onUsePastedEvent(): void {
    if (link.kind !== "sign") return;
    const parsed = parseSignedEvent(eventJson);
    if (!parsed.ok) {
      setErr(parsed.message);
      return;
    }
    setErr(null);
    setLink({ kind: "confirm", challenge: link.challenge, event: parsed.event });
  }

  async function onVerify(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || link.kind !== "confirm") return;
    setErr(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await verifyPubkeyLink(csrf, {
        event: link.event,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(password ? { password } : {}),
      });
      resetFlow();
      setNotice(
        result.relinked
          ? `Re-verified ${truncatePubkey(result.pubkey)}.`
          : `Linked ${truncatePubkey(result.pubkey)}. A linked key grants nothing — it is an attribution label.`,
      );
      reload();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  async function onUnlink(pubkey: string): Promise<void> {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      await unlinkAccountPubkey(csrf, pubkey);
      setUnlink(null);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const pasteField = (
    <>
      <label>
        Signed event (JSON)
        <textarea
          value={eventJson}
          onChange={(e) => setEventJson(e.target.value)}
          rows={8}
          spellCheck={false}
          className="account-event-input"
          data-testid="account-pubkey-event"
        />
      </label>
      <p className="dim">
        Sign the statement above with any Nostr tool — <code>nak</code>, a nostr-tools script, a
        phone signer — and paste the whole event object it prints:{" "}
        <code>{'{"id":…,"pubkey":…,"sig":…}'}</code>
      </p>
      <div className="actions">
        <button
          type="button"
          disabled={busy}
          onClick={onUsePastedEvent}
          data-testid="account-pubkey-paste-continue"
        >
          Continue
        </button>
      </div>
    </>
  );

  return (
    <>
      <p className="muted">
        Linking a Nostr key lets this hub recognize things you sign with it — signed requests from
        your agents or apps — as yours. It's an attribution label: it does not log you in, mint a
        token, or widen a scope. Unlinking does not revoke tokens.
      </p>

      {notice ? (
        <p className="muted" data-testid="account-pubkeys-notice">
          {notice}
        </p>
      ) : null}

      {link.kind === "idle" ? (
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onStartLink()}
            data-testid="account-pubkey-link"
          >
            {busy ? "Starting…" : "Link a key"}
          </button>
        </div>
      ) : (
        <div className="link-flow" data-testid="account-pubkey-flow">
          <StepIndicator current={link.kind === "statement" ? 1 : link.kind === "sign" ? 2 : 3} />

          {link.kind === "statement" ? (
            <div className="link-panel" data-testid="account-pubkey-step-statement">
              <h3>Get the statement</h3>
              <p>
                The hub wrote this one-time statement naming your account and this hub. Signing it
                proves you hold the key — nothing else.
              </p>
              <pre
                className="statement-box"
                data-testid="account-pubkey-statement"
                style={{ whiteSpace: "pre-wrap" }}
              >
                <code>{link.challenge.event_template.content}</code>
              </pre>
              <p className="dim">
                It stops being valid at <code>{formatDate(link.challenge.expires_at)}</code>. Start
                over if that passes.
              </p>
              <div className="actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setLink({ kind: "sign", challenge: link.challenge })}
                  data-testid="account-pubkey-statement-continue"
                >
                  Next: sign it
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={resetFlow}
                  data-testid="account-pubkey-cancel"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {link.kind === "sign" ? (
            <div className="link-panel" data-testid="account-pubkey-step-sign">
              <h3>Sign it</h3>
              <pre
                className="statement-box"
                data-testid="account-pubkey-statement"
                style={{ whiteSpace: "pre-wrap" }}
              >
                <code>{link.challenge.event_template.content}</code>
              </pre>

              {nip07 ? (
                <>
                  <p>
                    Your browser has a Nostr signing extension. It will show you that sentence and
                    ask you to approve it.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onSignWithExtension()}
                      data-testid="account-pubkey-nip07"
                    >
                      {busy ? "Waiting for signer…" : "Sign with browser extension"}
                    </button>
                  </div>
                  <div className="account-subsection">
                    <button
                      type="button"
                      className="secondary account-disclosure"
                      aria-expanded={showPaste}
                      aria-controls="account-pubkey-paste"
                      onClick={() => setShowPaste((s) => !s)}
                      data-testid="account-pubkey-paste-toggle"
                    >
                      <span aria-hidden="true">{showPaste ? "▾" : "▸"}</span> Sign somewhere else /
                      paste manually
                    </button>
                    <div id="account-pubkey-paste" hidden={!showPaste}>
                      {showPaste ? pasteField : null}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p data-testid="account-pubkey-no-extension">
                    No signing extension detected in this browser. Sign the statement wherever your
                    key lives, then paste the result below.
                  </p>
                  <p className="dim">
                    A NIP-07 extension (Alby, nos2x, and friends) makes this one click next time.
                  </p>
                  <div id="account-pubkey-paste">{pasteField}</div>
                </>
              )}

              <div className="actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setLink({ kind: "statement", challenge: link.challenge })}
                  data-testid="account-pubkey-back-statement"
                >
                  Back
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={resetFlow}
                  data-testid="account-pubkey-cancel"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {link.kind === "confirm" ? (
            <form
              onSubmit={(e) => void onVerify(e)}
              className="link-panel settings-form account-form"
              data-testid="account-pubkey-step-confirm"
            >
              <h3>Confirm</h3>
              <p>
                Signed by{" "}
                <code data-testid="account-pubkey-signer">{truncatePubkey(link.event.pubkey)}</code>
                . Linking records that this key is yours.
              </p>
              <label>
                Label (optional)
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. 'my phone key'"
                  data-testid="account-pubkey-label"
                />
              </label>
              {firstLink ? (
                <>
                  <label>
                    Your hub password
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      data-testid="account-pubkey-password"
                    />
                  </label>
                  <p className="dim" data-testid="account-pubkey-password-why">
                    First link asks for your hub password so a stolen browser session can't bind a
                    key to your account.
                  </p>
                </>
              ) : null}
              <div className="actions">
                <button type="submit" disabled={busy} data-testid="account-pubkey-verify">
                  {busy ? "Verifying…" : "Link key"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setLink({ kind: "sign", challenge: link.challenge })}
                  data-testid="account-pubkey-back-sign"
                >
                  Back
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={resetFlow}
                  data-testid="account-pubkey-cancel"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
        </div>
      )}

      {list.kind === "loading" ? (
        <p className="muted" data-loading="true">
          Loading keys…
        </p>
      ) : list.kind === "error" ? (
        <div className="error" data-testid="account-pubkeys-error">
          {list.message}
        </div>
      ) : list.pubkeys.length === 0 ? (
        <p className="muted" data-testid="account-pubkeys-empty">
          No keys linked to this account.
        </p>
      ) : (
        <div data-testid="account-pubkeys-list">
          {list.pubkeys.map((k) => (
            <div
              key={k.pubkey}
              className="vault-row"
              data-testid={`account-pubkey-row-${k.pubkey}`}
            >
              <div className="body">
                <div className="name">
                  <code title={k.pubkey}>{truncatePubkey(k.pubkey)}</code>
                  {k.label ? <span className="tag muted">{k.label}</span> : null}
                </div>
                <div className="dim" style={{ marginTop: "0.25rem", fontSize: "0.82rem" }}>
                  <span className="muted">linked </span>
                  <code>{formatDate(k.linked_at)}</code>
                </div>
                {unlink === k.pubkey ? (
                  <div className="error-banner" style={{ marginTop: "0.5rem" }}>
                    <p>
                      Unlink <code>{truncatePubkey(k.pubkey)}</code>? Attribution proofs already
                      written stay; tokens are not revoked.
                    </p>
                    <div className="actions">
                      <button
                        type="button"
                        onClick={() => void onUnlink(k.pubkey)}
                        disabled={busy}
                        data-testid={`account-pubkey-unlink-confirm-${k.pubkey}`}
                      >
                        {busy ? "Unlinking…" : "Unlink"}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setUnlink(null)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
              {unlink !== k.pubkey ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setUnlink(k.pubkey)}
                  data-testid={`account-pubkey-unlink-${k.pubkey}`}
                >
                  Unlink
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {err && (
        <div className="error" data-testid="account-pubkeys-form-error">
          {err}
        </div>
      )}
    </>
  );
}

function truncatePubkey(pubkey: string): string {
  if (pubkey.length <= 16) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}
