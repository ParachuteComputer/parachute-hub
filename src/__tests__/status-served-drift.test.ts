import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { status } from "../commands/status.ts";
import type { DetectServedResolutionDeps } from "../install-source.ts";

/**
 * Wiring test for the hub#780 served-bundle guardrail — the EXECUTING proof
 * that `status()` actually calls `detectServedResolution` + `servedDivergenceNote`
 * and prints the `! SERVED-DRIFT:` continuation line on a real row. The pure
 * formatter is covered in `install-source.test.ts`; this drives the whole
 * `status()` pipeline so a silently-severed wire (working-and-quiet vs
 * dead-and-quiet, indistinguishable without an executing call) is caught.
 *
 * No service-manager subprocess runs: every platform-manager read
 * (`probeHubHealth`, `queryHubUnitState`, `readInstanceState`) is stubbed via
 * the `supervisor` seams, so the service-manager-shelling code is never
 * reached. The `probeHubHealth: false` (hub-down) row path is used
 * deliberately — it carries `base.servedNote` onto the row without needing the
 * operator-token / DB / module-states machinery.
 */

const APP_PKG = "@openparachute/app";
const HOME = "/home/op";
// The stale install-cache copy the shim would resolve — the hub#780 shape.
const CACHE_ROOT = join(
  HOME,
  ".bun/install/cache",
  `${APP_PKG}@0.22.5@@@1`,
  "node_modules",
  APP_PKG,
);
// Where the bun-global link (the SOURCE column's truth) actually points.
const LINK_ROOT = join(HOME, ".bun/install/global/node_modules", APP_PKG);

/**
 * A services.json carrying a single shim-served row: `parachute-app` resolves
 * to short `app`, whose spec `startCmd` runs `notes-serve.ts` — the exact
 * `shimServed` signal `manifestRowBase` keys the guardrail on. Written to disk
 * so `status()` reads it through the real `readManifest` path.
 */
function writeAppManifest(dir: string): string {
  const manifestPath = join(dir, "services.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      services: [
        {
          name: "parachute-app",
          port: 1944,
          paths: ["/app"],
          health: "/app/health",
          version: "0.22.9",
        },
      ],
    })}\n`,
  );
  return manifestPath;
}

/**
 * Force the served bundle to diverge from the global link: the shim resolves
 * the stale cache copy (v0.22.5) while `resolveBunGlobal` reports the link.
 * `resolveSync` returns the cache copy for whichever candidate base is walked.
 */
function divergentServedDeps(): DetectServedResolutionDeps {
  return {
    home: HOME,
    cwd: "/",
    resolveSync: (_specifier: string, _base: string) => join(CACHE_ROOT, "package.json"),
    existsSync: () => true,
    readJson: (_path: string) => ({ version: "0.22.5" }),
    resolveBunGlobal: (_pkg: string) => LINK_ROOT,
  };
}

/**
 * Consistent resolution: the shim lands on the same root the link points at,
 * so the guardrail must stay silent (the post-fix healthy shape).
 */
function consistentServedDeps(): DetectServedResolutionDeps {
  return {
    home: HOME,
    cwd: "/",
    resolveSync: (_specifier: string, _base: string) => join(LINK_ROOT, "package.json"),
    existsSync: () => true,
    readJson: (_path: string) => ({ version: "0.22.9" }),
    resolveBunGlobal: (_pkg: string) => LINK_ROOT,
  };
}

/**
 * Hub-down supervisor stubs — every platform-manager read replaced so nothing
 * shells out. `probeHubHealth: false` selects the hub-is-down module-row
 * branch, which still carries `servedNote`.
 */
const downSupervisor = {
  probeHubHealth: async () => false,
  queryHubUnitState: () => ({ state: "inactive" as const }),
  readInstanceState: () => undefined,
};

async function runStatus(servedResolutionDeps: DetectServedResolutionDeps): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "hub780-status-"));
  const lines: string[] = [];
  try {
    await status({
      manifestPath: writeAppManifest(dir),
      configDir: dir,
      print: (line) => lines.push(line),
      servedResolutionDeps,
      supervisor: downSupervisor,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return lines;
}

describe("status() served-drift wiring (hub#780)", () => {
  test("prints the ! SERVED-DRIFT: line for a shim-served row whose bundle diverges from its link", async () => {
    const lines = await runStatus(divergentServedDeps());

    const drift = lines.find((l) => l.includes("SERVED-DRIFT"));
    // The whole point of the guardrail: this line must appear. If the wiring
    // (the detectServedResolution call, or the `if (row.servedNote) print(...)`)
    // is severed, `drift` is undefined and this fails.
    expect(drift).toBeDefined();
    // Assert the exact continuation line — identity of the specific signal, not
    // just "some line printed": the `  ! ` prefix, the served (stale) version,
    // the served path, and the diverging link path all have to be right.
    expect(drift).toBe(
      `  ! SERVED-DRIFT: serving ${APP_PKG}@0.22.5 from ${CACHE_ROOT}, not the global link at ${LINK_ROOT} — clear the stale \`~/.bun/install/cache\` entry and \`bun link\` the checkout, then restart`,
    );
  });

  test("stays silent when the shim resolves the same root the link points at (post-fix healthy shape)", async () => {
    const lines = await runStatus(consistentServedDeps());

    // The app row is still rendered (proves status() ran + built the row) …
    expect(lines.some((l) => l.includes("parachute-app"))).toBe(true);
    // … but with consistent resolution the guardrail must NOT fire. This makes
    // the positive test above discriminating: the pipeline emits the note only
    // on genuine divergence, not unconditionally.
    expect(lines.some((l) => l.includes("SERVED-DRIFT"))).toBe(false);
  });
});
