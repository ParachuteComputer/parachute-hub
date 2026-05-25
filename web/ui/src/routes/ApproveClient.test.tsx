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

function renderRoute(clientId = "c1", search = "") {
  const url = `/approve-client/${clientId}${search}`;
  return render(
    <MemoryRouter initialEntries={[url]}>
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
    // Workstream D added a second arg (returnTo); share-link case passes
    // undefined.
    expect(api.approveOauthClient).toHaveBeenCalledWith("c1", undefined);
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

  // Approval-UX rc.19 (Issue 2): unnamed vault scopes get rendered as
  // `vault:*:<verb>` on the operator approval page, with an inline
  // explanation about how a specific vault is selected during sign-in.
  // The pre-rc.19 shape rendered raw `vault:read`, which implied
  // vault-wide unrestricted access — silent narrowing at mint surprised
  // operators.
  it("renders unnamed vault scopes as vault:*:<verb> with a wildcard explanation", async () => {
    vi.mocked(api.getOauthClient).mockResolvedValue(
      pendingClient({ scopes: ["vault:read", "vault:write"] }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByText("vault:*:read")).toBeInTheDocument());
    expect(screen.getByText("vault:*:write")).toBeInTheDocument();
    // Wildcard explanation present.
    expect(screen.getByText(/a specific vault is selected during sign-in/i)).toBeInTheDocument();
    // The raw unnamed form should NOT appear as a scope code element.
    expect(screen.queryByText(/^vault:read$/)).toBeNull();
    expect(screen.queryByText(/^vault:write$/)).toBeNull();
  });

  it("leaves named vault scopes (vault:<name>:<verb>) untouched", async () => {
    vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient({ scopes: ["vault:work:read"] }));
    renderRoute();
    await waitFor(() => expect(screen.getByText("vault:work:read")).toBeInTheDocument());
    // Already-named scopes don't carry the wildcard, so the explanation
    // hint doesn't render.
    expect(screen.queryByText(/a specific vault is selected during sign-in/i)).toBeNull();
  });

  // Workstream D — the SPA approve page can resume a parked OAuth flow
  // when given a `return_to` query parameter. The unauth share-link case
  // (no return_to) still renders the dead-end success state. See
  // AUDIT-UI-UX.md §5 row D and
  // parachute-patterns/patterns/oauth-dcr-approval.md "SPA approve page
  // (two cases, one route)".
  describe("workstream D — OAuth resume via return_to", () => {
    // `window.location.assign` doesn't work in jsdom by default; spy on
    // it so we can assert the redirect was triggered without actually
    // navigating the test runner away.
    let originalLocation: Location;
    let assignSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      originalLocation = window.location;
      assignSpy = vi.fn();
      // Override `window.location` with a minimal shim that captures
      // `.assign(url)` calls. Restoring `originalLocation` after each
      // test keeps suite isolation.
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...originalLocation, assign: assignSpy },
      });
    });
    afterEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    });

    const authorizeUrl =
      "/oauth/authorize?client_id=c1&response_type=code&scope=vault%3Awork%3Aread";

    it("approves with return_to and navigates to redirect_to on success", async () => {
      vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient());
      vi.mocked(api.approveOauthClient).mockResolvedValue({
        client_id: "c1",
        status: "approved",
        already_approved: false,
        redirect_to: authorizeUrl,
      });
      renderRoute("c1", `?return_to=${encodeURIComponent(authorizeUrl)}`);
      fireEvent.click(await screen.findByRole("button", { name: /approve notes/i }));
      await waitFor(() => expect(assignSpy).toHaveBeenCalledWith(authorizeUrl));
      // Approve API was called WITH the return_to argument — the SPA passes
      // it through to the server's gate.
      expect(api.approveOauthClient).toHaveBeenCalledWith("c1", authorizeUrl);
    });

    it("renders the dead-end success state when no return_to is in the URL", async () => {
      vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient());
      vi.mocked(api.approveOauthClient).mockResolvedValue({
        client_id: "c1",
        status: "approved",
        already_approved: false,
      });
      renderRoute(); // no search
      fireEvent.click(await screen.findByRole("button", { name: /approve notes/i }));
      await waitFor(() => expect(screen.getByText(/^approved\.$/i)).toBeInTheDocument());
      // SPA called approve with `undefined` for return_to — the share-link
      // case must not smuggle in a bogus value.
      expect(api.approveOauthClient).toHaveBeenCalledWith("c1", undefined);
      expect(assignSpy).not.toHaveBeenCalled();
    });

    it("rejects an off-origin return_to and falls back to the dead-end state", async () => {
      vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient());
      vi.mocked(api.approveOauthClient).mockResolvedValue({
        client_id: "c1",
        status: "approved",
        already_approved: false,
      });
      // Scheme-relative URL — points off-origin if the browser follows it.
      // The SPA's same-origin gate must drop it before the API call.
      renderRoute("c1", "?return_to=%2F%2Fevil.example%2Foauth%2Fauthorize");
      fireEvent.click(await screen.findByRole("button", { name: /approve notes/i }));
      await waitFor(() => expect(screen.getByText(/^approved\.$/i)).toBeInTheDocument());
      // Critical: api call sees `undefined`, NOT the off-origin value.
      expect(api.approveOauthClient).toHaveBeenCalledWith("c1", undefined);
      expect(assignSpy).not.toHaveBeenCalled();
    });

    it("rejects an absolute URL return_to", async () => {
      vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient());
      vi.mocked(api.approveOauthClient).mockResolvedValue({
        client_id: "c1",
        status: "approved",
        already_approved: false,
      });
      renderRoute(
        "c1",
        `?return_to=${encodeURIComponent("https://evil.example/oauth/authorize")}`,
      );
      fireEvent.click(await screen.findByRole("button", { name: /approve notes/i }));
      await waitFor(() => expect(screen.getByText(/^approved\.$/i)).toBeInTheDocument());
      expect(api.approveOauthClient).toHaveBeenCalledWith("c1", undefined);
      expect(assignSpy).not.toHaveBeenCalled();
    });

    it("re-validates redirect_to client-side as belt-and-suspenders", async () => {
      // Defense-in-depth: even if the server (bug, or some future change)
      // echoed back an off-origin value as `redirect_to`, the SPA's own
      // gate must refuse to navigate there. This test pins that contract.
      vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient());
      vi.mocked(api.approveOauthClient).mockResolvedValue({
        client_id: "c1",
        status: "approved",
        already_approved: false,
        redirect_to: "//evil.example/oauth/authorize",
      });
      renderRoute("c1", `?return_to=${encodeURIComponent(authorizeUrl)}`);
      fireEvent.click(await screen.findByRole("button", { name: /approve notes/i }));
      await waitFor(() => expect(screen.getByText(/^approved\.$/i)).toBeInTheDocument());
      expect(assignSpy).not.toHaveBeenCalled();
    });

    it("auto-redirects on load when the client is already approved AND return_to is set", async () => {
      // Race-tolerant resume: someone (parallel session, automation) approved
      // the client between the original /oauth/authorize → /admin/approve-
      // client navigation and the operator clicking the link. With
      // return_to set we should resume immediately rather than make the
      // operator click an Approve button against an already-approved row.
      vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient({ status: "approved" }));
      renderRoute("c1", `?return_to=${encodeURIComponent(authorizeUrl)}`);
      await waitFor(() => expect(assignSpy).toHaveBeenCalledWith(authorizeUrl));
      // No Approve button rendered — we left the SPA before the success
      // state could render.
      expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    });

    it("shows the dead-end already-approved state when no return_to is set", async () => {
      // Pre-existing behaviour — pin it against the new code path so the
      // share-link case still works.
      vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient({ status: "approved" }));
      renderRoute(); // no return_to
      await waitFor(() => expect(screen.getByText(/already approved/i)).toBeInTheDocument());
      expect(assignSpy).not.toHaveBeenCalled();
    });

    it("auto-redirects to non-authorize same-origin return_to (broader SPA gate is by design)", async () => {
      // Pin the deliberately-broader SPA gate behaviour: the SPA's
      // isSafeReturnTo accepts any same-origin path (starts with /, not //),
      // not just /oauth/authorize?-prefixed targets. The server-side gate is
      // stricter and only echoes redirect_to for /oauth/authorize? targets —
      // but the SPA's on-load auto-redirect path doesn't round-trip through
      // the server, so a future caller could wire ?return_to=/some/other/page.
      // Today no caller does this; the test exists to document the contract
      // (per patterns#97 "two cases, one route" + the deliberately-broader
      // SPA gate notes).
      vi.mocked(api.getOauthClient).mockResolvedValue(pendingClient({ status: "approved" }));
      renderRoute("c1", "?return_to=/admin/vaults");
      await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("/admin/vaults"));
    });
  });
});
