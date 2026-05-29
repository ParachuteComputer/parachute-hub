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
  test("warns loudly, offers password + 2FA, and prints hub-JWT token guidance", async () => {
    const h = makeHarness(["y", "n"]); // password yes, 2fa no
    await runAuthPreflight({ status: status(), ...wire(h) });
    const joined = h.logs.join("\n");
    expect(joined).toContain("No owner password");
    expect(joined).toContain("public internet");
    // Programmatic-client guidance points at the hub mint path, not pvt_*.
    expect(joined).toContain("parachute auth mint-token --scope vault:default:read");
    expect(joined).toContain("Bearer <hub-jwt>");
    // Only password + 2FA are interactive offers; token guidance is printed,
    // not prompted (no auto-mint).
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toEqual(["parachute", "auth", "set-password"]);
  });

  test("token guidance uses the first discovered vault name", async () => {
    const h = makeHarness(["n", "n"]);
    await runAuthPreflight({ status: status({ vaultNames: ["work"] }), ...wire(h) });
    expect(h.logs.join("\n")).toContain("--scope vault:work:read");
  });

  test("user declines every prompt → no subprocesses run", async () => {
    const h = makeHarness(["", ""]); // all Enter = skip
    await runAuthPreflight({ status: status(), ...wire(h) });
    expect(h.commands).toHaveLength(0);
    // Prompted on password + 2FA (token guidance is not a prompt).
    expect(h.prompts).toHaveLength(2);
  });

  test("user accepts password + 2FA → both commands invoked in order", async () => {
    const h = makeHarness(["y", "y"]);
    await runAuthPreflight({ status: status(), ...wire(h) });
    expect(h.commands.map((c) => c.join(" "))).toEqual([
      "parachute auth set-password",
      "parachute auth 2fa enroll",
    ]);
  });

  test("never offers the removed `vault tokens create` command", async () => {
    const h = makeHarness(["y", "y"]);
    await runAuthPreflight({ status: status(), ...wire(h) });
    const allCommands = h.commands.map((c) => c.join(" ")).join("\n");
    expect(allCommands).not.toContain("vault tokens create");
    // And no log line steers the operator at the dead command as guidance.
    const guidance = h.logs.filter((l) => !l.includes("old affordance")).join("\n");
    expect(guidance).not.toContain("parachute vault tokens create");
  });
});

describe("runAuthPreflight — password set, no 2FA", () => {
  test("short nudge, offers 2FA only — ignores vestigial tokenCount", async () => {
    const h = makeHarness(["y"]);
    await runAuthPreflight({
      // tokenCount is non-zero (vestigial pvt_* rows) but no longer consulted.
      status: status({ hasOwnerPassword: true, tokenCount: 3 }),
      ...wire(h),
    });
    const joined = h.logs.join("\n");
    expect(joined).toContain("Owner password is set");
    expect(joined).toContain("2FA");
    expect(h.prompts).toHaveLength(1);
    expect(h.commands).toEqual([["parachute", "auth", "2fa", "enroll"]]);
  });

  test("user declines → no command runs", async () => {
    const h = makeHarness([""]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: true, tokenCount: 3 }),
      ...wire(h),
    });
    expect(h.commands).toHaveLength(0);
  });

  test("null tokenCount (DB unreadable) is irrelevant — password gates the branch", async () => {
    const h = makeHarness([""]); // decline 2FA
    await runAuthPreflight({
      status: status({ hasOwnerPassword: true, hasTotp: false, tokenCount: null }),
      ...wire(h),
    });
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.toLowerCase()).toContain("2fa");
  });
});

describe("runAuthPreflight — all good", () => {
  test("single positive line, no prompts (tokens not required)", async () => {
    const h = makeHarness([]);
    await runAuthPreflight({
      // tokenCount: 0 — a hub JWT is minted on demand, not a standing need.
      status: status({ hasOwnerPassword: true, hasTotp: true, tokenCount: 0 }),
      ...wire(h),
    });
    const joined = h.logs.join("\n");
    expect(joined).toContain("looks good");
    expect(joined).toContain("owner password + 2FA");
    expect(h.prompts).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
  });
});

describe("runAuthPreflight — subprocess failure handling", () => {
  test("non-zero exit from an auth command doesn't abort the rest of the preflight", async () => {
    const h = makeHarness(["y", "y"]);
    // Override the interactive runner to return non-zero on the first call.
    let first = true;
    const interactiveRunner = async (cmd: readonly string[]) => {
      h.commands.push([...cmd]);
      if (first) {
        first = false;
        return 7;
      }
      return 0;
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
    // Both commands still attempted, neither aborted the flow.
    expect(h.commands.map((c) => c[0])).toEqual(["parachute", "parachute"]);
    const joined = h.logs.join("\n");
    expect(joined).toContain("exited 7");
  });
});

describe("runAuthPreflight — case-insensitive yes", () => {
  test('"Y", "YES", and "y" all count as affirmative; anything else is decline', async () => {
    for (const yes of ["y", "Y", "yes", "YES"]) {
      const h = makeHarness([yes]);
      await runAuthPreflight({
        status: status({ hasOwnerPassword: true, tokenCount: 1 }),
        ...wire(h),
      });
      expect(h.commands).toHaveLength(1);
    }
    for (const no of ["", "n", "no", "q", "bogus"]) {
      const h = makeHarness([no]);
      await runAuthPreflight({
        status: status({ hasOwnerPassword: true, tokenCount: 1 }),
        ...wire(h),
      });
      expect(h.commands).toHaveLength(0);
    }
  });
});
