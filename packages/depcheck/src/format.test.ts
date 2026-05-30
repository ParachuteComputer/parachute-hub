import { describe, expect, test } from "bun:test";
import {
  type FormatOpts,
  formatMissingDependency,
  resolveInstallCommands,
  toMissingDependencyWire,
} from "./format.ts";
import { DEPENDENCY_REGISTRY, lookupDep } from "./registry.ts";

const git = DEPENDENCY_REGISTRY.git;
const cloudflared = DEPENDENCY_REGISTRY.cloudflared;
const tailscale = DEPENDENCY_REGISTRY.tailscale;
const claude = DEPENDENCY_REGISTRY.claude;
const tar = DEPENDENCY_REGISTRY.tar;
const bun = DEPENDENCY_REGISTRY.bun;

const darwin: FormatOpts = { platform: "darwin", arch: "arm64" };
const linuxX64: FormatOpts = { platform: "linux", arch: "x64" };
const linuxArm: FormatOpts = { platform: "linux", arch: "arm64" };
const win32: FormatOpts = { platform: "win32", arch: "x64" };

describe("resolveInstallCommands", () => {
  test("darwin → brew recipe only", () => {
    expect(resolveInstallCommands(git, darwin)).toEqual(["brew install git"]);
  });

  test("linux → apt + dnf when no static binary", () => {
    expect(resolveInstallCommands(git, linuxX64)).toEqual([
      "sudo apt-get install -y git",
      "sudo dnf install git",
    ]);
  });

  test("linux static-binary recipe WINS over distro packages", () => {
    const cmds = resolveInstallCommands(cloudflared, linuxX64);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("cloudflared-linux-amd64");
    // never lists apt/dnf for cloudflared (it has none anyway, but the
    // static binary must be the sole linux recipe)
    expect(cmds[0]).not.toContain("apt-get");
  });

  test("linux static-binary arch mapping: arm64 → arm64 suffix", () => {
    const cmds = resolveInstallCommands(cloudflared, linuxArm);
    expect(cmds[0]).toContain("cloudflared-linux-arm64");
  });

  test("linux unknown arch drops static binary → docs (no fabricated URL)", () => {
    // mips64 has no published cloudflared artifact → linuxBinaryUrl returns
    // undefined → no distro fallback for cloudflared → empty install list
    const cmds = resolveInstallCommands(cloudflared, {
      platform: "linux",
      arch: "mips64el" as NodeJS.Architecture,
    });
    expect(cmds).toEqual([]);
  });

  test("tailscale linux uses the curl install.sh recipe", () => {
    const cmds = resolveInstallCommands(tailscale, linuxX64);
    expect(cmds).toEqual(["curl -fsSL https://tailscale.com/install.sh | sh"]);
  });

  test("win32 / unknown platform lists ALL families", () => {
    const cmds = resolveInstallCommands(git, win32);
    expect(cmds).toContain("brew install git");
    expect(cmds).toContain("sudo apt-get install -y git");
    expect(cmds).toContain("sudo dnf install git");
  });

  test("generic-only spec (bun) on darwin falls back to generic", () => {
    expect(resolveInstallCommands(bun, darwin)).toEqual([
      "curl -fsSL https://bun.sh/install | bash",
    ]);
  });

  test("foundational spec with no recipes (tar) → empty list", () => {
    expect(resolveInstallCommands(tar, darwin)).toEqual([]);
    expect(resolveInstallCommands(tar, linuxX64)).toEqual([]);
    expect(resolveInstallCommands(tar, win32)).toEqual([]);
  });
});

