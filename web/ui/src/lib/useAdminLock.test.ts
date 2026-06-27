/**
 * useAdminLock — the client timing logic behind the admin screen-lock.
 *
 * The regression these tests pin (the "PIN re-prompts every few seconds"
 * loop, #678-adjacent): the hook re-anchors its LOCAL idle timer from the
 * server's `idle_seconds` on every heartbeat. When the `/heartbeat` response
 * OMITTED that field, `idleSeconds.current` was overwritten with `undefined`,
 * `armIdleTimer` computed `Math.max(1, undefined) * 1000 = NaN`, and
 * `setTimeout(fn, NaN)` coerced to `setTimeout(fn, 0)` — slamming the operator
 * back to the lock screen almost instantly, over and over.
 *
 * Two halves of the fix are exercised here:
 *   1. A heartbeat WITHOUT a usable `idle_seconds` must NOT poison the timer
 *      (the client now guards with Number.isFinite + a 15-min fallback).
 *   2. A heartbeat WITH `idle_seconds` re-anchors the window to that value.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api.ts";
import { useAdminLock } from "./useAdminLock.ts";

vi.mock("./api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    getAdminLockStatus: vi.fn(),
    adminLockHeartbeat: vi.fn(),
  };
});

const CSRF = "csrf-token";
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

/** Flush microtasks (the awaited fetch promises inside the hook). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Fire a single activity event the hook listens for. */
function activity() {
  act(() => {
    window.dispatchEvent(new Event("pointerdown"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useAdminLock — idle timer re-anchoring", () => {
  it("a heartbeat WITHOUT idle_seconds does NOT instantly re-lock (the bug)", async () => {
    // Configured + unlocked, idle window 900s.
    vi.mocked(api.getAdminLockStatus).mockResolvedValue({
      configured: true,
      locked: false,
      idle_seconds: 900,
      unlock_seconds_remaining: 900,
    });
    // The poisoned shape: the old server response omitted idle_seconds. We model
    // it explicitly as a value the type claims is present but runtime lacks.
    vi.mocked(api.adminLockHeartbeat).mockResolvedValue({
      configured: true,
      locked: false,
      unlock_seconds_remaining: 900,
    } as unknown as api.AdminLockStatus);

    const { result } = renderHook(() => useAdminLock(CSRF, true));
    await flush(); // initial getAdminLockStatus resolves

    expect(result.current.configured).toBe(true);
    expect(result.current.locked).toBe(false);

    // First activity → fires the (poisoned) heartbeat AND arms the idle timer
    // (with the load-time 900s). The heartbeat resolves and, in the BUGGY
    // version, overwrote idleSeconds.current with undefined.
    activity();
    await flush();

    // A SECOND activity re-arms the timer. In the buggy version this computed
    // Math.max(1, undefined) * 1000 = NaN → setTimeout(fn, 0) → instant lock.
    // (Advance past the heartbeat debounce so the 2nd activity is a clean
    // re-arm, mirroring real continuous use.)
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    activity();
    await flush();

    // Advance well past the broken-instant window but short of the real one.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // The bug locked here (NaN → 0ms). With the guard, still unlocked.
    expect(result.current.locked).toBe(false);

    // It DOES still lock at the legitimate fallback window (15 min) from the
    // last re-arm.
    act(() => {
      vi.advanceTimersByTime(FIFTEEN_MIN_MS);
    });
    expect(result.current.locked).toBe(true);
  });

  it("a heartbeat WITH idle_seconds re-anchors the window to that value", async () => {
    vi.mocked(api.getAdminLockStatus).mockResolvedValue({
      configured: true,
      locked: false,
      idle_seconds: 900,
      unlock_seconds_remaining: 900,
    });
    // Heartbeat reports a SHORTER window (operator tightened it mid-session).
    vi.mocked(api.adminLockHeartbeat).mockResolvedValue({
      configured: true,
      locked: false,
      idle_seconds: 120,
      unlock_seconds_remaining: 120,
    });

    const { result } = renderHook(() => useAdminLock(CSRF, true));
    await flush();

    // First activity: arms the timer with the load-time window (900s) AND sends
    // a heartbeat. The heartbeat's idle_seconds (120) lands in the ref AFTER the
    // timer was armed — armIdleTimer runs synchronously, the heartbeat resolves
    // later — so it takes effect on the NEXT activity, not this timer.
    activity();
    await flush();

    // A SUBSEQUENT activity (debounced past the heartbeat window via the clock)
    // re-arms with the heartbeat-reported 120s.
    act(() => {
      vi.advanceTimersByTime(31_000); // past HEARTBEAT_DEBOUNCE_MS so a 2nd HB could fire
    });
    activity();
    await flush();

    // 119s after the re-arm: still unlocked (window is now 120s).
    act(() => {
      vi.advanceTimersByTime(119_000);
    });
    expect(result.current.locked).toBe(false);

    // Cross 120s: re-lock fires at the heartbeat-reported window.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.locked).toBe(true);
  });

  it("a fresh load while a PIN is set + no unlock window starts locked", async () => {
    vi.mocked(api.getAdminLockStatus).mockResolvedValue({
      configured: true,
      locked: true,
      idle_seconds: 900,
      unlock_seconds_remaining: 0,
    });

    const { result } = renderHook(() => useAdminLock(CSRF, true));
    await flush();

    expect(result.current.configured).toBe(true);
    expect(result.current.locked).toBe(true);
  });

  it("a heartbeat reporting locked (drift) flips to locked", async () => {
    vi.mocked(api.getAdminLockStatus).mockResolvedValue({
      configured: true,
      locked: false,
      idle_seconds: 900,
      unlock_seconds_remaining: 900,
    });
    vi.mocked(api.adminLockHeartbeat).mockResolvedValue({
      configured: true,
      locked: true,
      idle_seconds: 900,
      unlock_seconds_remaining: 0,
    });

    const { result } = renderHook(() => useAdminLock(CSRF, true));
    await flush();
    expect(result.current.locked).toBe(false);

    activity();
    await flush();
    expect(result.current.locked).toBe(true);
  });

  it("feature OFF (no PIN) never arms a timer or locks", async () => {
    vi.mocked(api.getAdminLockStatus).mockResolvedValue({
      configured: false,
      locked: false,
      idle_seconds: 900,
      unlock_seconds_remaining: 0,
    });

    const { result } = renderHook(() => useAdminLock(CSRF, true));
    await flush();

    activity();
    await flush();
    act(() => {
      vi.advanceTimersByTime(2 * FIFTEEN_MIN_MS);
    });
    expect(result.current.configured).toBe(false);
    expect(result.current.locked).toBe(false);
    // No heartbeat is sent while unconfigured.
    expect(api.adminLockHeartbeat).not.toHaveBeenCalled();
  });
});
