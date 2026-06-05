import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CloudflaredState,
  CloudflaredStateError,
  type CloudflaredTunnelRecord,
  clearCloudflaredState,
  clearPendingHostname,
  findTunnelRecord,
  listTunnelRecords,
  readCloudflaredState,
  readPendingHostname,
  withTunnelRecord,
  withoutTunnelRecord,
  writeCloudflaredState,
  writePendingHostname,
} from "../cloudflare/state.ts";

function makeTempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-cfstate-"));
  return {
    path: join(dir, "cloudflared-state.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const sampleRecord: CloudflaredTunnelRecord = {
  pid: 12345,
  tunnelUuid: "2c1a7c7e-1234-5678-9abc-def012345678",
  tunnelName: "parachute",
  hostname: "vault.example.com",
  startedAt: "2026-04-22T12:00:00.000Z",
  configPath: "/home/x/.parachute/cloudflared/parachute/config.yml",
};

const sample: CloudflaredState = {
  version: 2,
  tunnels: { parachute: sampleRecord },
};

describe("cloudflared state", () => {
  test("read returns undefined when the file doesn't exist", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(readCloudflaredState(path)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("write + read round-trip", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeCloudflaredState(sample, path);
      expect(readCloudflaredState(path)).toEqual(sample);
    } finally {
      cleanup();
    }
  });

  test("clear removes the file", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeCloudflaredState(sample, path);
      expect(existsSync(path)).toBe(true);
      clearCloudflaredState(path);
      expect(existsSync(path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("throws on unsupported version", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, JSON.stringify({ version: 99, tunnels: {} }));
      expect(() => readCloudflaredState(path)).toThrow(/unsupported version/);
    } finally {
      cleanup();
    }
  });

  test("throws on non-positive pid in a tunnel record", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          tunnels: { parachute: { ...sampleRecord, pid: -1 } },
        }),
      );
      expect(() => readCloudflaredState(path)).toThrow(CloudflaredStateError);
    } finally {
      cleanup();
    }
  });

  test("throws when tunnel record's name doesn't match its key", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          tunnels: { parachute: { ...sampleRecord, tunnelName: "different" } },
        }),
      );
      expect(() => readCloudflaredState(path)).toThrow(/must equal its key/);
    } finally {
      cleanup();
    }
  });

  test("throws on malformed JSON", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, "{not json");
      expect(() => readCloudflaredState(path)).toThrow(/failed to parse/);
    } finally {
      cleanup();
    }
  });

  test("migrates v1 single-record state to v2 on read", () => {
    const { path, cleanup } = makeTempPath();
    try {
      // v1 — pre-#32 shape with the single record at the top level. cloudflared
      // installs in the wild may still have this on disk; reading it must not
      // explode and must yield the canonical v2 shape.
      const legacy = {
        version: 1,
        pid: 12345,
        tunnelUuid: "2c1a7c7e-1234-5678-9abc-def012345678",
        tunnelName: "parachute",
        hostname: "vault.example.com",
        startedAt: "2026-04-22T12:00:00.000Z",
        configPath: "/home/x/.parachute/cloudflared/config.yml",
      };
      writeFileSync(path, JSON.stringify(legacy));

      const state = readCloudflaredState(path);
      expect(state).toEqual({
        version: 2,
        tunnels: {
          parachute: {
            pid: 12345,
            tunnelUuid: "2c1a7c7e-1234-5678-9abc-def012345678",
            tunnelName: "parachute",
            hostname: "vault.example.com",
            startedAt: "2026-04-22T12:00:00.000Z",
            configPath: "/home/x/.parachute/cloudflared/config.yml",
          },
        },
      });
    } finally {
      cleanup();
    }
  });

  test("v1 migration is read-only until the next write", () => {
    // The migration is silent on read but doesn't rewrite disk on its own —
    // disk only flips when the next write commits. Mirrors how other state
    // migrations in the repo behave; documents the contract.
    const { path, cleanup } = makeTempPath();
    try {
      const legacy = {
        version: 1,
        pid: 12345,
        tunnelUuid: "2c1a7c7e-1234-5678-9abc-def012345678",
        tunnelName: "parachute",
        hostname: "vault.example.com",
        startedAt: "2026-04-22T12:00:00.000Z",
        configPath: "/home/x/.parachute/cloudflared/config.yml",
      };
      writeFileSync(path, JSON.stringify(legacy));
      readCloudflaredState(path); // returns v2 in memory
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      expect(onDisk.version).toBe(1);

      // After a write, disk reflects v2.
      const state = readCloudflaredState(path);
      writeCloudflaredState(state as CloudflaredState, path);
      const onDiskAfter = JSON.parse(readFileSync(path, "utf8"));
      expect(onDiskAfter.version).toBe(2);
      expect(onDiskAfter.tunnels.parachute.tunnelName).toBe("parachute");
    } finally {
      cleanup();
    }
  });
});

