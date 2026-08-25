/**
 * /admin/account — "My account": self-service password, 2FA, my-tokens, and
 * pubkey-link for the signed-in user (hub#85 + hub#833 (b)).
 *
 * The owner is NOT special here: `two_factor_enabled` comes from `/api/me`
 * (keyed off the session's own user), and every action POSTs to
 * `/api/account/*`, which act on `session.userId`. Same path for the first
 * admin and any friend user.
 *
 * Four sections:
 *   - Password — current → new (+ confirm). 12-char floor mirrors the server
 *     validator; the server is authoritative (its 400/401 message surfaces).
 *   - Two-factor — status pill; when off, an enroll flow (QR + secret + verify
 *     a code → backup codes shown ONCE); when on, a password-gated disable.
 *   - API tokens — list / mint / revoke THIS user's tokens. Operator registry
 *     stays at `/admin/tokens`. JWT shown once. Cookie+CSRF, cannot mint
 *     `parachute:host:*`.
 *   - Nostr keys — list / link / unlink. A linked key is an attribution
 *     label; it grants nothing. First-link is password-gated.
 *
 * The CSRF token + 2FA status are read from `/api/me` (the single who-am-I
 * read App.tsx already does). We refetch it after a 2FA change so the status
 * pill + section swap without a full reload.
 */
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
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

export function Account() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

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
    <section className="settings" data-testid="account-page">
      <h1>My account</h1>
      <p className="muted">
        Manage your own sign-in credentials, API tokens, and linked Nostr keys. Changes here apply
        to your account only. The operator token registry is a separate page.
      </p>

      <PasswordSection csrf={state.csrf} />
      <TwoFactorSection
        csrf={state.csrf}
        enabled={state.twoFactorEnabled}
        onChanged={() => void refresh()}
      />
      <TokensSection csrf={state.csrf} />
      <PubkeysSection csrf={state.csrf} />
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
    <section
      className="settings-block"
      aria-labelledby="account-password-heading"
      data-testid="account-password"
    >
      <h2 id="account-password-heading">Password</h2>
      <p className="muted">Change the password you use to sign in to this hub.</p>

      <form onSubmit={(e) => void onSubmit(e)} className="settings-form">
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
    </section>
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
    <section
      className="settings-block"
      aria-labelledby="account-2fa-heading"
      data-testid="account-2fa"
    >
      <h2 id="account-2fa-heading">Two-factor authentication</h2>
      <p className="muted">
        Add a time-based one-time code (TOTP) from an authenticator app as a second step at sign-in.
      </p>

      <p>
        Status:{" "}
        <span
          className={`lock-status-pill ${enabled ? "lock-status-on" : "lock-status-off"}`}
          data-testid="account-2fa-status"
        >
          {enabled ? "Enabled" : "Off"}
        </span>
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
        <form onSubmit={(e) => void onDisable(e)} className="settings-form">
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
        <form onSubmit={(e) => void onConfirm(e)} className="settings-form">
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
              className="destructive"
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
    </section>
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

