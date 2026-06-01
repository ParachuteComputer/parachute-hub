/**
 * HubUpgradeCard component tests (design 2026-06-01 §5.3 / D4) — the four
 * upgrade-flow states the no-shell operator sees:
 *   - in-progress ("upgrading… the hub will restart")
 *   - success (the new version answers)
 *   - timeout ("the hub may still be coming up — refresh shortly")
 *   - redeploy-required (image-pinned container → dashboard hint, NO spinner)
 *
 * The polling loop is driven with fake timers so the success/timeout paths are
 * deterministic. `getHubStatus` / `startHubUpgrade` / `getHubUpgradeStatus` are
 * mocked off `../lib/api.ts`.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HubStatus, HubUpgradeAccepted } from "../lib/api.ts";
import * as api from "../lib/api.ts";
import { HubUpgradeCard } from "./HubUpgradeCard.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    getHubStatus: vi.fn(),
    startHubUpgrade: vi.fn(),
    getHubUpgradeStatus: vi.fn(),
  };
});

const mkStatus = (overrides: Partial<HubStatus> = {}): HubStatus => ({
  version: "0.6.3-rc.1",
  started_at: "2026-06-01T00:00:00.000Z",
  uptime_ms: 1000,
  source: "container",
  ...overrides,
});

const accepted = (overrides: Partial<HubUpgradeAccepted> = {}): HubUpgradeAccepted => ({
  operation_id: "op-1",
  target_version: "0.6.3-rc.2",
  channel: "rc",
  mode: "in-place",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("HubUpgradeCard — initial render", () => {
  it("renders nothing until the hub status resolves", () => {
    vi.mocked(api.getHubStatus).mockReturnValue(new Promise(() => {}));
    const { container } = render(<HubUpgradeCard />);
    expect(container.querySelector("[data-testid=hub-upgrade-card]")).toBeNull();
  });

  it("renders current version + Upgrade button once status loads", async () => {
    vi.mocked(api.getHubStatus).mockResolvedValue(mkStatus());
    render(<HubUpgradeCard />);
    await waitFor(() => expect(screen.getByTestId("hub-upgrade-card")).toBeInTheDocument());
    expect(screen.getByTestId("hub-current-version")).toHaveTextContent("v0.6.3-rc.1");
    expect(screen.getByTestId("hub-upgrade-button")).toHaveTextContent("Upgrade hub");
  });
});

describe("HubUpgradeCard — in-progress + success", () => {
  it("shows upgrading then success when the new version answers", async () => {
    vi.useFakeTimers();
    // First getHubStatus (mount) → current; subsequent polls → new version.
    vi.mocked(api.getHubStatus)
      .mockResolvedValueOnce(mkStatus({ version: "0.6.3-rc.1" }))
      .mockResolvedValue(mkStatus({ version: "0.6.3-rc.2" }));
    vi.mocked(api.startHubUpgrade).mockResolvedValue(accepted());
    vi.mocked(api.getHubUpgradeStatus).mockResolvedValue(null);

    render(<HubUpgradeCard />);
    await vi.waitFor(() => expect(screen.getByTestId("hub-upgrade-card")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("hub-upgrade-button"));
    // The POST resolves → "upgrading" state.
    await vi.waitFor(() =>
      expect(screen.getByTestId("hub-upgrade-state-upgrading")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("hub-upgrade-state-upgrading")).toHaveTextContent("0.6.3-rc.2");

    // Advance the poll loop — the new version answers → success.
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() =>
      expect(screen.getByTestId("hub-upgrade-state-success")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("hub-upgrade-state-success")).toHaveTextContent("0.6.3-rc.2");
  });
});

describe("HubUpgradeCard — timeout", () => {
  it("shows the timeout copy when the new version never answers", async () => {
    vi.useFakeTimers();
    // Mount → current; every poll → still the same version (never upgrades).
    vi.mocked(api.getHubStatus).mockResolvedValue(mkStatus({ version: "0.6.3-rc.1" }));
    vi.mocked(api.startHubUpgrade).mockResolvedValue(accepted());
    vi.mocked(api.getHubUpgradeStatus).mockResolvedValue({
      operation_id: "op-1",
      phase: "restarting",
      mode: "in-place",
      current_version: "0.6.3-rc.1",
      target_version: "0.6.3-rc.2",
      channel: "rc",
      log: ["hub unit restarted via the service manager"],
      started_at: "2026-06-01T00:00:00.000Z",
    });

    render(<HubUpgradeCard />);
    await vi.waitFor(() => expect(screen.getByTestId("hub-upgrade-card")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("hub-upgrade-button"));
    await vi.waitFor(() =>
      expect(screen.getByTestId("hub-upgrade-state-upgrading")).toBeInTheDocument(),
    );

    // Blow past the 120s bounded deadline.
    await vi.advanceTimersByTimeAsync(125_000);
    await vi.waitFor(() =>
      expect(screen.getByTestId("hub-upgrade-state-timeout")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("hub-upgrade-state-timeout")).toHaveTextContent(
      "may still be coming up",
    );
    // The last status log line is surfaced as the unit/platform hint.
    expect(screen.getByTestId("hub-upgrade-state-timeout")).toHaveTextContent(
      "hub unit restarted via the service manager",
    );
  });
});

describe("HubUpgradeCard — redeploy-required (image-pinned)", () => {
  it("shows the dashboard hint and NO upgrade-progress spinner", async () => {
    vi.mocked(api.getHubStatus).mockResolvedValue(mkStatus({ source: "container" }));
    vi.mocked(api.startHubUpgrade).mockResolvedValue(
      accepted({ mode: "redeploy-required", target_version: "0.6.3-rc.2" }),
    );

    render(<HubUpgradeCard />);
    await waitFor(() => expect(screen.getByTestId("hub-upgrade-card")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("hub-upgrade-button"));

    await waitFor(() =>
      expect(screen.getByTestId("hub-upgrade-state-redeploy")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("hub-upgrade-state-redeploy")).toHaveTextContent(
      /redeploy from your platform dashboard/i,
    );
    // The upgrade button is replaced by a redeploy hint (no no-op button).
    expect(screen.queryByTestId("hub-upgrade-button")).toBeNull();
    expect(screen.getByTestId("hub-redeploy-hint")).toBeInTheDocument();
  });
});

describe("HubUpgradeCard — error", () => {
  it("surfaces a POST failure", async () => {
    vi.mocked(api.getHubStatus).mockResolvedValue(mkStatus());
    vi.mocked(api.startHubUpgrade).mockRejectedValue(new Error("boom"));

    render(<HubUpgradeCard />);
    await waitFor(() => expect(screen.getByTestId("hub-upgrade-card")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("hub-upgrade-button"));
    await waitFor(() => expect(screen.getByTestId("hub-upgrade-state-error")).toBeInTheDocument());
    expect(screen.getByTestId("hub-upgrade-state-error")).toHaveTextContent("boom");
  });
});
