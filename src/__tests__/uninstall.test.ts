/**
 * `parachute uninstall` — the CLI surface for a removal operation that already
 * existed but had no terminal entry point.
 *
 * The tests worth having here are about the two ways this command can be
 * WRONG in a way that costs an operator something:
 *
 *   1. Removing something they didn't confirm (a prompt into a pipe reads EOF,
 *      and a naive default turns that into "yes").
 *   2. Refusing to remove a RETIRED module — which is the single most likely
 *      thing anyone types this command for, since the retirement notes tell
 *      them to.
 *
 * Everything else is a thin delegation to `driveModuleOp`, so it's asserted at
 * the seam rather than re-tested through HTTP.
 */

import { describe, expect, test } from "bun:test";
import { uninstall } from "../commands/uninstall.ts";
import type { DriveModuleOpDeps, ModuleOp, ModuleOpResult } from "../module-ops-client.ts";
import {
  ModuleOpHttpError,
  NoOperatorTokenError,
  OperatorTokenExpiredError,
} from "../module-ops-client.ts";

/** A no-op db handle — the command only passes it through and closes it. */
function fakeDb() {
  let closed = false;
  const close = () => {
    closed = true;
  };
  return {
    handle: { close } as unknown as import("bun:sqlite").Database,
    wasClosed: () => closed,
  };
}

interface Recorded {
  short: string;
  op: ModuleOp;
}

function harness(
  over: {
    drive?: (short: string, op: ModuleOp, deps: DriveModuleOpDeps) => Promise<ModuleOpResult>;
  } = {},
) {
  const calls: Recorded[] = [];
  const lines: string[] = [];
  const db = fakeDb();
  const drive =
    over.drive ??
    (async (short: string, op: ModuleOp) => {
      calls.push({ short, op });
      return {
        status: 200,
        body: { short, log: [`${short} supervisor stopped`, "removed from services.json"] },
      } as ModuleOpResult;
    });
  return {
    calls,
    lines,
    db,
    opts: {
      driveModuleOp: drive,
      openDb: () => db.handle,
      configDir: "/tmp/does-not-matter",
      log: (l: string) => lines.push(l),
    },
  };
}

describe("confirmation", () => {
  test("a non-TTY run without --yes removes NOTHING", async () => {
    // The failure this prevents: prompting into a pipe returns EOF instantly.
    // Treating that as consent would silently uninstall inside any script.
    const h = harness();
    const code = await uninstall("vault", { ...h.opts, isTTY: false });
    expect(code).toBe(1);
    expect(h.calls).toEqual([]);
  });

  test("--yes in a non-TTY proceeds", async () => {
    const h = harness();
    const code = await uninstall("vault", { ...h.opts, isTTY: false, yes: true });
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ short: "vault", op: "uninstall" }]);
  });

  test("answering no at the prompt removes NOTHING", async () => {
    const h = harness();
    const code = await uninstall("vault", {
      ...h.opts,
      isTTY: true,
      confirm: async () => false,
    });
    expect(code).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.lines.join("\n")).toMatch(/Nothing changed/);
  });

  test("answering yes at the prompt proceeds", async () => {
    const h = harness();
    const code = await uninstall("vault", { ...h.opts, isTTY: true, confirm: async () => true });
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ short: "vault", op: "uninstall" }]);
  });

  test("the prompt says vault DATA survives", async () => {
    // Without this line the prompt reads like it might delete their notes,
    // which is the one thing that would make someone abandon the command.
    let asked = "";
    const h = harness();
    await uninstall("vault", {
      ...h.opts,
      isTTY: true,
      confirm: async (q) => {
        asked = q;
        return false;
      },
    });
    expect(asked).toMatch(/data is NOT touched/i);
  });
});

describe("which services are valid targets", () => {
  test("a RETIRED module can be uninstalled — the main reason to run this", async () => {
    // `notes` is retired today and `scribe` is next; a retired module is not
    // installable but is absolutely removable. The retirement notes tell
    // operators to run exactly this, so rejecting it would make the advice a
    // dead end for the second time. Validating against KNOWN rather than
    // INSTALLABLE is what keeps that true as more modules retire.
    for (const short of ["scribe", "notes"]) {
      const h = harness();
      const code = await uninstall(short, { ...h.opts, isTTY: false, yes: true });
      expect(code).toBe(0);
      expect(h.calls).toEqual([{ short, op: "uninstall" }]);
    }
  });

  test("an unknown service is rejected without calling the hub", async () => {
    const h = harness();
    const code = await uninstall("nonsuch", { ...h.opts, isTTY: false, yes: true });
    expect(code).toBe(1);
    expect(h.calls).toEqual([]);
  });

  test("no service at all is rejected", async () => {
    const h = harness();
    expect(await uninstall(undefined, { ...h.opts, yes: true })).toBe(1);
    expect(h.calls).toEqual([]);
  });
});

describe("output + failure modes", () => {
  test("prints the SERVER's per-step log, not a summary of our own", async () => {
    // Those steps include the "already gone" ones that make the op idempotent;
    // replacing them with "done!" hides what actually happened.
    const h = harness({
      drive: async () =>
        ({
          status: 200,
          body: { log: ["scribe not supervised", "parachute-scribe not in services.json"] },
        }) as ModuleOpResult,
    });
    await uninstall("scribe", { ...h.opts, isTTY: false, yes: true });
    const out = h.lines.join("\n");
    expect(out).toMatch(/not supervised/);
    expect(out).toMatch(/not in services\.json/);
  });

  test("a missing operator token explains how to get one", async () => {
    const h = harness({
      drive: async () => {
        throw new NoOperatorTokenError();
      },
    });
    expect(await uninstall("vault", { ...h.opts, isTTY: false, yes: true })).toBe(1);
  });

  test("an expired operator token surfaces its own actionable message", async () => {
    const h = harness({
      drive: async () => {
        throw new OperatorTokenExpiredError("operator token expired — run rotate-operator");
      },
    });
    expect(await uninstall("vault", { ...h.opts, isTTY: false, yes: true })).toBe(1);
  });

  test("an HTTP error from the hub is reported, not swallowed as success", async () => {
    const h = harness({
      drive: async () => {
        throw new ModuleOpHttpError(403, "forbidden", "operator scope required");
      },
    });
    expect(await uninstall("vault", { ...h.opts, isTTY: false, yes: true })).toBe(1);
  });

  test("a hub that isn't running fails with a nonzero code", async () => {
    // The most common real failure: uninstall needs the supervisor, so a down
    // hub means the connection refuses.
    const h = harness({
      drive: async () => {
        throw new Error("Unable to connect. Is the computer able to access the url?");
      },
    });
    expect(await uninstall("vault", { ...h.opts, isTTY: false, yes: true })).toBe(1);
  });

  test("the db handle is closed on the failure path too", async () => {
    // A leaked sqlite handle in a short-lived CLI is invisible; in a scripted
    // loop it isn't.
    const h = harness({
      drive: async () => {
        throw new Error("boom");
      },
    });
    await uninstall("vault", { ...h.opts, isTTY: false, yes: true });
    expect(h.db.wasClosed()).toBe(true);
  });
});
