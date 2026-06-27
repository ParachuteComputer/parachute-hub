/**
 * React hook driving the admin screen-lock client behavior.
 *
 * Responsibilities:
 *   - On mount (and when signed in), fetch the lock status. A fresh load while
 *     a PIN is set + no unlock window = locked (the "lock on fresh load" rule).
 *   - Detect inactivity client-side: an idle timer set to the server's idle
 *     window. On expiry, flip to locked (the server will already refuse mints
 *     by then — this just shows the lock screen promptly instead of waiting for
 *     the next failed API call).
 *   - On activity (pointer / key / scroll), debounce a heartbeat that slides
 *     the server-side window forward AND restarts the local idle timer.
 *   - Re-check on tab refocus (a session left in another tab may have locked).
 *
 * The server is always authoritative; this hook is the UX layer that turns the
 * server's "423 Locked" reality into a clean lock screen with no thrash.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type AdminLockStatus, adminLockHeartbeat, getAdminLockStatus } from "./api.ts";

export interface UseAdminLock {
  /** True while the initial status fetch is in flight. */
  loading: boolean;
  /** True when a PIN is configured AND this session isn't unlocked. */
  locked: boolean;
  /** True when a PIN is configured (feature ON). */
  configured: boolean;
  /** Call after a successful unlock (or set) to refresh + clear the lock. */
  refresh: () => void;
}

/** Debounce window for the activity → heartbeat call. */
const HEARTBEAT_DEBOUNCE_MS = 30_000;

export function useAdminLock(csrf: string | null, enabled: boolean): UseAdminLock {
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [configured, setConfigured] = useState(false);

  // Timers + bookkeeping kept in refs so the activity listener (a stable
  // closure) can reach the latest values without re-subscribing on every render.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHeartbeat = useRef(0);
  const idleSeconds = useRef(15 * 60);
  const csrfRef = useRef<string | null>(csrf);
  const lockedRef = useRef(false);
  csrfRef.current = csrf;
  lockedRef.current = locked;

  const clearIdleTimer = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
  }, []);

  const armIdleTimer = useCallback(() => {
    clearIdleTimer();
    // Local idle expiry → show the lock screen. The server window is the same
    // length, so by the time this fires the next mint would 423 anyway.
    // Guard against a non-finite ref value: a bad/absent server `idle_seconds`
    // (NaN/undefined) must NOT collapse to setTimeout(fn, 0) and slam the
    // operator to the lock screen instantly — fall back to the 15-min default.
    const seconds = Number.isFinite(idleSeconds.current) ? idleSeconds.current : 15 * 60;
    idleTimer.current = setTimeout(() => setLocked(true), Math.max(1, seconds) * 1000);
  }, [clearIdleTimer]);

  const applyStatus = useCallback(
    (s: AdminLockStatus) => {
      setConfigured(s.configured);
      setLocked(s.locked);
      if (Number.isFinite(s.idle_seconds)) idleSeconds.current = s.idle_seconds;
      if (s.configured && !s.locked) {
        armIdleTimer();
      } else {
        clearIdleTimer();
      }
    },
    [armIdleTimer, clearIdleTimer],
  );

  const refresh = useCallback(() => {
    if (!enabled) return;
    getAdminLockStatus()
      .then(applyStatus)
      .catch(() => {
        // Network hiccup — leave current state; a later activity/refocus retries.
      })
      .finally(() => setLoading(false));
  }, [enabled, applyStatus]);

  // Initial + sign-in status fetch.
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    refresh();
  }, [enabled, refresh]);

  // Activity listeners: debounced heartbeat (slides the server window) +
  // re-arm the local idle timer. Only active while unlocked + configured.
  useEffect(() => {
    if (!enabled || !configured) return;

    function onActivity() {
      if (lockedRef.current) return; // locked — activity shouldn't extend anything
      armIdleTimer();
      const now = Date.now();
      if (now - lastHeartbeat.current < HEARTBEAT_DEBOUNCE_MS) return;
      lastHeartbeat.current = now;
      const token = csrfRef.current;
      if (!token) return;
      adminLockHeartbeat(token)
        .then((s) => {
          // The server may report a lock that drifted (e.g. another tab locked).
          if (s.locked) setLocked(true);
          // Re-anchor the local idle window from the heartbeat — but ONLY when
          // the server actually sent a usable number. Assigning an absent field
          // here is what poisoned the timer (→ NaN → instant re-lock).
          else if (Number.isFinite(s.idle_seconds)) idleSeconds.current = s.idle_seconds;
        })
        .catch(() => {
          // Ignore — the idle timer + next mint failure are the backstop.
        });
    }

    const events: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "scroll", "mousemove"];
    for (const ev of events) window.addEventListener(ev, onActivity, { passive: true });
    // Re-check on tab refocus — a session may have locked while backgrounded.
    function onFocus() {
      refresh();
    }
    window.addEventListener("focus", onFocus);
    return () => {
      for (const ev of events) window.removeEventListener(ev, onActivity);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, configured, armIdleTimer, refresh]);

  useEffect(() => () => clearIdleTimer(), [clearIdleTimer]);

  return { loading, locked, configured, refresh };
}