function TokensSection({ csrf }: { csrf: string }) {
  const [list, setList] = useState<TokenListState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [mint, setMint] = useState<TokenMintState>({ kind: "idle" });
  const [revoke, setRevoke] = useState<TokenRevokeState>({ kind: "idle" });
  const [showForm, setShowForm] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [scope, setScope] = useState("");
  const [label, setLabel] = useState("");
  const [expiresIn, setExpiresIn] = useState("");

  useEffect(() => {
    void reload;
    let cancelled = false;
    setList({ kind: "loading" });
    listAccountTokens()
      .then((page) => {
        if (cancelled) return;
        setList({ kind: "ok", tokens: page.tokens, nextCursor: page.next_cursor });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setList({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

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
      setList({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoadingMore(false);
    }
  }

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
      setReload((n) => n + 1);
    } catch (err) {
      setMint({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function onConfirmRevoke(jti: string): Promise<void> {
    setRevoke({ kind: "revoking", jti });
    try {
      await revokeAccountToken(csrf, jti);
      setRevoke({ kind: "idle" });
      setReload((n) => n + 1);
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
    <section
      className="settings-block"
      aria-labelledby="account-tokens-heading"
      data-testid="account-tokens"
    >
      <h2 id="account-tokens-heading">API tokens</h2>
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

      <div className="actions" style={{ marginBottom: "0.75rem" }}>
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          data-testid="account-token-mint-toggle"
        >
          {showForm ? "Hide form" : "Mint a token"}
        </button>
      </div>

      {showForm ? (
        <form onSubmit={(e) => void onSubmitMint(e)} className="settings-form">
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

      {list.kind === "loading" ? (
        <p className="muted">Loading tokens…</p>
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
    </section>
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

type LinkView = { kind: "idle" } | { kind: "challenging"; challenge: PubkeyChallenge };

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

function PubkeysSection({ csrf }: { csrf: string }) {
  const [list, setList] = useState<PubkeyListState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<LinkView>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [eventJson, setEventJson] = useState("");
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [unlink, setUnlink] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void reload;
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
  }, [reload]);

  // Password step-up is required on the FIRST link. Show the field unless we
  // already know this account holds a key; a failed list still shows it
  // (server ignores the extra password on a subsequent link).
  const firstLink = list.kind !== "ok" || list.pubkeys.length === 0;

  async function onStartLink(): Promise<void> {
    if (busy) return;
    setErr(null);
    setNotice(null);
    setBusy(true);
    try {
      const challenge = await startPubkeyChallenge(csrf);
      setView({ kind: "challenging", challenge });
      setEventJson("");
      setLabel("");
      setPassword("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSignWithExtension(): Promise<void> {
    if (view.kind !== "challenging") return;
    const nostr = hasNip07();
    if (!nostr) {
      setErr("No NIP-07 signer is available in this browser.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const tpl = view.challenge.event_template;
      const signed = await nostr.signEvent({
        kind: tpl.kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: tpl.tags,
        content: tpl.content,
      });
      setEventJson(JSON.stringify(signed, null, 2));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    setNotice(null);
    let event: SignedNostrEvent;
    try {
      const parsed = JSON.parse(eventJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setErr("Paste a signed NIP-01 event object.");
        return;
      }
      event = parsed as SignedNostrEvent;
    } catch {
      setErr("Signed event is not valid JSON.");
      return;
    }
    setBusy(true);
    try {
      const result = await verifyPubkeyLink(csrf, {
        event,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(password ? { password } : {}),
      });
      setView({ kind: "idle" });
      setEventJson("");
      setLabel("");
      setPassword("");
      setNotice(
        result.relinked
          ? `Re-verified ${truncatePubkey(result.pubkey)}.`
          : `Linked ${truncatePubkey(result.pubkey)}. A linked key grants nothing — it is an attribution label.`,
      );
      setReload((n) => n + 1);
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
      setReload((n) => n + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const nip07 = hasNip07();

  return (
    <section
      className="settings-block"
      aria-labelledby="account-pubkeys-heading"
      data-testid="account-pubkeys"
    >
      <h2 id="account-pubkeys-heading">Nostr keys</h2>
      <p className="muted">
        A linked key is an attribution label. It does not log you in, mint a token, or widen a
        scope. Unlink does not revoke tokens.
      </p>

      {notice ? (
        <p className="muted" data-testid="account-pubkeys-notice">
          {notice}
        </p>
      ) : null}

      {view.kind === "challenging" ? (
        <form onSubmit={(e) => void onVerify(e)} className="settings-form">
          <p>
            Sign this statement with a Nostr key you hold, then paste the signed event. A signer
            that shows you the content will show you this sentence:
          </p>
          <pre
            className="token-box"
            data-testid="account-pubkey-statement"
            style={{ whiteSpace: "pre-wrap" }}
          >
            <code>{view.challenge.event_template.content}</code>
          </pre>
          {nip07 ? (
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
          ) : (
            <p className="muted">
              No NIP-07 extension detected. Sign the event template elsewhere and paste the JSON
              below.
            </p>
          )}
          <label>
            Signed event (JSON)
            <textarea
              value={eventJson}
              onChange={(e) => setEventJson(e.target.value)}
              rows={8}
              style={{ width: "100%", fontFamily: "monospace", fontSize: "0.85rem" }}
              data-testid="account-pubkey-event"
            />
          </label>
          <label>
            Label (optional)
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="phone, signing device, …"
              data-testid="account-pubkey-label"
            />
          </label>
          {firstLink ? (
            <label>
              Current password (required to link your first key)
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="account-pubkey-password"
              />
            </label>
          ) : null}
          <div className="actions">
            <button type="submit" disabled={busy} data-testid="account-pubkey-verify">
              {busy ? "Verifying…" : "Link key"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setView({ kind: "idle" });
                setErr(null);
              }}
              data-testid="account-pubkey-cancel"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onStartLink()}
            data-testid="account-pubkey-link"
          >
            {busy ? "Starting…" : "Link a Nostr key"}
          </button>
        </div>
      )}

      {list.kind === "loading" ? (
        <p className="muted">Loading keys…</p>
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
    </section>
  );
}

function truncatePubkey(pubkey: string): string {
  if (pubkey.length <= 16) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}
