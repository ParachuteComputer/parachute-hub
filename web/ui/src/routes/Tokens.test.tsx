/**
 * Tokens route smoke tests — list rendering, status pills, filter pills,
 * mint flow (form open → submit → mint-banner with copy → list refresh),
 * revoke confirm flow (cancel + confirm), revoke failure, "Load more"
 * cursor pagination, integration happy-path (mint → see in list →
 * revoke → see status update).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Tokens } from "./Tokens.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listTokens: vi.fn(),
    mintToken: vi.fn(),
    revokeToken: vi.fn(),
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
      <Tokens />
    </MemoryRouter>,
  );
}

const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

const tokenRow = (
  jti: string,
  overrides: Partial<api.AdminTokenListing> = {},
): api.AdminTokenListing => ({
  jti,
  user_id: "user-uuid",
  subject: null,
  client_id: "parachute-hub",
  scopes: ["scribe:transcribe"],
  expires_at: FUTURE,
  revoked_at: null,
  created_at: "2026-05-10T12:00:00.000Z",
  created_via: "cli_mint",
  permissions: null,
  ...overrides,
});

describe("Tokens — list rendering", () => {
  it("renders the empty state when no tokens exist", async () => {
    vi.mocked(api.listTokens).mockResolvedValue({ tokens: [], next_cursor: null });
    renderRoute();
    await waitFor(() => expect(screen.getByText(/no tokens\./i)).toBeInTheDocument());
  });

  it("renders one row per token with truncated jti, identity, scope, dates", async () => {
    // JTIs need to be > 14 chars to actually trigger truncation.
    vi.mocked(api.listTokens).mockResolvedValue({
      tokens: [
        tokenRow("aaaaaaaaXXXXXXXbbbb", { scopes: ["vault:work:read"] }),
        tokenRow("zzzzzzzzYYYYYYYwwww", {
          scopes: ["scribe:transcribe"],
          subject: "operator",
          user_id: null,
        }),
      ],
      next_cursor: null,
    });
    renderRoute();
    // Truncated jtis appear (8 chars + ellipsis + last 4).
    await waitFor(() => expect(screen.getByText(/aaaaaaaa…bbbb/)).toBeInTheDocument());
    expect(screen.getByText(/zzzzzzzz…wwww/)).toBeInTheDocument();
    // Identity rendering: user_id when present, subject as fallback.
    expect(screen.getByText("user-uuid")).toBeInTheDocument();
    expect(screen.getByText("operator")).toBeInTheDocument();
    // Scopes show as code tags.
    expect(screen.getByText("vault:work:read")).toBeInTheDocument();
    expect(screen.getByText("scribe:transcribe")).toBeInTheDocument();
  });

  it("renders status pills: live / expired / revoked", async () => {
    vi.mocked(api.listTokens).mockResolvedValue({
      tokens: [
        tokenRow("aliveeeeAAAAAAAXXXX", { expires_at: FUTURE, revoked_at: null }),
        tokenRow("expirexpirEEEEEEEEEXXXX", { expires_at: PAST, revoked_at: null }),
        tokenRow("revokedRRRRRRRRRRRXXXX", {
          expires_at: FUTURE,
          revoked_at: "2026-05-10T13:00:00.000Z",
        }),
      ],
      next_cursor: null,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText(/aliveeee…XXXX/)).toBeInTheDocument());
    // Status pill text appears for each.
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByText("expired")).toBeInTheDocument();
    expect(screen.getByText("revoked")).toBeInTheDocument();
  });

  it("revoke button only renders for live tokens (not expired or revoked)", async () => {
    vi.mocked(api.listTokens).mockResolvedValue({
      tokens: [
        tokenRow("aliveeeeAAAAAAAXXXX"),
        tokenRow("expirexpirEEEEEEEEEXXXX", { expires_at: PAST }),
        tokenRow("revokedRRRRRRRRRRRXXXX", { revoked_at: "2026-05-10T13:00:00.000Z" }),
      ],
      next_cursor: null,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText(/aliveeee…XXXX/)).toBeInTheDocument());
    // Three rows; only one Revoke button (for the live token).
    const revokeButtons = screen.getAllByRole("button", { name: /^revoke /i });
    expect(revokeButtons).toHaveLength(1);
  });

  it("renders the error banner + retry on listTokens failure", async () => {
    vi.mocked(api.listTokens).mockRejectedValue(new Error("network down"));
    renderRoute();
    await waitFor(() => expect(screen.getByText(/couldn't load tokens/i)).toBeInTheDocument());
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("Tokens — filter pills", () => {
  it("clicking a filter pill calls listTokens with the right ?revoked= value", async () => {
    vi.mocked(api.listTokens).mockResolvedValue({ tokens: [], next_cursor: null });
    renderRoute();
    // Initial call with default `all`.
    await waitFor(() => expect(api.listTokens).toHaveBeenCalledWith({ revoked: "all" }));

    fireEvent.click(screen.getByRole("button", { name: /^live only$/i, pressed: false }));
    await waitFor(() => expect(api.listTokens).toHaveBeenCalledWith({ revoked: "false" }));

    fireEvent.click(screen.getByRole("button", { name: /^revoked only$/i, pressed: false }));
    await waitFor(() => expect(api.listTokens).toHaveBeenCalledWith({ revoked: "true" }));
  });
});

describe("Tokens — mint form", () => {
  beforeEach(() => {
    vi.mocked(api.listTokens).mockResolvedValue({ tokens: [], next_cursor: null });
  });

  it("Mint new token toggle opens + cancels the form", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /mint new token/i }));
    // Form labels visible.
    expect(screen.getByLabelText(/scope \(space-separated\)/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByLabelText(/scope \(space-separated\)/i)).toBeNull());
  });

  it("client-side validation: empty scope on submit shows field-error", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /mint new token/i }));
    // Required attribute should block native submit, but we test the post-validation
    // path by bypassing the required check via direct form submit.
    const form = screen.getByLabelText(/scope \(space-separated\)/i).closest("form");
    expect(form).not.toBeNull();
    // Set an empty value and dispatch submit. JSDOM honors `required`, so we
    // need to remove it for the test — but the simpler signal is "mintToken
    // was not called when scope is empty." Verify by submitting after removing
    // required.
    const scopeInput = screen.getByLabelText(/scope \(space-separated\)/i) as HTMLInputElement;
    scopeInput.removeAttribute("required");
    fireEvent.submit(form!);
    await waitFor(() => expect(screen.getByText(/scope is required/i)).toBeInTheDocument());
    expect(api.mintToken).not.toHaveBeenCalled();
  });

  it("client-side validation: malformed permissions JSON shows field-error", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /mint new token/i }));
    fireEvent.change(screen.getByLabelText(/scope \(space-separated\)/i), {
      target: { value: "scribe:transcribe" },
    });
    fireEvent.change(screen.getByLabelText(/permissions/i), {
      target: { value: "not json {[" },
    });
    fireEvent.submit(screen.getByLabelText(/scope \(space-separated\)/i).closest("form")!);
    await waitFor(() =>
      expect(screen.getByText(/permissions is not valid JSON/i)).toBeInTheDocument(),
    );
    expect(api.mintToken).not.toHaveBeenCalled();
  });

  it("client-side validation: permissions array (not object) shows field-error", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /mint new token/i }));
    fireEvent.change(screen.getByLabelText(/scope \(space-separated\)/i), {
      target: { value: "scribe:transcribe" },
    });
    fireEvent.change(screen.getByLabelText(/permissions/i), {
      target: { value: '["array", "not object"]' },
    });
    fireEvent.submit(screen.getByLabelText(/scope \(space-separated\)/i).closest("form")!);
    await waitFor(() =>
      expect(screen.getByText(/permissions must be a JSON object/i)).toBeInTheDocument(),
    );
    expect(api.mintToken).not.toHaveBeenCalled();
  });

  it("client-side validation: non-integer expires_in shows field-error", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /mint new token/i }));
    fireEvent.change(screen.getByLabelText(/scope \(space-separated\)/i), {
      target: { value: "scribe:transcribe" },
    });
    fireEvent.change(screen.getByLabelText(/expires in/i), {
      target: { value: "not-a-number" },
    });
    fireEvent.submit(screen.getByLabelText(/scope \(space-separated\)/i).closest("form")!);
    await waitFor(() =>
      expect(screen.getByText(/expires_in must be a positive integer/i)).toBeInTheDocument(),
    );
    expect(api.mintToken).not.toHaveBeenCalled();
  });

  it("happy path: submits scope-only mint, shows mint-banner with the JWT, refreshes list", async () => {
    vi.mocked(api.mintToken).mockResolvedValue({
      jti: "newjtiabcdef",
      token: "header.payload.signature",
      expires_at: FUTURE,
      scope: "scribe:transcribe",
    });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /mint new token/i }));
    fireEvent.change(screen.getByLabelText(/scope \(space-separated\)/i), {
      target: { value: "scribe:transcribe" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^mint$/i }));

    await waitFor(() => expect(api.mintToken).toHaveBeenCalledWith({ scope: "scribe:transcribe" }));
    // Mint-banner shows the JWT once.
    await waitFor(() => expect(screen.getByText("header.payload.signature")).toBeInTheDocument());
    expect(screen.getByText(/this is the only time/i)).toBeInTheDocument();
    // List was refreshed (listTokens called twice — initial + post-mint).
    expect(vi.mocked(api.listTokens).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("happy path: full form (scope + audience + expires_in + subject + permissions) round-trips", async () => {
    vi.mocked(api.mintToken).mockResolvedValue({
      jti: "fulljtiXXXX",
      token: "h.p.s",
      expires_at: FUTURE,
      scope: "vault:default:write",
      permissions: { vault: { default: { write_tags: ["health"] } } },
    });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /mint new token/i }));
    fireEvent.change(screen.getByLabelText(/scope \(space-separated\)/i), {
      target: { value: "vault:default:write" },
    });
    fireEvent.change(screen.getByLabelText(/audience/i), {
      target: { value: "vault.default" },
    });
    fireEvent.change(screen.getByLabelText(/expires in/i), {
      target: { value: "3600" },
    });
    fireEvent.change(screen.getByLabelText(/subject/i), {
      target: { value: "robot" },
    });
    fireEvent.change(screen.getByLabelText(/permissions/i), {
      target: { value: '{"vault":{"default":{"write_tags":["health"]}}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /^mint$/i }));

    await waitFor(() =>
      expect(api.mintToken).toHaveBeenCalledWith({
        scope: "vault:default:write",
        audience: "vault.default",
        expires_in: 3600,
        subject: "robot",
        permissions: { vault: { default: { write_tags: ["health"] } } },
      }),
    );
  });

  it("server error on mint surfaces in the form (no mint-banner)", async () => {
    vi.mocked(api.mintToken).mockRejectedValue(new api.HttpError(403, "insufficient_scope"));
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /mint new token/i }));
    fireEvent.change(screen.getByLabelText(/scope \(space-separated\)/i), {
      target: { value: "scribe:transcribe" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^mint$/i }));

    await waitFor(() =>
      expect(screen.getByText(/mint failed \(403\): insufficient_scope/i)).toBeInTheDocument(),
    );
    // No mint-banner.
    expect(screen.queryByText(/this is the only time/i)).toBeNull();
  });
});

describe("Tokens — revoke flow", () => {
  it("revoke button opens confirm dialog; cancel returns to list without POST", async () => {
    vi.mocked(api.listTokens).mockResolvedValue({
      tokens: [tokenRow("revokemeRRRRRRRXXXX")],
      next_cursor: null,
    });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /^revoke revokeme…XXXX$/i }));
    expect(
      screen.getByRole("dialog", { name: /confirm revoke revokeme…XXXX/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /confirm revoke/i })).toBeNull(),
    );
    expect(api.revokeToken).not.toHaveBeenCalled();
  });

  it("confirm revoke calls POST then refreshes the list", async () => {
    const listMock = vi.mocked(api.listTokens);
    listMock.mockResolvedValueOnce({
      tokens: [tokenRow("revokemeRRRRRRRXXXX")],
      next_cursor: null,
    });
    listMock.mockResolvedValueOnce({
      tokens: [tokenRow("revokemeRRRRRRRXXXX", { revoked_at: "2026-05-10T14:00:00.000Z" })],
      next_cursor: null,
    });
    vi.mocked(api.revokeToken).mockResolvedValue({
      jti: "revokemeRRRRRRRXXXX",
      revoked_at: "2026-05-10T14:00:00.000Z",
    });

    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /^revoke revokeme…XXXX$/i }));
    const dialog = screen.getByRole("dialog", { name: /confirm revoke revokeme…XXXX/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^revoke$/i }));

    await waitFor(() => expect(api.revokeToken).toHaveBeenCalledWith("revokemeRRRRRRRXXXX"));
    // List refreshed; status pill switches to revoked.
    await waitFor(() => expect(screen.getByText("revoked")).toBeInTheDocument());
  });

  it("surfaces a per-row error banner when revoke fails", async () => {
    vi.mocked(api.listTokens).mockResolvedValue({
      tokens: [tokenRow("revokemeRRRRRRRXXXX")],
      next_cursor: null,
    });
    vi.mocked(api.revokeToken).mockRejectedValue(new api.HttpError(404, "not_found"));
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /^revoke revokeme…XXXX$/i }));
    const dialog = screen.getByRole("dialog", { name: /confirm revoke revokeme…XXXX/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^revoke$/i }));

    await waitFor(() =>
      expect(screen.getByText(/revoke failed \(404\): not_found/i)).toBeInTheDocument(),
    );
  });
});

describe("Tokens — client_id rendering (F2)", () => {
  it("renders client_id alongside identity for OAuth-style rows", async () => {
    vi.mocked(api.listTokens).mockResolvedValue({
      tokens: [
        tokenRow("oauthrowAAAAAAAAAXXXX", {
          client_id: "oauth-app-foo",
          user_id: "shared-user-uuid",
          subject: null,
        }),
      ],
      next_cursor: null,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("shared-user-uuid")).toBeInTheDocument());
    // client_id appears as code text following "client:" label.
    expect(screen.getByText("oauth-app-foo")).toBeInTheDocument();
    expect(screen.getByText(/client:/)).toBeInTheDocument();
  });

  it("renders parachute-hub client_id for CLI/operator-mint rows", async () => {
    vi.mocked(api.listTokens).mockResolvedValue({
      tokens: [
        tokenRow("clirowAAAAAAAAAXXXX", {
          client_id: "parachute-hub",
          user_id: null,
          subject: "operator",
        }),
      ],
      next_cursor: null,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("operator")).toBeInTheDocument());
    expect(screen.getByText("parachute-hub")).toBeInTheDocument();
  });
});

describe("Tokens — pagination", () => {
  it("Load more appends next page; clears button when next_cursor goes null", async () => {
    const listMock = vi.mocked(api.listTokens);
    listMock.mockResolvedValueOnce({
      tokens: [tokenRow("page1aaaPPPPPPPXXXX")],
      next_cursor: "cursor-1",
    });
    listMock.mockResolvedValueOnce({
      tokens: [tokenRow("page2bbbPPPPPPPYYYY")],
      next_cursor: null,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText(/page1aaa…XXXX/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /load more/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(screen.getByText(/page2bbb…YYYY/)).toBeInTheDocument());
    // Both rows now present; Load more button gone (next_cursor was null).
    expect(screen.getByText(/page1aaa…XXXX/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
    // Second call passed the cursor.
    expect(listMock).toHaveBeenLastCalledWith({ cursor: "cursor-1", revoked: "all" });
  });

  it("Load more is disabled while the next-page fetch is in flight (F1)", async () => {
    const listMock = vi.mocked(api.listTokens);
    listMock.mockResolvedValueOnce({
      tokens: [tokenRow("page1aaaPPPPPPPXXXX")],
      next_cursor: "cursor-1",
    });
    // Hold the second call open so we can inspect button state during the
    // in-flight window — the whole point of F1 is "user double-clicks; we
    // don't refire the fetch and overwrite each other's appended pages."
    let resolveSecond: (page: api.AdminTokensPage) => void = () => {};
    listMock.mockReturnValueOnce(
      new Promise<api.AdminTokensPage>((resolve) => {
        resolveSecond = resolve;
      }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByText(/page1aaa…XXXX/)).toBeInTheDocument());

    const loadMoreBtn = screen.getByRole("button", { name: /^load more$/i });
    expect(loadMoreBtn).not.toBeDisabled();
    fireEvent.click(loadMoreBtn);

    // While the second fetch is pending: button text flips to "Loading…"
    // AND it's disabled — so a second click can't refire the fetch.
    await waitFor(() => expect(screen.getByRole("button", { name: /^loading…$/i })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /^loading…$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^loading…$/i }));
    // Two extra clicks during the in-flight window — listTokens still only
    // called twice total (initial + the one in-flight), not four times.
    expect(listMock).toHaveBeenCalledTimes(2);

    // Resolve the in-flight call. Button reverts to enabled "Load more"
    // (or vanishes if next_cursor is null — here we set null to verify
    // the cleanup path).
    resolveSecond({ tokens: [tokenRow("page2bbbPPPPPPPYYYY")], next_cursor: null });
    await waitFor(() => expect(screen.getByText(/page2bbb…YYYY/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^load more$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^loading…$/i })).toBeNull();
  });
});

describe("Tokens — integration: mint → see in list → revoke → see status update", () => {
  it("walks the full happy-path loop", async () => {
    const listMock = vi.mocked(api.listTokens);
    // Page 1 (initial): empty registry.
    listMock.mockResolvedValueOnce({ tokens: [], next_cursor: null });
    // Page 2 (after mint): one live row.
    listMock.mockResolvedValueOnce({
      tokens: [tokenRow("integratioNIIIIIIIIIIonXX", { scopes: ["scribe:transcribe"] })],
      next_cursor: null,
    });
    // Page 3 (after revoke): one revoked row.
    listMock.mockResolvedValueOnce({
      tokens: [
        tokenRow("integratioNIIIIIIIIIIonXX", {
          scopes: ["scribe:transcribe"],
          revoked_at: "2026-05-10T14:00:00.000Z",
        }),
      ],
      next_cursor: null,
    });
    vi.mocked(api.mintToken).mockResolvedValue({
      jti: "integratioNIIIIIIIIIIonXX",
      token: "h.p.s",
      expires_at: FUTURE,
      scope: "scribe:transcribe",
    });
    vi.mocked(api.revokeToken).mockResolvedValue({
      jti: "integratioNIIIIIIIIIIonXX",
      revoked_at: "2026-05-10T14:00:00.000Z",
    });

    renderRoute();
    // Step 1: empty state visible.
    await waitFor(() => expect(screen.getByText(/no tokens\./i)).toBeInTheDocument());

    // Step 2: open form, fill scope, mint.
    fireEvent.click(screen.getByRole("button", { name: /mint new token/i }));
    fireEvent.change(screen.getByLabelText(/scope \(space-separated\)/i), {
      target: { value: "scribe:transcribe" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^mint$/i }));

    // Step 3: mint-banner appears with the once-shown JWT.
    await waitFor(() => expect(screen.getByText("h.p.s")).toBeInTheDocument());

    // Step 4: list refreshed to show the new live row.
    await waitFor(() => expect(screen.getByText(/integrat…onXX/)).toBeInTheDocument());
    expect(screen.getByText("live")).toBeInTheDocument();

    // Step 5: open revoke confirm, confirm.
    fireEvent.click(screen.getByRole("button", { name: /^revoke integrat…onXX$/i }));
    const dialog = screen.getByRole("dialog", { name: /confirm revoke integrat…onXX/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^revoke$/i }));

    // Step 6: status pill switches to revoked; row stays.
    await waitFor(() => expect(screen.getByText("revoked")).toBeInTheDocument());
  });
});
