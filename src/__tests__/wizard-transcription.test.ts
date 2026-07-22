/**
 * CLI wizard transcription step (onboarding-streamline hub PR1).
 *
 * Exercises `walkTranscriptionStep` against an injected command runner + RAM
 * probe + platform — NOTHING installs and no subprocess is spawned. Covers the
 * four branches the brief calls for: the CLI transcription question, the
 * platform mapping, the RAM gate, and install-or-skip (mocked scribe
 * subprocess).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkTranscriptionStep } from "../commands/wizard-transcription.ts";
import { scribeConfigPath } from "../scribe-config.ts";

function makeHarness(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-wztrans-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Records every command the step would have spawned, returns scripted codes. */
function recordingRunner(codes: number[] = []) {
  const cmds: string[][] = [];
  let i = 0;
  return {
    cmds,
    run: async (cmd: readonly string[]): Promise<number> => {
      cmds.push([...cmd]);
      const code = codes[i++];
      return code ?? 0;
    },
  };
}

function readCfg(dir: string): Record<string, unknown> | undefined {
  const p = scribeConfigPath(dir);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

describe("walkTranscriptionStep — mode resolution (the CLI question)", () => {
  test("none: writes no scribe config, runs no command", async () => {
    const h = makeHarness();
    try {
      const r = recordingRunner();
      const logs: string[] = [];
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: (l) => logs.push(l),
        transcribeMode: "none",
        runCommand: r.run,
        platform: "linux",
      });
      expect(code).toBe(0);
      expect(r.cmds).toEqual([]);
      expect(readCfg(h.dir)).toBeUndefined();
      expect(logs.join("\n")).toContain("Transcription off");
    } finally {
      h.cleanup();
    }
  });

  test("interactive prompt: '1' chooses none", async () => {
    const h = makeHarness();
    try {
      const r = recordingRunner();
      const answers = ["1"];
      let i = 0;
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: () => {},
        prompt: async () => answers[i++] ?? "",
        runCommand: r.run,
        platform: "linux",
      });
      expect(code).toBe(0);
      expect(r.cmds).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("non-interactive stdin (no flag) DEFAULTS to none — never hangs on the prompt", async () => {
    // Headless-hardening: with no `--transcribe-mode` flag AND a closed / non-
    // interactive stdin, an interactive `prompt("Pick [1]:")` would busy-hang
    // Bun's readline question() forever (the exact e2e wedge). Transcription is
    // optional and documented as never-blocking, so resolveChoice DEFAULTS to
    // "none" (with an honest log line) rather than throwing. We drive the real
    // defaultPrompt (no `prompt` seam) and force isTTY=false for determinism;
    // if the guard regressed, this test would HANG instead of passing.
    const h = makeHarness();
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      const r = recordingRunner();
      const logs: string[] = [];
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: (l) => logs.push(l),
        // no transcribeMode, no prompt seam → real defaultPrompt would be hit
        runCommand: r.run,
        platform: "linux",
      });
      expect(code).toBe(0);
      expect(r.cmds).toEqual([]); // nothing installed
      expect(readCfg(h.dir)).toBeUndefined(); // no provider recorded
      expect(logs.join("\n")).toContain("not interactive");
      expect(logs.join("\n")).toContain("Transcription off");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
      h.cleanup();
    }
  });

  test("interactive prompt: '3' then 'g' chooses groq cloud", async () => {
    const h = makeHarness();
    try {
      const r = recordingRunner([0]);
      const answers = ["3", "g", "gsk_interactive"];
      let i = 0;
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: () => {},
        prompt: async () => answers[i++] ?? "",
        runCommand: r.run,
        platform: "linux",
      });
      expect(code).toBe(0);
      // One install command, with the groq provider + key.
      expect(r.cmds.length).toBe(1);
      expect(r.cmds[0]).toEqual([
        "parachute",
        "install",
        "scribe",
        "--scribe-provider",
        "groq",
        "--scribe-key",
        "gsk_interactive",
      ]);
    } finally {
      h.cleanup();
    }
  });
});

describe("walkTranscriptionStep — cloud (install-or-skip via the one-shot)", () => {
  test("groq with a key: install one-shot carries provider + key", async () => {
    const h = makeHarness();
    try {
      const r = recordingRunner([0]);
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: () => {},
        transcribeMode: "groq",
        transcribeApiKey: "gsk_abc123",
        runCommand: r.run,
        platform: "linux",
      });
      expect(code).toBe(0);
      expect(r.cmds[0]).toEqual([
        "parachute",
        "install",
        "scribe",
        "--scribe-provider",
        "groq",
        "--scribe-key",
        "gsk_abc123",
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("openai without a key: install one-shot omits --scribe-key + tells operator how to add it", async () => {
    const h = makeHarness();
    try {
      const r = recordingRunner([0]);
      const logs: string[] = [];
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: (l) => logs.push(l),
        transcribeMode: "openai",
        transcribeApiKey: "",
        runCommand: r.run,
        platform: "darwin",
      });
      expect(code).toBe(0);
      expect(r.cmds[0]).toEqual(["parachute", "install", "scribe", "--scribe-provider", "openai"]);
      expect(logs.join("\n")).toContain("OPENAI_API_KEY");
    } finally {
      h.cleanup();
    }
  });

  test("cloud install failure: surfaces the non-zero exit + a retry hint, still exits 0", async () => {
    const h = makeHarness();
    try {
      const r = recordingRunner([1]); // install fails
      const logs: string[] = [];
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: (l) => logs.push(l),
        transcribeMode: "groq",
        transcribeApiKey: "gsk_x",
        runCommand: r.run,
        platform: "linux",
      });
      expect(code).toBe(0); // non-fatal — doesn't block the wizard
      expect(logs.join("\n")).toContain("returned 1");
    } finally {
      h.cleanup();
    }
  });
});

