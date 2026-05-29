import { describe, expect, test } from "bun:test";
import { runAuthPreflight } from "../commands/expose-auth-preflight.ts";
import type { VaultAuthStatus } from "../vault/auth-status.ts";

interface Harness {
  logs: string[];
  prompts: string[];
  promptAnswers: string[];
  commands: string[][];
}

function makeHarness(answers: string[] = []): Harness {
  return { logs: [], prompts: [], promptAnswers: answers, commands: [] };
}

function wire(h: Harness) {
  let i = 0;
  return {
    log: (line: string) => h.logs.push(line),
    prompt: async (q: string) => {
      h.prompts.push(q);
      const answer = h.promptAnswers[i++];
      if (answer === undefined) throw new Error(`prompt exhausted at: ${q}`);
      return answer;
    },
    interactiveRunner: async (cmd: readonly string[]) => {
      h.commands.push([...cmd]);
      return 0;
    },
  };
}

function status(partial: Partial<VaultAuthStatus> = {}): VaultAuthStatus {
  return {
    hasOwnerPassword: false,
    hasTotp: false,
    tokenCount: 0,
    vaultNames: ["default"],
    ...partial,
  };
}

describe("runAuthPreflight — wide open (no owner password)", () => {
  test("warns loudly, offers password only, prints hub-JWT token guidance + honest 2FA note", async () => {
    const h = makeHarness(["y"]); // password yes
    await runAuthPreflight({ status: status(), ...wire(h) });
    const joined = h.logs.join("\n");
    expect(joined).toContain("No owner password");
    expect(joined).toContain("public internet");
    // Programmatic-client guidance points at the hub mint path, not pvt_*.
    expect(joined).toContain("parachute auth mint-token --scope vault:default:read");
    expect(joined).toContain("Bearer <hub-jwt>");
    // Honest 2FA state — coming (#473), not offered as a dead enroll command.
    expect(joined).toContain("#473");
    expect(joined).not.toContain("2fa enroll");
    // Only password is an interactive offer; token guidance + 2FA note are
    // printed, not prompted.
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toEqual(["parachute", "auth", "set-password"]);
    expect(h.prompts).toHaveLength(1);
  });

  test("token guidance uses the first discovered vault name", async () => {
    const h = makeHarness(["n"]);
    await runAuthPreflight({ status: status({ vaultNames: ["work"] }), ...wire(h) });
    expect(h.logs.join("\n")).toContain("--scope vault:work:read");
  });

  test("user declines the password prompt → no subprocesses run", async () => {
    const h = makeHarness([""]); // Enter = skip
    await runAuthPreflight({ status: status(), ...wire(h) });
    expect(h.commands).toHaveLength(0);
    // Only one prompt now (password); token guidance + 2FA note aren't prompts.
    expect(h.prompts).toHaveLength(1);
  });

  test("user accepts the password offer → set-password invoked", async () => {
    const h = makeHarness(["y"]);
    await runAuthPreflight({ status: status(), ...wire(h) });
    expect(h.commands.map((c) => c.join(" "))).toEqual(["parachute auth set-password"]);
  });

  test("null tokenCount with no owner password still classifies wide-open", async () => {
    // The `tokenCount: null` (unreadable vault DB) path is vestigial post-DROP
    // — `classify()` gates on `hasOwnerPassword` alone. A box with no owner
    // password AND an unreadable token DB must still take the loud wide-open
    // branch, not silently fall through to a quieter state.
    const h = makeHarness(["n"]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: false, tokenCount: null }),
      ...wire(h),
    });
    const joined = h.logs.join("\n");
    expect(joined).toContain("No owner password");
    expect(joined).toContain("public internet");
    // Wide-open offers the password (one prompt); not the password-set path.
    expect(h.prompts).toHaveLength(1);
  });

  test("never offers a dead command (vault tokens create OR auth 2fa enroll)", async () => {
    const h = makeHarness(["y"]);
    await runAuthPreflight({ status: status(), ...wire(h) });
    const allCommands = h.commands.map((c) => c.join(" ")).join("\n");
    expect(allCommands).not.toContain("vault tokens create");
    expect(allCommands).not.toContain("auth 2fa enroll");
    // And no log line steers the operator at a dead command as guidance.
    const guidance = h.logs.join("\n");
    expect(guidance).not.toContain("parachute vault tokens create");
    expect(guidance).not.toContain("parachute auth 2fa enroll");
  });
});

describe("runAuthPreflight — password set", () => {
  test("single confirmation line + honest 2FA note, no prompts (ignores vestigial tokenCount)", async () => {
    const h = makeHarness([]);
    await runAuthPreflight({
      // tokenCount is non-zero (vestigial pvt_* rows) but no longer consulted.
      status: status({ hasOwnerPassword: true, tokenCount: 3 }),
      ...wire(h),
    });
    const joined = h.logs.join("\n");
    expect(joined).toContain("Owner password is set");
    // Honest 2FA note (#473) — not a prompt, not the dead enroll command.
    expect(joined).toContain("#473");
    expect(joined).not.toContain("2fa enroll");
    expect(h.prompts).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
  });

  test("null tokenCount (DB unreadable) is irrelevant — password gates the branch", async () => {
    const h = makeHarness([]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: true, hasTotp: false, tokenCount: null }),
      ...wire(h),
    });
    expect(h.logs.join("\n")).toContain("Owner password is set");
    expect(h.prompts).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
  });

  test("password + legacy vault TOTP — still the quiet password-set path", async () => {
    const h = makeHarness([]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: true, hasTotp: true, tokenCount: 0 }),
      ...wire(h),
    });
    expect(h.logs.join("\n")).toContain("Owner password is set");
    expect(h.prompts).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
  });
});

describe("runAuthPreflight — subprocess failure handling", () => {
  test("non-zero exit from set-password doesn't abort the rest of the preflight", async () => {
    const h = makeHarness(["y"]);
    const interactiveRunner = async (cmd: readonly string[]) => {
      h.commands.push([...cmd]);
      return 7;
    };
    await runAuthPreflight({
      status: status(),
      log: (l) => h.logs.push(l),
      prompt: async (q) => {
        h.prompts.push(q);
        return h.promptAnswers.shift() ?? "";
      },
      interactiveRunner,
    });
    // The command was attempted; the flow continued (token guidance still
    // printed afterward).
    expect(h.commands.map((c) => c[0])).toEqual(["parachute"]);
    const joined = h.logs.join("\n");
    expect(joined).toContain("exited 7");
    expect(joined).toContain("Bearer <hub-jwt>");
  });
});

describe("runAuthPreflight — case-insensitive yes", () => {
  test('"Y", "YES", and "y" all count as affirmative; anything else is decline', async () => {
    // Now only the wide-open path prompts (for the password). Drive it there.
    for (const yes of ["y", "Y", "yes", "YES"]) {
      const h = makeHarness([yes]);
      await runAuthPreflight({
        status: status({ hasOwnerPassword: false }),
        ...wire(h),
      });
      expect(h.commands).toHaveLength(1);
    }
    for (const no of ["", "n", "no", "q", "bogus"]) {
      const h = makeHarness([no]);
      await runAuthPreflight({
        status: status({ hasOwnerPassword: false }),
        ...wire(h),
      });
      expect(h.commands).toHaveLength(0);
    }
  });
});
