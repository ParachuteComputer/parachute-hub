/**
 * LockScreen — unit coverage for the PIN-entry surface.
 *   - Unlock calls `unlockAdmin(csrf, pin)` and fires `onUnlocked` on success.
 *   - A wrong PIN (HttpError 401) shows an error and clears the field.
 *   - A rate-limit (429) shows the wait message.
 *   - The Unlock button is disabled until the PIN is at least 4 digits.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api.ts";
import { LockScreen } from "./LockScreen.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return { ...actual, unlockAdmin: vi.fn() };
});

afterEach(() => vi.clearAllMocks());

describe("LockScreen", () => {
  it("unlocks on a correct PIN and calls onUnlocked", async () => {
    vi.mocked(api.unlockAdmin).mockResolvedValue({
      configured: true,
      locked: false,
      idle_seconds: 900,
      unlock_seconds_remaining: 900,
    });
    const onUnlocked = vi.fn();
    render(<LockScreen csrf="csrf-1" onUnlocked={onUnlocked} />);
    fireEvent.change(screen.getByTestId("admin-lock-pin-input"), { target: { value: "4827" } });
    fireEvent.click(screen.getByTestId("admin-lock-unlock"));
    await waitFor(() => expect(api.unlockAdmin).toHaveBeenCalledWith("csrf-1", "4827"));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
  });

  it("shows 'Incorrect PIN.' on a 401 and clears the field", async () => {
    vi.mocked(api.unlockAdmin).mockRejectedValue(new api.HttpError(401, "incorrect PIN"));
    const onUnlocked = vi.fn();
    render(<LockScreen csrf="csrf-1" onUnlocked={onUnlocked} />);
    const input = screen.getByTestId("admin-lock-pin-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0000" } });
    fireEvent.click(screen.getByTestId("admin-lock-unlock"));
    expect(await screen.findByTestId("admin-lock-error")).toHaveTextContent(/incorrect pin/i);
    expect(input.value).toBe("");
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("shows the wait message on a 429 rate-limit", async () => {
    vi.mocked(api.unlockAdmin).mockRejectedValue(new api.HttpError(429, "too many"));
    render(<LockScreen csrf="csrf-1" onUnlocked={vi.fn()} />);
    fireEvent.change(screen.getByTestId("admin-lock-pin-input"), { target: { value: "0000" } });
    fireEvent.click(screen.getByTestId("admin-lock-unlock"));
    expect(await screen.findByTestId("admin-lock-error")).toHaveTextContent(/too many attempts/i);
  });

  it("disables Unlock until the PIN is at least 4 digits", () => {
    render(<LockScreen csrf="csrf-1" onUnlocked={vi.fn()} />);
    const btn = screen.getByTestId("admin-lock-unlock");
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByTestId("admin-lock-pin-input"), { target: { value: "12" } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByTestId("admin-lock-pin-input"), { target: { value: "1234" } });
    expect(btn).not.toBeDisabled();
  });

  it("strips non-digit characters from input", () => {
    render(<LockScreen csrf="csrf-1" onUnlocked={vi.fn()} />);
    const input = screen.getByTestId("admin-lock-pin-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12ab34" } });
    expect(input.value).toBe("1234");
  });
});
