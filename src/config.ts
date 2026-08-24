import { homedir } from "node:os";
import { join, sep } from "node:path";

/**
 * Root config directory. Honors `$PARACHUTE_HOME` to match the convention
 * used by `parachute-vault` — both sides must resolve the same path for the
 * shared `services.json` to round-trip.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PARACHUTE_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".parachute");
}

export const CONFIG_DIR = configDir();
export const SERVICES_MANIFEST_PATH = join(CONFIG_DIR, "services.json");

// bunfig.toml's preload is cwd-sensitive. If a test process imports this
// module without it, fail here instead of freezing CONFIG_DIR onto the live
// install (hub#840). Production (`NODE_ENV` unset / not `test`) is unchanged.
if (process.env.NODE_ENV === "test") {
  const realHome = join(homedir(), ".parachute");
  if (CONFIG_DIR === realHome || CONFIG_DIR.startsWith(`${realHome}${sep}`)) {
    throw new Error(
      `[parachute-hub] refusing to resolve test state inside the live install at ${realHome}; set PARACHUTE_HOME to a temporary directory (the bunfig.toml [test] preload does this automatically)`,
    );
  }
}
