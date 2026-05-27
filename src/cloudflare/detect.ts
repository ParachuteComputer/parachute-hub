import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../tailscale/run.ts";

export const DEFAULT_CLOUDFLARED_HOME = join(homedir(), ".cloudflared");

/**
 * `cloudflared --version` is the canonical liveness probe. Swallow only
 * "binary not on PATH" errors — anything else (EACCES from a non-executable
 * file, corrupted binary, etc.) propagates so we don't silently report
 * "not installed" when something more specific is wrong.
 */
export async function isCloudflaredInstalled(runner: Runner): Promise<boolean> {
  try {
    const { code } = await runner(["cloudflared", "--version"]);
    return code === 0;
  } catch (err) {
    if (isBinaryNotFoundError(err)) return false;
    throw err;
  }
}

function isBinaryNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "ENOENT") return true;
  // Bun.spawn's error shape varies across versions; fall back to message
  // string matching so we catch "Executable not found in $PATH" and
  // "ENOENT" variants without pinning to one runtime detail.
  if (typeof e.message === "string") {
    return /ENOENT|not found|No such file/i.test(e.message);
  }
  return false;
}

/**
 * `cloudflared tunnel login` drops a cert at `~/.cloudflared/cert.pem` — its
 * presence is cloudflared's own login marker. Every `cloudflared tunnel
 * create|list|route` call reads this file; without it those commands fail
 * with "Cannot determine default origin certificate path", which is a worse
 * surface than catching the missing cert up front.
 */
export function isCloudflaredLoggedIn(cloudflaredHome: string = DEFAULT_CLOUDFLARED_HOME): boolean {
  return existsSync(join(cloudflaredHome, "cert.pem"));
}

/**
 * Cloudflare's "Downloads" page (developers.cloudflare.com/cloudflare-one/
 * connections/connect-networks/downloads/) churns markdown anchors; pkg.cloudflare.com
 * paths the older instructions referenced now serve HTML / 404. Aaron hit
 * the failure mode on a fresh Amazon Linux 2023 EC2 install (2026-05-27):
 * `sudo dnf install cloudflared` returned 'No match for argument:
 * cloudflared'. The reliable cross-distro path is grabbing the static
 * binary from Cloudflare's GitHub releases.
 *
 * Canonical install paths:
 *
 *   macOS  → `brew install cloudflared` (homebrew is the documented path)
 *   Linux  → architecture-specific binary from GitHub releases
 *   other  → the binary-download path is still the best generic answer
 *
 * The `arch` parameter is the architecture string in `process.arch`
 * shape (`x64`, `arm64`, `arm`). Mapped to the suffix cloudflared uses
 * in its release artifacts (`amd64`, `arm64`, `arm`). Unknown arches
 * fall through to a generic pointer at the releases page.
 */
export function cloudflaredInstallHint(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  if (platform === "darwin") {
    return [
      "Install cloudflared:",
      "  brew install cloudflared",
      "",
      "(or download a static binary from",
      "  https://github.com/cloudflare/cloudflared/releases/latest)",
    ].join("\n");
  }
  if (platform === "linux") {
    const suffix = linuxArtifactSuffix(arch);
    if (suffix) {
      return [
        "Install cloudflared (static binary — works across distros):",
        `  curl -L -o /usr/local/bin/cloudflared \\`,
        `    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${suffix}`,
        "  sudo chmod +x /usr/local/bin/cloudflared",
        "  cloudflared --version",
        "",
        "(distro packages are unreliable across versions; the GitHub release is the canonical path.)",
      ].join("\n");
    }
    return [
      "Install cloudflared from the official binary release:",
      "  https://github.com/cloudflare/cloudflared/releases/latest",
      `(pick the linux-* artifact matching your architecture; your arch is "${arch}")`,
    ].join("\n");
  }
  return [
    "Install cloudflared from the official binary release:",
    "  https://github.com/cloudflare/cloudflared/releases/latest",
  ].join("\n");
}

/**
 * Map a Node `process.arch` to the suffix Cloudflare uses for its
 * cloudflared-linux-* release artifacts. Returns undefined for arches
 * that don't have a published artifact (we surface a generic pointer
 * in that case instead of fabricating a download URL that 404s).
 */
function linuxArtifactSuffix(arch: NodeJS.Architecture): string | undefined {
  switch (arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    case "arm":
      return "arm";
    case "ia32":
      return "386";
    default:
      return undefined;
  }
}