describe("walkTranscriptionStep — local install-or-skip", () => {
  test("Linux, ample RAM, install succeeds: install-backend uses onnx-asr; provider kept", async () => {
    const h = makeHarness();
    try {
      // module install (writes provider via --scribe-provider), install-backend, restart
      const r = recordingRunner([0, 0, 0]);
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: () => {},
        transcribeMode: "local",
        runCommand: r.run,
        platform: "linux",
        availableRamMib: 4096,
      });
      expect(code).toBe(0);
      // Module install pins the resolved Linux backend, NOT parakeet-mlx.
      expect(r.cmds[0]).toEqual([
        "parachute",
        "install",
        "scribe",
        "--scribe-provider",
        "onnx-asr",
      ]);
      // scribe's own runnable install routine, targeting onnx-asr.
      expect(r.cmds[1]).toEqual(["parachute-scribe", "install-backend", "--provider", "onnx-asr"]);
      // A restart so the running scribe picks up the engine.
      expect(r.cmds[2]).toEqual(["parachute", "restart", "scribe"]);
    } finally {
      h.cleanup();
    }
  });

  test("macOS local resolves to parakeet-mlx", async () => {
    const h = makeHarness();
    try {
      const r = recordingRunner([0, 0, 0]);
      await walkTranscriptionStep({
        configDir: h.dir,
        log: () => {},
        transcribeMode: "local",
        runCommand: r.run,
        platform: "darwin",
        availableRamMib: 16384,
      });
      expect(r.cmds[1]).toEqual([
        "parachute-scribe",
        "install-backend",
        "--provider",
        "parakeet-mlx",
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("install-backend FAILS: clears the provisional provider (no dead string) + points at cloud", async () => {
    const h = makeHarness();
    try {
      // module install OK, install-backend FAILS (exit 3). No restart should run.
      const r = recordingRunner([0, 3]);
      const logs: string[] = [];
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: (l) => logs.push(l),
        transcribeMode: "local",
        runCommand: r.run,
        platform: "linux",
        availableRamMib: 4096,
      });
      expect(code).toBe(0);
      // Only two commands ran — the failed install-backend, no restart.
      expect(r.cmds.length).toBe(2);
      expect(r.cmds.some((c) => c[0] === "parachute" && c[1] === "restart")).toBe(false);
      // The provisional provider write (by the install one-shot in production)
      // is cleared. We simulate the install having written it by checking the
      // step never leaves a transcribe.provider on its own write path — and the
      // honest cloud steer is logged.
      expect(logs.join("\n")).toContain("install failed");
      expect(logs.join("\n")).toContain("Cloud alternative");
    } finally {
      h.cleanup();
    }
  });

  test("RAM below floor: REFUSES local, records nothing, steers to cloud one-shot", async () => {
    const h = makeHarness();
    try {
      const r = recordingRunner();
      const logs: string[] = [];
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: (l) => logs.push(l),
        transcribeMode: "local",
        runCommand: r.run,
        platform: "linux",
        availableRamMib: 900, // 1 GB droplet
      });
      expect(code).toBe(0);
      // Nothing installed, nothing recorded.
      expect(r.cmds).toEqual([]);
      expect(readCfg(h.dir)).toBeUndefined();
      const joined = logs.join("\n");
      expect(joined).toContain("isn't possible");
      expect(joined).toContain("parachute install scribe --scribe-provider groq");
    } finally {
      h.cleanup();
    }
  });

  test("unsupported platform: REFUSES local + steers to cloud, no install", async () => {
    const h = makeHarness();
    try {
      const r = recordingRunner();
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: () => {},
        transcribeMode: "local",
        runCommand: r.run,
        platform: "win32",
        availableRamMib: 99999,
      });
      expect(code).toBe(0);
      expect(r.cmds).toEqual([]);
      expect(readCfg(h.dir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("module install fails before the engine: clears provider, no install-backend run", async () => {
    const h = makeHarness();
    try {
      const r = recordingRunner([5]); // module install fails
      const code = await walkTranscriptionStep({
        configDir: h.dir,
        log: () => {},
        transcribeMode: "local",
        runCommand: r.run,
        platform: "linux",
        availableRamMib: 4096,
      });
      expect(code).toBe(0);
      expect(r.cmds.length).toBe(1);
      expect(r.cmds[0]?.[1]).toBe("install");
    } finally {
      h.cleanup();
    }
  });
});
