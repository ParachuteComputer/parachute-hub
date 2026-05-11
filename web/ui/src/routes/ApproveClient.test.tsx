/**
 * ApproveClient route smoke tests — loading, pending render + approve flow,
 * already-approved on load, unknown client, approve error.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { ApproveClient } from "./ApproveClient.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    getOauthClient: vi.fn(),
    approveOauthClient: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderRoute(clientId = "c1") {
  return render(
    <MemoryRouter initialEntries={[`/approve-client/${clientId}`]}>
      <Routes>
        <Route path="/approve-client/:clientId" element={<ApproveClient />} />
      </Routes>
    </MemoryRouter>,
  );
}

const pendingClient = (overrides: Partial<api.AdminClientView> = {}): api.AdminClientView => ({
  client_id: "c1",
  client_name: "Notes",
  redirect_uris: ["https://notes.example/cb"],
  scopes: ["vault:work:read"],
  status: "pending",
  registered_at: "2026-05-11T12:00:00.000Z",
  ...overrides,
});

describe("ApproveClient", () => {
  it("renders the pending client details + Approve button", async () => {
    vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient());
    renderRoute();
    await waitFor(() => expect(screen.getByText("Notes")).toBeInTheDocument());
    expect(screen.getByText("https://notes.example/cb")).toBeInTheDocument();
    expect(screen.getByText("vault:work:read")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve notes/i })).toBeInTheDocument();
  });

  it("clicking Approve calls the API and renders success", async () => {
    vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient());
    vi.mocked(api.approveOauthClient).mockResolvedValue({
      client_id: "c1",
      status: "approved",
      already_approved: false,
    });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /approve notes/i }));
    await waitFor(() => expect(screen.getByText(/^approved\.$/i)).toBeInTheDocument());
    expect(api.approveOauthClient).toHaveBeenCalledWith("c1");
    expect(screen.getByText(/can now run an OAuth flow/i)).toBeInTheDocument();
  });

  it("short-circuits to success if the row was already approved on load", async () => {
    vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient({ status: "approved" }));
    renderRoute();
    await waitFor(() => expect(screen.getByText(/already approved/i)).toBeInTheDocument());
    // Approve button should not render in the already-approved short-circuit.
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(api.approveOauthClient).not.toHaveBeenCalled();
  });

  it("renders 'Unknown client' when the API returns 404", async () => {
    vi.mocked(api.getOauthClient).mockRejectedValue(new api.HttpError(404, "no client"));
    renderRoute();
    await waitFor(() => expect(screen.getByText(/unknown client/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("surfaces approve errors inline without leaving the page", async () => {
    vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient());
    vi.mocked(api.approveOauthClient).mockRejectedValue(new api.HttpError(500, "db unavailable"));
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /approve notes/i }));
    await waitFor(() => expect(screen.getByText(/approve failed/i)).toBeInTheDocument());
    expect(screen.getByText(/db unavailable/i)).toBeInTheDocument();
    // Still on the same screen — Approve button reappears for a retry.
    expect(screen.getByRole("button", { name: /approve notes/i })).toBeInTheDocument();
  });

  it("renders the error banner + retry on initial load failure", async () => {
    vi.mocked(api.getOauthClient).mockRejectedValue(new Error("network down"));
    renderRoute();
    await waitFor(() => expect(screen.getByText(/couldn't load the client/i)).toBeInTheDocument());
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
