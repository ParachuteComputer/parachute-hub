import { describe, expect, test } from "bun:test";
import type { CloudflaredState } from "../cloudflare/state.ts";
import {
  type ExposePublicOffAutoOpts,
  runExposePublicOffAutoDetect,
} from "../commands/expose-off-auto.ts";
import type { ExposeState } from "../expose-state.ts";

function tailscaleState(overrides: Partial<ExposeState> = {}): ExposeState {
  return {
    version: 1,
    layer: "public",
    mode: "path",
    canonicalFqdn: "box.tail-scale.ts.net",
    port: 8080,
    funnel: true,
    entries: [
      {
        kind: "proxy",
        mount: "/vault/default",
        target: "http://127.0.0.1:8080",
        service: "parachute-vault",
      },
    ],
    ...overrides,
  };
}

function cloudflaredState(
  overrides: { hostname?: string; tunnelName?: string; pid?: number } = {},
): CloudflaredState {
  const tunnelName = overrides.tunnelName ?? "vault-tunnel";
  return {
    version: 2,
    tunnels: {
      [tunnelName]: {
        pid: overrides.pid ?? 4242,
        tunnelUuid: "11111111-2222-3333-4444-555555555555",
        tunnelName,
        hostname: overrides.hostname ?? "vault.example.com",
        startedAt: "2026-04-23T10:00:00.000Z",
        configPath: "/tmp/config.yml",
      },
    },
  };
}

interface Harness {
  logs: string[];
  prompts: string[];
  tailscaleCalls: number;
  cloudflareCalls: number;
}

function makeHarness(
  input: {
    tsState?: ExposeState;
    cfState?: CloudflaredState;
    promptAnswers?: string[];
    isTty?: boolean;
    tsExitCode?: number;
    cfExitCode?: number;
  } = {},
): {
  harness: Harness;
  opts: ExposePublicOffAutoOpts;
} {
  const harness: Harness = {
    logs: [],
    prompts: [],
    tailscaleCalls: 0,
    cloudflareCalls: 0,
  };
  const answers = [...(input.promptAnswers ?? [])];
  let i = 0;
  const opts: ExposePublicOffAutoOpts = {
    log: (l) => harness.logs.push(l),
    isTty: input.isTty ?? true,
    readTailscaleState: () => input.tsState,
    readCloudflaredState: () => input.cfState,
    prompt: async (q) => {
      harness.prompts.push(q);
      const a = answers[i++];
      if (a === undefined) throw new Error(`prompt exhausted at: ${q}`);
      return a;
    },
    exposePublicImpl: async (_action) => {
      harness.tailscaleCalls++;
      return input.tsExitCode ?? 0;
    },
    exposeCloudflareOffImpl: async () => {
      harness.cloudflareCalls++;
      return input.cfExitCode ?? 0;
    },
  };
  return { harness, opts };
}

describe("runExposePublicOffAutoDetect — neither live", () => {
  test("quiet no-op, exit 0, no teardown called", async () => {
    const { harness, opts } = makeHarness();
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(0);
    expect(harness.tailscaleCalls).toBe(0);
    expect(harness.cloudflareCalls).toBe(0);
    expect(harness.prompts).toHaveLength(0);
    expect(harness.logs).toEqual(["No public exposure active. Nothing to tear down."]);
  });

  test("tailnet-layer state is NOT counted as public", async () => {
    // A tailnet exposure has layer==="tailnet" and funnel===false. The auto
    // path is scoped to public. State files co-exist; we must not tear down a
    // tailnet exposure when the user typed `expose public off`.
    const tsState = tailscaleState({ layer: "tailnet", funnel: false });
    const { harness, opts } = makeHarness({ tsState });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(0);
    expect(harness.tailscaleCalls).toBe(0);
    expect(harness.logs).toEqual(["No public exposure active. Nothing to tear down."]);
  });

  test("public state with no entries is not counted as live", async () => {
    const tsState = tailscaleState({ entries: [] });
    const { harness, opts } = makeHarness({ tsState });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(0);
    expect(harness.tailscaleCalls).toBe(0);
  });
});

