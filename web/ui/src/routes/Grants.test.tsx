/**
 * Grants route tests (agent-connector grants, 4b-1 + 4b-2) — loading, empty
 * state, grouping by agent, and the status shapes: pending vault → one-click
 * approve, pending service → token paste then approve, approved → revoke, and
 * the 4b-2 mcp paths (Connect → OAuth redirect, paste-a-token static bearer,
 * approved → revoke, needs_consent → reconnect). The list NEVER carries secret
 * material — the view only renders the wire shape from `listAgentGrants`.
 *
 * Mock `lib/api.ts` so the route's fetch helpers are stubbed; assert on the
 * rendered DOM + the calls made (notably: approveAgentGrant for a service/mcp
 * token grant carries the pasted token; for a vault grant or an mcp Connect it
 * carries no token, and Connect full-page redirects to the returned authorizeUrl).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Grants } from "./Grants.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listAgentGrants: vi.fn(),
    approveAgentGrant: vi.fn(),
    revokeAgentGrant: vi.fn(),
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
      <Grants />
    </MemoryRouter>,
  );
}

const sampleGrants: api.GrantListing[] = [
  {
    id: "agent1-vault-research-read",
    agent: "agent1",
    connection: { kind: "vault", target: "research", access: "read", tags: ["#published"] },
    status: "pending",
  },
  {
    id: "agent1-service-github",
    agent: "agent1",
    connection: { kind: "service", target: "github", inject: ["env", "mcp"] },
    status: "pending",
  },
  {
    id: "agent1-vault-notes-write",
    agent: "agent1",
    connection: { kind: "vault", target: "notes", access: "write" },
    status: "approved",
    approvedAt: "2026-06-17T00:00:00.000Z",
  },
  {
    id: "agent1-vault-archive-read",
    agent: "agent1",
    connection: { kind: "vault", target: "archive", access: "read" },
    status: "revoked",
  },
  {
    id: "agent2-mcp-remote",
    agent: "agent2",
    connection: { kind: "mcp", target: "https://remote.test/mcp" },
    status: "pending",
  },
  {
    id: "agent2-mcp-approved",
    agent: "agent2",
    connection: { kind: "mcp", target: "https://granted.test/mcp" },
    status: "approved",
    approvedAt: "2026-06-18T00:00:00.000Z",
  },
  {
    id: "agent2-mcp-stale",
    agent: "agent2",
    connection: { kind: "mcp", target: "https://stale.test/mcp" },
    status: "needs_consent",
    reason: "oauth refresh expired",
  },
];

/** Minimal approved-listing echo for stubbing `approveAgentGrant` (no authorizeUrl). */
function approvedEcho(id: string): api.GrantListing {
  const src = sampleGrants.find((g) => g.id === id);
  if (!src) throw new Error(`approvedEcho: no fixture grant with id ${id}`);
  return { ...src, id, status: "approved" };
}

