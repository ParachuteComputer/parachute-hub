import { describe, expect, test } from "bun:test";
import {
  MissingDependencyError,
  ensureExecutable,
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
