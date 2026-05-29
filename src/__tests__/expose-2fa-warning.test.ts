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

  test("falls back to legacy config.yaml totp_secret when hub.db is absent", () => {
    // hub#473: hub.db is the source of truth for real 2FA, but a super-old
    // install with no hub.db still suppresses the warning if the legacy vault
    // YAML totp_secret is set. Point hubDbPath at a nonexistent file so the
    // YAML fallback is exercised.
    const dir = mkdtempSync(join(tmpdir(), "pcli-2fa-warn-"));
    try {
      writeFileSync(join(dir, "config.yaml"), 'totp_secret: "JBSWY3DPEHPK3PXP"\n');
      expect(is2FAEnrolled({ vaultHome: dir, hubDbPath: join(dir, "absent-hub.db") })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing config.yaml + absent hub.db → not enrolled (false)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-2fa-warn-"));
    try {
      // No config.yaml written, no hub.db.
      expect(is2FAEnrolled({ vaultHome: dir, hubDbPath: join(dir, "absent-hub.db") })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty totp_secret value + absent hub.db → not enrolled", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-2fa-warn-"));
    try {
      writeFileSync(join(dir, "config.yaml"), 'totp_secret: ""\n');
      expect(is2FAEnrolled({ vaultHome: dir, hubDbPath: join(dir, "absent-hub.db") })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hub.db with an enrolled user → enrolled (the real signal)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-2fa-warn-"));
    try {
      const { hubDbPath, openHubDb } = await import("../hub-db.ts");
      const { createUser } = await import("../users.ts");
      const { persistEnrollment } = await import("../two-factor-store.ts");
      const { generateTotpSecret } = await import("../totp.ts");
      const dbPath = hubDbPath(dir);
      const db = openHubDb(dbPath);
      const u = await createUser(db, "owner", "owner-password-123");
      await persistEnrollment(db, u.id, generateTotpSecret("owner").secret);
      db.close();
      expect(is2FAEnrolled({ vaultHome: dir, hubDbPath: dbPath })).toBe(true);
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
    // hub#473: real hub-login 2FA. The warning now recommends the real
    // `parachute auth 2fa enroll` path (+ the /account/2fa browser path) and
    // still nudges a strong owner password.
    expect(joined).toContain("/login is now reachable on the public internet");
    expect(joined).toContain("https://vault.example.com/login");
    expect(joined).toContain("parachute auth 2fa enroll");
    expect(joined).toContain("/account/2fa");
    expect(joined).toContain("parachute auth set-password");
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
    expect(logs.some((l) => l.includes("/login is now reachable on the public internet"))).toBe(
      true,
    );
  });

  test("embeds the supplied publicUrl into the /login pointer", () => {
    const logs: string[] = [];
    printPublic2FAWarning({
      status: status({ hasTotp: false }),
      log: (l) => logs.push(l),
      publicUrl: "https://parachute.taildf9ce2.ts.net",
    });
    expect(logs.some((l) => l.includes("https://parachute.taildf9ce2.ts.net/login"))).toBe(true);
  });
});
