/**
 * HubVersionBadge smoke tests — renders version + uptime + source on
 * mount; click expands the detail panel; refresh button refetches.
 *
 * Auth failure shapes: 401/403 from getHubStatus surface as thrown
 * HttpErrors; the badge swallows and renders null (or the prior
 * status). We assert the null-on-initial-failure shape rather than the
 * recovery shape — that one's exercised through the live SPA, not
 * worth the extra mock juggle here.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError, type HubStatus } from "../lib/api.ts";
import * as api from "../lib/api.ts";
import { HubVersionBadge, formatUptime } from "./HubVersionBadge.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    getHubStatus: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mkStatus = (overrides: Partial<HubStatus> = {}): HubStatus => ({
  version: "0.5.13-rc.23",
  started_at: "2026-05-23T14:23:45.000Z",
  uptime_ms: 8025000, // 2h 13m
  source: "container",
  ...overrides,
});

describe("formatUptime", () => {
  it("seconds for <1m", () => {
    expect(formatUptime(45_000)).toBe("45s");
  });
  it("minutes for <1h", () => {
    expect(formatUptime(45 * 60 * 1000)).toBe("45m");
  });
  it("hours+minutes for <1d", () => {
    expect(formatUptime((2 * 60 + 13) * 60 * 1000)).toBe("2h 13m");
  });
  it("days+hours for >=1d", () => {
    expect(formatUptime((30 * 60 + 0) * 60 * 1000)).toBe("1d 6h");
  });
});

describe("HubVersionBadge — initial render", () => {
  it("renders nothing until the first fetch resolves", () => {
    vi.mocked(api.getHubStatus).mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<HubVersionBadge />);
    expect(container.querySelector("[data-testid=hub-version-badge]")).toBeNull();
  });

  it("renders version + uptime + source after fetch", async () => {
    vi.mocked(api.getHubStatus).mockResolvedValue(mkStatus());
    render(<HubVersionBadge />);
    await waitFor(() =>
      expect(screen.getByTestId("hub-version-badge-summary")).toBeInTheDocument(),
    );
    const summary = screen.getByTestId("hub-version-badge-summary");
    expect(summary.textContent).toContain("0.5.13-rc.23");
    expect(summary.textContent).toContain("2h 13m");
    expect(screen.getByTestId("hub-version-badge-source").textContent).toBe("container");
  });

  it("collapses (renders null) when first fetch fails with 401", async () => {
    vi.mocked(api.getHubStatus).mockRejectedValue(new HttpError(401, "no session"));
    const { container } = render(<HubVersionBadge />);
    // Let the rejection settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector("[data-testid=hub-version-badge]")).toBeNull();
  });
});

describe("HubVersionBadge — expand + refresh", () => {
  it("clicking the summary expands the detail panel", async () => {
    vi.mocked(api.getHubStatus).mockResolvedValue(
      mkStatus({
        source: "bun-linked",
        bun_linked_path: "/Users/p/ParachuteComputer/parachute-hub",
        git_head: "a53af21",
      }),
    );
    render(<HubVersionBadge />);
    const summary = await waitFor(() => screen.getByTestId("hub-version-badge-summary"));

    // Panel hidden initially.
    expect(screen.queryByTestId("hub-version-badge-panel")).toBeNull();

    fireEvent.click(summary);

    const panel = await waitFor(() => screen.getByTestId("hub-version-badge-panel"));
    expect(panel.textContent).toContain("@openparachute/hub 0.5.13-rc.23");
    expect(panel.textContent).toContain("bun-linked");
    // Source detail surfaces basename + git head when bun-linked.
    expect(panel.textContent).toContain("parachute-hub");
    expect(panel.textContent).toContain("a53af21");
    // "Started" line carries the formatted UTC timestamp + (uptime ago).
    expect(panel.textContent).toMatch(/Started/);
    expect(panel.textContent).toMatch(/2026-05-23 14:23:45 UTC/);
  });

  it("clicking refresh refetches /api/hub", async () => {
    const first = mkStatus({ uptime_ms: 8025000 });
    const second = mkStatus({ uptime_ms: 8055000 }); // 30s later
    vi.mocked(api.getHubStatus).mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    render(<HubVersionBadge />);
    const summary = await waitFor(() => screen.getByTestId("hub-version-badge-summary"));
    fireEvent.click(summary);

    const refresh = await waitFor(() => screen.getByTestId("hub-version-badge-refresh"));
    fireEvent.click(refresh);

    await waitFor(() =>
      expect(vi.mocked(api.getHubStatus).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    // After the refetch, the summary uptime should reflect the new value
    // (8055s = still 2h 14m — assert the call count instead, which is
    // deterministic regardless of formatting boundaries).
    expect(vi.mocked(api.getHubStatus)).toHaveBeenCalledTimes(2);
  });

  it("shows container_build_time when surfaced", async () => {
    vi.mocked(api.getHubStatus).mockResolvedValue(
      mkStatus({
        source: "container",
        container_build_time: "2026-05-23T14:21:00.000Z",
      }),
    );
    render(<HubVersionBadge />);
    const summary = await waitFor(() => screen.getByTestId("hub-version-badge-summary"));
    fireEvent.click(summary);

    const panel = await waitFor(() => screen.getByTestId("hub-version-badge-panel"));
    expect(panel.textContent).toContain("Built");
    expect(panel.textContent).toContain("2026-05-23 14:21:00 UTC");
  });
});
