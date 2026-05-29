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
  test("warns loudly, offers password + real 2FA enroll, prints hub-JWT token guidance", async () => {
    const h = makeHarness(["y", "y"]); // password yes, 2FA yes
    await runAuthPreflight({ status: status(), ...wire(h) });
    const joined = h.logs.join("\n");
    expect(joined).toContain("No owner password");
    expect(joined).toContain("public internet");
    // Programmatic-client guidance points at the hub mint path, not pvt_*.
    expect(joined).toContain("parachute auth mint-token --scope vault:default:read");
    expect(joined).toContain("Bearer <hub-jwt>");
    // Real 2FA (hub#473) — both commands offered + run.
    expect(h.commands.map((c) => c.join(" "))).toEqual([
      "parachute auth set-password",
      "parachute auth 2fa enroll",
    ]);
    // Two interactive offers now: password + 2FA. Token guidance is printed.
    expect(h.prompts).toHaveLength(2);
  });

  test("token guidance uses the first discovered vault name", async () => {
    const h = makeHarness(["n", "n"]);
    await runAuthPreflight({ status: status({ vaultNames: ["work"] }), ...wire(h) });
    expect(h.logs.join("\n")).toContain("--scope vault:work:read");
  });

  test("user declines both prompts → no subprocesses run", async () => {
    const h = makeHarness(["", ""]); // Enter = skip both
    await runAuthPreflight({ status: status(), ...wire(h) });
    expect(h.commands).toHaveLength(0);
    expect(h.prompts).toHaveLength(2);
  });

  test("user accepts the password offer → set-password invoked", async () => {
    const h = makeHarness(["y", "n"]);
    await runAuthPreflight({ status: status(), ...wire(h) });
    expect(h.commands.map((c) => c.join(" "))).toEqual(["parachute auth set-password"]);
  });

  test("null tokenCount with no owner password still classifies wide-open", async () => {
    // The `tokenCount: null` (unreadable vault DB) path is vestigial post-DROP
    // — `classify()` gates on `hasOwnerPassword` alone.
    const h = makeHarness(["n", "n"]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: false, tokenCount: null }),
      ...wire(h),
    });
    const joined = h.logs.join("\n");
    expect(joined).toContain("No owner password");
    expect(joined).toContain("public internet");
    expect(h.prompts).toHaveLength(2);
  });

  test("never offers the dead vault-tokens-create command", async () => {
    const h = makeHarness(["y", "n"]);
    await runAuthPreflight({ status: status(), ...wire(h) });
    const allCommands = h.commands.map((c) => c.join(" ")).join("\n");
    expect(allCommands).not.toContain("vault tokens create");
    const guidance = h.logs.join("\n");
    expect(guidance).not.toContain("parachute vault tokens create");
  });
});

describe("runAuthPreflight — password set, no 2FA", () => {
  test("confirms password set + offers real 2FA enroll (ignores vestigial tokenCount)", async () => {
    const h = makeHarness(["n"]); // decline 2FA
    await runAuthPreflight({
      // tokenCount is non-zero (vestigial pvt_* rows) but no longer consulted.
      status: status({ hasOwnerPassword: true, hasTotp: false, tokenCount: 3 }),
      ...wire(h),
    });
    const joined = h.logs.join("\n");
    expect(joined).toContain("Owner password is set");
    // Real 2FA offer (hub#473) — exactly one prompt (the 2FA offer).
    expect(h.prompts).toHaveLength(1);
    expect(h.commands).toHaveLength(0); // declined
  });

  test("accepting the 2FA offer runs `parachute auth 2fa enroll`", async () => {
    const h = makeHarness(["y"]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: true, hasTotp: false }),
      ...wire(h),
    });
    expect(h.commands.map((c) => c.join(" "))).toEqual(["parachute auth 2fa enroll"]);
  });

  test("null tokenCount (DB unreadable) is irrelevant — password gates the branch", async () => {
    const h = makeHarness(["n"]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: true, hasTotp: false, tokenCount: null }),
      ...wire(h),
    });
    expect(h.logs.join("\n")).toContain("Owner password is set");
    expect(h.prompts).toHaveLength(1);
  });
});

describe("runAuthPreflight — password + 2FA both set", () => {
  test("two-line confirmation, no prompts", async () => {
    const h = makeHarness([]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: true, hasTotp: true, tokenCount: 0 }),
      ...wire(h),
    });
    const joined = h.logs.join("\n");
    expect(joined).toContain("Owner password is set");
    expect(joined).toContain("Two-factor authentication is on");
    expect(h.prompts).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
  });
});

describe("runAuthPreflight — subprocess failure handling", () => {
  test("non-zero exit from set-password doesn't abort the rest of the preflight", async () => {
    const h = makeHarness(["y", "n"]);
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
    // Drive the password-set-no-2FA path so there's exactly one prompt (2FA).
    for (const yes of ["y", "Y", "yes", "YES"]) {
      const h = makeHarness([yes]);
      await runAuthPreflight({
        status: status({ hasOwnerPassword: true, hasTotp: false }),
        ...wire(h),
      });
      expect(h.commands).toHaveLength(1);
    }
    for (const no of ["", "n", "no", "q", "bogus"]) {
      const h = makeHarness([no]);
      await runAuthPreflight({
        status: status({ hasOwnerPassword: true, hasTotp: false }),
        ...wire(h),
      });
      expect(h.commands).toHaveLength(0);
    }
  });
});