describe("runExposePublicOffAutoDetect — exactly one live", () => {
  test("tailscale-only → tears down tailscale, prints summary", async () => {
    const { harness, opts } = makeHarness({ tsState: tailscaleState() });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(0);
    expect(harness.tailscaleCalls).toBe(1);
    expect(harness.cloudflareCalls).toBe(0);
    expect(harness.logs).toContain(
      "✓ Tore down Tailscale Funnel (was: https://box.tail-scale.ts.net)",
    );
  });

  test("cloudflare-only → tears down cloudflare, prints summary", async () => {
    const { harness, opts } = makeHarness({ cfState: cloudflaredState() });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(0);
    expect(harness.tailscaleCalls).toBe(0);
    expect(harness.cloudflareCalls).toBe(1);
    expect(harness.logs).toContain(
      "✓ Tore down Cloudflare Tunnel (was: https://vault.example.com)",
    );
  });

  test("teardown failure propagates exit code and suppresses summary line", async () => {
    const { harness, opts } = makeHarness({ tsState: tailscaleState(), tsExitCode: 2 });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(2);
    expect(harness.tailscaleCalls).toBe(1);
    // Summary line printed only on success — the inner teardown already
    // explained what went wrong.
    expect(harness.logs.some((l) => l.startsWith("✓ Tore down"))).toBe(false);
  });
});

describe("runExposePublicOffAutoDetect — both live (TTY prompt)", () => {
  test("Enter defaults to 'both' — tears down tailscale then cloudflare", async () => {
    const { harness, opts } = makeHarness({
      tsState: tailscaleState(),
      cfState: cloudflaredState(),
      promptAnswers: [""],
      isTty: true,
    });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(0);
    expect(harness.tailscaleCalls).toBe(1);
    expect(harness.cloudflareCalls).toBe(1);
    expect(harness.prompts).toHaveLength(1);
  });

  test("'1' tears down tailscale only", async () => {
    const { harness, opts } = makeHarness({
      tsState: tailscaleState(),
      cfState: cloudflaredState(),
      promptAnswers: ["1"],
      isTty: true,
    });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(0);
    expect(harness.tailscaleCalls).toBe(1);
    expect(harness.cloudflareCalls).toBe(0);
  });

  test("'2' tears down cloudflare only", async () => {
    const { harness, opts } = makeHarness({
      tsState: tailscaleState(),
      cfState: cloudflaredState(),
      promptAnswers: ["2"],
      isTty: true,
    });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(0);
    expect(harness.tailscaleCalls).toBe(0);
    expect(harness.cloudflareCalls).toBe(1);
  });

  test("'3' explicitly selects both", async () => {
    const { harness, opts } = makeHarness({
      tsState: tailscaleState(),
      cfState: cloudflaredState(),
      promptAnswers: ["3"],
      isTty: true,
    });
    await runExposePublicOffAutoDetect(opts);
    expect(harness.tailscaleCalls).toBe(1);
    expect(harness.cloudflareCalls).toBe(1);
  });

  test("'4' cancels — exit 0, no teardown", async () => {
    const { harness, opts } = makeHarness({
      tsState: tailscaleState(),
      cfState: cloudflaredState(),
      promptAnswers: ["4"],
      isTty: true,
    });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(0);
    expect(harness.tailscaleCalls).toBe(0);
    expect(harness.cloudflareCalls).toBe(0);
    expect(harness.logs).toContain("Cancelled — no teardown.");
  });

  test("unknown input re-prompts", async () => {
    const { harness, opts } = makeHarness({
      tsState: tailscaleState(),
      cfState: cloudflaredState(),
      promptAnswers: ["huh?", "1"],
      isTty: true,
    });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(0);
    expect(harness.prompts).toHaveLength(2);
    expect(harness.tailscaleCalls).toBe(1);
    expect(harness.cloudflareCalls).toBe(0);
  });

  test("both-teardown: failure from tailscale propagates, cloudflare still runs", async () => {
    const { harness, opts } = makeHarness({
      tsState: tailscaleState(),
      cfState: cloudflaredState(),
      promptAnswers: ["3"],
      isTty: true,
      tsExitCode: 2,
    });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(2);
    expect(harness.tailscaleCalls).toBe(1);
    expect(harness.cloudflareCalls).toBe(1);
  });
});

describe("runExposePublicOffAutoDetect — both live (non-TTY)", () => {
  test("tears down both without prompting", async () => {
    const { harness, opts } = makeHarness({
      tsState: tailscaleState(),
      cfState: cloudflaredState(),
      isTty: false,
    });
    const code = await runExposePublicOffAutoDetect(opts);
    expect(code).toBe(0);
    expect(harness.prompts).toHaveLength(0);
    expect(harness.tailscaleCalls).toBe(1);
    expect(harness.cloudflareCalls).toBe(1);
    expect(harness.logs).toContain("(non-TTY: tearing down both.)");
  });
});
