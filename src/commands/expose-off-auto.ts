/**
 * `parachute expose public off` (no `--cloudflare`) — auto-detect which
 * provider is live and tear that one down. Layer 4 of the interactive arc.
 *
 * The CLI now has two teardown paths under `expose public off`:
 *   - Tailscale Funnel — state in expose-state.json, torn down by exposeOff.
 *   - Cloudflare Tunnel — state in cloudflared-state.json, torn down by
 *     exposeCloudflareOff.
 *
 * Users shouldn't need to remember which provider they brought up last just
 * to turn it off. This wrapper reads both state files and routes:
 *
 *   - Neither live  → quiet no-op, exit 0.
 *   - Exactly one   → tear it down, print a single-line summary.
 *   - Both live     → prompt (TTY) for which to tear down, or `both`;
 *                     non-TTY tears down both (off means off).
 *
 * Since #32 the cloudflared-state.json holds a map of tunnels keyed by
 * name, so "cloudflare is live" means any tunnel record exists; tearing
 * down "cloudflare" iterates every recorded tunnel.
 *
 * `--cloudflare` still works as an explicit override and skips this module
 * entirely (see cli.ts). Shape mirrors the other Layer-N modules — every
 * side-effectful edge is an injectable seam so the full decision tree is
 * testable without touching real state files or spawning teardown.
 */

import { createInterface } from "node:readline/promises";
import {
  CLOUDFLARED_STATE_PATH,
  type CloudflaredState,
  listTunnelRecords,
  readCloudflaredState,
} from "../cloudflare/state.ts";
import { EXPOSE_STATE_PATH, type ExposeState, readExposeState } from "../expose-state.ts";
import {
  type ExposeCloudflareOpts,
  exposeCloudflareOff as defaultExposeCloudflareOff,
} from "./expose-cloudflare.ts";
import { type ExposeOpts, exposePublic as defaultExposePublic } from "./expose.ts";

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export interface ExposePublicOffAutoOpts {
  /**
   * Forwarded to the tailscale teardown (`exposePublic("off", …)`). Tests use
   * this to inject a fake runner / log sink / statePath.
   */
  tailscaleOffOpts?: ExposeOpts;
  /**
   * Forwarded to the cloudflare teardown. Tests use it the same way. The
   * wrapper sets `tunnelName` per record when iterating; callers don't need
   * to provide it.
   */
  cloudflareOffOpts?: ExposeCloudflareOpts;

  prompt?: (question: string) => Promise<string>;
  log?: (line: string) => void;
  isTty?: boolean;

  readTailscaleState?: (path?: string) => ExposeState | undefined;
  readCloudflaredState?: (path?: string) => CloudflaredState | undefined;
  exposePublicImpl?: (action: "off", opts: ExposeOpts) => Promise<number>;
  exposeCloudflareOffImpl?: (opts: ExposeCloudflareOpts) => Promise<number>;
}

interface Resolved {
  tailscaleOffOpts: ExposeOpts;
  cloudflareOffOpts: ExposeCloudflareOpts;
  prompt: (question: string) => Promise<string>;
  log: (line: string) => void;
  isTty: boolean;
  readTailscaleState: (path?: string) => ExposeState | undefined;
  readCloudflaredState: (path?: string) => CloudflaredState | undefined;
  exposePublicImpl: (action: "off", opts: ExposeOpts) => Promise<number>;
  exposeCloudflareOffImpl: (opts: ExposeCloudflareOpts) => Promise<number>;
}

function resolve(opts: ExposePublicOffAutoOpts): Resolved {
  return {
    tailscaleOffOpts: opts.tailscaleOffOpts ?? {},
    cloudflareOffOpts: opts.cloudflareOffOpts ?? {},
    prompt: opts.prompt ?? defaultPrompt,
    log: opts.log ?? ((line) => console.log(line)),
    isTty: opts.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    readTailscaleState: opts.readTailscaleState ?? readExposeState,
    readCloudflaredState: opts.readCloudflaredState ?? readCloudflaredState,
    exposePublicImpl: opts.exposePublicImpl ?? defaultExposePublic,
    exposeCloudflareOffImpl: opts.exposeCloudflareOffImpl ?? defaultExposeCloudflareOff,
  };
}

function tailscalePublicIsLive(state: ExposeState | undefined): state is ExposeState {
  return !!state && state.layer === "public" && state.funnel === true && state.entries.length > 0;
}

