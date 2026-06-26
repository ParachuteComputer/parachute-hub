import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MissingDependencyError,
  NonExecutableError,
  ensureExecutable,
  findNonExecutableOnPath,
  isBinaryNotFoundError,
  rethrowIfMissing,
} from "./error.ts";
import { lookupDep } from "./registry.ts";

describe("MissingDependencyError", () => {
  test("carries errorType, binary, spec; message is the formatted block", () => {
    const err = new MissingDependencyError("git", lookupDep("git"), {
      platform: "darwin",
      arch: "arm64",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.errorType).toBe("missing_dependency");
    expect(err.binary).toBe("git");
    expect(err.spec?.binary).toBe("git");
    expect(err.message).toContain("git is required to mirror your vault to a git remote");
    expect(err.message).toContain("brew install git");
  });

  test("toWire() returns the structured shape (no sysadmin trailer in description)", () => {
    const err = new MissingDependencyError("git", lookupDep("git"), {
      platform: "linux",
      arch: "x64",
    });
    const wire = err.toWire();
    expect(wire.error_type).toBe("missing_dependency");
    expect(wire.binary).toBe("git");
    expect(wire.install.linux).toContain("apt-get");
    expect(wire.error_description).not.toContain("system administrator");
  });

  test("undefined spec → generic message + degraded wire", () => {
    const err = new MissingDependencyError("frobnicate", undefined);
    expect(err.spec).toBeUndefined();
    expect(err.message).toContain("frobnicate is required but was not found on PATH");
    expect(err.toWire().why).toBeNull();
  });
});

describe("ensureExecutable", () => {
  test("throws MissingDependencyError when which → null", () => {
    expect(() => ensureExecutable("git", { which: () => null, platform: "darwin" })).toThrow(
      MissingDependencyError,
    );
  });

  test("the thrown error carries the looked-up spec", () => {
    try {
      ensureExecutable("tailscale", { which: () => null, platform: "linux", arch: "x64" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingDependencyError);
      const err = e as MissingDependencyError;
      expect(err.binary).toBe("tailscale");
      expect(err.spec?.why).toBe("expose your hub over a tailnet");
    }
  });

  test("is silent when which → a path", () => {
    expect(() => ensureExecutable("git", { which: () => "/usr/bin/git" })).not.toThrow();
  });

  test("unregistered binary still throws (spec undefined, generic message)", () => {
    try {
      ensureExecutable("frobnicate", { which: () => null });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingDependencyError);
      expect((e as MissingDependencyError).spec).toBeUndefined();
    }
  });

  // #634: present-but-non-executable detection. The secondary probe is injected
  // explicitly so the test stays fs-free; the pure `which`-only seam (no probe
  // injected) still defaults to not-found, proving the gate.
  test("#634: which→null + a present-but-non-executable hit → NonExecutableError (chmod hint)", () => {
    try {
      ensureExecutable("channel", {
        which: () => null,
        findNonExecutable: () => "/home/op/.bun/bin/channel",
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NonExecutableError);
      const err = e as NonExecutableError;
      expect(err.errorType).toBe("non_executable");
      expect(err.binary).toBe("channel");
      expect(err.path).toBe("/home/op/.bun/bin/channel");
      expect(err.message).toContain(
        "channel found at /home/op/.bun/bin/channel but is not executable",
      );
      expect(err.message).toContain("chmod +x /home/op/.bun/bin/channel");
    }
  });

  test("#634: which→null + no non-executable hit → still MissingDependencyError (not collapsed)", () => {
    try {
      ensureExecutable("git", { which: () => null, findNonExecutable: () => null });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingDependencyError);
      expect(e).not.toBeInstanceOf(NonExecutableError);
    }
  });

  test("#634: a stubbed `which` WITHOUT an injected probe keeps the pure not-found seam (no fs touch)", () => {
    // Existing call shape — a test that injects only `which` must NOT trip the
    // real PATH walk (gate: the production probe runs only for real Bun.which).
    expect(() => ensureExecutable("git", { which: () => null })).toThrow(MissingDependencyError);
  });
});

describe("findNonExecutableOnPath (#634 real-fs probe)", () => {
  const dir = mkdtempSync(join(tmpdir(), "depcheck-nonexec-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("returns the path of a present-but-non-executable file on PATH", () => {
    const p = join(dir, "noexec-tool");
    writeFileSync(p, "#!/bin/sh\necho hi\n");
    chmodSync(p, 0o644); // present, regular file, NOT executable
    const found = findNonExecutableOnPath("noexec-tool", { PATH: dir } as NodeJS.ProcessEnv);
    expect(found).toBe(p);
  });

  test("returns null for an executable file (not our case)", () => {
    const p = join(dir, "exec-tool");
    writeFileSync(p, "#!/bin/sh\necho hi\n");
    chmodSync(p, 0o755); // executable → not a non-executable hit
    expect(findNonExecutableOnPath("exec-tool", { PATH: dir } as NodeJS.ProcessEnv)).toBeNull();
  });

  test("returns null when the binary is absent from PATH (genuinely not installed)", () => {
    expect(
      findNonExecutableOnPath("totally-absent", { PATH: dir } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe("NonExecutableError", () => {
  test("interactive:false strips nothing extra but renders the chmod block", () => {
    const err = new NonExecutableError("bun", "/usr/local/bin/bun", { interactive: false });
    expect(err).toBeInstanceOf(Error);
    expect(err.errorType).toBe("non_executable");
    expect(err.message).toContain("bun found at /usr/local/bin/bun but is not executable");
    expect(err.message).toContain("chmod +x /usr/local/bin/bun");
  });
});

describe("isBinaryNotFoundError", () => {
  test("matches code === ENOENT", () => {
    expect(isBinaryNotFoundError({ code: "ENOENT" })).toBe(true);
  });

  test("matches Bun 'Executable not found' message", () => {
    expect(isBinaryNotFoundError(new Error('Executable not found in $PATH: "git"'))).toBe(true);
  });

  test("matches 'No such file' message", () => {
    expect(isBinaryNotFoundError(new Error("spawn git ENOENT: No such file"))).toBe(true);
  });

  test("does NOT match EACCES (must propagate)", () => {
    expect(isBinaryNotFoundError({ code: "EACCES", message: "permission denied" })).toBe(false);
  });

  test("does NOT match an unrelated error", () => {
    expect(isBinaryNotFoundError(new Error("connection refused"))).toBe(false);
    expect(isBinaryNotFoundError(null)).toBe(false);
    expect(isBinaryNotFoundError("string")).toBe(false);
  });

  test("binary-scoped match: message-only match requires the binary name", () => {
    const err = new Error('Executable not found in $PATH: "git"');
    expect(isBinaryNotFoundError(err, "git")).toBe(true);
    // a not-found message about a DIFFERENT binary doesn't attribute to ours
    expect(isBinaryNotFoundError(err, "tailscale")).toBe(false);
  });

  test("bare ENOENT with no message still matches even when a binary is named", () => {
    expect(isBinaryNotFoundError({ code: "ENOENT" }, "git")).toBe(true);
  });

  test("code===ENOENT matches even with a generic message + a named binary", () => {
    // errno is the unambiguous signal; the message is often generic
    // ("spawn failed") and must not gate attribution.
    expect(
      isBinaryNotFoundError(
        Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
        "cloudflared",
      ),
    ).toBe(true);
  });

  test("ENOENT in the message string (no .code) is also a not-found signal", () => {
    expect(isBinaryNotFoundError(new Error("ENOENT: cloudflared not on PATH"), "cloudflared")).toBe(
      true,
    );
  });
});

describe("rethrowIfMissing", () => {
  test("throws MissingDependencyError on a not-found spawn error", () => {
    const spawnErr = new Error('Executable not found in $PATH: "tailscale"');
    expect(() =>
      rethrowIfMissing(spawnErr, "tailscale", { platform: "linux", arch: "x64" }),
    ).toThrow(MissingDependencyError);
  });

  test("the rethrown error carries the registry spec", () => {
    try {
      rethrowIfMissing({ code: "ENOENT" }, "tailscale");
      // no throw here means the helper returned — fail
      // (we expect a throw)
    } catch (e) {
      expect(e).toBeInstanceOf(MissingDependencyError);
      expect((e as MissingDependencyError).spec?.binary).toBe("tailscale");
      return;
    }
    throw new Error("rethrowIfMissing should have thrown for ENOENT");
  });

  test("returns (does NOT throw) for a non-not-found error", () => {
    expect(() => rethrowIfMissing({ code: "EACCES" }, "tailscale")).not.toThrow();
    expect(() => rethrowIfMissing(new Error("boom"), "tailscale")).not.toThrow();
  });
});