describe("Grants — loading + states", () => {
  it("shows a loading state, then the grants grouped by agent", async () => {
    vi.mocked(api.listAgentGrants).mockResolvedValue(sampleGrants);
    renderRoute();
    expect(screen.getByText(/loading grants/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("agent1")).toBeInTheDocument());
    expect(screen.getByText("agent2")).toBeInTheDocument();
    // both agent group sections present
    expect(screen.getByLabelText("Grants for agent1")).toBeInTheDocument();
    expect(screen.getByLabelText("Grants for agent2")).toBeInTheDocument();
  });

  it("shows the empty state when there are no grants", async () => {
    vi.mocked(api.listAgentGrants).mockResolvedValue([]);
    renderRoute();
    await waitFor(() => expect(screen.getByText(/no grant requests yet/i)).toBeInTheDocument());
  });

  it("shows an error banner + retry on load failure", async () => {
    vi.mocked(api.listAgentGrants).mockRejectedValueOnce(new Error("boom"));
    renderRoute();
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("Grants — approve / revoke", () => {
  it("a pending vault grant approves in one click (no token)", async () => {
    vi.mocked(api.listAgentGrants).mockResolvedValue(sampleGrants);
    vi.mocked(api.approveAgentGrant).mockResolvedValue(approvedEcho("agent1-vault-research-read"));
    renderRoute();
    await waitFor(() => expect(screen.getByText("agent1")).toBeInTheDocument());

    const row = screen.getByText(/vault: research/i).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /^approve$/i }));

    await waitFor(() =>
      expect(api.approveAgentGrant).toHaveBeenCalledWith("agent1-vault-research-read"),
    );
    // vault approve carries NO token argument
    expect(vi.mocked(api.approveAgentGrant).mock.calls[0]).toEqual(["agent1-vault-research-read"]);
  });

  it("a pending service grant reveals a token field, then approves WITH the token", async () => {
    vi.mocked(api.listAgentGrants).mockResolvedValue(sampleGrants);
    vi.mocked(api.approveAgentGrant).mockResolvedValue(approvedEcho("agent1-service-github"));
    renderRoute();
    await waitFor(() => expect(screen.getByText("agent1")).toBeInTheDocument());

    const row = screen.getByText(/service: github/i).closest("tr") as HTMLElement;
    // first click reveals the paste field
    fireEvent.click(within(row).getByRole("button", { name: /approve…/i }));
    const input = within(row).getByLabelText(/api token for github/i);
    fireEvent.change(input, { target: { value: "ghp_secret" } });
    fireEvent.click(within(row).getByRole("button", { name: /save & approve/i }));

    await waitFor(() =>
      expect(api.approveAgentGrant).toHaveBeenCalledWith("agent1-service-github", "ghp_secret"),
    );
  });

  it("an approved grant offers Revoke", async () => {
    vi.mocked(api.listAgentGrants).mockResolvedValue(sampleGrants);
    vi.mocked(api.revokeAgentGrant).mockResolvedValue();
    renderRoute();
    await waitFor(() => expect(screen.getByText("agent1")).toBeInTheDocument());

    const row = screen.getByText(/vault: notes/i).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /revoke/i }));
    await waitFor(() =>
      expect(api.revokeAgentGrant).toHaveBeenCalledWith("agent1-vault-notes-write"),
    );
  });

  it("a revoked vault grant offers Re-approve (re-mints fresh material)", async () => {
    vi.mocked(api.listAgentGrants).mockResolvedValue(sampleGrants);
    vi.mocked(api.approveAgentGrant).mockResolvedValue(approvedEcho("agent1-vault-archive-read"));
    renderRoute();
    await waitFor(() => expect(screen.getByText("agent1")).toBeInTheDocument());

    const row = screen.getByText(/vault: archive/i).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /re-approve/i }));
    await waitFor(() =>
      expect(api.approveAgentGrant).toHaveBeenCalledWith("agent1-vault-archive-read"),
    );
  });
});

