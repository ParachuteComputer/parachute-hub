import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueAuthCode } from "../auth-codes.ts";
import { registerClient } from "../clients.ts";
import { type AuthDeps, type Runner, auth, authHelp } from "../commands/auth.ts";
import { findGrant, recordGrant } from "../grants.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken, validateAccessToken } from "../jwt-sign.ts";
import {
  OPERATOR_TOKEN_AUDIENCE,
  OPERATOR_TOKEN_CLIENT_ID,
  OPERATOR_TOKEN_SCOPES,
  readOperatorTokenFile,
  writeOperatorTokenFile,
} from "../operator-token.ts";
import { createUser, listUsers, verifyPassword } from "../users.ts";

function makeRunner(result: number | (() => Promise<number>) = 0): {
  runner: Runner;
  calls: Array<readonly string[]>;
} {
  const calls: Array<readonly string[]> = [];
  const runner: Runner = {
    async run(cmd) {
      calls.push(cmd);
      return typeof result === "function" ? await result() : result;
    },
  };
  return { runner, calls };
}

function makeTmp(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "phub-auth-"));
  return {
    dir,
    dbPath: hubDbPath(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Capture console.log + console.error output for the duration of `fn`. */
async function captureOutput(fn: () => Promise<number> | number): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const origLog = console.log;
  const origErr = console.error;
  let stdout = "";
  let stderr = "";
  console.log = (...a: unknown[]) => {
    stdout += `${a.map(String).join(" ")}\n`;
  };
  console.error = (...a: unknown[]) => {
    stderr += `${a.map(String).join(" ")}\n`;
  };
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("parachute auth", () => {
  test("2fa is hub-local — never forwards to parachute-vault", async () => {
    // 2fa used to forward to the deprecated `parachute-vault 2fa` stub. As of
    // hub#473 it's real hub-login TOTP, fully hub-local (hub.db). No subprocess.
    const tmp = makeTmp();
    try {
      const db = openHubDb(tmp.dbPath);
      await createUser(db, "owner", "owner-password-123");
      db.close();
      const { runner, calls } = makeRunner(0);
      const out = await captureOutput(() =>
        auth(["2fa", "status"], { runner, dbPath: tmp.dbPath }),
      );
      expect(out.code).toBe(0);
      expect(calls).toEqual([]); // did NOT spawn parachute-vault
      expect(out.stdout).toContain("Two-factor authentication: OFF");
    } finally {
      tmp.cleanup();
    }
  });

  test("2fa status reports OFF for a fresh user, then ON after a CLI enroll round-trip", async () => {
    const tmp = makeTmp();
    try {
      const db = openHubDb(tmp.dbPath);
      await createUser(db, "owner", "owner-password-123");
      db.close();

      // status → OFF
      const off = await captureOutput(() =>
        auth(["2fa", "status"], { dbPath: tmp.dbPath, isInteractive: () => false }),
      );
      expect(off.code).toBe(0);
      expect(off.stdout).toContain("OFF");

      // enroll requires a confirm code — drive the readLine seam with the
      // live TOTP code generated from the secret the command prints.
      const { generateTotpSecret } = await import("../totp.ts");
      // We can't intercept the random secret the command mints, so instead
      // exercise the store directly to assert the ON path is reachable, then
      // assert the CLI status reflects it. (The handler-level enroll round
      // trip is covered in two-factor.test.ts against the real secret.)
      const db2 = openHubDb(tmp.dbPath);
      const { persistEnrollment } = await import("../two-factor-store.ts");
      const u = listUsers(db2)[0]!;
      const { secret } = generateTotpSecret(u.username);
      await persistEnrollment(db2, u.id, secret);
      db2.close();

      const on = await captureOutput(() =>
        auth(["2fa", "status"], { dbPath: tmp.dbPath, isInteractive: () => false }),
      );
      expect(on.code).toBe(0);
      expect(on.stdout).toContain("ON");
      expect(on.stdout).toContain("backup_codes");

      // disenroll clears it.
      const dis = await captureOutput(() =>
        auth(["2fa", "disenroll"], { dbPath: tmp.dbPath, isInteractive: () => false }),
      );
      expect(dis.code).toBe(0);
      expect(dis.stdout).toContain("Turned off");

      const off2 = await captureOutput(() =>
        auth(["2fa", "status"], { dbPath: tmp.dbPath, isInteractive: () => false }),
      );
      expect(off2.stdout).toContain("OFF");
    } finally {
      tmp.cleanup();
    }
  });

  test("2fa enroll confirms the printed secret against a live code, prints backup codes", async () => {
    const tmp = makeTmp();
    try {
      const db = openHubDb(tmp.dbPath);
      await createUser(db, "owner", "owner-password-123");
      db.close();

      // Single console.log interception that BOTH accumulates stdout and lets
      // the readLine seam read the secret the command just printed. (Avoids
      // nesting two console.log replacements.)
      const OTPAuth = await import("otpauth");
      const origLog = console.log;
      let stdout = "";
      let capturedSecret = "";
      console.log = (...a: unknown[]) => {
        const line = a.map(String).join(" ");
        stdout += `${line}\n`;
        const m = line.match(/secret key:\s+([A-Z2-7]+)/);
        if (m) capturedSecret = m[1]!;
      };
      let code = "";
      let exitCode = 0;
      try {
        exitCode = await auth(["2fa", "enroll"], {
          dbPath: tmp.dbPath,
          isInteractive: () => true,
          readLine: async () => {
            // The secret has been printed by the time the prompt fires.
            const totp = new OTPAuth.TOTP({
              issuer: "Parachute Hub",
              label: "owner",
              algorithm: "SHA1",
              digits: 6,
              period: 30,
              secret: OTPAuth.Secret.fromBase32(capturedSecret),
            });
            code = totp.generate();
            return code;
          },
        });
      } finally {
        console.log = origLog;
      }
      expect(exitCode).toBe(0);
      expect(capturedSecret.length).toBeGreaterThan(0);
      expect(stdout).toContain("now ON");
      // 10 backup codes printed (hyphenated form).
      const backupLines = stdout.split("\n").filter((l) => /^ {2}[a-z2-9]{5}-[a-z2-9]{5}$/.test(l));
      expect(backupLines.length).toBe(10);
      expect(code.length).toBe(6);
      // The persisted state reflects the enrollment: the captured secret is
      // now stored on the user row. (We don't re-verify `code` — the enroll
      // confirm consumed it via the replay cache, by design.)
      const db2 = openHubDb(tmp.dbPath);
      const { getTotpState } = await import("../two-factor-store.ts");
      const uid = listUsers(db2)[0]!.id;
      const persisted = getTotpState(db2, uid);
      expect(persisted.secret).toBe(capturedSecret);
      expect(persisted.backupCodes.length).toBe(10);
      db2.close();
    } finally {
      tmp.cleanup();
    }
  });

  test("2fa enroll refuses to re-enroll when already on", async () => {
    const tmp = makeTmp();
    try {
      const db = openHubDb(tmp.dbPath);
      const u = await createUser(db, "owner", "owner-password-123");
      const { generateTotpSecret } = await import("../totp.ts");
      const { persistEnrollment } = await import("../two-factor-store.ts");
      await persistEnrollment(db, u.id, generateTotpSecret("owner").secret);
      db.close();
      const out = await captureOutput(() =>
        auth(["2fa", "enroll"], { dbPath: tmp.dbPath, isInteractive: () => true }),
      );
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("already enabled");
    } finally {
      tmp.cleanup();
    }
  });

  test("set-password no longer forwards to vault", async () => {
    const tmp = makeTmp();
    try {
      const { runner, calls } = makeRunner(0);
      const code = await auth(["set-password", "--password", "pw"], {
        runner,
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      });
      expect(code).toBe(0);
      // Did NOT spawn parachute-vault.
      expect(calls).toEqual([]);
    } finally {
      tmp.cleanup();
    }
  });

  test("bogus subcommand exits 1 without spawning vault", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth(["whoami"], runner);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  test("no args prints help and exits 0 without spawning vault", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth([], runner);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  test("--help and help both route to the same help surface", async () => {
    const { runner, calls } = makeRunner(0);
    expect(await auth(["--help"], runner)).toBe(0);
    expect(await auth(["-h"], runner)).toBe(0);
    expect(await auth(["help"], runner)).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("authHelp", () => {
  const h = authHelp();

  test("lists every blessed subcommand", () => {
    expect(h).toContain("parachute auth set-password");
    expect(h).toContain("parachute auth list-users");
    expect(h).toContain("parachute auth 2fa");
    expect(h).toContain("parachute auth rotate-key");
    expect(h).toContain("parachute auth reap-clients");
  });

  test("reap-clients help documents dry-run-by-default + the conservative gate (#640)", () => {
    expect(h).toContain("reap-clients");
    expect(h).toContain("Dry-run by DEFAULT");
    expect(h).toContain("--apply");
    expect(h).toContain("--older-than");
    expect(h).toContain("PROVABLY-DEAD");
    expect(h).toContain("#640");
  });

  test("2fa help documents the real hub-login TOTP subcommands (#473)", () => {
    expect(h).toContain("#473");
    // Real enroll / disenroll subcommands are now advertised.
    expect(h).toContain("2fa enroll");
    expect(h).toContain("2fa disenroll");
    expect(h).toContain("otpauth://");
    expect(h).toContain("backup codes");
  });

  test("set-password help mentions the new flags + hub-local home", () => {
    expect(h).toContain("--username");
    expect(h).toContain("--allow-multi");
    expect(h).toContain("hub.db");
  });

  test("rotate-key explains the 24h JWKS retention", () => {
    expect(h).toContain("jwks.json");
    // "24" + "hours" may be split by line wrap; check both pieces.
    expect(h).toContain("24");
    expect(h).toContain("hours");
  });
});

describe("parachute auth rotate-key", () => {
  test("invokes the rotate hook and exits 0; does not spawn vault", async () => {
    const { runner, calls } = makeRunner(0);
    let hookCalls = 0;
    const code = await auth(["rotate-key"], {
      runner,
      rotateKey: () => {
        hookCalls++;
        return { kid: "test-kid-abc", createdAt: "2026-04-26T00:00:00.000Z" };
      },
    });
    expect(code).toBe(0);
    expect(hookCalls).toBe(1);
    expect(calls).toEqual([]);
  });

  test("propagates rotate errors as exit 1", async () => {
    const code = await auth(["rotate-key"], {
      rotateKey: () => {
        throw new Error("disk full");
      },
    });
    expect(code).toBe(1);
  });
});

describe("parachute auth set-password", () => {
  test("creates the first user with --password (non-interactive)", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      const { code, stdout } = await captureOutput(() =>
        auth(["set-password", "--password", "hunter2"], deps),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("Created hub user");
      expect(stdout).toContain("owner");
      const db = openHubDb(tmp.dbPath);
      try {
        const users = listUsers(db);
        expect(users).toHaveLength(1);
        expect(users[0]?.username).toBe("owner");
        expect(await verifyPassword(users[0]!, "hunter2")).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("creates with a custom --username", async () => {
    const tmp = makeTmp();
    try {
      const { code } = await captureOutput(() =>
        auth(["set-password", "--username", "aaron", "--password", "pw"], {
          dbPath: tmp.dbPath,
          configDir: tmp.dir,
          isInteractive: () => false,
        }),
      );
      expect(code).toBe(0);
      const db = openHubDb(tmp.dbPath);
      try {
        expect(listUsers(db).map((u) => u.username)).toEqual(["aaron"]);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("updates the existing user's password (single-user mode)", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath, configDir: tmp.dir, isInteractive: () => false };
      // First-run create.
      await captureOutput(() => auth(["set-password", "--password", "old"], deps));
      // Update.
      const { code, stdout } = await captureOutput(() =>
        auth(["set-password", "--password", "new"], deps),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("Updated password");
      const db = openHubDb(tmp.dbPath);
      try {
        const u = listUsers(db)[0]!;
        expect(await verifyPassword(u, "new")).toBe(true);
        expect(await verifyPassword(u, "old")).toBe(false);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("rejects --username mismatch without --allow-multi", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath, configDir: tmp.dir, isInteractive: () => false };
      await captureOutput(() => auth(["set-password", "--password", "p"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["set-password", "--username", "second", "--password", "p"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("already exists");
    } finally {
      tmp.cleanup();
    }
  });

  test("creates a second user with --allow-multi", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath, configDir: tmp.dir, isInteractive: () => false };
      await captureOutput(() => auth(["set-password", "--password", "p"], deps));
      const { code } = await captureOutput(() =>
        auth(["set-password", "--username", "second", "--password", "p", "--allow-multi"], deps),
      );
      expect(code).toBe(0);
      const db = openHubDb(tmp.dbPath);
      try {
        expect(
          listUsers(db)
            .map((u) => u.username)
            .sort(),
        ).toEqual(["owner", "second"]);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("non-interactive without --password is an error", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["set-password"], {
          dbPath: tmp.dbPath,
          configDir: tmp.dir,
          isInteractive: () => false,
        }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--password is required");
    } finally {
      tmp.cleanup();
    }
  });

  test("interactive: prompts twice and creates the user when they match", async () => {
    const tmp = makeTmp();
    try {
      const prompts: string[] = [];
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => true,
        readPassword: async (p) => {
          prompts.push(p);
          return "matched";
        },
        readLine: async () => "y",
      };
      const { code } = await captureOutput(() => auth(["set-password"], deps));
      expect(code).toBe(0);
      expect(prompts.length).toBe(2);
      const db = openHubDb(tmp.dbPath);
      try {
        const u = listUsers(db)[0]!;
        expect(await verifyPassword(u, "matched")).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("interactive: mismatched confirmation aborts with exit 1", async () => {
    const tmp = makeTmp();
    try {
      const answers = ["one", "two"];
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => true,
        readPassword: async () => answers.shift() ?? "",
        readLine: async () => "y",
      };
      const { code, stderr } = await captureOutput(() => auth(["set-password"], deps));
      expect(code).toBe(1);
      expect(stderr).toContain("did not match");
    } finally {
      tmp.cleanup();
    }
  });

  test("interactive: empty password aborts with exit 1", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => true,
        readPassword: async () => "",
        readLine: async () => "y",
      };
      const { code, stderr } = await captureOutput(() => auth(["set-password"], deps));
      expect(code).toBe(1);
      expect(stderr).toContain("empty");
    } finally {
      tmp.cleanup();
    }
  });

  test("first-run interactive: declining the default-username confirmation aborts", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => true,
        readPassword: async () => "pw",
        readLine: async () => "n",
      };
      const { code, stderr } = await captureOutput(() => auth(["set-password"], deps));
      expect(code).toBe(1);
      expect(stderr).toContain("aborted");
    } finally {
      tmp.cleanup();
    }
  });

  test("unknown flag exits 1", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["set-password", "--lol"], {
          dbPath: tmp.dbPath,
          configDir: tmp.dir,
          isInteractive: () => false,
        }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("unknown flag");
    } finally {
      tmp.cleanup();
    }
  });
});

describe("parachute auth list-users", () => {
  test("empty state prints the seeding hint", async () => {
    const tmp = makeTmp();
    try {
      const { code, stdout } = await captureOutput(() =>
        auth(["list-users"], { dbPath: tmp.dbPath }),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("no hub users yet");
    } finally {
      tmp.cleanup();
    }
  });

  test("lists usernames after a set-password", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath, configDir: tmp.dir, isInteractive: () => false };
      await captureOutput(() =>
        auth(["set-password", "--username", "alice", "--password", "p"], deps),
      );
      const { code, stdout } = await captureOutput(() => auth(["list-users"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("USERNAME");
      expect(stdout).toContain("alice");
    } finally {
      tmp.cleanup();
    }
  });
});

describe("set-password operator-token side-effect", () => {
  // First-run set-password must seed ~/.parachute/operator.token. Without
  // this, on-box CLI callers have nothing to present as a bearer when the
  // hub starts requiring auth on every request (no loopback bypass).
  test("creates operator.token on first-run, signed against active key, audience=operator", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      const { code, stdout } = await captureOutput(() =>
        auth(["set-password", "--password", "pw"], deps),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("operator token");
      const tokenOnDisk = await readOperatorTokenFile(tmp.dir);
      expect(tokenOnDisk).not.toBeNull();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, tokenOnDisk ?? "");
        expect(validated.payload.aud).toBe(OPERATOR_TOKEN_AUDIENCE);
        expect(validated.payload.scope).toBe(OPERATOR_TOKEN_SCOPES.join(" "));
        const users = listUsers(db);
        expect(validated.payload.sub).toBe(users[0]?.id);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  // Password reset rotates the file too — old token stays valid until its
  // 1y TTL expires (the hub doesn't track operator-token jtis), but the
  // file always carries the freshest one.
  test("password update overwrites operator.token with a fresh JWT", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "old"], deps));
      const first = await readOperatorTokenFile(tmp.dir);
      // Sleep a beat to make sure the new JWT has a different iat — JWT
      // claims are second-precision.
      await new Promise((r) => setTimeout(r, 1100));
      await captureOutput(() => auth(["set-password", "--password", "new"], deps));
      const second = await readOperatorTokenFile(tmp.dir);
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("parachute auth rotate-operator", () => {
  test("mints a fresh token, overwrites the file, exits 0", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const before = await readOperatorTokenFile(tmp.dir);
      await new Promise((r) => setTimeout(r, 1100));
      const { code, stdout } = await captureOutput(() => auth(["rotate-operator"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("Rotated operator token");
      const after = await readOperatorTokenFile(tmp.dir);
      expect(after).not.toBeNull();
      expect(after).not.toBe(before);
    } finally {
      tmp.cleanup();
    }
  });

  test("with no users yet, exits 1 with a hint to run set-password", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      const { code, stderr } = await captureOutput(() => auth(["rotate-operator"], deps));
      expect(code).toBe(1);
      expect(stderr).toContain("set-password");
    } finally {
      tmp.cleanup();
    }
  });

  // closes #213 — `--scope-set` flag.
  test("--scope-set=start mints with parachute:host:start only", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() =>
        auth(["rotate-operator", "--scope-set", "start"], deps),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("scope_set:  start");
      const onDisk = await readOperatorTokenFile(tmp.dir);
      expect(onDisk).not.toBeNull();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, onDisk!, "http://127.0.0.1:1939");
        expect(validated.payload.scope).toBe("parachute:host:start");
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--scope-set=admin (default) mints the full admin set", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() => auth(["rotate-operator"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("scope_set:  admin");
      const onDisk = await readOperatorTokenFile(tmp.dir);
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, onDisk!, "http://127.0.0.1:1939");
        const scopes = String(validated.payload.scope ?? "").split(" ");
        expect(scopes).toContain("hub:admin");
        expect(scopes).toContain("parachute:host:admin");
        expect(scopes).toContain("vault:admin");
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--scope-set=bogus rejected with usage message", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["rotate-operator", "--scope-set", "wallet"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--scope-set must be one of");
      expect(stderr).toContain("install");
      expect(stderr).toContain("admin");
    } finally {
      tmp.cleanup();
    }
  });

  test("unknown flag is rejected", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["rotate-operator", "--bogus"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("unknown flag");
    } finally {
      tmp.cleanup();
    }
  });
});

// closes #74 — the operator's surface for the DCR approval gate. The CLI
// is the only approval path at launch (no admin UI yet); these tests pin
// the round-trip so an operator can promote a pending registration.
describe("parachute auth pending-clients / approve-client", () => {
  test("pending-clients on an empty db says '(no pending OAuth clients)'", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      const { code, stdout } = await captureOutput(() => auth(["pending-clients"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("no pending OAuth clients");
    } finally {
      tmp.cleanup();
    }
  });

  test("pending-clients lists pending rows; approve-client promotes them", async () => {
    const tmp = makeTmp();
    try {
      const { registerClient } = await import("../clients.ts");
      const db = openHubDb(tmp.dbPath);
      let pendingId: string;
      try {
        pendingId = registerClient(db, {
          redirectUris: ["https://app.example/cb"],
          status: "pending",
          clientName: "MyApp",
        }).client.clientId;
        registerClient(db, {
          redirectUris: ["https://approved.example/cb"],
          status: "approved",
          clientName: "Already",
        });
      } finally {
        db.close();
      }
      const deps: AuthDeps = { dbPath: tmp.dbPath };

      // pending-clients shows only the pending row.
      const list = await captureOutput(() => auth(["pending-clients"], deps));
      expect(list.code).toBe(0);
      expect(list.stdout).toContain(pendingId);
      expect(list.stdout).toContain("MyApp");
      expect(list.stdout).not.toContain("approved.example");

      // approve-client without an arg is a usage error.
      const noArg = await captureOutput(() => auth(["approve-client"], deps));
      expect(noArg.code).toBe(1);
      expect(noArg.stderr).toContain("missing client_id");

      // approve-client <unknown> is a 1.
      const unknown = await captureOutput(() => auth(["approve-client", "no-such"], deps));
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain("no OAuth client");

      // approve-client <pending> succeeds and the row drops off pending-clients.
      const ok = await captureOutput(() => auth(["approve-client", pendingId], deps));
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain("Approved");
      const after = await captureOutput(() => auth(["pending-clients"], deps));
      expect(after.stdout).toContain("no pending OAuth clients");
    } finally {
      tmp.cleanup();
    }
  });
});

// hub#640 — RFC 7592 deregistration from the terminal.
describe("parachute auth revoke-client", () => {
  test("revoke-client without an arg is a usage error", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      const { code, stderr } = await captureOutput(() => auth(["revoke-client"], deps));
      expect(code).toBe(1);
      expect(stderr).toContain("missing client_id");
    } finally {
      tmp.cleanup();
    }
  });

  test("revoke-client <unknown> exits 1 with a friendly message", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      const { code, stderr } = await captureOutput(() => auth(["revoke-client", "no-such"], deps));
      expect(code).toBe(1);
      expect(stderr).toContain("no OAuth client");
    } finally {
      tmp.cleanup();
    }
  });

  test("revoke-client deletes the client + cascades its grant + emits audit line", async () => {
    const tmp = makeTmp();
    try {
      const db = openHubDb(tmp.dbPath);
      let userId: string;
      let clientId: string;
      try {
        const user = await createUser(db, "owner", "pw");
        userId = user.id;
        clientId = registerClient(db, {
          redirectUris: ["https://app.example/cb"],
          clientName: "MyApp",
        }).client.clientId;
        recordGrant(db, userId, clientId, ["vault:work:read"]);
        expect(findGrant(db, userId, clientId)).not.toBeNull();
      } finally {
        db.close();
      }
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      const { code, stdout } = await captureOutput(() => auth(["revoke-client", clientId], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("Deregistered OAuth client");
      // Audit line for greppability (matches the route's shape, remover_sub=cli).
      expect(stdout).toContain(`client deleted: client_id=${clientId}`);
      expect(stdout).toContain("client_name=MyApp");
      expect(stdout).toContain("remover_sub=cli");

      // Verify the cascade actually landed in the db.
      const db2 = openHubDb(tmp.dbPath);
      try {
        expect(
          db2.query("SELECT client_id FROM clients WHERE client_id = ?").get(clientId),
        ).toBeNull();
        expect(findGrant(db2, userId, clientId)).toBeNull();
      } finally {
        db2.close();
      }
    } finally {
      tmp.cleanup();
    }
  });
});

// closes #640 — OAuth client GC reaper. Dry-run by default; only provably-dead
// clients are reapable. The deep gate coverage lives in clients.test.ts; these
// exercise the CLI surface (dry-run safety, --apply, --json, empty case).
describe("parachute auth reap-clients", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Register a client `daysAgo` days before now (relative to wall clock). */
  function oldClient(db: ReturnType<typeof openHubDb>, daysAgo: number, name?: string): string {
    const when = new Date(Date.now() - daysAgo * DAY_MS);
    return registerClient(db, {
      redirectUris: ["https://app.example/cb"],
      ...(name !== undefined ? { clientName: name } : {}),
      now: () => when,
    }).client.clientId;
  }

  test("empty case: clean message, exit 0, no false alarm", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      const { code, stdout } = await captureOutput(() => auth(["reap-clients"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("No abandoned clients to reap.");
    } finally {
      tmp.cleanup();
    }
  });

  test("dry-run by DEFAULT lists candidates but deletes NOTHING", async () => {
    const tmp = makeTmp();
    let deadId: string;
    try {
      const db = openHubDb(tmp.dbPath);
      try {
        deadId = oldClient(db, 60, "DeadApp");
      } finally {
        db.close();
      }
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      const { code, stdout } = await captureOutput(() => auth(["reap-clients"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain(deadId);
      expect(stdout).toContain("DeadApp");
      expect(stdout).toContain("--apply");
      expect(stdout).toContain("nothing deleted");

      // Count unchanged: the client is still there.
      const db2 = openHubDb(tmp.dbPath);
      try {
        const n = db2.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM clients").get()?.n;
        expect(n).toBe(1);
      } finally {
        db2.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--apply actually reaps + emits an audit line, dry-run is a no-op before it", async () => {
    const tmp = makeTmp();
    let deadId: string;
    try {
      const db = openHubDb(tmp.dbPath);
      try {
        deadId = oldClient(db, 60, "DeadApp");
      } finally {
        db.close();
      }
      const deps: AuthDeps = { dbPath: tmp.dbPath };

      // Dry-run first: count before == count after.
      await captureOutput(() => auth(["reap-clients"], deps));
      const db2 = openHubDb(tmp.dbPath);
      try {
        expect(db2.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM clients").get()?.n).toBe(1);
      } finally {
        db2.close();
      }

      // --apply deletes.
      const { code, stdout } = await captureOutput(() => auth(["reap-clients", "--apply"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("Reaped 1 abandoned OAuth client");
      expect(stdout).toContain(`client reaped: client_id=${deadId}`);
      expect(stdout).toContain("client_name=DeadApp");

      const db3 = openHubDb(tmp.dbPath);
      try {
        expect(db3.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM clients").get()?.n).toBe(0);
      } finally {
        db3.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("NEVER reaps a client with a live grant (--apply leaves it intact)", async () => {
    const tmp = makeTmp();
    let liveId: string;
    let userId: string;
    try {
      const db = openHubDb(tmp.dbPath);
      try {
        const user = await createUser(db, "owner", "pw");
        userId = user.id;
        liveId = oldClient(db, 60, "GrantedApp");
        recordGrant(db, userId, liveId, ["vault:work:read"]);
      } finally {
        db.close();
      }
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      const { code, stdout } = await captureOutput(() => auth(["reap-clients", "--apply"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("No abandoned clients to reap.");

      const db2 = openHubDb(tmp.dbPath);
      try {
        expect(
          db2.query("SELECT client_id FROM clients WHERE client_id = ?").get(liveId),
        ).not.toBeNull();
        expect(findGrant(db2, userId, liveId)).not.toBeNull();
      } finally {
        db2.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("NEVER reaps a freshly-registered client (inside the 30d floor)", async () => {
    const tmp = makeTmp();
    try {
      const db = openHubDb(tmp.dbPath);
      try {
        oldClient(db, 5); // 5 days old
      } finally {
        db.close();
      }
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      const { code, stdout } = await captureOutput(() => auth(["reap-clients"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("No abandoned clients to reap.");
    } finally {
      tmp.cleanup();
    }
  });

  test("--older-than tunes the age floor", async () => {
    const tmp = makeTmp();
    let id: string;
    try {
      const db = openHubDb(tmp.dbPath);
      try {
        id = oldClient(db, 15); // 15 days old
      } finally {
        db.close();
      }
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      // Default 30d → not reapable.
      const def = await captureOutput(() => auth(["reap-clients"], deps));
      expect(def.stdout).toContain("No abandoned clients to reap.");
      // 10d floor → reapable.
      const tuned = await captureOutput(() => auth(["reap-clients", "--older-than", "10"], deps));
      expect(tuned.stdout).toContain(id);
    } finally {
      tmp.cleanup();
    }
  });

  test("--json emits machine output; applied=false in dry-run, true with --apply", async () => {
    const tmp = makeTmp();
    let deadId: string;
    try {
      const db = openHubDb(tmp.dbPath);
      try {
        deadId = oldClient(db, 60, "JsonApp");
      } finally {
        db.close();
      }
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      const dry = await captureOutput(() => auth(["reap-clients", "--json"], deps));
      expect(dry.code).toBe(0);
      const parsed = JSON.parse(dry.stdout) as {
        applied: boolean;
        count: number;
        clients: Array<{ clientId: string }>;
      };
      expect(parsed.applied).toBe(false);
      expect(parsed.count).toBe(1);
      expect(parsed.clients[0]?.clientId).toBe(deadId);
      // dry-run JSON deleted nothing.
      const db2 = openHubDb(tmp.dbPath);
      try {
        expect(db2.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM clients").get()?.n).toBe(1);
      } finally {
        db2.close();
      }

      const wet = await captureOutput(() => auth(["reap-clients", "--json", "--apply"], deps));
      const wetParsed = JSON.parse(wet.stdout) as {
        applied: boolean;
        clients: Array<{ reaped?: boolean }>;
      };
      expect(wetParsed.applied).toBe(true);
      expect(wetParsed.clients[0]?.reaped).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });

  test("a client with only an in-flight auth_code is NEVER reaped", async () => {
    const tmp = makeTmp();
    let id: string;
    try {
      const db = openHubDb(tmp.dbPath);
      try {
        const user = await createUser(db, "owner", "pw");
        id = oldClient(db, 60);
        issueAuthCode(db, {
          clientId: id,
          userId: user.id,
          redirectUri: "https://app.example/cb",
          scopes: ["vault:work:read"],
          codeChallenge: "x".repeat(43),
          codeChallengeMethod: "S256",
        });
      } finally {
        db.close();
      }
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      const { stdout } = await captureOutput(() => auth(["reap-clients"], deps));
      expect(stdout).toContain("No abandoned clients to reap.");
    } finally {
      tmp.cleanup();
    }
  });

  test("rejects --older-than 0 / negative / non-integer", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      for (const bad of ["0", "-5", "abc"]) {
        const { code, stderr } = await captureOutput(() =>
          auth(["reap-clients", "--older-than", bad], deps),
        );
        expect(code).toBe(1);
        expect(stderr).toContain("--older-than");
      }
    } finally {
      tmp.cleanup();
    }
  });
});

// closes #75 — operator-facing controls for the OAuth consent skip-list.
describe("parachute auth list-grants / revoke-grant", () => {
  test("list-grants shows the seeding hint when no users exist", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["list-grants"], { dbPath: tmp.dbPath }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("no hub users yet");
    } finally {
      tmp.cleanup();
    }
  });

  test("list-grants shows '(no OAuth grants)' when the user has none", async () => {
    const tmp = makeTmp();
    try {
      const db = openHubDb(tmp.dbPath);
      try {
        await createUser(db, "owner", "pw");
      } finally {
        db.close();
      }
      const { code, stdout } = await captureOutput(() =>
        auth(["list-grants"], { dbPath: tmp.dbPath }),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("no OAuth grants on record");
      expect(stdout).toContain("owner");
    } finally {
      tmp.cleanup();
    }
  });

  test("list-grants prints rows with client_id + client_name + scopes", async () => {
    const tmp = makeTmp();
    try {
      const db = openHubDb(tmp.dbPath);
      let userId: string;
      let clientId: string;
      try {
        const user = await createUser(db, "owner", "pw");
        userId = user.id;
        const reg = registerClient(db, {
          redirectUris: ["https://app.example/cb"],
          clientName: "MyApp",
        });
        clientId = reg.client.clientId;
        recordGrant(db, userId, clientId, ["vault:default:read", "scribe:transcribe"]);
      } finally {
        db.close();
      }
      const { code, stdout } = await captureOutput(() =>
        auth(["list-grants"], { dbPath: tmp.dbPath }),
      );
      expect(code).toBe(0);
      expect(stdout).toContain(clientId);
      expect(stdout).toContain("MyApp");
      expect(stdout).toContain("vault:default:read");
      expect(stdout).toContain("scribe:transcribe");
    } finally {
      tmp.cleanup();
    }
  });

  test("revoke-grant without args prints usage", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["revoke-grant"], { dbPath: tmp.dbPath }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("missing client_id");
    } finally {
      tmp.cleanup();
    }
  });

  test("revoke-grant for an unknown client errors", async () => {
    const tmp = makeTmp();
    try {
      const db = openHubDb(tmp.dbPath);
      try {
        await createUser(db, "owner", "pw");
      } finally {
        db.close();
      }
      const { code, stderr } = await captureOutput(() =>
        auth(["revoke-grant", "no-such"], { dbPath: tmp.dbPath }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("no grant on record");
    } finally {
      tmp.cleanup();
    }
  });

  test("revoke-grant deletes the row and surfaces a friendly message", async () => {
    const tmp = makeTmp();
    try {
      const db = openHubDb(tmp.dbPath);
      let userId: string;
      let clientId: string;
      try {
        const user = await createUser(db, "owner", "pw");
        userId = user.id;
        const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
        clientId = reg.client.clientId;
        recordGrant(db, userId, clientId, ["vault:default:read"]);
        expect(findGrant(db, userId, clientId)).not.toBeNull();
      } finally {
        db.close();
      }
      const { code, stdout } = await captureOutput(() =>
        auth(["revoke-grant", clientId], { dbPath: tmp.dbPath }),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("Revoked OAuth grant");
      expect(stdout).toContain("re-prompt for consent");

      // Row gone.
      const verifyDb = openHubDb(tmp.dbPath);
      try {
        expect(findGrant(verifyDb, userId, clientId)).toBeNull();
      } finally {
        verifyDb.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("multi-user mode requires --username on revoke-grant", async () => {
    const tmp = makeTmp();
    try {
      const db = openHubDb(tmp.dbPath);
      let aliceId: string;
      let clientId: string;
      try {
        const alice = await createUser(db, "alice", "pw");
        aliceId = alice.id;
        await createUser(db, "bob", "pw", { allowMulti: true });
        const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
        clientId = reg.client.clientId;
        recordGrant(db, aliceId, clientId, ["vault:default:read"]);
      } finally {
        db.close();
      }
      const ambig = await captureOutput(() =>
        auth(["revoke-grant", clientId], { dbPath: tmp.dbPath }),
      );
      expect(ambig.code).toBe(1);
      expect(ambig.stderr).toContain("multiple hub users exist");

      const targeted = await captureOutput(() =>
        auth(["revoke-grant", clientId, "--username", "alice"], { dbPath: tmp.dbPath }),
      );
      expect(targeted.code).toBe(0);
      expect(targeted.stdout).toContain("alice");

      // Bob never had this grant, so revoking his side is a 1.
      const bobMiss = await captureOutput(() =>
        auth(["revoke-grant", clientId, "--username", "bob"], { dbPath: tmp.dbPath }),
      );
      expect(bobMiss.code).toBe(1);
    } finally {
      tmp.cleanup();
    }
  });
});

// closes #179 — scope-narrow JWT minting against operator identity, for
// agent-secret injection and other on-box callers that want a tight bearer.
describe("parachute auth mint-token", () => {
  test("missing --scope is a usage error", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token"], { dbPath: tmp.dbPath, configDir: tmp.dir }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--scope is required");
    } finally {
      tmp.cleanup();
    }
  });

  test("no operator.token on disk is an actionable error", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe"], {
          dbPath: tmp.dbPath,
          configDir: tmp.dir,
        }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("operator.token");
      expect(stderr).toContain("rotate-operator");
    } finally {
      tmp.cleanup();
    }
  });

  test("scope-only mint emits a JWT signed by the active key, audience inferred", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe"], deps),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      expect(token.split(".").length).toBe(3);
      // Strict purity: stdout is exactly the token + trailing newline,
      // nothing extra. Pipes (`| pbcopy`, `| jq`) depend on this.
      expect(stdout).toBe(`${token}\n`);
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, token);
        expect(validated.payload.aud).toBe("scribe");
        expect(validated.payload.scope).toBe("scribe:transcribe");
        const users = listUsers(db);
        expect(validated.payload.sub).toBe(users[0]?.id);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  // closes #213 — auto-rotation banner must not leak into stdout (pipe purity).
  test("operator token within 7d of expiry: auto-rotates, banner on stderr only", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      // Bootstrap: set-password to seed the user + signing key.
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      // Overwrite operator.token with one that's within 7d of expiry — the
      // auto-rotation path should fire on the next mint-token invocation.
      const { issueOperatorToken } = await import("../operator-token.ts");
      const db = openHubDb(tmp.dbPath);
      const originalOnDisk = await readOperatorTokenFile(tmp.dir);
      try {
        await issueOperatorToken(db, listUsers(db)[0]!.id, {
          dir: tmp.dir,
          issuer: "http://127.0.0.1:1939",
          ttlSeconds: 24 * 60 * 60,
        });
      } finally {
        db.close();
      }

      const { code, stdout, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe"], deps),
      );
      expect(code).toBe(0);
      // The minted JWT is the only thing on stdout (pipe purity).
      const token = stdout.trim();
      expect(token.split(".").length).toBe(3);
      expect(stdout).toBe(`${token}\n`);
      // Auto-rotation banner went to stderr.
      expect(stderr).toContain("auto-rotated");
      expect(stderr).toContain("scope_set=admin");
      // The on-disk operator.token was replaced.
      const after = await readOperatorTokenFile(tmp.dir);
      expect(after).not.toBeNull();
      expect(after).not.toBe(originalOnDisk);
    } finally {
      tmp.cleanup();
    }
  });

  // Helper: stash a token with the chosen scopes at operator.token, returning
  // the deps bag so the caller can immediately invoke mint-token. Used by
  // every gating-scope test below to exercise the gate against a known
  // narrow / wide token without going through `rotate-operator` (which would
  // always mint admin-set).
  //
  // TTL is 30d (well beyond the 7d auto-rotation window) so the token
  // survives the next mint-token call without being silently swapped for a
  // fresh admin-set token by the auto-rotation path. Without this, narrow
  // tokens would auto-rotate to admin and our gate tests would all see the
  // post-rotation token, defeating the test entirely.
  async function bootstrapWithOperatorScopes(
    tmp: { dir: string; dbPath: string; cleanup: () => void },
    scopes: readonly string[],
  ): Promise<AuthDeps> {
    const deps: AuthDeps = {
      dbPath: tmp.dbPath,
      configDir: tmp.dir,
      isInteractive: () => false,
    };
    await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
    const db = openHubDb(tmp.dbPath);
    let token: string;
    try {
      const owner = listUsers(db)[0]!;
      const signed = await signAccessToken(db, {
        sub: owner.id,
        scopes: [...scopes],
        audience: "operator",
        clientId: OPERATOR_TOKEN_CLIENT_ID,
        issuer: "http://127.0.0.1:1939",
        ttlSeconds: 30 * 24 * 60 * 60,
      });
      token = signed.token;
    } finally {
      db.close();
    }
    await writeOperatorTokenFile(token, tmp.dir);
    return deps;
  }

  // hub#222: gate widened from `hub:admin` to `parachute:host:auth`. The
  // following tests pin the new behaviour:
  //   - admin scope-set (which carries both) still succeeds (regression);
  //   - `auth` scope-set (carries only `:host:auth`) NOW succeeds (gain);
  //   - other narrow scope-sets (vault/install/etc.) still rejected;
  //   - error message updated to name the new gate.

  test("operator token with `auth` scope-set (parachute:host:auth only) mints successfully (hub#222)", async () => {
    const tmp = makeTmp();
    try {
      const deps = await bootstrapWithOperatorScopes(tmp, ["parachute:host:auth"]);
      const { code, stdout, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe"], deps),
      );
      expect(code).toBe(0);
      // Pipe purity: stdout is the JWT, stderr empty.
      const token = stdout.trim();
      expect(token.split(".").length).toBe(3);
      expect(stdout).toBe(`${token}\n`);
      expect(stderr).toBe("");
    } finally {
      tmp.cleanup();
    }
  });

  test("operator token with admin scope-set still mints (regression — admin includes :host:auth as superset)", async () => {
    const tmp = makeTmp();
    try {
      // The full admin scope-set carries both `hub:admin` and `parachute:host:auth`.
      const deps = await bootstrapWithOperatorScopes(tmp, [
        "hub:admin",
        "parachute:host:auth",
        "vault:admin",
      ]);
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe"], deps),
      );
      expect(code).toBe(0);
      expect(stdout.trim().split(".").length).toBe(3);
    } finally {
      tmp.cleanup();
    }
  });

  test("operator token without parachute:host:auth is rejected (no token emitted)", async () => {
    const tmp = makeTmp();
    try {
      // Narrow non-auth token (resembles what someone might stash by mistake,
      // or a `--scope-set vault` operator token from rotate-operator).
      const deps = await bootstrapWithOperatorScopes(tmp, ["scribe:transcribe"]);
      const { code, stdout, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("lacks parachute:host:auth scope");
      expect(stderr).toContain("rotate-operator");
      expect(stdout).toBe("");
    } finally {
      tmp.cleanup();
    }
  });

  test("`vault` scope-set is rejected (regression — narrow scope-sets still can't mint)", async () => {
    const tmp = makeTmp();
    try {
      const deps = await bootstrapWithOperatorScopes(tmp, ["parachute:host:vault"]);
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("lacks parachute:host:auth scope");
    } finally {
      tmp.cleanup();
    }
  });

  test("`install` scope-set is rejected (regression — narrow scope-sets still can't mint)", async () => {
    const tmp = makeTmp();
    try {
      const deps = await bootstrapWithOperatorScopes(tmp, ["parachute:host:install", "vault:read"]);
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("lacks parachute:host:auth scope");
    } finally {
      tmp.cleanup();
    }
  });

  test("named vault scope infers aud=vault.<name>", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:work:read"], deps),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, token);
        expect(validated.payload.aud).toBe("vault.work");
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--aud override beats inference", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:work:read", "--aud", "custom-resource"], deps),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, token);
        expect(validated.payload.aud).toBe("custom-resource");
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--ttl honored; expiry math matches", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe", "--ttl", "1h"], deps),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, token);
        const exp = validated.payload.exp;
        const iat = validated.payload.iat;
        if (typeof exp !== "number" || typeof iat !== "number") {
          throw new Error("expected numeric exp+iat");
        }
        expect(exp - iat).toBe(3600);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--ttl=365d is accepted (boundary)", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe", "--ttl", "365d"], deps),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, token);
        const exp = validated.payload.exp;
        const iat = validated.payload.iat;
        if (typeof exp !== "number" || typeof iat !== "number") {
          throw new Error("expected numeric exp+iat");
        }
        expect(exp - iat).toBe(365 * 24 * 60 * 60);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--ttl=0s is rejected (must be > 0)", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe", "--ttl", "0s"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("must be > 0");
    } finally {
      tmp.cleanup();
    }
  });

  test("--ttl > 365d errors", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe", "--ttl", "400d"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("365d cap");
    } finally {
      tmp.cleanup();
    }
  });

  test("--ttl with invalid format errors", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe", "--ttl", "1week"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("invalid --ttl");
    } finally {
      tmp.cleanup();
    }
  });

  test("multiple scopes (space-separated) carried verbatim into the JWT", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:work:read scribe:transcribe"], deps),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, token);
        expect(validated.payload.scope).toBe("vault:work:read scribe:transcribe");
        // Named vault scope wins for audience inference.
        expect(validated.payload.aud).toBe("vault.work");
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--sub override emits the JWT with that subject", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe", "--sub", "agent:scribe-runner"], deps),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, token);
        expect(validated.payload.sub).toBe("agent:scribe-runner");
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("unknown flag errors", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--lol"], { dbPath: tmp.dbPath, configDir: tmp.dir }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("unknown flag");
    } finally {
      tmp.cleanup();
    }
  });

  // closes #212 Phase 1 — registry write, --permissions, --expires-in,
  // --ttl deprecation notice.
  test("every successful mint writes a tokens registry row (created_via=cli_mint)", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe"], deps),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, token);
        const jti = validated.payload.jti as string;
        const row = db
          .query<{ jti: string; created_via: string; subject: string | null }, [string]>(
            "SELECT jti, created_via, subject FROM tokens WHERE jti = ?",
          )
          .get(jti);
        expect(row).not.toBeNull();
        expect(row?.created_via).toBe("cli_mint");
        // Default subject = operator's sub (the hub user id).
        expect(typeof row?.subject).toBe("string");
        expect(row?.subject?.length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--permissions JSON object round-trips into JWT + registry row", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const permissions = '{"vault":{"default":{"write_tags":["health"]}}}';
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:default:write", "--permissions", permissions], deps),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, token);
        expect(validated.payload.permissions).toEqual({
          vault: { default: { write_tags: ["health"] } },
        });
        const jti = validated.payload.jti as string;
        const row = db
          .query<{ permissions: string }, [string]>("SELECT permissions FROM tokens WHERE jti = ?")
          .get(jti);
        expect(JSON.parse(row!.permissions)).toEqual({
          vault: { default: { write_tags: ["health"] } },
        });
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--permissions with malformed JSON is rejected", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:read", "--permissions", "{not-json}"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("not valid JSON");
    } finally {
      tmp.cleanup();
    }
  });

  test("--permissions with non-object JSON (array) is rejected", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:read", "--permissions", "[1,2,3]"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("must be a JSON object");
    } finally {
      tmp.cleanup();
    }
  });

  test("--expires-in (canonical) sets the JWT TTL in seconds", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe", "--expires-in", "7200"], deps),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, token);
        const exp = validated.payload.exp as number;
        const iat = validated.payload.iat as number;
        expect(exp - iat).toBe(7200);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--expires-in with non-integer value rejected", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:read", "--expires-in", "1d"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("integer seconds count");
    } finally {
      tmp.cleanup();
    }
  });

  test("--expires-in over 365d cap rejected", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:read", "--expires-in", String(366 * 86400)], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("365d cap");
    } finally {
      tmp.cleanup();
    }
  });

  test("--ttl emits deprecation notice on stderr but still works", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "scribe:transcribe", "--ttl", "1h"], deps),
      );
      expect(code).toBe(0);
      expect(stdout.trim().split(".").length).toBe(3);
      expect(stderr).toContain("--ttl is deprecated");
      expect(stderr).toContain("--expires-in");
      expect(stderr).toContain("future release");
    } finally {
      tmp.cleanup();
    }
  });

  test("--ephemeral mints a short-lived (1h) token", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:default:read", "--ephemeral"], deps),
      );
      expect(code).toBe(0);
      const token = stdout.trim();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, token);
        const exp = validated.payload.exp as number;
        const iat = validated.payload.iat as number;
        expect(exp - iat).toBe(60 * 60);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("--ephemeral is mutually exclusive with --expires-in", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:read", "--ephemeral", "--expires-in", "3600"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--ephemeral");
      // No token leaked to stdout on the conflict error.
      expect(stdout).toBe("");
    } finally {
      tmp.cleanup();
    }
  });

  test("--ephemeral is mutually exclusive with the deprecated --ttl too", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:read", "--ephemeral", "--ttl", "1h"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--ephemeral");
      expect(stdout).toBe("");
    } finally {
      tmp.cleanup();
    }
  });

  // closes #215 reviewer F1 — privilege-diffusion guard on the CLI mint path.
  test("CLI mint-token rejects parachute:host:auth (non-requestable scope)", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stdout, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "parachute:host:auth"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("not requestable");
      expect(stderr).toContain("parachute:host:auth");
      // No token leaked to stdout.
      expect(stdout).toBe("");
    } finally {
      tmp.cleanup();
    }
  });

  test("passing both --ttl and --expires-in is an error", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["mint-token", "--scope", "vault:read", "--ttl", "1h", "--expires-in", "3600"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--ttl");
      expect(stderr).toContain("--expires-in");
    } finally {
      tmp.cleanup();
    }
  });
});