function cloudflareIsLive(state: CloudflaredState | undefined): state is CloudflaredState {
  return !!state && Object.keys(state.tunnels).length > 0;
}

function tailscaleUrl(state: ExposeState): string {
  return `https://${state.canonicalFqdn}`;
}

type BothChoice = "tailscale" | "cloudflare" | "both" | "cancel";

async function promptBothLive(
  r: Resolved,
  tsState: ExposeState,
  cfState: CloudflaredState,
): Promise<BothChoice> {
  const records = listTunnelRecords(cfState);
  const cfSummary =
    records.length === 1
      ? `https://${records[0]?.hostname}`
      : records.map((t) => `https://${t.hostname}`).join(", ");
  r.log("Two public exposures are currently live:");
  r.log(`  [1] Tailscale Funnel  — ${tailscaleUrl(tsState)}`);
  r.log(`  [2] Cloudflare Tunnel — ${cfSummary}`);
  r.log("  [3] both");
  r.log("  [4] cancel");
  while (true) {
    const raw = (await r.prompt("Tear down which? [3]: ")).trim().toLowerCase();
    if (raw === "" || raw === "3" || raw === "both") return "both";
    if (raw === "1" || raw === "tailscale" || raw === "ts" || raw === "funnel") return "tailscale";
    if (raw === "2" || raw === "cloudflare" || raw === "cf") return "cloudflare";
    if (raw === "4" || raw === "cancel" || raw === "q") return "cancel";
    r.log(`(didn't understand "${raw}" — please pick 1, 2, 3, or 4)`);
  }
}

async function tearDownTailscale(r: Resolved, state: ExposeState): Promise<number> {
  const url = tailscaleUrl(state);
  const code = await r.exposePublicImpl("off", r.tailscaleOffOpts);
  if (code === 0) r.log(`✓ Tore down Tailscale Funnel (was: ${url})`);
  return code;
}

async function tearDownCloudflare(r: Resolved, state: CloudflaredState): Promise<number> {
  const records = listTunnelRecords(state);
  let firstFailure = 0;
  for (const record of records) {
    const url = `https://${record.hostname}`;
    const code = await r.exposeCloudflareOffImpl({
      ...r.cloudflareOffOpts,
      tunnelName: record.tunnelName,
    });
    if (code === 0) r.log(`✓ Tore down Cloudflare Tunnel (was: ${url})`);
    if (code !== 0 && firstFailure === 0) firstFailure = code;
  }
  return firstFailure;
}

export async function runExposePublicOffAutoDetect(
  opts: ExposePublicOffAutoOpts = {},
): Promise<number> {
  const r = resolve(opts);

  const tsStatePath = r.tailscaleOffOpts.statePath ?? EXPOSE_STATE_PATH;
  const cfStatePath = r.cloudflareOffOpts.statePath ?? CLOUDFLARED_STATE_PATH;
  const tsState = r.readTailscaleState(tsStatePath);
  const cfState = r.readCloudflaredState(cfStatePath);

  const tsLive = tailscalePublicIsLive(tsState);
  const cfLive = cloudflareIsLive(cfState);

  if (!tsLive && !cfLive) {
    r.log("No public exposure active. Nothing to tear down.");
    return 0;
  }

  if (tsLive && !cfLive) {
    return await tearDownTailscale(r, tsState);
  }

  if (!tsLive && cfLive) {
    return await tearDownCloudflare(r, cfState);
  }

  // Both live. Unusual (typical flow brings one up at a time) but possible
  // when a prior bring-up raced or a teardown was skipped. Off means off, so
  // the non-TTY default is to clear both rather than refuse.
  const choice: BothChoice = r.isTty
    ? await promptBothLive(r, tsState as ExposeState, cfState as CloudflaredState)
    : "both";

  if (!r.isTty) {
    r.log("Two public exposures are live (Tailscale Funnel + Cloudflare Tunnel).");
    r.log("(non-TTY: tearing down both.)");
  }

  if (choice === "cancel") {
    r.log("Cancelled — no teardown.");
    return 0;
  }

  if (choice === "tailscale") {
    return await tearDownTailscale(r, tsState as ExposeState);
  }
  if (choice === "cloudflare") {
    return await tearDownCloudflare(r, cfState as CloudflaredState);
  }

  // both
  const tsCode = await tearDownTailscale(r, tsState as ExposeState);
  const cfCode = await tearDownCloudflare(r, cfState as CloudflaredState);
  return tsCode !== 0 ? tsCode : cfCode;
}
