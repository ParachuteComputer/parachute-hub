/**
 * `parachute expose public` (no provider flag, non-TTY) — auto-pick logic.
 *
 * The interactive picker (`expose-interactive.ts`) covers the TTY case end to
 * end. Scripts and CI hit a different shape: they can't answer prompts, but
 * they still benefit from "use what's set up rather than always defaulting to
 * Tailscale and failing if Tailscale isn't logged in."
 *
 * Decision tree, deterministic:
 *
 *   - Both providers ready → ambiguous, can't prompt; fail with a hint at
 *     `--tailnet` / `--cloudflare`. Better to refuse than silently bias.
 *   - Exactly one ready → use it.
 *       - Tailnet:    proceed to `exposePublic("up", …)`.
 *       - Cloudflare: needs `--domain`; if missing, fail with the same
 *                     usage hint the explicit `--cloudflare` path emits.
 *   - Neither ready → fail with install pointers for both. The user almost
 *     certainly meant "spin up the public layer" and we can't, so this is the
 *     loud surface — not a silent default.
 *
 * The `--skip-provider-check` escape hatch bypasses everything and runs
 * today's Tailscale Funnel path. CI that's already prepared its environment
 * (or doesn't care about Cloudflare) can pin to the legacy behavior with a
 * single flag.
 *
 * Shape mirrors the other expose modules — every side-effectful edge is an
 * injectable seam so the decision tree is testable without spawning real
 * tailscale/cloudflared.
 */

import { DEFAULT_CLOUDFLARED_HOME } from "../cloudflare/detect.ts";
import {
  type ProviderAvailability,
  type DetectProvidersOpts,
  detectProviders,
  isCloudflareReady,
  isTailnetReady,
} from "../providers/detect.ts";
import {
  type ExposeCloudflareOpts,
  exposeCloudflareUp as defaultExposeCloudflareUp,
} from "./expose-cloudflare.ts";
import { type ExposeOpts, exposePublic as defaultExposePublic } from "./expose.ts";

export interface ExposePublicAutoOpts {
  /** Hostname for the Cloudflare path. Required when Cloudflare ends up picked. */
  domain?: string;
  /** Tunnel name override for the Cloudflare path (#32). */
  tunnelName?: string;
  /** Forwarded to the Tailscale Funnel handoff. */
  tailscaleOpts?: ExposeOpts;
  /** Forwarded to the Cloudflare handoff. */
  cloudflareOpts?: ExposeCloudflareOpts;
  /** Override `~/.cloudflared` (parity with the interactive picker's seam). */
  cloudflaredHome?: string;
  log?: (line: string) => void;

  /** Test seams. */
  detectProvidersImpl?: (opts: DetectProvidersOpts) => Promise<ProviderAvailability>;
  exposePublicImpl?: (action: "up", opts: ExposeOpts) => Promise<number>;
  exposeCloudflareUpImpl?: (hostname: string, opts: ExposeCloudflareOpts) => Promise<number>;
}

interface Resolved {
  domain: string | undefined;
  tunnelName: string | undefined;
  tailscaleOpts: ExposeOpts;
  cloudflareOpts: ExposeCloudflareOpts;
  cloudflaredHome: string;
  log: (line: string) => void;
  detectProvidersImpl: (opts: DetectProvidersOpts) => Promise<ProviderAvailability>;
  exposePublicImpl: (action: "up", opts: ExposeOpts) => Promise<number>;
  exposeCloudflareUpImpl: (hostname: string, opts: ExposeCloudflareOpts) => Promise<number>;
}

function resolve(opts: ExposePublicAutoOpts): Resolved {
  return {
    domain: opts.domain,
    tunnelName: opts.tunnelName,
    tailscaleOpts: opts.tailscaleOpts ?? {},
    cloudflareOpts: opts.cloudflareOpts ?? {},
    cloudflaredHome: opts.cloudflaredHome ?? DEFAULT_CLOUDFLARED_HOME,
    log: opts.log ?? ((line) => console.log(line)),
    detectProvidersImpl: opts.detectProvidersImpl ?? detectProviders,
    exposePublicImpl: opts.exposePublicImpl ?? ((a, o) => defaultExposePublic(a, o)),
    exposeCloudflareUpImpl: opts.exposeCloudflareUpImpl ?? defaultExposeCloudflareUp,
  };
}

