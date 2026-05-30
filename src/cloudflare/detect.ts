import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isBinaryNotFoundError, lookupDep } from "@openparachute/depcheck";
import type { Runner } from "../tailscale/run.ts";

export const DEFAULT_CLOUDFLARED_HOME = join(homedir(), ".cloudflared");

/**
 * `cloudflared --version` is the canonical liveness probe. Swallow only
 * "binary not on PATH" errors — anything else (EACCES from a non-executable
 * file, corrupted binary, etc.) propagates so we don't silently report
 * "not installed" when something more specific is wrong.
 *
 * The not-found matcher is `@openparachute/depcheck`'s `isBinaryNotFoundError`
 * — the single source of truth across the ecosystem (this used to be a local
 * copy that drifted from vault's `git-preflight.ts`). Pass the binary name so
 * a not-found message about an unrelated file isn't mis-attributed.
 */
export async function isCloudflaredInstalled(runner: Runner): Promise<boolean> {
  try {
    const { code } = await runner(["cloudflared", "--version"]);
    return code === 0;
  } catch (err) {
    if (isBinaryNotFoundError(err, "cloudflared")) return false;
    throw err;
  }
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
 * shape (`x64`, `arm64`, `arm`). The static-binary curl recipe + the arch
 * mapping now live in `@openparachute/depcheck`'s `cloudflared` registry
 * entry (`install.linuxBinaryUrl`) — the single source of truth shared with
 * the structured `MissingDependencyError` UX. This function keeps its own
 * prose (the surrounding "works across distros" framing the expose flow
 * prints) but derives the URL + arch support from the registry so the two
 * can't drift. A `undefined` recipe (arch with no published artifact) is the
 * signal to fall through to the generic releases pointer rather than
 * fabricating a 404-bound URL.
 */
export function cloudflaredInstallHint(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const releasesUrl = "https://github.com/cloudflare/cloudflared/releases/latest";
  if (platform === "darwin") {
    return [
      "Install cloudflared:",
      "  brew install cloudflared",
      "",
      "(or download a static binary from",
      `  ${releasesUrl})`,
    ].join("\n");
  }
  if (platform === "linux") {
    const downloadUrl = cloudflaredLinuxDownloadUrl(arch);
    if (downloadUrl) {
      return [
        "Install cloudflared (static binary — works across distros):",
        "  curl -L -o /usr/local/bin/cloudflared \\",
        `    ${downloadUrl}`,
        "  sudo chmod +x /usr/local/bin/cloudflared",
        "  cloudflared --version",
        "",
        "(distro packages are unreliable across versions; the GitHub release is the canonical path.)",
      ].join("\n");
    }
    return [
      "Install cloudflared from the official binary release:",
      `  ${releasesUrl}`,
      `(pick the linux-* artifact matching your architecture; your arch is "${arch}")`,
    ].join("\n");
  }
  return ["Install cloudflared from the official binary release:", `  ${releasesUrl}`].join("\n");
}

/**
 * Pull the cloudflared-linux-<suffix> download URL for an arch out of the
 * depcheck registry's static-binary recipe. The registry recipe is a
 * multi-line `curl … / chmod … / version` block; we extract the single
 * `https://…/cloudflared-linux-<suffix>` line so this function's own prose
 * wraps the canonical URL. Returns undefined when the arch has no published
 * artifact (registry recipe is undefined) — the caller then uses the generic
 * pointer. Keeps the arch→suffix mapping in exactly one place (the registry).
 */
function cloudflaredLinuxDownloadUrl(arch: NodeJS.Architecture): string | undefined {
  const recipe = lookupDep("cloudflared")?.install.linuxBinaryUrl?.(arch);
  if (!recipe) return undefined;
  const urlLine = recipe
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("https://"));
  return urlLine;
}
