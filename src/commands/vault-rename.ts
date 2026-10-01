import { CONFIG_DIR } from "../config.ts";
import { DEFAULT_HUB_BASE_URL } from "../module-ops-client.ts";
import { type VaultRemoveDeps, defaultResolveBearer } from "./vault-remove.ts";

/** Drive the running hub's identity cascade, using the same operator bearer
 * resolver as remove. Never shell directly to the mechanics-only vault CLI. */
export async function vaultRename(args: string[], deps: VaultRemoveDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const names: string[] = [];
  let baseUrl = deps.baseUrl ?? DEFAULT_HUB_BASE_URL;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--yes" || arg === "-y") continue;
    if (arg === "--hub-origin" && args[i + 1]) {
      baseUrl = args[++i]!;
      continue;
    }
    if (arg.startsWith("--hub-origin=")) {
      baseUrl = arg.slice("--hub-origin=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      logError(`Unknown flag: ${arg}`);
      return 1;
    }
    names.push(arg);
  }
  if (names.length !== 2) {
    logError("usage: parachute vault rename <old> <new> [--hub-origin <url>]");
    return 1;
  }
  try {
    const bearer = await (deps.resolveBearer?.() ?? defaultResolveBearer(CONFIG_DIR));
    const response = await (deps.fetch ?? fetch)(
      `${baseUrl.replace(/\/+$/, "")}/vaults/${encodeURIComponent(names[0]!)}/rename`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ new_name: names[1] }),
      },
    );
    const body = await response.json();
    if (!response.ok) {
      logError(`parachute vault rename: ${JSON.stringify(body)}`);
      return 1;
    }
    log(JSON.stringify(body, null, 2));
    return 0;
  } catch (err) {
    logError(
      `parachute vault rename: ${String(err)}. The hub must be running; run parachute start if it is stopped.`,
    );
    return 1;
  }
}
