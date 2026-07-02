import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HubInstanceRecord,
  type LoopbackProbe,
  type SelfProbeState,
  armHubSelfProbe,
  classifyLoopback,
  generateInstanceNonce,
  hijackAlertMessage,
  hubInstancePath,
  probeLoopbackInstance,
  readHubInstanceFile,
  writeHubInstanceFile,
} from "../hub-instance.ts";

/**
 * hub#737 loopback-hijack detection. The nonce file is the linchpin — an
 * external process learns THIS hub's true identity from disk, then compares it
 * to what a (possibly hijacked) loopback /health returns. Every side effect
 * (fs, network) is exercised against a tmp dir / injected fetch.
 */

function makeDir(): { configDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "parachute-instance-test-"));
  return { configDir: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function record(over: Partial<HubInstanceRecord> = {}): HubInstanceRecord {
  return {
    instance: "nonce-1",
    pid: 4242,
    port: 1939,
    startedAt: "2026-07-02T00:00:00.000Z",
    ...over,
  };
}

describe("nonce + instance file", () => {
  test("generateInstanceNonce yields distinct UUID-shaped values", () => {
    const a = generateInstanceNonce();
    const b = generateInstanceNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("write → read round-trips the record (incl. selfProbe)", () => {
    const { configDir, cleanup } = makeDir();
    try {
      const sp: SelfProbeState = {
        status: "ok",
        checkedAt: "2026-07-02T00:01:00.000Z",
      };
      expect(writeHubInstanceFile(record({ selfProbe: sp }), { configDir })).toBe(true);
      const back = readHubInstanceFile(configDir);
      expect(back?.instance).toBe("nonce-1");
      expect(back?.port).toBe(1939);
      expect(back?.pid).toBe(4242);
      expect(back?.selfProbe?.status).toBe("ok");
      // Written 0644 (world-readable diagnostic aid, not a secret).
      const raw = readFileSync(hubInstancePath(configDir), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("read returns null on absent / malformed / instance-less files", () => {
    const { configDir, cleanup } = makeDir();
    try {
      expect(readHubInstanceFile(configDir)).toBeNull(); // absent
      writeFileSync(hubInstancePath(configDir), "not json{");
      expect(readHubInstanceFile(configDir)).toBeNull(); // malformed
      writeFileSync(hubInstancePath(configDir), JSON.stringify({ port: 1939 }));
      expect(readHubInstanceFile(configDir)).toBeNull(); // no instance field
    } finally {
      cleanup();
    }
  });

  test("write failure is swallowed (returns false, logs) — never throws", () => {
    const logs: string[] = [];
    // An un-writable path (a file where a dir must be) forces the mkdir/write to
    // fail; the helper must degrade, not throw.
    const { configDir, cleanup } = makeDir();
    try {
      const filePath = join(configDir, "blocker");
      writeFileSync(filePath, "x");
      const ok = writeHubInstanceFile(record(), {
        configDir: join(filePath, "nested"),
        log: (l) => logs.push(l),
      });
      expect(ok).toBe(false);
      expect(logs.length).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("classifyLoopback", () => {
  test("unreachable when the probe didn't answer", () => {
    expect(classifyLoopback("n1", { reachable: false })).toBe("unreachable");
  });
  test("ok when the returned instance matches ours", () => {
    expect(classifyLoopback("n1", { reachable: true, status: 200, instance: "n1" })).toBe("ok");
  });
  test("hijacked when a different instance answers", () => {
    expect(classifyLoopback("n1", { reachable: true, status: 200, instance: "n2" })).toBe(
      "hijacked",
    );
  });
  test("hijacked when a reachable process carries NO instance (old/foreign hub)", () => {
    expect(classifyLoopback("n1", { reachable: true, status: 200 })).toBe("hijacked");
  });
});

describe("probeLoopbackInstance", () => {
  test("extracts instance + isHub from a well-formed /health body", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ service: "parachute-hub", instance: "xyz" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const out = await probeLoopbackInstance(1939, { fetchFn });
    expect(out).toEqual({ reachable: true, status: 200, instance: "xyz", isHub: true });
  });

  test("reachable-but-junk body → reachable with no instance (foreign server shape)", async () => {
    const fetchFn = (async () =>
      new Response("<html>not a hub</html>", { status: 200 })) as unknown as typeof fetch;
    const out = await probeLoopbackInstance(1939, { fetchFn });
    expect(out.reachable).toBe(true);
    expect(out.instance).toBeUndefined();
    expect(out.isHub).toBeUndefined();
  });

  test("network error → not reachable, never throws", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const out = await probeLoopbackInstance(1939, { fetchFn });
    expect(out).toEqual({ reachable: false });
  });
});

describe("armHubSelfProbe", () => {
  /** A probe stub that returns a fixed LoopbackProbe. */
  function fixedProbe(p: LoopbackProbe): (port: number) => Promise<LoopbackProbe> {
    return async () => p;
  }

  test("ok verdict: writes state, stays quiet (no loud log)", async () => {
    const logs: string[] = [];
    const states: SelfProbeState[] = [];
    const probe = armHubSelfProbe(
      { port: 1939, nonce: "n1", record: record() },
      {
        probe: fixedProbe({ reachable: true, status: 200, instance: "n1" }),
        writeState: (s) => states.push(s),
        log: (l) => logs.push(l),
        setIntervalFn: () => 0,
      },
    );
    const verdict = await probe.probeOnce();
    expect(verdict).toBe("ok");
    expect(logs).toEqual([]);
    expect(states.at(-1)?.status).toBe("ok");
  });

  test("hijacked verdict: LOUD alert on EVERY probe + observedInstance persisted", async () => {
    const logs: string[] = [];
    const states: SelfProbeState[] = [];
    const probe = armHubSelfProbe(
      { port: 1939, nonce: "n1", record: record() },
      {
        probe: fixedProbe({ reachable: true, status: 200, instance: "rogue-9" }),
        writeState: (s) => states.push(s),
        log: (l) => logs.push(l),
        setIntervalFn: () => 0,
      },
    );
    expect(await probe.probeOnce()).toBe("hijacked");
    expect(await probe.probeOnce()).toBe("hijacked");
    // Repeated verbatim — a hijack is a standing emergency, not a one-shot.
    expect(logs.length).toBe(2);
    expect(logs[0]).toContain("LOOPBACK HIJACK");
    expect(logs[0]).toContain("lsof -nP -iTCP:1939");
    expect(states.at(-1)?.observedInstance).toBe("rogue-9");
    expect(states.at(-1)?.status).toBe("hijacked");
  });

  test("unreachable verdict: logs ONCE per state change, not per tick", async () => {
    const logs: string[] = [];
    const probe = armHubSelfProbe(
      { port: 1939, nonce: "n1", record: record() },
      {
        probe: fixedProbe({ reachable: false }),
        writeState: () => {},
        log: (l) => logs.push(l),
        setIntervalFn: () => 0,
      },
    );
    await probe.probeOnce();
    await probe.probeOnce();
    expect(logs.length).toBe(1); // second consecutive unreachable is silent
    expect(logs[0]).toContain("did not answer");
  });

  test("recovery: hijacked → ok logs a single 'cleared' line", async () => {
    const logs: string[] = [];
    let current: LoopbackProbe = { reachable: true, status: 200, instance: "rogue" };
    const probe = armHubSelfProbe(
      { port: 1939, nonce: "n1", record: record() },
      {
        probe: async () => current,
        writeState: () => {},
        log: (l) => logs.push(l),
        setIntervalFn: () => 0,
      },
    );
    expect(await probe.probeOnce()).toBe("hijacked");
    current = { reachable: true, status: 200, instance: "n1" };
    expect(await probe.probeOnce()).toBe("ok");
    expect(logs.length).toBe(2);
    expect(logs[1]).toContain("Hijack cleared");
  });

  test("stop() clears the interval handle", () => {
    let cleared: unknown;
    const probe = armHubSelfProbe(
      { port: 1939, nonce: "n1", record: record() },
      {
        probe: fixedProbe({ reachable: true, instance: "n1" }),
        writeState: () => {},
        setIntervalFn: () => "the-handle",
        clearIntervalFn: (h) => {
          cleared = h;
        },
      },
    );
    probe.stop();
    expect(cleared).toBe("the-handle");
  });

  test("default writeState patches selfProbe into the real instance file", async () => {
    const { configDir, cleanup } = makeDir();
    try {
      const rec = record();
      writeHubInstanceFile(rec, { configDir });
      const probe = armHubSelfProbe(
        { port: 1939, nonce: "n1", record: rec, configDir },
        {
          probe: fixedProbe({ reachable: true, status: 200, instance: "someone-else" }),
          log: () => {},
          setIntervalFn: () => 0,
        },
      );
      await probe.probeOnce();
      const back = readHubInstanceFile(configDir);
      expect(back?.selfProbe?.status).toBe("hijacked");
      expect(back?.instance).toBe("nonce-1"); // base record preserved
    } finally {
      cleanup();
    }
  });
});

describe("hijackAlertMessage", () => {
  test("names the observed instance + the diagnosis commands + incident ref", () => {
    const msg = hijackAlertMessage(1939, "rogue-42");
    expect(msg).toContain("instance=rogue-42");
    expect(msg).toContain("lsof -nP -iTCP:1939 -sTCP:LISTEN");
    expect(msg).toContain("orb list");
    expect(msg).toContain("hub#737");
  });
  test("degrades gracefully when the foreign process carries no nonce", () => {
    const msg = hijackAlertMessage(1939);
    expect(msg).toContain("no hub instance nonce");
  });
});