describe("cloudflared state — record helpers", () => {
  const recordA: CloudflaredTunnelRecord = {
    pid: 1001,
    tunnelUuid: "aaaaaaaa-0000-0000-0000-000000000001",
    tunnelName: "alpha",
    hostname: "alpha.example.com",
    startedAt: "2026-04-23T10:00:00.000Z",
    configPath: "/tmp/alpha/config.yml",
  };
  const recordB: CloudflaredTunnelRecord = {
    pid: 1002,
    tunnelUuid: "bbbbbbbb-0000-0000-0000-000000000002",
    tunnelName: "beta",
    hostname: "beta.example.com",
    startedAt: "2026-04-23T11:00:00.000Z",
    configPath: "/tmp/beta/config.yml",
  };

  test("findTunnelRecord returns undefined for unknown name and the record for known name", () => {
    const state: CloudflaredState = { version: 2, tunnels: { alpha: recordA } };
    expect(findTunnelRecord(state, "alpha")).toEqual(recordA);
    expect(findTunnelRecord(state, "beta")).toBeUndefined();
    expect(findTunnelRecord(undefined, "alpha")).toBeUndefined();
  });

  test("withTunnelRecord inserts into empty/undefined state", () => {
    const next = withTunnelRecord(undefined, recordA);
    expect(next).toEqual({ version: 2, tunnels: { alpha: recordA } });
  });

  test("withTunnelRecord adds a second tunnel without disturbing the first", () => {
    const initial = withTunnelRecord(undefined, recordA);
    const next = withTunnelRecord(initial, recordB);
    expect(next.tunnels).toEqual({ alpha: recordA, beta: recordB });
  });

  test("withTunnelRecord replaces an existing record under the same name", () => {
    const initial = withTunnelRecord(undefined, recordA);
    const replaced: CloudflaredTunnelRecord = { ...recordA, pid: 9999 };
    const next = withTunnelRecord(initial, replaced);
    expect(next.tunnels.alpha).toEqual(replaced);
    expect(Object.keys(next.tunnels)).toEqual(["alpha"]);
  });

  test("withoutTunnelRecord drops the named tunnel and returns undefined when empty", () => {
    const initial = withTunnelRecord(undefined, recordA);
    expect(withoutTunnelRecord(initial, "alpha")).toBeUndefined();
  });

  test("withoutTunnelRecord leaves other tunnels in place", () => {
    const both = withTunnelRecord(withTunnelRecord(undefined, recordA), recordB);
    const next = withoutTunnelRecord(both, "alpha");
    expect(next).toEqual({ version: 2, tunnels: { beta: recordB } });
  });

  test("listTunnelRecords returns sorted-by-name order", () => {
    const both = withTunnelRecord(withTunnelRecord(undefined, recordB), recordA);
    expect(listTunnelRecords(both).map((r) => r.tunnelName)).toEqual(["alpha", "beta"]);
    expect(listTunnelRecords(undefined)).toEqual([]);
  });
});

describe("hub#567 pending hostname", () => {
  test("read returns undefined when no state file / no pending hostname", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(readPendingHostname(path)).toBeUndefined();
      writeCloudflaredState(sample, path);
      expect(readPendingHostname(path)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("write then read round-trips the pending hostname (seeds empty state)", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writePendingHostname("techne.parachute.computer", path);
      expect(readPendingHostname(path)).toBe("techne.parachute.computer");
      const state = readCloudflaredState(path);
      expect(state?.pendingHostname).toBe("techne.parachute.computer");
      expect(state?.tunnels).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("write preserves existing tunnel records", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeCloudflaredState(sample, path);
      writePendingHostname("techne.parachute.computer", path);
      const state = readCloudflaredState(path);
      expect(state?.pendingHostname).toBe("techne.parachute.computer");
      expect(state?.tunnels.parachute).toEqual(sampleRecord);
    } finally {
      cleanup();
    }
  });

  test("clear drops the pending hostname but keeps tunnel records", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeCloudflaredState({ ...sample, pendingHostname: "techne.parachute.computer" }, path);
      clearPendingHostname(path);
      const state = readCloudflaredState(path);
      expect(state?.pendingHostname).toBeUndefined();
      expect(state?.tunnels.parachute).toEqual(sampleRecord);
    } finally {
      cleanup();
    }
  });

  test("clear removes the state file entirely when no tunnels remain", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writePendingHostname("techne.parachute.computer", path);
      expect(existsSync(path)).toBe(true);
      clearPendingHostname(path);
      expect(existsSync(path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("validate preserves a pending hostname round-tripped through the bytes", () => {
    const { path, cleanup } = makeTempPath();
    try {
      const withPending: CloudflaredState = { ...sample, pendingHostname: "a.example.com" };
      writeCloudflaredState(withPending, path);
      expect(readCloudflaredState(path)).toEqual(withPending);
    } finally {
      cleanup();
    }
  });

  test("withTunnelRecord preserves an existing pending hostname", () => {
    const seed: CloudflaredState = { version: 2, tunnels: {}, pendingHostname: "a.example.com" };
    const next = withTunnelRecord(seed, sampleRecord);
    expect(next.pendingHostname).toBe("a.example.com");
    expect(next.tunnels.parachute).toEqual(sampleRecord);
  });

  test("withoutTunnelRecord carries the pending hostname when it's the only thing left", () => {
    const seed: CloudflaredState = {
      version: 2,
      tunnels: { parachute: sampleRecord },
      pendingHostname: "a.example.com",
    };
    // Removing the last tunnel must NOT discard a typed-but-not-routed hostname.
    expect(withoutTunnelRecord(seed, "parachute")).toEqual({
      version: 2,
      tunnels: {},
      pendingHostname: "a.example.com",
    });
  });

  test("withoutTunnelRecord returns undefined when no tunnels AND no pending hostname remain", () => {
    const seed: CloudflaredState = { version: 2, tunnels: { parachute: sampleRecord } };
    expect(withoutTunnelRecord(seed, "parachute")).toBeUndefined();
  });
});
