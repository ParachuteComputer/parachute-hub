/**
 * Connections route tests (modular-UI P5) — loading, list, empty state, the
 * builder driven from the catalog, create posting the right body, the channel
 * preset pre-filling + showing connect lines, and remove confirm-then-DELETE.
 *
 * Same shape as Channels.test.tsx: mock `lib/api.ts` so the route's fetch
 * helpers are stubbed and assert on the rendered DOM + the calls made.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Connections } from "./Connections.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listConnections: vi.fn(),
    getConnectionsCatalog: vi.fn(),
    listVaults: vi.fn(),
    createConnection: vi.fn(),
    deleteConnection: vi.fn(),
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
      <Connections />
    </MemoryRouter>,
  );
}

function catalog(): api.ConnectionsCatalog {
  return {
    events: [
      { module: "vault", key: "note.created", title: "A note was created", filterSchema: null },
      { module: "vault", key: "note.updated", title: "A note was updated", filterSchema: null },
    ],
    actions: [
      {
        module: "channel",
        key: "message.deliver",
        title: "Deliver an inbound message",
        inputSchema: null,
        provision: { type: "vault-trigger" },
      },
    ],
  };
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

function connection(id: string): api.ConnectionListing {
  return {
    id,
    source: { module: "vault", vault: "default", event: "note.created" },
    sink: { module: "channel", action: "message.deliver", params: { channel: "eng" } },
    provisioned: { type: "vault-trigger", vault: "default", triggerName: `conn_${id}` },
    created_at: "2026-06-09T00:00:00.000Z",
  };
}

describe("Connections — list rendering", () => {
  it("shows a loading state on first paint", () => {
    vi.mocked(api.listConnections).mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.getConnectionsCatalog).mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.listVaults).mockImplementation(() => new Promise(() => {}));
    renderRoute();
    expect(screen.getByText(/loading connections/i)).toBeInTheDocument();
  });

  it("renders the empty state when no connections exist", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([]);
    vi.mocked(api.getConnectionsCatalog).mockResolvedValue(catalog());
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    renderRoute();
    await waitFor(() => expect(screen.getByText(/no connections yet/i)).toBeInTheDocument());
  });

  it("lists provisioned connections", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([connection("channel-eng")]);
    vi.mocked(api.getConnectionsCatalog).mockResolvedValue(catalog());
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    renderRoute();
    await waitFor(() => expect(screen.getByText("channel-eng")).toBeInTheDocument());
    expect(screen.getByText(/vault\.note\.created/)).toBeInTheDocument();
    expect(screen.getByText(/channel\.message\.deliver/)).toBeInTheDocument();
  });

  it("groups connections by provenance — module-initiated vs custom (R2)", async () => {
    const fromChannel: api.ConnectionListing = {
      ...connection("channel-eng"),
      requested_by: "channel",
    };
    const custom: api.ConnectionListing = { ...connection("custom-one"), requested_by: "custom" };
    vi.mocked(api.listConnections).mockResolvedValue([custom, fromChannel]);
    vi.mocked(api.getConnectionsCatalog).mockResolvedValue(catalog());
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    renderRoute();
    await waitFor(() => expect(screen.getByText("channel-eng")).toBeInTheDocument());

    // Two labeled groups appear: "Added from channel" and "Custom (built here)".
    expect(screen.getByText(/added from channel/i)).toBeInTheDocument();
    expect(screen.getByText(/custom \(built here\)/i)).toBeInTheDocument();

    // The channel-initiated connection carries a provenance badge; the
    // hand-built one does not (it shows the muted "custom" marker instead).
    const channelRow = document.querySelector('[data-connection-id="channel-eng"]');
    expect(channelRow?.getAttribute("data-requested-by")).toBe("channel");
    expect(within(channelRow as HTMLElement).getByTestId("provenance-badge").textContent).toBe(
      "channel",
    );
    const customRow = document.querySelector('[data-connection-id="custom-one"]');
    expect(customRow?.getAttribute("data-requested-by")).toBe("custom");
    expect(within(customRow as HTMLElement).queryByTestId("provenance-badge")).toBeNull();

    // The module-initiated group sorts before custom (custom sorts last).
    const groups = Array.from(document.querySelectorAll("[data-provenance-group]")).map((g) =>
      g.getAttribute("data-provenance-group"),
    );
    expect(groups).toEqual(["channel", "custom"]);
  });

  it("treats a connection with no requested_by as custom (pre-R2 back-compat)", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([connection("legacy")]);
    vi.mocked(api.getConnectionsCatalog).mockResolvedValue(catalog());
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    renderRoute();
    await waitFor(() => expect(screen.getByText("legacy")).toBeInTheDocument());
    expect(screen.getByText(/custom \(built here\)/i)).toBeInTheDocument();
    const row = document.querySelector('[data-connection-id="legacy"]');
    expect(row?.getAttribute("data-requested-by")).toBe("custom");
  });
});

describe("Connections — builder", () => {
  it("populates source/sink dropdowns from the catalog", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([]);
    vi.mocked(api.getConnectionsCatalog).mockResolvedValue(catalog());
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("channel-preset")).toBeInTheDocument());
    // Source module select offers vault.
    const srcModule = screen.getByLabelText("Module", { selector: "#conn-source-module" });
    expect(within(srcModule).getByRole("option", { name: "vault" })).toBeInTheDocument();
    // Sink module select offers channel.
    const sinkModule = screen.getByLabelText("Module", { selector: "#conn-sink-module" });
    expect(within(sinkModule).getByRole("option", { name: "channel" })).toBeInTheDocument();
  });

  it("the channel preset pre-fills the builder", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([]);
    vi.mocked(api.getConnectionsCatalog).mockResolvedValue(catalog());
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("channel-preset")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("channel-preset"));
    // Source module + event get set.
    const srcModule = screen.getByLabelText("Module", {
      selector: "#conn-source-module",
    }) as HTMLSelectElement;
    expect(srcModule.value).toBe("vault");
    const srcEvent = screen.getByLabelText(/Event/i) as HTMLSelectElement;
    expect(srcEvent.value).toBe("note.created");
    // The filter text carries the inbound tag.
    const filter = screen.getByLabelText(/Filter/i) as HTMLTextAreaElement;
    expect(filter.value).toContain("#channel-message/inbound");
  });

  it("create posts the right body and renders connect lines for a channel sink", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([]);
    vi.mocked(api.getConnectionsCatalog).mockResolvedValue(catalog());
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    vi.mocked(api.createConnection).mockResolvedValue({
      connection: connection("channel-eng"),
      connect: {
        mcpAdd:
          "claude mcp add --transport http --scope user channel-eng https://hub/channel/mcp/eng",
        launch:
          "claude --dangerously-load-development-channels=server:channel-eng --dangerously-skip-permissions",
      },
    });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("channel-preset")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("channel-preset"));
    fireEvent.click(screen.getByRole("button", { name: /create connection/i }));

    await waitFor(() => expect(api.createConnection).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(api.createConnection).mock.calls[0]![0];
    expect(arg.source.module).toBe("vault");
    expect(arg.source.event).toBe("note.created");
    expect(arg.source.vault).toBe("default");
    expect(arg.source.filter).toMatchObject({ tags: ["#channel-message/inbound"] });
    expect(arg.sink).toMatchObject({
      module: "channel",
      action: "message.deliver",
      params: { channel: "eng" },
    });

    // Connect lines surface.
    await waitFor(() => expect(screen.getByTestId("connection-connect-panel")).toBeInTheDocument());
    expect(screen.getByTestId("connection-mcp-add").textContent).toContain("channel-eng");
  });

  it("surfaces a bad-JSON filter error before posting", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([]);
    vi.mocked(api.getConnectionsCatalog).mockResolvedValue(catalog());
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("channel-preset")).toBeInTheDocument());
    // Pick valid source/sink, then a broken filter.
    fireEvent.change(screen.getByLabelText("Module", { selector: "#conn-source-module" }), {
      target: { value: "vault" },
    });
    fireEvent.change(screen.getByLabelText("Event", { selector: "#conn-source-event" }), {
      target: { value: "note.created" },
    });
    fireEvent.change(screen.getByLabelText("Module", { selector: "#conn-sink-module" }), {
      target: { value: "channel" },
    });
    fireEvent.change(screen.getByLabelText("Action", { selector: "#conn-sink-action" }), {
      target: { value: "message.deliver" },
    });
    fireEvent.change(screen.getByLabelText(/Filter/i), { target: { value: "{ not json" } });
    fireEvent.click(screen.getByRole("button", { name: /create connection/i }));
    await waitFor(() => expect(screen.getByText(/not valid JSON/i)).toBeInTheDocument());
    expect(api.createConnection).not.toHaveBeenCalled();
  });
});

describe("Connections — remove", () => {
  it("confirm-then-DELETE removes a connection", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([connection("channel-eng")]);
    vi.mocked(api.getConnectionsCatalog).mockResolvedValue(catalog());
    vi.mocked(api.listVaults).mockResolvedValue(vaultsResult("default"));
    vi.mocked(api.deleteConnection).mockResolvedValue(undefined);
    renderRoute();
    await waitFor(() => expect(screen.getByText("channel-eng")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /remove channel-eng/i }));
    // Confirm dialog → Remove.
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    await waitFor(() => expect(api.deleteConnection).toHaveBeenCalledWith("channel-eng"));
  });
});
