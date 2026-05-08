import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { is2FAEnrolled, printPublic2FAWarning } from "../commands/expose-2fa-warning.ts";
import type { VaultAuthStatus } from "../vault/auth-status.ts";

function status(partial: Partial<VaultAuthStatus> = {}): VaultAuthStatus {
  return {
    hasOwnerPassword: false,
    hasTotp: false,
    tokenCount: 0,
    vaultNames: [],
    ...partial,
  };
}

describe("is2FAEnrolled", () => {
  test("returns true when status carries hasTotp: true", () => {
    expect(is2FAEnrolled({ status: status({ hasTotp: true }) })).toBe(true);
  });

  test("returns false when status carries hasTotp: false", () => {
    expect(is2FAEnrolled({ status: status({ hasTotp: false }) })).toBe(false);
  });

  test("reads totp_secret from vaultHome's config.yaml when status not supplied", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-2fa-warn-"));
    try {
      writeFileSync(join(dir, "config.yaml"), 'totp_secret: "JBSWY3DPEHPK3PXP"\n');
      expect(is2FAEnrolled({ vaultHome: dir })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing config.yaml → not enrolled (false)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-2fa-warn-"));
    try {
      // No config.yaml written.
      expect(is2FAEnrolled({ vaultHome: dir })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty totp_secret value → not enrolled (matches vault's readGlobalConfig)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-2fa-warn-"));
    try {
      writeFileSync(join(dir, "config.yaml"), 'totp_secret: ""\n');
      expect(is2FAEnrolled({ vaultHome: dir })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed config.yaml → not enrolled (safer fail mode, fires warning)", () => {
    // The probe parses config.yaml with a line-anchored regex (no YAML
    // dependency), so junk content simply doesn't match `totp_secret: "..."`
    // and resolves to `hasTotp: false` — which fires the public-exposure
    // warning rather than silently suppressing it. Pin that contract so a
    // future refactor of auth-status.ts can't quietly invert it.
    const dir = mkdtempSync(join(tmpdir(), "pcli-2fa-warn-"));
    try {
      writeFileSync(join(dir, "config.yaml"), "totp_secret: [unbalanced\n  ::: not yaml\n");
      expect(is2FAEnrolled({ vaultHome: dir })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("printPublic2FAWarning", () => {
  test("not enrolled → fires warning, returns true", () => {
    const logs: string[] = [];
    const fired = printPublic2FAWarning({
      status: status({ hasTotp: false }),
      log: (l) => logs.push(l),
      publicUrl: "https://vault.example.com",
    });
    expect(fired).toBe(true);
    const joined = logs.join("\n");
    expect(joined).toContain("2FA is not enrolled");
    expect(joined).toContain("https://vault.example.com/admin/login");
    expect(joined).toContain("parachute auth 2fa enroll");
  });

  test("enrolled → suppressed, returns false, logs nothing", () => {
    const logs: string[] = [];
    const fired = printPublic2FAWarning({
      status: status({ hasTotp: true }),
      log: (l) => logs.push(l),
      publicUrl: "https://vault.example.com",
    });
    expect(fired).toBe(false);
    expect(logs).toEqual([]);
  });

  test("password-also-missing case still fires (warning is layer-independent of password state)", () => {
    // The wide-open state (no password, no 2FA) hits this branch too — the
    // hub's own `printAuthGuidance` (cloudflare) and `runAuthPreflight`
    // (interactive wizard) cover the password remediation; this warning is
    // strictly about 2FA.
    const logs: string[] = [];
    const fired = printPublic2FAWarning({
      status: status({ hasOwnerPassword: false, hasTotp: false }),
      log: (l) => logs.push(l),
      publicUrl: "https://vault.example.com",
    });
    expect(fired).toBe(true);
    expect(logs.some((l) => l.includes("2FA is not enrolled"))).toBe(true);
  });

  test("embeds the supplied publicUrl into the /admin/login pointer", () => {
    const logs: string[] = [];
    printPublic2FAWarning({
      status: status({ hasTotp: false }),
      log: (l) => logs.push(l),
      publicUrl: "https://parachute.taildf9ce2.ts.net",
    });
    expect(logs.some((l) => l.includes("https://parachute.taildf9ce2.ts.net/admin/login"))).toBe(
      true,
    );
  });
});
