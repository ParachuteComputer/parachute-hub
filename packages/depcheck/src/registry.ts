/**
 * The dependency registry — the single source of truth for "what external
 * binary does an operation need, why, and how does an operator install it?"
 *
 * Every Parachute module that shells out to a CLI tool (`git`, `tailscale`,
 * `cloudflared`, transcription providers, …) used to carry its own ad-hoc
 * "install git via …" string near the spawn site. Those strings drifted —
 * vault's `git-preflight.ts` and hub's `cloudflare/detect.ts` had divergent
 * copies of both the install recipe AND the ENOENT matcher. This registry
 * + the formatter in `format.ts` are the one place each binary's metadata
 * lives; per-repo code looks it up at the spawn site.
 *
 * A `DepSpec` is intentionally data, not behavior. The formatter
 * (`formatMissingDependency`) turns it into the operator-facing block; the
 * helpers (`ensureExecutable` / `isBinaryNotFoundError` / `rethrowIfMissing`)
 * turn a spawn failure into a `MissingDependencyError` carrying the spec.
 */

/**
 * Static-binary install recipe selector. Some tools (cloudflared, tailscale)
 * are best installed from a pinned static binary keyed by CPU architecture
 * rather than a distro package (distro packages churn / 404 across versions —
 * see the cloudflared comment in hub's `cloudflare/detect.ts`). Returns a
 * curl recipe string for the given arch, or `undefined` for arches without a
 * published artifact (the formatter then drops to the docs URL rather than
 * fabricating a download URL that 404s).
 */
export type LinuxBinaryUrl = (arch: NodeJS.Architecture) => string | undefined;

export interface DepSpec {
  /** PATH name, e.g. "git". */
  readonly binary: string;
  /** Lower-case verb phrase completing "<binary> is required to <why>". */
  readonly why: string;
  /** Docs URL — always shown in the formatted block. */
  readonly docsUrl: string;
  readonly install: {
    /** macOS recipe, e.g. "brew install git". */
    readonly darwin?: string;
    /** Debian/Ubuntu apt recipe, e.g. "sudo apt-get install -y git". */
    readonly linuxApt?: string;
    /** Fedora/Amazon-Linux dnf recipe, e.g. "sudo dnf install git". */
    readonly linuxDnf?: string;
    /**
     * Static-binary curl recipe keyed by arch. When set and it returns a
     * recipe for the detected arch, it WINS over the apt/dnf distro lines on
     * Linux — distro packages for these tools are unreliable across versions.
     */
    readonly linuxBinaryUrl?: LinuxBinaryUrl;
    /**
     * Cross-platform fallback (pip / uv / curl-installer). Shown when no
     * platform-specific recipe applies — e.g. provider tooling installed via
     * pip on every OS, or a one-liner curl installer.
     */
    readonly generic?: string;
  };
  /**
   * Provider-style optional dependency. When true the formatter uses
   * `altHint` instead of the "ask your system administrator" trailer — the
   * fix is "switch provider", not "install a foundational tool" — and the
   * caller's contract is to degrade the specific service, not the whole
   * request.
   */
  readonly optional?: boolean;
  /**
   * Replaces the "or ask your system administrator to install it for you."
   * trailer when `optional` is set. e.g. "or switch transcription provider".
   */
  readonly altHint?: string;
}

/**
 * Map a Node `process.arch` to the suffix Cloudflare uses for its
 * `cloudflared-linux-*` release artifacts. Lifted verbatim from hub's
 * `src/cloudflare/detect.ts` `linuxArtifactSuffix` so the two can't drift —
 * that file now consumes this registry instead of carrying its own copy.
 * Returns undefined for arches with no published artifact.
 */
