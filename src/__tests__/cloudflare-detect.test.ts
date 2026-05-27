import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloudflaredInstallHint,
  isCloudflaredInstalled,
  isCloudflaredLoggedIn,
} from "../cloudflare/detect.ts";
import type { CommandResult, Runner } from "../tailscale/run.ts";

function stubRunner(result: CommandResult | Error): Runner {
  return async (_cmd) => {
    if (result instanceof Error) throw result;
    return result;
  };
}

describe("cloudflare detect", () => {
  test("isCloudflaredInstalled returns true on exit 0", async () => {
    const runner = stubRunner({ code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" });
    expect(await isCloudflaredInstalled(runner)).toBe(true);
  });

  test("isCloudflaredInstalled returns false on non-zero exit", async () => {
    const runner = stubRunner({ code: 127, stdout: "", stderr: "not found" });
    expect(await isCloudflaredInstalled(runner)).toBe(false);
  });

  test("isCloudflaredInstalled swallows ENOENT (binary missing → not installed)", async () => {
    // Bun.spawn throws synchronously when the binary is missing; the detector
    // has to read that as "not installed" rather than propagating the error.
    const runner = stubRunner(new Error("ENOENT: cloudflared not on PATH"));
    expect(await isCloudflaredInstalled(runner)).toBe(false);
  });

  test("isCloudflaredInstalled matches on .code === 'ENOENT' too", async () => {
    const err = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    expect(await isCloudflaredInstalled(stubRunner(err))).toBe(false);
  });

  test("isCloudflaredInstalled propagates non-ENOENT errors (don't lie about why)", async () => {
    // An EACCES (binary found but not executable) is real misconfiguration,
    // not a missing install. Swallowing it here would mask the actual fix.
    const err = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    await expect(isCloudflaredInstalled(stubRunner(err))).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  test("isCloudflaredLoggedIn reads cert.pem presence in the passed home dir", () => {
    const home = mkdtempSync(join(tmpdir(), "cf-home-"));
    try {
      expect(isCloudflaredLoggedIn(home)).toBe(false);
      writeFileSync(join(home, "cert.pem"), "-----BEGIN CERTIFICATE-----\n...\n");
      expect(isCloudflaredLoggedIn(home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  describe("cloudflaredInstallHint", () => {
    test("darwin: names brew + points at GitHub releases as fallback", () => {
      const hint = cloudflaredInstallHint("darwin", "arm64");
      expect(hint).toContain("brew install cloudflared");
      expect(hint).toContain("https://github.com/cloudflare/cloudflared/releases/latest");
    });

    test("linux x64: writes the curl line with the amd64 artifact suffix", () => {
      // Refresh of stale URLs (2026-05-27). Aaron hit this on a fresh
      // Amazon Linux 2023 install — `sudo dnf install cloudflared`
      // returned 'No match for argument: cloudflared', and the hub's
      // hint pointed at developers.cloudflare.com paths that 404. The
      // GitHub release is the reliable cross-distro path.
      const hint = cloudflaredInstallHint("linux", "x64");
      expect(hint).toContain("curl -L -o /usr/local/bin/cloudflared");
      expect(hint).toContain(
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
      );
      expect(hint).toContain("sudo chmod +x /usr/local/bin/cloudflared");
    });

    test("linux arm64: writes the arm64 artifact suffix", () => {
      const hint = cloudflaredInstallHint("linux", "arm64");
      expect(hint).toContain("cloudflared-linux-arm64");
    });

    test("linux arm (32-bit): writes the arm artifact suffix", () => {
      const hint = cloudflaredInstallHint("linux", "arm");
      expect(hint).toContain("cloudflared-linux-arm");
    });

    test("linux exotic arch: falls back to a generic GitHub releases pointer", () => {
      // riscv64 / ppc64 / mips64 — no cloudflared artifact published, so
      // we don't fabricate a 404-bound download URL; we point the user at
      // the releases page and surface what their arch is so they can pick.
      const hint = cloudflaredInstallHint("linux", "riscv64");
      expect(hint).toContain("https://github.com/cloudflare/cloudflared/releases/latest");
      expect(hint).toContain("riscv64");
      expect(hint).not.toContain("curl -L -o /usr/local/bin/cloudflared");
    });

    test("no stale developers.cloudflare.com or pkg.cloudflare.com paths anywhere", () => {
      // Aaron caught both URL shapes returning HTML/404 on 2026-05-27 —
      // they had been the hub's installer instructions for months.
      // Hard-assert they're gone so they don't regress.
      for (const platform of ["darwin", "linux"] as const) {
        for (const arch of ["x64", "arm64"] as const) {
          const hint = cloudflaredInstallHint(platform, arch);
          expect(hint).not.toContain("developers.cloudflare.com");
          expect(hint).not.toContain("pkg.cloudflare.com");
        }
      }
    });

    test("non-Linux, non-darwin platform: GitHub releases pointer with no curl line", () => {
      const hint = cloudflaredInstallHint("win32", "x64");
      expect(hint).toContain("https://github.com/cloudflare/cloudflared/releases/latest");
      expect(hint).not.toContain("brew install");
      expect(hint).not.toContain("curl -L -o");
    });
  });
});