describe("Grants — mcp (remote/OAuth) is grantable (4b-2)", () => {
  // jsdom doesn't implement navigation; spy on window.location.assign so the
  // Connect-redirect path is observable and doesn't throw "Not implemented".
  let assignSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
  });

  it("a pending mcp grant shows Connect (no stale 4b-1 placeholder)", async () => {
    vi.mocked(api.listAgentGrants).mockResolvedValue(sampleGrants);
    renderRoute();
    await waitFor(() => expect(screen.getByText("agent2")).toBeInTheDocument());

    const row = screen.getByText(/mcp: https:\/\/remote\.test\/mcp/i).closest("tr") as HTMLElement;
    expect(within(row).getByRole("button", { name: /^connect$/i })).toBeInTheDocument();
    expect(within(row).queryByText(/oauth coming in 4b-2/i)).toBeNull();
  });

  it("clicking Connect approves with NO token and redirects to authorizeUrl", async () => {
    const authorizeUrl = "https://issuer.test/oauth/authorize?client_id=hub&state=xyz";
    vi.mocked(api.listAgentGrants).mockResolvedValue(sampleGrants);
    vi.mocked(api.approveAgentGrant).mockResolvedValue({
      ...(sampleGrants.find((g) => g.id === "agent2-mcp-remote") as api.GrantListing),
      authorizeUrl,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("agent2")).toBeInTheDocument());

    const row = screen.getByText(/mcp: https:\/\/remote\.test\/mcp/i).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(api.approveAgentGrant).toHaveBeenCalledWith("agent2-mcp-remote"));
    // started OAuth with no token argument
    expect(vi.mocked(api.approveAgentGrant).mock.calls[0]).toEqual(["agent2-mcp-remote"]);
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith(authorizeUrl));
  });

  it("'Paste a token instead' reveals an input, then approves WITH the token", async () => {
    vi.mocked(api.listAgentGrants).mockResolvedValue(sampleGrants);
    vi.mocked(api.approveAgentGrant).mockResolvedValue(approvedEcho("agent2-mcp-remote"));
    renderRoute();
    await waitFor(() => expect(screen.getByText("agent2")).toBeInTheDocument());

    const row = screen.getByText(/mcp: https:\/\/remote\.test\/mcp/i).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /paste a token instead/i }));
    const input = within(row).getByLabelText(/api token for https:\/\/remote\.test\/mcp/i);
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "static_bearer" } });
    fireEvent.click(within(row).getByRole("button", { name: /save & approve/i }));

    await waitFor(() =>
      expect(api.approveAgentGrant).toHaveBeenCalledWith("agent2-mcp-remote", "static_bearer"),
    );
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("an approved mcp grant offers Revoke", async () => {
    vi.mocked(api.listAgentGrants).mockResolvedValue(sampleGrants);
    vi.mocked(api.revokeAgentGrant).mockResolvedValue();
    renderRoute();
    await waitFor(() => expect(screen.getByText("agent2")).toBeInTheDocument());

    const row = screen.getByText(/mcp: https:\/\/granted\.test\/mcp/i).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /revoke/i }));
    await waitFor(() => expect(api.revokeAgentGrant).toHaveBeenCalledWith("agent2-mcp-approved"));
  });

  it("a needs_consent mcp grant offers Reconnect (re-consent path)", async () => {
    const authorizeUrl = "https://issuer.test/oauth/authorize?reconsent=1";
    vi.mocked(api.listAgentGrants).mockResolvedValue(sampleGrants);
    vi.mocked(api.approveAgentGrant).mockResolvedValue({
      ...(sampleGrants.find((g) => g.id === "agent2-mcp-stale") as api.GrantListing),
      authorizeUrl,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("agent2")).toBeInTheDocument());

    const row = screen.getByText(/mcp: https:\/\/stale\.test\/mcp/i).closest("tr") as HTMLElement;
    const reconnect = within(row).getByRole("button", { name: /reconnect/i });
    expect(reconnect).toBeInTheDocument();
    fireEvent.click(reconnect);
    await waitFor(() => expect(api.approveAgentGrant).toHaveBeenCalledWith("agent2-mcp-stale"));
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith(authorizeUrl));
  });

  it("Connect with no authorizeUrl returned → reloads (defensive), no redirect", async () => {
    // Defensive branch: an mcp approve that comes back WITHOUT authorizeUrl must
    // not navigate — it falls back to a list reload (listAgentGrants re-called).
    vi.mocked(api.listAgentGrants).mockResolvedValue(sampleGrants);
    vi.mocked(api.approveAgentGrant).mockResolvedValue(approvedEcho("agent2-mcp-remote"));
    renderRoute();
    await waitFor(() => expect(screen.getByText("agent2")).toBeInTheDocument());
    const callsBefore = vi.mocked(api.listAgentGrants).mock.calls.length;

    const row = screen.getByText(/mcp: https:\/\/remote\.test\/mcp/i).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(api.approveAgentGrant).toHaveBeenCalledWith("agent2-mcp-remote"));
    // No redirect, and the list was re-fetched (reload bump).
    expect(assignSpy).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(vi.mocked(api.listAgentGrants).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });
});