function cloudflaredLinuxSuffix(arch: NodeJS.Architecture): string | undefined {
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

const CLOUDFLARED_RELEASE_BASE =
  "https://github.com/cloudflare/cloudflared/releases/latest/download";

/**
 * The seeded registry. Keyed by PATH binary name. Entries verified against
 * the spawn-site audit across vault / scribe / runner / hub.
 *
 * Frozen so a consumer can't mutate a shared spec at runtime.
 */
export const DEPENDENCY_REGISTRY: Readonly<Record<string, DepSpec>> = Object.freeze({
  git: {
    binary: "git",
    why: "mirror your vault to a git remote",
    docsUrl: "https://git-scm.com/downloads",
    install: {
      darwin: "brew install git",
      linuxApt: "sudo apt-get install -y git",
      linuxDnf: "sudo dnf install git",
    },
  },
  tailscale: {
    binary: "tailscale",
    why: "expose your hub over a tailnet",
    docsUrl: "https://tailscale.com/download",
    install: {
      darwin: "brew install tailscale",
      linuxBinaryUrl: () => "curl -fsSL https://tailscale.com/install.sh | sh",
      generic: "curl -fsSL https://tailscale.com/install.sh | sh",
    },
  },
  cloudflared: {
    binary: "cloudflared",
    why: "expose your hub publicly via a Cloudflare tunnel",
    docsUrl: "https://github.com/cloudflare/cloudflared/releases/latest",
    install: {
      darwin: "brew install cloudflared",
      // Static binary from GitHub releases — distro packages are unreliable
      // across versions (Aaron hit `dnf install cloudflared` → 'No match' on
      // Amazon Linux 2023). The arch mapping is lifted from the old
      // `cloudflaredInstallHint`. Multi-line recipe matches what detect.ts
      // emitted: download → chmod +x → version check.
      linuxBinaryUrl: (arch) => {
        const suffix = cloudflaredLinuxSuffix(arch);
        if (!suffix) return undefined;
        return [
          "curl -L -o /usr/local/bin/cloudflared \\",
          `  ${CLOUDFLARED_RELEASE_BASE}/cloudflared-linux-${suffix}`,
          "sudo chmod +x /usr/local/bin/cloudflared",
          "cloudflared --version",
        ].join("\n");
      },
    },
  },
  bun: {
    binary: "bun",
    why: "run Parachute modules",
    docsUrl: "https://bun.sh",
    install: {
      generic: "curl -fsSL https://bun.sh/install | bash",
    },
  },
  claude: {
    binary: "claude",
    why: "clean up transcripts / run vault jobs via the Claude CLI",
    docsUrl: "https://claude.com/claude-code",
    install: {
      generic: "npm i -g @anthropic-ai/claude-code",
    },
    optional: true,
    altHint: "or switch cleanup/job provider",
  },
  ffmpeg: {
    binary: "ffmpeg",
    why: "convert non-WAV audio before transcription",
    docsUrl: "https://ffmpeg.org/download.html",
    install: {
      darwin: "brew install ffmpeg",
      linuxApt: "sudo apt-get install -y ffmpeg",
      linuxDnf: "sudo dnf install ffmpeg",
    },
  },
  tar: {
    binary: "tar",
    why: "compress your vault backups",
    docsUrl: "https://www.gnu.org/software/tar/",
    install: {},
  },
  tail: {
    binary: "tail",
    why: "stream service log files",
    docsUrl: "https://www.gnu.org/software/coreutils/",
    install: {},
  },
  systemctl: {
    binary: "systemctl",
    why: "manage the background service on Linux (systemd)",
    docsUrl: "https://www.freedesktop.org/software/systemd/man/systemctl.html",
    install: {},
  },
  launchctl: {
    binary: "launchctl",
    why: "manage the background service on macOS",
    docsUrl: "https://ss64.com/mac/launchctl.html",
    install: {},
  },
  "parakeet-mlx": {
    binary: "parakeet-mlx",
    why: "transcribe audio with the parakeet-mlx provider",
    docsUrl: "https://github.com/senstella/parakeet-mlx",
    install: {
      generic: "uv tool install parakeet-mlx",
    },
    optional: true,
    altHint: "or switch transcription provider",
  },
  "whisper-ctranslate2": {
    binary: "whisper-ctranslate2",
    why: "transcribe with the whisper provider",
    docsUrl: "https://github.com/Softcatala/whisper-ctranslate2",
    install: {
      generic: "pip install whisper-ctranslate2",
    },
    optional: true,
    altHint: "or switch transcription provider",
  },
  "onnx-asr": {
    binary: "onnx-asr",
    why: "transcribe with the onnx-asr provider",
    docsUrl: "https://github.com/istupakov/onnx-asr",
    install: {
      generic: "pip install onnx-asr",
    },
    optional: true,
    altHint: "or switch transcription provider",
  },
  "parachute-vault": {
    binary: "parachute-vault",
    why: "run the Vault module Hub supervises",
    docsUrl: "https://parachute.computer",
    install: {
      generic: "parachute install vault",
    },
  },
});

/**
 * Look up a `DepSpec` by binary name. Returns `undefined` for an unregistered
 * binary — callers MUST treat that as "fail loud with a generic message",
 * never fabricate an install command. The formatter does exactly this when
 * handed an `undefined` spec.
 */
export function lookupDep(binary: string): DepSpec | undefined {
  return DEPENDENCY_REGISTRY[binary];
}
