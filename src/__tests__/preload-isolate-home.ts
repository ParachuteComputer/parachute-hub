/**
 * Sandbox `PARACHUTE_HOME` for the whole test run. Wired as `[test] preload`
 * in `bunfig.toml`, so it applies to `bun test` however it's invoked — not
 * only through `bun run test`, which is not how CI runs the suite.
 *
 * ## Why a preload and not a `beforeEach`
 *
 * `config.ts` computes the config root ONCE, at import time:
 *
 *     export const CONFIG_DIR = configDir();
 *     export const SERVICES_MANIFEST_PATH = join(CONFIG_DIR, "services.json");
 *
 * Every `deps.manifestPath ?? SERVICES_MANIFEST_PATH` fallback in the server
 * (hub-server, api-users, api-vault-caps, account-api, admin-vaults, …) reads
 * that frozen value. By the time a `beforeEach` runs, the constant is already
 * bound to the operator's real `~/.parachute`. Only something that runs BEFORE
 * the first import can move it — hence a preload.
 *
 * ## What was leaking (hub#840)
 *
 * The suite has plenty of per-test temp dirs; the leak is in the handler tests
 * that build a hub server without threading `manifestPath` through `deps`.
 * Measured on `next` by pointing `HOME` at a sentinel and running `bun test
 * ./src`: **116 reads of the live `services.json`** — 84 from
 * `oauth-handlers.test.ts`, 17 from `migrate.test.ts`, 13 from
 * `hub-server.test.ts`, one each from `setup-gate.test.ts` and
 * `admin-lock.test.ts`. Not read-only, either: the same run CREATED
 * `operator.token` (mode 0600) and `well-known/parachute.json` inside the live
 * config dir.
 *
 * On a CI runner that is harmless — there is no `~/.parachute` there, which is
 * why this has never turned CI red. On an operator box it is live supervisor
 * state, and #840 records a test run registering a dead `parachute-app` row at
 * port 1942 into the real manifest.
 *
 * ## Why an EMPTY dir specifically
 *
 * The sandbox reproduces the CI shape: a config root with nothing in it. That
 * matters — seeding it instead is what makes tests fail. The same sentinel run
 * above went 38 red, and every one of those failures was a test reading the
 * sentinel's contents (the `expose` plan tests read the manifest to build their
 * plan). Under an empty root they pass, exactly as they do on CI. Isolation
 * here means "no ambient state", not "different ambient state".
 *
 * Deliberately unconditional: an exported `PARACHUTE_HOME` pointing at the real
 * config root is precisely the case this has to defend against, so honouring a
 * pre-set value would hand the footgun back. An inherited bearer would bypass
 * on-disk isolation the same way; blank it. Tests that need a token inject one
 * explicitly.
 *
 * Bun test does not reliably dispatch process exit hooks, so do not promise
 * cleanup that will not run. The OS reaps these small temp directories.
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

const realHome = join(homedir(), ".parachute");
const sandbox = mkdtempSync(join(tmpdir(), "phub-test-home-"));

if (sandbox === realHome || sandbox.startsWith(`${realHome}${sep}`)) {
  throw new Error(
    `[hub test preload] refusing to run: temporary test home ${sandbox} is inside ` +
      `the live install at ${realHome}; check TMPDIR`,
  );
}

process.env.PARACHUTE_HOME = sandbox;
process.env.PARACHUTE_HUB_TOKEN = "";
