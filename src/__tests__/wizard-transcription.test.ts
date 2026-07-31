/**
 * The CLI wizard's transcription step, after it moved from scribe to the vault.
 *
 * The step used to branch four ways (none / groq / openai / local) and shell
 * `parachute install scribe`. Scribe is retired (hub#809), so every non-`none`
 * choice dead-ended in "✗ scribe install returned 1" — the wizard asked a
 * question nothing could answer.
 *
 * What these tests pin is the property that made that bad: the step must never
 * ask without doing, and must never fail setup over an optional extra.
 */

import { describe, expect, test } from "bun:test";
import { walkTranscriptionStep } from "../commands/wizard-transcription.ts";

function harness(over: { answers?: string[]; exitCode?: number } = {}) {
  const logs: string[] = [];
  const cmds: string[][] = [];
  const answers = [...(over.answers ?? [])];
  return {
    logs,
    cmds,
    opts: {
      configDir: "/tmp/does-not-matter",
      log: (l: string) => logs.push(l),
      prompt: async () => answers.shift() ?? "",
      runCommand: async (cmd: readonly string[]) => {
        cmds.push([...cmd]);
        return over.exitCode ?? 0;
      },
    },
  };
}

describe("it installs through the VAULT, never through scribe", () => {
  test("a yes runs `parachute-vault transcription install --yes`", async () => {
    const h = harness({ answers: ["y"] });
    expect(await walkTranscriptionStep(h.opts)).toBe(0);
    expect(h.cmds).toEqual([["parachute-vault", "transcription", "install", "--yes"]]);
  });

  test("it never shells `parachute install scribe`", async () => {
    // The regression this rewrite exists to prevent. A retired module can't be
    // installed, so asking and then trying is a guaranteed failure.
    const h = harness({ answers: ["y"] });
    await walkTranscriptionStep(h.opts);
    const joined = h.cmds.flat().join(" ");
    expect(joined).not.toContain("scribe");
  });

  test("--yes is passed, so the vault command doesn't ask a second time", async () => {
    // Load-bearing under `curl … | bash`: stdin is the pipe there, so a second
    // prompt would hang rather than take a default.
    const h = harness({ answers: ["y"] });
    await walkTranscriptionStep(h.opts);
    expect(h.cmds[0]).toContain("--yes");
  });
});

describe("the question", () => {
  test("a blank answer defaults to YES", async () => {
    // Skipping fails silently — audio uploads and nothing transcribes it — so
    // the safe default is to do the work.
    const h = harness({ answers: [""] });
    await walkTranscriptionStep(h.opts);
    expect(h.cmds.length).toBe(1);
  });

  test("'n' skips and says how to do it later", async () => {
    const h = harness({ answers: ["n"] });
    expect(await walkTranscriptionStep(h.opts)).toBe(0);
    expect(h.cmds).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/transcription install/);
  });

  test("transcribeMode=none skips without prompting", async () => {
    const h = harness();
    await walkTranscriptionStep({ ...h.opts, transcribeMode: "none" });
    expect(h.cmds).toEqual([]);
  });

  test("the legacy cloud spellings now mean 'set up local'", async () => {
    // `--transcribe=groq` in someone's existing script must not error. Cloud
    // providers are gone, so the only honest reading left is "yes, set it up".
    for (const mode of ["local", "groq", "openai"] as const) {
      const h = harness();
      await walkTranscriptionStep({ ...h.opts, transcribeMode: mode });
      expect(h.cmds).toEqual([["parachute-vault", "transcription", "install", "--yes"]]);
    }
  });
});

describe("failure is never fatal to setup", () => {
  test("a non-zero install still returns 0 from the step", async () => {
    // `parachute init` must not fail over an optional extra the operator can
    // retry with one command.
    const h = harness({ answers: ["y"], exitCode: 1 });
    expect(await walkTranscriptionStep(h.opts)).toBe(0);
  });

  test("and it says what to run to retry + to diagnose", async () => {
    const h = harness({ answers: ["y"], exitCode: 1 });
    await walkTranscriptionStep(h.opts);
    const out = h.logs.join("\n");
    expect(out).toMatch(/transcription install/);
    expect(out).toMatch(/transcription status/);
  });
});
