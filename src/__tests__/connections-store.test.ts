/**
 * Tests for the connections registry store (`connections.json`,
 * `connections-store.ts`). The store's behavior is otherwise exercised
 * indirectly through `admin-connections.test.ts`; this file pins the on-disk
 * shape directly — specifically the `version` field added 2026-07-01 (the
 * future-migration seam) and the legacy-file tolerance that makes it safe.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTIONS_FILE_VERSION,
  type ConnectionRecord,
  getConnection,
  putConnection,
  readConnections,
  removeConnection,
} from "../connections-store.ts";

let dir: string;
let storePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phub-connections-store-"));
  storePath = join(dir, "connections.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rec(over: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: over.id ?? "conn-1",
    source: over.source ?? { module: "vault", vault: "default", event: "note.created" },
    sink: over.sink ?? { module: "agent", action: "message.deliver" },
    provisioned: over.provisioned ?? { type: "vault-trigger", triggerName: "t1", vault: "default" },
    createdAt: over.createdAt ?? "2026-07-01T00:00:00.000Z",
  };
}

describe("file versioning (2026-07-01 — future-migration seam)", () => {
  test("every write stamps version: 1 and put → read round-trips", () => {
    putConnection(storePath, rec());
    const onDisk = JSON.parse(readFileSync(storePath, "utf8")) as { version?: unknown };
    expect(onDisk.version).toBe(CONNECTIONS_FILE_VERSION);
    expect(onDisk.version).toBe(1);
    const back = readConnections(storePath);
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(rec());
    // Rewrites (upsert + remove) keep stamping it.
    putConnection(storePath, rec({ id: "conn-2" }));
    removeConnection(storePath, "conn-1");
    const after = JSON.parse(readFileSync(storePath, "utf8")) as {
      version?: unknown;
      connections: unknown[];
    };
    expect(after.version).toBe(1);
    expect(after.connections).toHaveLength(1);
  });

  test("a LEGACY file without version loads fine (treated as v1)", () => {
    const legacy = rec();
    writeFileSync(storePath, JSON.stringify({ connections: [legacy] }));
    const back = readConnections(storePath);
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(legacy);
    expect(getConnection(storePath, legacy.id)?.id).toBe(legacy.id);
    // First write-through upgrades the file to the versioned shape without
    // losing the legacy record.
    putConnection(storePath, rec({ id: "conn-2" }));
    const upgraded = JSON.parse(readFileSync(storePath, "utf8")) as {
      version?: unknown;
      connections: unknown[];
    };
    expect(upgraded.version).toBe(1);
    expect(upgraded.connections).toHaveLength(2);
  });

  test("a missing or garbage file still reads as empty (fresh hub)", () => {
    expect(readConnections(storePath)).toEqual([]);
    writeFileSync(storePath, "not-json{");
    expect(readConnections(storePath)).toEqual([]);
  });
});
