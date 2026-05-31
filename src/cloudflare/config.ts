import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "../config.ts";

/**
 * The legacy shared tunnel name. Pre-#491, every machine defaulted its
 * Cloudflare tunnel to this single constant — but Cloudflare tunnels are
 * account-wide, so a second machine exposing a *different* hostname found and
 * reused the SAME tunnel, both connectors registered on one UUID, and the edge
 * load-balanced requests across them → a request for host B could land on host
 * A's connector (whose config.yml only routes host A) → ~50% cross-host 404s.
 *
 * The default is now a per-hostname derived name (`deriveTunnelName`). This
 * constant's role narrows to "the legacy shared name we migrate away from":
 *   - the up-path legacy-sweep kills a stale `"parachute"` connector on the box
 *     so running deploys self-heal on the next expose, and
 *   - the off-path reuse-hint compares against it (records no longer equal it,
 *     so the hint always includes `--tunnel-name`, which is now correct).
 */
export const DEFAULT_TUNNEL_NAME = "parachute";

/**
 * Derive a dedicated, per-hostname tunnel name from a hostname. Cloudflare
 * tunnels are account-wide, so each machine/hostname needs its OWN tunnel —
 * sharing one name across boxes collides their connectors (#491). The name is
 * deterministic (same hostname → same name) so re-exposing the same hostname
 * is idempotent: it finds and reuses the tunnel it created last time.
 *
 * Sanitization: lowercase, dots → hyphens, drop anything outside `[a-z0-9_-]`,
 * then prefix `parachute-`. Examples:
 *   `our.parachute.computer` → `parachute-our-parachute-computer`
 *   `vault.example.com`      → `parachute-vault-example-com`
 *
 * Length: tunnel names must satisfy `isValidTunnelName` (≤64 chars). When the
 * derived name would exceed 64, truncate the sanitized body and append a short
 * stable suffix (`-<8-hex>`) computed deterministically from the FULL hostname
 * so two long hostnames sharing a 64-char prefix can't collide on the same
 * tunnel. The hash is a non-crypto FNV-1a-style fold — deterministic, no
 * Math.random / Date dependency (those would break idempotent re-expose).
 */
const TUNNEL_NAME_PREFIX = "parachute-";
const MAX_TUNNEL_NAME = 64;

function shortStableHash(input: string): string {
  // FNV-1a 32-bit. Deterministic, dependency-free, good enough to disambiguate
  // two hostnames that sanitize to the same truncated prefix. >>> 0 keeps it
  // unsigned so the hex is stable across runtimes.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function deriveTunnelName(hostname: string): string {
  const body = hostname
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/[^a-z0-9_-]/g, "");
  const full = `${TUNNEL_NAME_PREFIX}${body}`;
  if (full.length <= MAX_TUNNEL_NAME) return full;
  // Too long — truncate the body and append a stable 8-hex suffix derived from
  // the full hostname. Reserve room for the prefix + "-" + 8 hex chars.
  const suffix = `-${shortStableHash(hostname)}`;
  const room = MAX_TUNNEL_NAME - TUNNEL_NAME_PREFIX.length - suffix.length;
  // Strip any trailing hyphen the truncation left behind (e.g. a slice that
  // lands on a dot-turned-hyphen) so the body doesn't abut the suffix as `--`.
  const truncated = body.slice(0, room).replace(/-+$/, "");
  return `${TUNNEL_NAME_PREFIX}${truncated}${suffix}`;
}

/**
 * Per-tunnel config + log file paths. Each tunnel gets its own subdirectory
 * under `~/.parachute/cloudflared/<tunnelName>/` so multiple tunnels on one
 * box don't trample each other's config.yml or interleave log lines.
 *
 * The per-hostname tunnel (`deriveTunnelName(host)`, e.g.
 * `parachute-our-parachute-computer`) lives at
 * `~/.parachute/cloudflared/<tunnelName>/{config.yml,cloudflared.log}`.
 * Re-running `parachute expose public --cloudflare` regenerates the file
 * at that path; any legacy `parachute/` file is left in place but unused.
 *
 * `configDir` overrides the base (`~/.parachute` by default). Tests pass a
 * tmp dir so per-tunnel-derived paths never resolve against the operator's
 * real `CONFIG_DIR` — otherwise running the suite scribbles fixture
 * config.yml + log files into `~/.parachute/cloudflared/<name>/`.
 */
export function cloudflaredPathsFor(
  tunnelName: string,
  configDir: string = CONFIG_DIR,
): {
  configPath: string;
  logPath: string;
} {
  const dir = join(configDir, "cloudflared", tunnelName);
  return {
    configPath: join(dir, "config.yml"),
    logPath: join(dir, "cloudflared.log"),
  };
}

export interface TunnelConfigOpts {
  tunnelUuid: string;
  /** Absolute path to the per-tunnel credentials JSON (`~/.cloudflared/<uuid>.json`). */
  credentialsFile: string;
  hostname: string;
  /** Loopback port the tunnel forwards traffic to (vault = 1940). */
  servicePort: number;
}

/**
 * Emit a cloudflared config.yml. The shape is pinned to the documented
 * Named Tunnel + ingress rules schema; we route every request for the
 * configured hostname to the local service port and 404 everything else.
 *
 * Single-hostname ingress today. Multi-service routing (hub at /, vault
 * under /vault/…, etc.) is deferred — the hub/OAuth seam lives on the
 * Tailscale Funnel path and wasn't worth duplicating into the Cloudflare
 * shape before we have a second CF user pushing on it.
 */
/**
 * Double-quote `credentials-file` so a `$HOME` with a space (e.g. macOS
 * "John Doe") doesn't break YAML parsing. Tunnel UUIDs and `http://localhost`
 * URLs don't need quoting by the YAML spec, so only this one path gets it.
 * Backslashes and double-quotes inside the path are escaped.
 */
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderConfig(opts: TunnelConfigOpts): string {
  return `# Generated by parachute expose public --cloudflare — do not edit by hand.
# Re-running the command regenerates this file.
tunnel: ${opts.tunnelUuid}
credentials-file: ${yamlQuote(opts.credentialsFile)}

ingress:
  - hostname: ${opts.hostname}
    service: http://localhost:${opts.servicePort}
  - service: http_status:404
`;
}

export function writeConfig(opts: TunnelConfigOpts, configPath: string): string {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, renderConfig(opts));
  return configPath;
}
