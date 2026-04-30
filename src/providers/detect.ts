/**
 * Unified `parachute expose public` provider readiness probe.
 *
 * Public exposure has two backends today — Tailscale Funnel and Cloudflare
 * Tunnel — and every entry point that decides between them needs the same
 * "what's actually usable on this box right now?" snapshot. The interactive
 * picker (`expose-interactive.ts`), the non-TTY auto-pick path
 * (`expose-public-auto.ts`), and any future caller share this module so the
 * readiness rules stay in one place.
 *
 * "Ready" = the user could pick this provider and have it work end-to-end:
 *
 *   - tailnet:    binary on PATH AND logged in AND Funnel ACL grants the cap.
 *                 Funnel without the cap fails at bringup with an opaque
 *                 admin-console error, which we'd rather pre-empt.
 *   - cloudflare: binary on PATH AND `~/.cloudflared/cert.pem` exists.
 *                 cert.pem is cloudflared's own login marker — every
 *                 `tunnel create|list|route` call reads it.
 *
 * The shape (`available` + provider-specific extras) keeps the call sites
 * readable: `r.tailnet.available && r.tailnet.funnelEnabled` reads as the
 * sentence it represents.
 */

import {
  DEFAULT_CLOUDFLARED_HOME,
  isCloudflaredInstalled,
  isCloudflaredLoggedIn,
} from "../cloudflare/detect.ts";
import { getTailscaleStatus, isTailscaleInstalled } from "../tailscale/detect.ts";
import { type Runner, defaultRunner } from "../tailscale/run.ts";

export interface TailnetAvailability {
  /** `tailscale` is on PATH. */
  available: boolean;
  /** This machine is logged into a tailnet (Self.DNSName populated). */
  loggedIn: boolean;
  /** This node's tailnet ACL grants the Funnel capability. */
  funnelEnabled: boolean;
}

export interface CloudflareAvailability {
  /** `cloudflared` is on PATH. */
  available: boolean;
  /** `~/.cloudflared/cert.pem` exists (the login marker). */
  loggedIn: boolean;
}

export interface ProviderAvailability {
  tailnet: TailnetAvailability;
  cloudflare: CloudflareAvailability;
}

export interface DetectProvidersOpts {
  runner?: Runner;
  /** Override `~/.cloudflared` for tests and `$HOME`-free environments. */
  cloudflaredHome?: string;
}

export async function detectProviders(
  opts: DetectProvidersOpts = {},
): Promise<ProviderAvailability> {
  const runner = opts.runner ?? defaultRunner;
  const cloudflaredHome = opts.cloudflaredHome ?? DEFAULT_CLOUDFLARED_HOME;

  const tailnetAvailable = await isTailscaleInstalled(runner);
  // One `tailscale status --json` covers both login state and Funnel cap;
  // skip when the binary is missing — the call would just fail.
  const { loggedIn: tailnetLoggedIn, funnelCapable: tailnetFunnelEnabled } = tailnetAvailable
    ? await getTailscaleStatus(runner)
    : { loggedIn: false, funnelCapable: false };

  const cloudflareAvailable = await isCloudflaredInstalled(runner);
  const cloudflareLoggedIn = cloudflareAvailable ? isCloudflaredLoggedIn(cloudflaredHome) : false;

  return {
    tailnet: {
      available: tailnetAvailable,
      loggedIn: tailnetLoggedIn,
      funnelEnabled: tailnetFunnelEnabled,
    },
    cloudflare: {
      available: cloudflareAvailable,
      loggedIn: cloudflareLoggedIn,
    },
  };
}

/** Tailnet Funnel is usable end-to-end on this box. */
export function isTailnetReady(p: ProviderAvailability): boolean {
  return p.tailnet.available && p.tailnet.loggedIn && p.tailnet.funnelEnabled;
}

/** Cloudflare Tunnel is usable end-to-end on this box. */
export function isCloudflareReady(p: ProviderAvailability): boolean {
  return p.cloudflare.available && p.cloudflare.loggedIn;
}