describe("parachute auth revoke-token", () => {
  // Each test mints a fresh token via mint-token and then revokes it. Going
  // through the public mint surface (rather than calling signAccessToken +
  // recordTokenMint directly) keeps these tests honest about the contract:
  // mint writes a registry row, revoke-token flips its bit, and a future
  // round-trip through validateAccessToken would reject it. The Phase 4
  // RS-side enforcement is exercised in scope-guard's own integration suite.

  async function mintAJti(deps: AuthDeps): Promise<string> {
    const { stdout } = await captureOutput(() =>
      auth(["mint-token", "--scope", "scribe:transcribe"], deps),
    );
    const token = stdout.trim();
    // Decode the unverified payload to recover the jti — every mint stamps one.
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8")) as {
      jti: string;
    };
    return payload.jti;
  }

  test("missing jti positional is a usage error", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["revoke-token"], { dbPath: tmp.dbPath, configDir: tmp.dir }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("missing jti argument");
    } finally {
      tmp.cleanup();
    }
  });

  test("unexpected flag is a usage error", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["revoke-token", "--reason", "compromise", "abc123"], {
          dbPath: tmp.dbPath,
          configDir: tmp.dir,
        }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("unexpected flag");
      expect(stderr).toContain("--reason");
    } finally {
      tmp.cleanup();
    }
  });

  test("revokes a fresh token and prints subject + scope", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const jti = await mintAJti(deps);
      const { code, stdout, stderr } = await captureOutput(() => auth(["revoke-token", jti], deps));
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`revoked: jti=${jti}`);
      expect(stdout).toContain("identity=");
      expect(stdout).toContain("scope=scribe:transcribe");

      // Registry row really has revoked_at set now.
      const db = openHubDb(tmp.dbPath);
      try {
        const { findTokenRowByJti } = await import("../jwt-sign.ts");
        const row = findTokenRowByJti(db, jti);
        expect(row?.revokedAt).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("re-revoke is idempotent: exit 0, prints existing revoked_at", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const jti = await mintAJti(deps);
      const first = await captureOutput(() => auth(["revoke-token", jti], deps));
      expect(first.code).toBe(0);

      // Capture the timestamp from the first revoke for cross-check.
      const db = openHubDb(tmp.dbPath);
      let firstRevokedAt: string | null;
      try {
        const { findTokenRowByJti } = await import("../jwt-sign.ts");
        firstRevokedAt = findTokenRowByJti(db, jti)?.revokedAt ?? null;
      } finally {
        db.close();
      }
      expect(firstRevokedAt).not.toBeNull();

      const second = await captureOutput(() => auth(["revoke-token", jti], deps));
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("already revoked at");
      expect(second.stdout).toContain(firstRevokedAt!);
    } finally {
      tmp.cleanup();
    }
  });

  test("unknown jti exits 1 with not-found error", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["revoke-token", "this-jti-does-not-exist"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("no token with jti this-jti-does-not-exist found in registry");
    } finally {
      tmp.cleanup();
    }
  });

  test("operator token without parachute:host:auth is rejected", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      // Replace operator.token with a narrow JWT that lacks parachute:host:auth.
      const db = openHubDb(tmp.dbPath);
      let narrow: string;
      try {
        const owner = listUsers(db)[0]!;
        const signed = await signAccessToken(db, {
          sub: owner.id,
          scopes: ["scribe:transcribe"],
          audience: "scribe",
          clientId: OPERATOR_TOKEN_CLIENT_ID,
          issuer: "http://127.0.0.1:1939",
          ttlSeconds: 3600,
        });
        narrow = signed.token;
      } finally {
        db.close();
      }
      await writeOperatorTokenFile(narrow, tmp.dir);

      const { code, stderr } = await captureOutput(() => auth(["revoke-token", "any-jti"], deps));
      expect(code).toBe(1);
      expect(stderr).toContain("lacks parachute:host:auth scope");
      expect(stderr).toContain("rotate-operator");
    } finally {
      tmp.cleanup();
    }
  });

  test("missing operator.token is an actionable error", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["revoke-token", "any-jti"], { dbPath: tmp.dbPath, configDir: tmp.dir }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("operator.token");
      expect(stderr).toContain("rotate-operator");
    } finally {
      tmp.cleanup();
    }
  });

  test("authHelp lists revoke-token alongside mint-token", () => {
    expect(authHelp()).toContain("revoke-token");
    expect(authHelp()).toContain("revoke-token <jti>");
  });
});
