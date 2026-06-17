/**
 * Full-surface lock screen for the admin SPA (optional idle PIN lock).
 *
 * Rendered by `App` INSTEAD of the admin content when the operator's session is
 * locked (a PIN is configured + no fresh unlock). Phone-style: one PIN field,
 * Unlock → the whole admin surface is usable again. The server is the source of
 * truth — this is the visible half of the `/admin/*-token` mint refusing to
 * mint while locked (every admin API would fail closed anyway; this turns that
 * into a clean "enter your PIN" instead of a wall of errors).
 */
import { type FormEvent, useEffect, useRef, useState } from "react";
import { HttpError, unlockAdmin } from "../lib/api.ts";
import { BrandMark, WORDMARK_TEXT } from "./BrandMark.tsx";

interface LockScreenProps {
  /** CSRF token from /api/me — required for the unlock POST. */
  csrf: string;
  /** Called after a successful unlock so the parent re-renders the admin shell. */
  onUnlocked: () => void;
}

export function LockScreen({ csrf, onUnlocked }: LockScreenProps) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await unlockAdmin(csrf, pin);
      setPin("");
      onUnlocked();
    } catch (err) {
      // 401 wrong PIN, 429 rate-limited — surface the server's message.
      const msg =
        err instanceof HttpError
          ? err.status === 429
            ? "Too many attempts — wait a moment and try again."
            : "Incorrect PIN."
          : err instanceof Error
            ? err.message
            : "Unlock failed.";
      setError(msg);
      setPin("");
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    // The lock screen REPLACES the whole admin shell (it's not a modal layered
    // over live content), so it's the page's main landmark rather than a
    // role="dialog". `aria-label` names it for assistive tech.
    <main className="lock-screen" data-testid="admin-lock-screen" aria-label="Admin console locked">
      <div className="lock-card">
        <BrandMark size={32} idSuffix="lock" className="lock-brand-mark" />
        <h1 className="lock-title">{WORDMARK_TEXT} is locked</h1>
        <p className="muted lock-sub">Enter your PIN to unlock the admin console.</p>
        <form onSubmit={(e) => void onSubmit(e)} className="lock-form">
          <label htmlFor="admin-lock-pin" className="visually-hidden">
            PIN
          </label>
          <input
            id="admin-lock-pin"
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            // Digits only, matching the server's 4–12 digit rule. The pattern
            // is a UX nudge; the server is authoritative.
            pattern="[0-9]*"
            maxLength={12}
            placeholder="••••"
            value={pin}
            disabled={busy}
            onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ""))}
            className="lock-pin-input"
            data-testid="admin-lock-pin-input"
            aria-invalid={error ? "true" : undefined}
          />
          <button type="submit" disabled={busy || pin.length < 4} data-testid="admin-lock-unlock">
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </form>
        {error && (
          <div className="error lock-error" role="alert" data-testid="admin-lock-error">
            {error}
          </div>
        )}
      </div>
    </main>
  );
}