function reportNeitherReady(r: Resolved, p: ProviderAvailability): number {
  r.log("parachute expose public: no exposure provider is set up on this machine.");
  r.log("");
  r.log("Pick one and finish setting it up, then re-run.");
  r.log("");
  r.log("  Option A — Tailscale Funnel (free, *.ts.net URL, no domain needed):");
  if (!p.tailnet.available) {
    r.log("    1. Install:           https://tailscale.com/download");
    r.log("    2. Log in:            tailscale up");
    r.log("    3. Enable Funnel:     https://login.tailscale.com/admin/acls");
  } else if (!p.tailnet.loggedIn) {
    r.log("    1. ✓ tailscale installed");
    r.log("    2. Log in:            tailscale up");
    r.log("    3. Enable Funnel:     https://login.tailscale.com/admin/acls");
  } else {
    r.log("    1. ✓ tailscale installed");
    r.log("    2. ✓ logged in");
    r.log("    3. Enable Funnel:     https://login.tailscale.com/admin/acls");
  }
  r.log("");
  r.log("  Option B — Cloudflare Tunnel (your own domain, Cloudflare DNS):");
  if (!p.cloudflare.available) {
    r.log(
      "    1. Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    );
    r.log("    2. Log in:              cloudflared tunnel login");
    r.log("    3. Re-run with --domain: parachute expose public --cloudflare --domain <hostname>");
  } else {
    r.log("    1. ✓ cloudflared installed");
    r.log("    2. Log in:              cloudflared tunnel login");
    r.log("    3. Re-run with --domain: parachute expose public --cloudflare --domain <hostname>");
  }
  r.log("");
  r.log("To bypass this check (e.g., CI scripts pinning to today's Tailscale default):");
  r.log("  parachute expose public --skip-provider-check");
  return 1;
}

function reportBothReadyAmbiguous(r: Resolved): number {
  r.log("parachute expose public: both Tailscale Funnel and Cloudflare Tunnel are configured.");
  r.log("");
  r.log("Without a TTY there's no way to ask which one — pick explicitly:");
  r.log("  parachute expose public --tailnet");
  r.log("  parachute expose public --cloudflare --domain <hostname>");
  r.log("");
  r.log("Or pin to today's Tailscale-Funnel default with --skip-provider-check.");
  return 1;
}

function reportCloudflareNeedsDomain(r: Resolved): number {
  r.log("parachute expose public: Cloudflare Tunnel is the only configured provider,");
  r.log("but `--domain <hostname>` is required to route DNS through it.");
  r.log("");
  r.log("Re-run with the hostname:");
  r.log("  parachute expose public --cloudflare --domain vault.example.com");
  r.log("");
  r.log(
    "The hostname's apex domain must already be a zone on your Cloudflare account.",
  );
  return 1;
}

/**
 * Auto-pick entry point — call from `cli.ts` only when neither provider flag
 * (`--tailnet` / `--cloudflare`) was supplied AND we're not in a TTY (the TTY
 * path runs `expose-interactive.ts` instead).
 */
export async function exposePublicAutoPick(
  opts: ExposePublicAutoOpts = {},
): Promise<number> {
  const r = resolve(opts);
  const availability = await r.detectProvidersImpl({ cloudflaredHome: r.cloudflaredHome });
  const tsReady = isTailnetReady(availability);
  const cfReady = isCloudflareReady(availability);

  if (tsReady && cfReady) return reportBothReadyAmbiguous(r);
  if (!tsReady && !cfReady) return reportNeitherReady(r, availability);

  if (tsReady) {
    r.log("Auto-detected Tailscale Funnel as the only configured provider.");
    return r.exposePublicImpl("up", r.tailscaleOpts);
  }

  // cfReady
  if (!r.domain) return reportCloudflareNeedsDomain(r);
  r.log("Auto-detected Cloudflare Tunnel as the only configured provider.");
  const cfOpts: ExposeCloudflareOpts = { ...r.cloudflareOpts };
  if (r.tunnelName !== undefined) cfOpts.tunnelName = r.tunnelName;
  return r.exposeCloudflareUpImpl(r.domain, cfOpts);
}
