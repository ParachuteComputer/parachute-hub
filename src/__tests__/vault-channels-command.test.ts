/**
 * `parachute vault attach-channel | detach-channel | list-channels`.
 *
 * The command is a CLIENT of the running hub — every verb must go out as an
 * operator-token-bearing request to `/api/channel-vaults` and nothing may be
 * decided locally. These tests inject the bearer resolver + `fetch` so the
 * request shape, the rendering, and the error mapping are asserted without a
 * live hub or a real socket. Same harness shape as `vault-remove.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { CHANNEL_SUBCOMMANDS, vaultChannels } from "../commands/vault-channels.ts";

const BEARER = "header.payload.signature";
const RELAY = "buzz.unforced.dev";
const CHANNEL = "3ff68a58-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const BASE = "http://127.0.0.1:1939";

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let i = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const call: FakeCall = { url, method: init?.method ?? "GET", headers };
    if (typeof init?.body === "string") call.body = init.body;
    calls.push(call);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(r?.body ?? {}), {
      status: r?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

function makeSinks() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (l: string) => out.push(l),
    logError: (l: string) => err.push(l),
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
}

function deps(responses: Array<{ status: number; body: unknown }>) {
  const f = fakeFetch(responses);
  const sinks = makeSinks();
  return {
    calls: f.calls,
    sinks,
    deps: {
      resolveBearer: async () => BEARER,
      fetch: f.fetch,
      baseUrl: BASE,
      log: sinks.log,
      logError: sinks.logError,
    },
  };
}

const ATTACHED = {
  relay_host: RELAY,
  channel_id: CHANNEL,
  vault: "ch-3ff68a58",
  mode: "sync",
  relay_self_pubkey: null,
  synced_at: null,
  created_at: "2026-09-02T00:00:00.000Z",
  created: true,
};

describe("attach-channel", () => {
  test("POSTs the binding with the operator bearer and renders the result", async () => {
    const t = deps([{ status: 201, body: ATTACHED }]);
    const code = await vaultChannels(
      "attach-channel",
      ["--relay", RELAY, "--channel", CHANNEL],
      t.deps,
    );
    expect(code).toBe(0);

    expect(t.calls).toHaveLength(1);
    const call = t.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(`${BASE}/api/channel-vaults`);
    expect(call?.headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ relay: RELAY, channel: CHANNEL });

    expect(t.sinks.text()).toContain('to vault "ch-3ff68a58"');
    // The operator must not be left thinking access was granted.
    expect(t.sinks.text()).toContain("no access was granted");
  });

  test("--vault rides the body; --vault=<name> parses too", async () => {
    const t = deps([{ status: 201, body: { ...ATTACHED, vault: "parachute" } }]);
    const code = await vaultChannels(
      "attach-channel",
      ["--relay", `wss://${RELAY}/`, `--channel=${CHANNEL}`, "--vault=parachute"],
      t.deps,
    );
    expect(code).toBe(0);
    expect(JSON.parse(t.calls[0]?.body ?? "{}")).toEqual({
      relay: `wss://${RELAY}/`,
      channel: CHANNEL,
      vault: "parachute",
    });
    expect(t.sinks.text()).toContain('to vault "parachute"');
  });

  test("a 200 with created:false renders as an idempotent no-op", async () => {
    const t = deps([{ status: 200, body: { ...ATTACHED, created: false } }]);
    const code = await vaultChannels(
      "attach-channel",
      ["--relay", RELAY, "--channel", CHANNEL],
      t.deps,
    );
    expect(code).toBe(0);
    expect(t.sinks.text()).toContain("already attached");
    expect(t.sinks.text()).toContain("Nothing to do");
  });

  test("a 400 vault_not_found is surfaced verbatim, not as a raw status", async () => {
    const t = deps([
      {
        status: 400,
        body: {
          error: "vault_not_found",
          error_description:
            'vault "parachute" is not installed on this hub — create it with `parachute vault create parachute` first',
        },
      },
    ]);
    const code = await vaultChannels(
      "attach-channel",
      ["--relay", RELAY, "--channel", CHANNEL, "--vault", "parachute"],
      t.deps,
    );
    expect(code).toBe(1);
    expect(t.sinks.errText()).toContain("is not installed on this hub");
    expect(t.sinks.errText()).toContain("parachute vault create");
  });

  test("a 403 steers the operator at the operator token, not at the endpoint", async () => {
    const t = deps([
      {
        status: 403,
        body: {
          error: "insufficient_scope",
          error_description: "token missing required scope: parachute:host:admin",
        },
      },
    ]);
    const code = await vaultChannels(
      "attach-channel",
      ["--relay", RELAY, "--channel", CHANNEL],
      t.deps,
    );
    expect(code).toBe(1);
    expect(t.sinks.errText()).toContain("rotate-operator");
  });

  test("missing --relay / --channel fails before any request", async () => {
    const t = deps([{ status: 201, body: ATTACHED }]);
    expect(await vaultChannels("attach-channel", ["--channel", CHANNEL], t.deps)).toBe(1);
    expect(await vaultChannels("attach-channel", ["--relay", RELAY], t.deps)).toBe(1);
    expect(t.calls).toEqual([]);
  });

  test("an unknown flag fails before any request", async () => {
    const t = deps([{ status: 201, body: ATTACHED }]);
    expect(
      await vaultChannels(
        "attach-channel",
        ["--relay", RELAY, "--channel", CHANNEL, "--force"],
        t.deps,
      ),
    ).toBe(1);
    expect(t.calls).toEqual([]);
    expect(t.sinks.errText()).toContain("unexpected argument");
  });

  test("--hub-origin retargets the request", async () => {
    const t = deps([{ status: 201, body: ATTACHED }]);
    await vaultChannels(
      "attach-channel",
      ["--relay", RELAY, "--channel", CHANNEL, "--hub-origin", "https://hub.example/"],
      t.deps,
    );
    expect(t.calls[0]?.url).toBe("https://hub.example/api/channel-vaults");
  });
});

describe("detach-channel", () => {
  test("DELETEs with relay + channel in the query string", async () => {
    const t = deps([
      {
        status: 200,
        body: { relay_host: RELAY, channel_id: CHANNEL, vault: "ch-3ff68a58", removed: true },
      },
    ]);
    const code = await vaultChannels(
      "detach-channel",
      ["--relay", RELAY, "--channel", CHANNEL],
      t.deps,
    );
    expect(code).toBe(0);
    expect(t.calls[0]?.method).toBe("DELETE");
    const url = new URL(t.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/channel-vaults");
    expect(url.searchParams.get("relay")).toBe(RELAY);
    expect(url.searchParams.get("channel")).toBe(CHANNEL);
    expect(t.sinks.text()).toContain("Detached channel");
    // Detach must never read as a destroy.
    expect(t.sinks.text()).toContain("vault itself is untouched");
  });

  test("removed:false renders as nothing-to-do and still exits 0", async () => {
    const t = deps([{ status: 200, body: { removed: false, vault: null } }]);
    expect(
      await vaultChannels("detach-channel", ["--relay", RELAY, "--channel", CHANNEL], t.deps),
    ).toBe(0);
    expect(t.sinks.text()).toContain("Nothing to do");
  });

  test("an unknown flag is refused before anything is sent", async () => {
    const t = deps([{ status: 200, body: {} }]);
    expect(
      await vaultChannels(
        "detach-channel",
        ["--relay", RELAY, "--channel", CHANNEL, "--force"],
        t.deps,
      ),
    ).toBe(1);
    expect(t.calls).toEqual([]);
  });
});

describe("list-channels", () => {
  test("renders relay, channel, vault, mode and synced_at", async () => {
    const t = deps([
      {
        status: 200,
        body: {
          channel_vaults: [
            {
              relay_host: RELAY,
              channel_id: CHANNEL,
              vault: "parachute",
              mode: "sync",
              synced_at: null,
              created_at: "x",
            },
            {
              relay_host: "other.example",
              channel_id: "c2",
              vault: "ch-c2",
              mode: "frozen",
              synced_at: "2026-09-02T10:00:00.000Z",
              created_at: "x",
            },
          ],
        },
      },
    ]);
    const code = await vaultChannels("list-channels", [], t.deps);
    expect(code).toBe(0);
    expect(t.calls[0]?.method).toBe("GET");
    expect(t.calls[0]?.url).toBe(`${BASE}/api/channel-vaults`);

    const text = t.sinks.text();
    expect(text).toContain("RELAY");
    expect(text).toContain("CHANNEL");
    expect(text).toContain("VAULT");
    expect(text).toContain("MODE");
    expect(text).toContain("SYNCED");
    expect(text).toContain(RELAY);
    expect(text).toContain(CHANNEL);
    expect(text).toContain("parachute");
    expect(text).toContain("frozen");
    // A binding that has never synced says so rather than printing "null".
    expect(text).toContain("never");
    expect(text).toContain("2026-09-02T10:00:00.000Z");
  });

  test("an empty list says so instead of printing a bare header", async () => {
    const t = deps([{ status: 200, body: { channel_vaults: [] } }]);
    expect(await vaultChannels("list-channels", [], t.deps)).toBe(0);
    expect(t.sinks.text()).toContain("No channels are attached");
  });

  test("?vault= filters", async () => {
    const t = deps([{ status: 200, body: { channel_vaults: [] } }]);
    await vaultChannels("list-channels", ["--vault", "parachute"], t.deps);
    expect(new URL(t.calls[0]?.url ?? "").searchParams.get("vault")).toBe("parachute");
  });

  test("list-channels needs no --relay/--channel", async () => {
    const t = deps([{ status: 200, body: { channel_vaults: [] } }]);
    expect(await vaultChannels("list-channels", [], t.deps)).toBe(0);
    expect(t.calls).toHaveLength(1);
  });
});

describe("the subcommand set", () => {
  test("matches the literal list cli.ts dispatches on", () => {
    // cli.ts repeats these literals so the passthrough for every other vault
    // verb doesn't load this module. This is the pin that keeps them equal.
    expect([...CHANNEL_SUBCOMMANDS]).toEqual(["attach-channel", "detach-channel", "list-channels"]);
    const cli = Bun.file(new URL("../cli.ts", import.meta.url)).text();
    return cli.then((src) => {
      for (const sub of CHANNEL_SUBCOMMANDS) {
        expect(src).toContain(`sub === "${sub}"`);
      }
    });
  });

  test("--help prints usage without contacting the hub", async () => {
    const t = deps([{ status: 200, body: {} }]);
    expect(await vaultChannels("attach-channel", ["--help"], t.deps)).toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.sinks.text()).toContain("attach-channel");
  });
});
