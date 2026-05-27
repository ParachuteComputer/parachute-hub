import { describe, expect, test } from "bun:test";
import { exposePublicAutoPick } from "../commands/expose-public-auto.ts";
import type { ProviderAvailability } from "../providers/detect.ts";

function availability(opts: {
  tailnet?: { available?: boolean; loggedIn?: boolean; funnelEnabled?: boolean };
  cloudflare?: { available?: boolean; loggedIn?: boolean };
}): ProviderAvailability {
  return {
    tailnet: {
      available: opts.tailnet?.available ?? false,
      loggedIn: opts.tailnet?.loggedIn ?? false,
      funnelEnabled: opts.tailnet?.funnelEnabled ?? false,
    },
    cloudflare: {
      available: opts.cloudflare?.available ?? false,
      loggedIn: opts.cloudflare?.loggedIn ?? false,
    },
  };
}

describe("exposePublicAutoPick — exactly one ready", () => {
  test("only tailnet ready → runs exposePublic('up') without prompting", async () => {
    let called: { action: string; opts: unknown } | undefined;
    const code = await exposePublicAutoPick({
      tailscaleOpts: { hubOrigin: "https://override.example" },
      log: () => {},
      detectProvidersImpl: async () =>
        availability({ tailnet: { available: true, loggedIn: true, funnelEnabled: true } }),
      exposePublicImpl: async (action, opts) => {
        called = { action, opts };
        return 0;
      },
      exposeCloudflareUpImpl: async () => {
        throw new Error("must not be called when only tailnet is ready");
      },
    });
    expect(code).toBe(0);
    expect(called).toEqual({
      action: "up",
      opts: { hubOrigin: "https://override.example" },
    });
  });

  test("only cloudflare ready + --domain given → runs exposeCloudflareUp", async () => {
    let receivedHostname: string | undefined;
    let receivedOpts: unknown;
    const code = await exposePublicAutoPick({
      domain: "vault.example.com",
      tunnelName: "vault",
      log: () => {},
      detectProvidersImpl: async () =>
        availability({ cloudflare: { available: true, loggedIn: true } }),
      exposePublicImpl: async () => {
        throw new Error("must not be called when only cloudflare is ready");
      },
      exposeCloudflareUpImpl: async (hostname, opts) => {
        receivedHostname = hostname;
        receivedOpts = opts;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(receivedHostname).toBe("vault.example.com");
    expect(receivedOpts).toEqual({ tunnelName: "vault" });
  });

  test("only cloudflare ready + no --domain → exits 1 with hostname-required hint", async () => {
    const logs: string[] = [];
    const code = await exposePublicAutoPick({
      log: (l) => logs.push(l),
      detectProvidersImpl: async () =>
        availability({ cloudflare: { available: true, loggedIn: true } }),
      exposePublicImpl: async () => {
        throw new Error("must not be called");
      },
      exposeCloudflareUpImpl: async () => {
        throw new Error("must not be called");
      },
    });
    expect(code).toBe(1);
    const joined = logs.join("\n");
    expect(joined).toMatch(/--domain <hostname> is required|--domain.+required/);
    expect(joined).toContain("--cloudflare --domain vault.example.com");
  });
});

describe("exposePublicAutoPick — ambiguous", () => {
  test("both ready → exits 1 pointing to --tailnet/--cloudflare", async () => {
    const logs: string[] = [];
    const code = await exposePublicAutoPick({
      log: (l) => logs.push(l),
      detectProvidersImpl: async () =>
        availability({
          tailnet: { available: true, loggedIn: true, funnelEnabled: true },
          cloudflare: { available: true, loggedIn: true },
        }),
      exposePublicImpl: async () => {
        throw new Error("must not be called when ambiguous");
      },
      exposeCloudflareUpImpl: async () => {
        throw new Error("must not be called when ambiguous");
      },
    });
    expect(code).toBe(1);
    const joined = logs.join("\n");
    expect(joined).toContain("--tailnet");
    expect(joined).toContain("--cloudflare");
    expect(joined).toContain("--skip-provider-check");
  });
});

describe("exposePublicAutoPick — neither ready", () => {
  test("no providers → exits 1 with install pointers for both", async () => {
    const logs: string[] = [];
    const code = await exposePublicAutoPick({
      log: (l) => logs.push(l),
      detectProvidersImpl: async () => availability({}),
      exposePublicImpl: async () => {
        throw new Error("must not be called");
      },
      exposeCloudflareUpImpl: async () => {
        throw new Error("must not be called");
      },
    });
    expect(code).toBe(1);
    const joined = logs.join("\n");
    expect(joined).toContain("tailscale.com/download");
    // Post 2026-05-27 cloudflared-URL refresh: the install hint now points
    // at GitHub releases (developers.cloudflare.com / pkg.cloudflare.com
    // both returned HTML/404 on Aaron's fresh AL2023 EC2 box).
    expect(joined).toContain("github.com/cloudflare/cloudflared/releases/latest");
    expect(joined).not.toContain("developers.cloudflare.com");
    expect(joined).toContain("--skip-provider-check");
  });

  test("partial readiness (installed but not logged in) lists the next step", async () => {
    const logs: string[] = [];
    const code = await exposePublicAutoPick({
      log: (l) => logs.push(l),
      detectProvidersImpl: async () =>
        availability({
          tailnet: { available: true, loggedIn: false, funnelEnabled: false },
          cloudflare: { available: true, loggedIn: false },
        }),
      exposePublicImpl: async () => 0,
      exposeCloudflareUpImpl: async () => 0,
    });
    expect(code).toBe(1);
    const joined = logs.join("\n");
    // Both binaries marked installed; both still need login.
    expect(joined).toContain("✓ tailscale installed");
    expect(joined).toContain("✓ cloudflared installed");
    expect(joined).toContain("tailscale up");
    expect(joined).toContain("cloudflared tunnel login");
  });
});
