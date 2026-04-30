import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProviderAvailability,
  detectProviders,
  isCloudflareReady,
  isTailnetReady,
} from "../providers/detect.ts";
import type { CommandResult, Runner } from "../tailscale/run.ts";

interface FixedRunnerOpts {
  tailscaleInstalled?: boolean;
  tailscaleLoggedIn?: boolean;
  tailscaleFunnelCap?: boolean;
  cloudflaredInstalled?: boolean;
}

function fixedRunner(opts: FixedRunnerOpts): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (cmd) => {
    calls.push([...cmd]);
    const head = cmd.slice(0, 2).join(" ");
    if (head === "tailscale version") {
      return opts.tailscaleInstalled
        ? ({ code: 0, stdout: "1.82.0\n", stderr: "" } as CommandResult)
        : ({ code: 127, stdout: "", stderr: "not found" } as CommandResult);
    }
    if (head === "tailscale status") {
      const self: Record<string, unknown> = {};
      if (opts.tailscaleLoggedIn) self.DNSName = "host.example.ts.net.";
      if (opts.tailscaleFunnelCap) self.CapMap = { funnel: null };
      return { code: 0, stdout: JSON.stringify({ Self: self }), stderr: "" } as CommandResult;
    }
    if (head === "cloudflared --version") {
      return opts.cloudflaredInstalled
        ? ({ code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" } as CommandResult)
        : ({ code: 127, stdout: "", stderr: "not found" } as CommandResult);
    }
    throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
  };
  return { runner, calls };
}

function makeCloudflaredHome(loggedIn: boolean): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "providers-detect-cf-"));
  if (loggedIn) writeFileSync(join(home, "cert.pem"), "---");
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe("detectProviders", () => {
  test("everything available + logged in + funnel granted → both ready", async () => {
    const env = makeCloudflaredHome(true);
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
        cloudflaredInstalled: true,
      });
      const r = await detectProviders({ runner, cloudflaredHome: env.home });
      expect(r).toEqual({
        tailnet: { available: true, loggedIn: true, funnelEnabled: true },
        cloudflare: { available: true, loggedIn: true },
      });
      expect(isTailnetReady(r)).toBe(true);
      expect(isCloudflareReady(r)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("tailscale installed but Funnel cap missing → not tailnet-ready", async () => {
    const env = makeCloudflaredHome(false);
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: false,
      });
      const r = await detectProviders({ runner, cloudflaredHome: env.home });
      expect(r.tailnet).toEqual({ available: true, loggedIn: true, funnelEnabled: false });
      expect(isTailnetReady(r)).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  test("cloudflared installed but no cert.pem → not cloudflare-ready", async () => {
    const env = makeCloudflaredHome(false);
    try {
      const { runner } = fixedRunner({ cloudflaredInstalled: true });
      const r = await detectProviders({ runner, cloudflaredHome: env.home });
      expect(r.cloudflare).toEqual({ available: true, loggedIn: false });
      expect(isCloudflareReady(r)).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  test("neither binary installed → no `tailscale status` probe is issued", async () => {
    const env = makeCloudflaredHome(false);
    try {
      const { runner, calls } = fixedRunner({});
      const r = await detectProviders({ runner, cloudflaredHome: env.home });
      const ran = calls.map((c) => c.slice(0, 2).join(" "));
      // `tailscale version` is the gate; if it fails, we skip status to avoid
      // a guaranteed-to-fail call.
      expect(ran).toContain("tailscale version");
      expect(ran).not.toContain("tailscale status");
      expect(r.tailnet.available).toBe(false);
      expect(r.cloudflare.available).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});

describe("readiness predicates", () => {
  const base: ProviderAvailability = {
    tailnet: { available: false, loggedIn: false, funnelEnabled: false },
    cloudflare: { available: false, loggedIn: false },
  };

  test("isTailnetReady requires all three legs", () => {
    expect(
      isTailnetReady({
        ...base,
        tailnet: { available: true, loggedIn: true, funnelEnabled: true },
      }),
    ).toBe(true);
    expect(
      isTailnetReady({
        ...base,
        tailnet: { available: true, loggedIn: true, funnelEnabled: false },
      }),
    ).toBe(false);
    expect(
      isTailnetReady({
        ...base,
        tailnet: { available: true, loggedIn: false, funnelEnabled: true },
      }),
    ).toBe(false);
  });

  test("isCloudflareReady requires both legs", () => {
    expect(isCloudflareReady({ ...base, cloudflare: { available: true, loggedIn: true } })).toBe(
      true,
    );
    expect(isCloudflareReady({ ...base, cloudflare: { available: true, loggedIn: false } })).toBe(
      false,
    );
    expect(isCloudflareReady({ ...base, cloudflare: { available: false, loggedIn: true } })).toBe(
      false,
    );
  });
});
