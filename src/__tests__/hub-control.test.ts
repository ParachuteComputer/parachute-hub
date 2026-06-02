import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearHubPort, hubPortPath, readHubPort, stopHub, writeHubPort } from "../hub-control.ts";
import { pidPath, readPid, writePid } from "../process-state.ts";

interface Harness {
  configDir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-hub-ctl-"));
  return {
    configDir: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("port persistence helpers", () => {
  test("writeHubPort + readHubPort round-trip", () => {
    const h = makeHarness();
    try {
      writeHubPort(1942, h.configDir);
      expect(readHubPort(h.configDir)).toBe(1942);
      expect(existsSync(hubPortPath(h.configDir))).toBe(true);
      clearHubPort(h.configDir);
      expect(readHubPort(h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("stopHub", () => {
  test("SIGTERMs running hub, clears pid + port", async () => {
    const h = makeHarness();
    try {
      writePid("hub", 4242, h.configDir);
      writeHubPort(1939, h.configDir);
      let aliveNow = true;
      const signals: NodeJS.Signals[] = [];
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: (_pid, sig) => {
          signals.push(sig as NodeJS.Signals);
          aliveNow = false;
        },
        alive: () => aliveNow,
        sleep: async () => {},
        now: () => 0,
        pidOnPort: () => undefined,
      });
      expect(stopped).toBe(true);
      expect(signals).toEqual(["SIGTERM"]);
      expect(existsSync(pidPath("hub", h.configDir))).toBe(false);
      expect(readHubPort(h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("escalates to SIGKILL when SIGTERM doesn't land", async () => {
    const h = makeHarness();
    try {
      writePid("hub", 4242, h.configDir);
      writeHubPort(1939, h.configDir);
      let t = 0;
      const signals: NodeJS.Signals[] = [];
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: (_pid, sig) => {
          signals.push(sig as NodeJS.Signals);
        },
        alive: () => true,
        sleep: async () => {
          t += 1000;
        },
        now: () => t,
        killWaitMs: 100,
        pollIntervalMs: 10,
        pidOnPort: () => undefined,
      });
      expect(stopped).toBe(true);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      h.cleanup();
    }
  });

  test("no-op + cleans port file when no pid recorded and port is free", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: () => {
          throw new Error("must not be called");
        },
        alive: () => true,
        sleep: async () => {},
        now: () => 0,
        pidOnPort: () => undefined,
      });
      expect(stopped).toBe(false);
      expect(readHubPort(h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("stale pid (process already gone) + port free clears state without killing", async () => {
    const h = makeHarness();
    try {
      writePid("hub", 77, h.configDir);
      writeHubPort(1939, h.configDir);
      let killCalled = false;
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: () => {
          killCalled = true;
        },
        alive: () => false,
        sleep: async () => {},
        now: () => 0,
        pidOnPort: () => undefined,
      });
      expect(stopped).toBe(false);
      expect(killCalled).toBe(false);
      expect(existsSync(pidPath("hub", h.configDir))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  // hub#287: orphan-detection paths. The bug shape is "hub.port is missing
  // or stale, but a bun process is still holding 1939, so `parachute stop
  // hub` says 'wasn't running' and the next `parachute start hub` fails
  // with EADDRINUSE." Three variations exercised below.

  test("hub#287: stale hub.port + orphan bound to canonical port → adopts + kills", async () => {
    // Pidfile names a dead process; lsof reveals a *different* PID is the
    // actual orphan holder. stopHub clears the stale pidfile, adopts the
    // orphan, and SIGTERMs it.
    const h = makeHarness();
    try {
      writePid("hub", 77, h.configDir);
      writeHubPort(1939, h.configDir);
      const killedPids: number[] = [];
      const log: string[] = [];
      let orphanAlive = true;
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: (pid, _sig) => {
          killedPids.push(pid);
          orphanAlive = false;
        },
        // Stale recorded pid (77) is dead; orphan PID (4242) is alive.
        alive: (pid) => (pid === 77 ? false : orphanAlive),
        sleep: async () => {},
        now: () => 0,
        pidOnPort: () => 4242,
        log: (l) => log.push(l),
      });
      expect(stopped).toBe(true);
      expect(killedPids).toEqual([4242]);
      expect(existsSync(pidPath("hub", h.configDir))).toBe(false);
      expect(readHubPort(h.configDir)).toBeUndefined();
      const out = log.join("\n");
      expect(out).toMatch(/Detected orphan hub process holding port 1939 \(PID 4242\)/);
      expect(out).toMatch(/✓ orphan hub process \(PID 4242\) stopped/);
    } finally {
      h.cleanup();
    }
  });

  test("hub#287: missing hub.port + orphan bound to canonical port → adopts + kills", async () => {
    // No pidfile, no port file — but lsof finds a bun proc on 1939.
    // stopHub adopts and kills it (this is the exact repro Aaron filed).
    const h = makeHarness();
    try {
      const killedPids: number[] = [];
      const log: string[] = [];
      let orphanAlive = true;
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: (pid, _sig) => {
          killedPids.push(pid);
          orphanAlive = false;
        },
        alive: () => orphanAlive,
        sleep: async () => {},
        now: () => 0,
        pidOnPort: () => 9999,
        log: (l) => log.push(l),
      });
      expect(stopped).toBe(true);
      expect(killedPids).toEqual([9999]);
      expect(log.join("\n")).toMatch(/Detected orphan hub process holding port 1939 \(PID 9999\)/);
    } finally {
      h.cleanup();
    }
  });

  test("hub#287: no orphan reported and no pidfile → genuine no-op", async () => {
    // The "hub really wasn't running" path stays clean — no false orphan
    // adoption when lsof returns nothing.
    const h = makeHarness();
    try {
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: () => {
          throw new Error("must not be called");
        },
        alive: () => true,
        sleep: async () => {},
        now: () => 0,
        pidOnPort: () => undefined,
      });
      expect(stopped).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("hub#287: orphan PID reported but already dead → treated as no-op", async () => {
    // Race window: lsof said port was held but the orphan exited before
    // we could signal it. alive() returns false, so we don't try to kill
    // a phantom — clean exit as "wasn't running".
    const h = makeHarness();
    try {
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: () => {
          throw new Error("must not be called");
        },
        alive: () => false,
        sleep: async () => {},
        now: () => 0,
        pidOnPort: () => 1234,
      });
      expect(stopped).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});
