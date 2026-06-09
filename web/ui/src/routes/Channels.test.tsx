/**
 * Channels route tests — loading, list rendering, empty state, the add-form
 * happy path (POST /admin/channels → connect lines rendered), the add-form
 * error path, and the remove confirm-then-DELETE flow.
 *
 * Same shape as Users.test.tsx: mock `lib/api.ts` so the route's fetch helpers
 * are stubbed and we assert on the rendered DOM + the calls the route makes.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Channels } from "./Channels.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listChannels: vi.fn(),
    listVaults: vi.fn(),
    provisionChannel: vi.fn(),
    deleteChannel: vi.fn(),
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
      <Channels />
    </MemoryRouter>,
  );
}

function channel(name: string, vault = "default"): api.ChannelListing {
  return { name, transport: "vault", vault };
}

function vaultsResult(...names: string[]): api.VaultsListResult {
  return {
    moduleInstalled: names.length > 0,
    vaults: names.map((name) => ({
      name,
      url: `https://hub.example.com/vault/${name}`,
      version: "0.5.0",
      path: `/vault/${name}`,
    })),
  };
}

describe("Channels — list rendering", () => {
  it("shows a loading state on first paint", () => {
    vi.mocked(api.listChannels).mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.listVaults).mockImplementation(() => new Promise(() => {}));
    renderRoute();
    expect(screen.getByText(/loading channels/i)).toBeInTheDocument();
  });

  it("renders the empty state when no channels exist", async () => {
    vi.mocked(api.listChannels).mockResolvedValue([]);
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    renderRoute();
    await waitFor(() => expect(screen.getByText(/no channels yet/i)).toBeInTheDocument());
    expect(
      screen.getByText(/add one below to chat with a claude code session/i),
    ).toBeInTheDocument();
  });

  it("renders one row per channel with name + vault", async () => {
    vi.mocked(api.listChannels).mockResolvedValue([
      channel("eng", "default"),
      channel("ops", "work"),
    ]);
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default", "work"));
    renderRoute();
    await waitFor(() => expect(screen.getByText("eng")).toBeInTheDocument());
    expect(screen.getByText("ops")).toBeInTheDocument();
    // Each channel's bound vault renders in its row.
    const engRow = screen.getByText("eng").closest("tr")!;
    expect(within(engRow).getByText("default")).toBeInTheDocument();
    const opsRow = screen.getByText("ops").closest("tr")!;
    expect(within(opsRow).getByText("work")).toBeInTheDocument();
  });

  it("renders the error banner + retry on listChannels failure", async () => {
    vi.mocked(api.listChannels).mockRejectedValue(new Error("network down"));
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    renderRoute();
    await waitFor(() => expect(screen.getByText(/couldn't load channels/i)).toBeInTheDocument());
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("Channels — add a channel", () => {
  it("submits to provisionChannel and renders the connect lines on success", async () => {
    vi.mocked(api.listChannels).mockResolvedValue([]);
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    vi.mocked(api.provisionChannel).mockResolvedValue({
      channel: "eng",
      vault: "default",
      connect: {
        mcpAdd:
          "claude mcp add --transport http --scope user channel-eng https://hub.example.com/channel/mcp/eng",
        launch:
          "claude --dangerously-load-development-channels=server:channel-eng --dangerously-skip-permissions",
      },
    });
    renderRoute();

    await waitFor(() => expect(screen.getByLabelText(/channel name/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/channel name/i), { target: { value: "eng" } });
    fireEvent.click(screen.getByRole("button", { name: /add channel/i }));

    await waitFor(() => expect(screen.getByTestId("channel-connect-panel")).toBeInTheDocument());
    expect(vi.mocked(api.provisionChannel)).toHaveBeenCalledWith({
      channelName: "eng",
      vault: "default",
    });
    // The two connect lines are rendered in copy-able code boxes.
    expect(screen.getByTestId("channel-mcp-add")).toHaveTextContent(
      "claude mcp add --transport http --scope user channel-eng",
    );
    expect(screen.getByTestId("channel-launch")).toHaveTextContent(
      "--dangerously-load-development-channels=server:channel-eng",
    );
    // The launch line carries `--dangerously-skip-permissions`, so a caution
    // note must render alongside it warning the operator about unrestricted
    // tool access.
    const warning = screen.getByTestId("channel-launch-warning");
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveTextContent(/unrestricted tool access/i);
    expect(warning).toHaveTextContent(/--dangerously-skip-permissions/);
    expect(warning).toHaveTextContent(/trust/i);
  });

  it("shows the server error message when provisioning fails", async () => {
    vi.mocked(api.listChannels).mockResolvedValue([]);
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    vi.mocked(api.provisionChannel).mockRejectedValue(
      new api.HttpError(400, 'no vault named "default" in this hub'),
    );
    renderRoute();

    await waitFor(() => expect(screen.getByLabelText(/channel name/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/channel name/i), { target: { value: "eng" } });
    fireEvent.click(screen.getByRole("button", { name: /add channel/i }));

    await waitFor(() =>
      expect(screen.getByText(/no vault named "default" in this hub/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("channel-connect-panel")).not.toBeInTheDocument();
  });

  it("client-validates the channel name before calling the server", async () => {
    vi.mocked(api.listChannels).mockResolvedValue([]);
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    renderRoute();

    const input = (await screen.findByLabelText(/channel name/i)) as HTMLInputElement;
    // A trailing-space name passes once trimmed but the leading char of the
    // raw value is fine — set a value the JS validator rejects (a leading
    // hyphen fails `^[a-z0-9]`), then submit the form directly so we exercise
    // the JS guard rather than the native HTML `pattern` gate.
    fireEvent.change(input, { target: { value: "-eng" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() =>
      expect(
        screen.getByText(/channel name must start with a letter or digit/i),
      ).toBeInTheDocument(),
    );
    expect(vi.mocked(api.provisionChannel)).not.toHaveBeenCalled();
  });

  it("tells the operator to create a vault first when none exist", async () => {
    vi.mocked(api.listChannels).mockResolvedValue([]);
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult());
    renderRoute();
    await waitFor(() => expect(screen.getByText(/create a vault first/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /add channel/i })).not.toBeInTheDocument();
  });
});

describe("Channels — remove a channel", () => {
  it("confirms then calls deleteChannel and reloads the list", async () => {
    vi.mocked(api.listChannels)
      .mockResolvedValueOnce([channel("eng", "default")])
      .mockResolvedValueOnce([]);
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    vi.mocked(api.deleteChannel).mockResolvedValue(undefined);
    renderRoute();

    await waitFor(() => expect(screen.getByText("eng")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /remove eng/i }));

    // Confirm dialog appears.
    const dialog = await screen.findByRole("dialog", { name: /confirm remove eng/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));

    await waitFor(() => expect(vi.mocked(api.deleteChannel)).toHaveBeenCalledWith("eng"));
    // After the reload (second listChannels returns []), the empty state shows.
    await waitFor(() => expect(screen.getByText(/no channels yet/i)).toBeInTheDocument());
  });

  it("surfaces a row-level error when teardown fails", async () => {
    vi.mocked(api.listChannels).mockResolvedValue([channel("eng", "default")]);
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    vi.mocked(api.deleteChannel).mockRejectedValue(
      new api.HttpError(207, "vault_trigger: downstream 500"),
    );
    renderRoute();

    await waitFor(() => expect(screen.getByText("eng")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /remove eng/i }));
    const dialog = await screen.findByRole("dialog", { name: /confirm remove eng/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));

    await waitFor(() =>
      expect(screen.getByText(/vault_trigger: downstream 500/i)).toBeInTheDocument(),
    );
  });
});
