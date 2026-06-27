/**
 * /admin/account — "My account": self-service password + 2FA for the
 * signed-in user (hub#85). Aaron chose option B — native in the SPA rather
 * than a link out to the server-rendered `/account/`.
 *
 * The owner is NOT special here: `two_factor_enabled` comes from `/api/me`
 * (keyed off the session's own user), and every action POSTs to
 * `/api/account/*`, which act on `session.userId`. Same path for the first
 * admin and any friend user.
 *
 * Two sections:
 *   - Password — current → new (+ confirm). 12-char floor mirrors the server
 *     validator; the server is authoritative (its 400/401 message surfaces).
 *   - Two-factor — status pill; when off, an enroll flow (QR + secret + verify
 *     a code → backup codes shown ONCE); when on, a password-gated disable.
 *
 * The CSRF token + 2FA status are read from `/api/me` (the single who-am-I
 * read App.tsx already does). We refetch it after a 2FA change so the status
 * pill + section swap without a full reload.
 */
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type MeResponse,
  type TwoFactorStart,
  changeAccountPassword,
  confirmTwoFactor,
  disableTwoFactor,
  getMe,
  startTwoFactor,
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
        Manage your own sign-in credentials. Changes here apply to your account only.
      </p>

      <PasswordSection csrf={state.csrf} />
      <TwoFactorSection
        csrf={state.csrf}
        enabled={state.twoFactorEnabled}
        onChanged={() => void refresh()}
      />
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