describe("formatMissingDependency — message anatomy", () => {
  test("line 1 names binary + why + not-found-on-PATH", () => {
    const msg = formatMissingDependency("git", git, darwin);
    expect(msg.split("\n")[0]).toBe(
      "git is required to mirror your vault to a git remote, but it was not found on PATH.",
    );
  });

  test("includes an install block and the docs line", () => {
    const msg = formatMissingDependency("git", git, darwin);
    expect(msg).toContain("Install it (macOS):");
    expect(msg).toContain("brew install git");
    expect(msg).toContain("Docs: https://git-scm.com/downloads");
  });

  test("interactive: true includes the sysadmin trailer for foundational deps", () => {
    const msg = formatMissingDependency("git", git, { ...darwin, interactive: true });
    expect(msg).toContain("Or ask your system administrator to install it for you.");
  });

  test("interactive: false strips the sysadmin trailer", () => {
    const msg = formatMissingDependency("git", git, { ...darwin, interactive: false });
    expect(msg).not.toContain("system administrator");
    // still carries the actionable parts
    expect(msg).toContain("brew install git");
    expect(msg).toContain("Docs:");
  });

  test("optional dep shows altHint instead of the sysadmin trailer", () => {
    const msg = formatMissingDependency("claude", claude, { ...darwin, interactive: true });
    expect(msg).toContain("or switch cleanup/job provider");
    expect(msg).not.toContain("system administrator");
  });

  test("optional dep in non-interactive mode drops the altHint trailer too", () => {
    const msg = formatMissingDependency("claude", claude, { ...darwin, interactive: false });
    expect(msg).not.toContain("or switch cleanup/job provider");
    expect(msg).not.toContain("system administrator");
  });

  test("linux static-binary recipe is indented under the install block", () => {
    const msg = formatMissingDependency("cloudflared", cloudflared, linuxX64);
    expect(msg).toContain("Install it (Linux):");
    expect(msg).toContain("  curl -L -o /usr/local/bin/cloudflared");
    expect(msg).toContain("  sudo chmod +x /usr/local/bin/cloudflared");
  });

  test("win32 (unknown) lists all families + still has docs", () => {
    const msg = formatMissingDependency("git", git, win32);
    expect(msg).toContain("Install it:");
    expect(msg).toContain("brew install git");
    expect(msg).toContain("sudo apt-get install -y git");
    expect(msg).toContain("Docs:");
  });

  test("foundational dep with no recipe still shows docs + sysadmin", () => {
    const msg = formatMissingDependency("tar", tar, linuxX64);
    expect(msg).toContain("tar is required to compress your vault backups");
    expect(msg).not.toContain("Install it");
    expect(msg).toContain("Docs: https://www.gnu.org/software/tar/");
    expect(msg).toContain("Or ask your system administrator");
  });

  test("unregistered binary → generic message, no fabricated install command", () => {
    const msg = formatMissingDependency("frobnicate", undefined, darwin);
    expect(msg).toBe(
      "frobnicate is required but was not found on PATH. Ask your system administrator, or check the Parachute docs.",
    );
    expect(msg).not.toContain("brew");
    expect(msg).not.toContain("apt-get");
    expect(msg).not.toContain("Install it");
  });

  test("ANSI is stripped in non-interactive mode", () => {
    // Inject a spec carrying ANSI so we exercise the stripper deterministically.
    const ansiSpec = {
      binary: "x",
      why: "[1mtest[0m bold",
      docsUrl: "https://example.com",
      install: { generic: "[32minstall-x[0m" },
    };
    const msg = formatMissingDependency("x", ansiSpec, { platform: "linux", interactive: false });
    expect(msg).not.toContain("[");
    expect(msg).toContain("install-x");
  });
});

describe("toMissingDependencyWire", () => {
  test("shape + that error_description has no sysadmin trailer", () => {
    const wire = toMissingDependencyWire("git", git, linuxX64);
    expect(wire.error).toBe("missing_dependency");
    expect(wire.error_type).toBe("missing_dependency");
    expect(wire.binary).toBe("git");
    expect(wire.why).toBe("mirror your vault to a git remote");
    expect(wire.docs_url).toBe("https://git-scm.com/downloads");
    expect(wire.install.linux).toBe("sudo apt-get install -y git\nsudo dnf install git");
    expect(wire.sysadmin_hint).toBe("Or ask your system administrator to install it for you.");
    // error_description is the headless render (linux platform here) — no
    // "ask someone else" trailer, and the recipe is platform-scoped to linux.
    expect(wire.error_description).not.toContain("system administrator");
    expect(wire.error_description).toContain("sudo apt-get install -y git");
  });

  test("darwin install field carries the brew recipe", () => {
    const wire = toMissingDependencyWire("git", git, darwin);
    expect(wire.install.darwin).toBe("brew install git");
  });

  test("cloudflared wire linux = static binary recipe for the arch", () => {
    const wire = toMissingDependencyWire("cloudflared", cloudflared, linuxX64);
    expect(wire.install.linux).toContain("cloudflared-linux-amd64");
  });

  test("optional dep wire sysadmin_hint = altHint", () => {
    const wire = toMissingDependencyWire("claude", claude, darwin);
    expect(wire.sysadmin_hint).toBe("or switch cleanup/job provider");
    expect(wire.install.generic).toBe("npm i -g @anthropic-ai/claude-code");
  });

  test("unregistered binary wire degrades: null why/docs, empty install", () => {
    const wire = toMissingDependencyWire("frobnicate", undefined, darwin);
    expect(wire.binary).toBe("frobnicate");
    expect(wire.why).toBeNull();
    expect(wire.docs_url).toBeNull();
    expect(wire.install).toEqual({});
    expect(wire.error_description).toContain("frobnicate is required but was not found");
  });
});

describe("lookupDep", () => {
  test("returns the spec for a registered binary", () => {
    expect(lookupDep("git")?.binary).toBe("git");
    expect(lookupDep("parakeet-mlx")?.optional).toBe(true);
  });

  test("returns undefined for an unregistered binary (never fabricates)", () => {
    expect(lookupDep("frobnicate")).toBeUndefined();
  });
});
