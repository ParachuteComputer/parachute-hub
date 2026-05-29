/**
 * McpConnectCard tests — the per-vault "MCP connection" surface.
 *
 * Covers:
 *   - the pure command/endpoint builders (the load-bearing strings the
 *     operator pastes into a terminal);
 *   - the rendered card showing the correct `/vault/<name>/mcp` endpoint +
 *     the `claude mcp add` OAuth command for a given vault name + hub origin;
 *   - the Copy affordance writing the real command to the clipboard;
 *   - the optional header-auth mint path going through the hub-JWT chain
 *     (`mintToken` with a `vault:<name>:read vault:<name>:write` scope) and
 *     rendering the `--header "Authorization: Bearer <jwt>"` variant once.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import {
  McpConnectCard,
  claudeMcpAddCommand,
  claudeMcpAddCommandWithToken,
  mcpEndpointFor,
} from "./McpConnectCard.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    mintToken: vi.fn(),
  };
});

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  vi.clearAllMocks();
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("command builders", () => {
  it("derives the MCP endpoint from the vault URL, stripping a trailing slash", () => {
    expect(mcpEndpointFor("https://hub.example.ts.net/vault/work")).toBe(
      "https://hub.example.ts.net/vault/work/mcp",
    );
    expect(mcpEndpointFor("https://hub.example.ts.net/vault/work/")).toBe(
      "https://hub.example.ts.net/vault/work/mcp",
    );
  });

  it("builds the OAuth `claude mcp add` command with no token", () => {
    expect(claudeMcpAddCommand("work", "https://hub.example.ts.net/vault/work")).toBe(
      "claude mcp add --transport http parachute-work https://hub.example.ts.net/vault/work/mcp",
    );
  });

  it("builds the header-auth variant with the Bearer token appended", () => {
    expect(
      claudeMcpAddCommandWithToken("work", "https://hub.example.ts.net/vault/work", "jwt-abc"),
    ).toBe(
      'claude mcp add --transport http parachute-work https://hub.example.ts.net/vault/work/mcp --header "Authorization: Bearer jwt-abc"',
    );
  });
});

describe("McpConnectCard", () => {
  const VAULT_URL = "https://hub.example.ts.net/vault/work";

  it("renders the correct /vault/<name>/mcp endpoint for the given vault + hub origin", () => {
    render(<McpConnectCard vaultName="work" vaultUrl={VAULT_URL} />);
    expect(screen.getByTestId("mcp-endpoint")).toHaveTextContent(
      "https://hub.example.ts.net/vault/work/mcp",
    );
  });

  it("renders the `claude mcp add` OAuth command (no token in the command)", () => {
    render(<McpConnectCard vaultName="work" vaultUrl={VAULT_URL} />);
    const cmd = screen.getByTestId("mcp-add-command");
    expect(cmd).toHaveTextContent(
      "claude mcp add --transport http parachute-work https://hub.example.ts.net/vault/work/mcp",
    );
    // The default command carries NO bearer header — OAuth is the path.
    expect(cmd.textContent).not.toContain("Authorization");
  });

  it("copies the real command to the clipboard via the Copy button", async () => {
    render(<McpConnectCard vaultName="work" vaultUrl={VAULT_URL} />);
    // The command's own Copy button (second copy button — endpoint is first).
    const copyButtons = screen.getAllByRole("button", { name: /^copy$/i });
    fireEvent.click(copyButtons[1]);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "claude mcp add --transport http parachute-work https://hub.example.ts.net/vault/work/mcp",
      ),
    );
  });

  it("mints a read+write hub JWT via the tokens chain and shows the header-auth command once", async () => {
    vi.mocked(api.mintToken).mockResolvedValue({
      jti: "jti-1",
      token: "jwt-headerauth",
      expires_at: "2026-09-01T00:00:00.000Z",
      scope: "vault:work:read vault:work:write",
    });
    render(<McpConnectCard vaultName="work" vaultUrl={VAULT_URL} />);

    // Open the optional token path + mint.
    fireEvent.click(screen.getByText(/use a token instead/i));
    fireEvent.click(screen.getByRole("button", { name: /mint a token/i }));

    // Mint goes through the hub-JWT chain with a vault:read+write scope —
    // NOT admin.
    await waitFor(() =>
      expect(api.mintToken).toHaveBeenCalledWith({
        scope: "vault:work:read vault:work:write",
      }),
    );

    // The header-auth command renders once with the minted JWT in the header.
    const headerCmd = await screen.findByTestId("mcp-header-command");
    expect(headerCmd).toHaveTextContent(
      'claude mcp add --transport http parachute-work https://hub.example.ts.net/vault/work/mcp --header "Authorization: Bearer jwt-headerauth"',
    );
  });

  it("surfaces a mint error inline without showing the header command", async () => {
    vi.mocked(api.mintToken).mockRejectedValue(new api.HttpError(403, "scope not permitted"));
    render(<McpConnectCard vaultName="work" vaultUrl={VAULT_URL} />);

    fireEvent.click(screen.getByText(/use a token instead/i));
    fireEvent.click(screen.getByRole("button", { name: /mint a token/i }));

    await waitFor(() =>
      expect(screen.getByText(/mint failed \(403\): scope not permitted/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("mcp-header-command")).toBeNull();
  });

  it("links to the full connect docs", () => {
    render(<McpConnectCard vaultName="work" vaultUrl={VAULT_URL} />);
    expect(screen.getByRole("link", { name: /full connect docs/i })).toHaveAttribute(
      "href",
      "https://parachute.computer/install#connect-mcp-clients",
    );
  });
});
