/**
 * Settings route smoke tests for the canonical hub URL surface
 * (hub#298). Covers initial render across the three source states,
 * save round-trip + optimistic refetch, reset, error surface.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Settings } from "./Settings.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    getHubOriginSetting: vi.fn(),
    setHubOriginSetting: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderRoute() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
}

describe("Settings — initial render across source states", () => {
  it("shows loading on first paint", () => {
    vi.mocked(api.getHubOriginSetting).mockImplementation(() => new Promise(() => {}));
    renderRoute();
    expect(screen.getByText(/loading settings/i)).toBeInTheDocument();
  });

  it("renders source=request with the request origin (default first-boot state)", async () => {
    vi.mocked(api.getHubOriginSetting).mockResolvedValue({
      hub_origin: null,
      resolved_issuer: "http://127.0.0.1:1939",
      source: "request",
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("hub-origin-source")).toHaveTextContent(/from request origin/i),
    );
    expect(screen.getByTestId("hub-origin-current")).toHaveTextContent("http://127.0.0.1:1939");
    // Input is empty (no stored value).
    const input = screen.getByLabelText(/canonical url/i) as HTMLInputElement;
    expect(input.value).toBe("");
    // Reset is disabled because nothing is stored.
    expect(screen.getByRole("button", { name: /reset to default/i })).toBeDisabled();
    // Save is disabled because the draft matches the empty stored state.
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("renders source=env with the env-resolved URL + env attribution label", async () => {
    vi.mocked(api.getHubOriginSetting).mockResolvedValue({
      hub_origin: null,
      resolved_issuer: "https://hub.from-env.example",
      source: "env",
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("hub-origin-source")).toHaveTextContent(/from env var/i),
    );
    expect(screen.getByTestId("hub-origin-source")).toHaveTextContent("PARACHUTE_HUB_ORIGIN");
    expect(screen.getByTestId("hub-origin-current")).toHaveTextContent(
      "https://hub.from-env.example",
    );
    // Input is still empty — the stored row is empty even though env wins.
    const input = screen.getByLabelText(/canonical url/i) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("renders source=settings + pre-fills the input from the stored value", async () => {
    vi.mocked(api.getHubOriginSetting).mockResolvedValue({
      hub_origin: "https://hub.example.com",
      resolved_issuer: "https://hub.example.com",
      source: "settings",
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("hub-origin-source")).toHaveTextContent(/from settings/i),
    );
    const input = screen.getByLabelText(/canonical url/i) as HTMLInputElement;
    expect(input.value).toBe("https://hub.example.com");
    expect(screen.getByRole("button", { name: /reset to default/i })).not.toBeDisabled();
  });
});

describe("Settings — save flow", () => {
  it("writes the new value + refetches on submit", async () => {
    vi.mocked(api.getHubOriginSetting)
      .mockResolvedValueOnce({
        hub_origin: null,
        resolved_issuer: "http://127.0.0.1:1939",
        source: "request",
      })
      .mockResolvedValueOnce({
        hub_origin: "https://hub.example.com",
        resolved_issuer: "https://hub.example.com",
        source: "settings",
      });
    vi.mocked(api.setHubOriginSetting).mockResolvedValue("https://hub.example.com");

    renderRoute();
    const input = await screen.findByLabelText(/canonical url/i);

    fireEvent.change(input, { target: { value: "https://hub.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(api.setHubOriginSetting).toHaveBeenCalledWith("https://hub.example.com"),
    );
    // Refetch — source label flips to "from settings".
    await waitFor(() =>
      expect(screen.getByTestId("hub-origin-source")).toHaveTextContent(/from settings/i),
    );
    expect(screen.getByTestId("hub-origin-current")).toHaveTextContent("https://hub.example.com");
  });

  it("surfaces the server's 400 error message", async () => {
    vi.mocked(api.getHubOriginSetting).mockResolvedValue({
      hub_origin: null,
      resolved_issuer: "http://127.0.0.1:1939",
      source: "request",
    });
    vi.mocked(api.setHubOriginSetting).mockRejectedValue(
      new api.HttpError(400, "hub_origin must not have a trailing slash"),
    );

    renderRoute();
    const input = await screen.findByLabelText(/canonical url/i);

    fireEvent.change(input, { target: { value: "https://hub.example.com/" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(screen.getByTestId("hub-origin-save-error")).toHaveTextContent(/trailing slash/i),
    );
  });

  it("treats an empty input as a clear (null) when saved", async () => {
    vi.mocked(api.getHubOriginSetting)
      .mockResolvedValueOnce({
        hub_origin: "https://hub.example.com",
        resolved_issuer: "https://hub.example.com",
        source: "settings",
      })
      .mockResolvedValueOnce({
        hub_origin: null,
        resolved_issuer: "http://127.0.0.1:1939",
        source: "request",
      });
    vi.mocked(api.setHubOriginSetting).mockResolvedValue(null);

    renderRoute();
    const input = (await screen.findByLabelText(/canonical url/i)) as HTMLInputElement;
    expect(input.value).toBe("https://hub.example.com");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(api.setHubOriginSetting).toHaveBeenCalledWith(null));
  });
});

describe("Settings — reset flow", () => {
  it("calls setHubOriginSetting(null) + refetches", async () => {
    vi.mocked(api.getHubOriginSetting)
      .mockResolvedValueOnce({
        hub_origin: "https://hub.example.com",
        resolved_issuer: "https://hub.example.com",
        source: "settings",
      })
      .mockResolvedValueOnce({
        hub_origin: null,
        resolved_issuer: "http://127.0.0.1:1939",
        source: "request",
      });
    vi.mocked(api.setHubOriginSetting).mockResolvedValue(null);

    renderRoute();
    await screen.findByLabelText(/canonical url/i);

    fireEvent.click(screen.getByRole("button", { name: /reset to default/i }));

    await waitFor(() => expect(api.setHubOriginSetting).toHaveBeenCalledWith(null));
    await waitFor(() =>
      expect(screen.getByTestId("hub-origin-source")).toHaveTextContent(/from request origin/i),
    );
    // Input is cleared after the refetch.
    const input = screen.getByLabelText(/canonical url/i) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("reset is disabled when no value is stored", async () => {
    vi.mocked(api.getHubOriginSetting).mockResolvedValue({
      hub_origin: null,
      resolved_issuer: "https://hub.from-env.example",
      source: "env",
    });
    renderRoute();
    await screen.findByLabelText(/canonical url/i);
    expect(screen.getByRole("button", { name: /reset to default/i })).toBeDisabled();
  });
});

describe("Settings — error states", () => {
  it("surfaces a load failure with a retry button", async () => {
    vi.mocked(api.getHubOriginSetting).mockRejectedValueOnce(
      new api.HttpError(500, "internal error"),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
