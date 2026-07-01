import { join } from "node:path";
import { readExposeState } from "./expose-state.ts";
import { HUB_DEFAULT_PORT, readHubPort } from "./hub-control.ts";
import { deriveHubOrigin } from "./hub-origin.ts";

/**
 * Resolve the hub origin used as `iss` for operator-minted tokens (the CLI mint
 * paths: `auth mint-token`, `auth revoke-token`, `surface token …`). Mirrors
 * `lifecycle.resolveHubOrigin`'s order, but falls back to the canonical loopback
 * (`http://127.0.0.1:1939`) instead of `undefined` — operator-minted tokens MUST
 * carry an issuer, and on first-run before any expose has happened the canonical
 * loopback is what services will validate against.
 *
 * Hoisted out of `commands/auth.ts` so every operator-mint surface resolves the
 * issuer identically — a divergence here would mint tokens whose `iss` fails the
 * resource server's strict check even when scopes match.
 */
export function resolveHubIssuer(override: string | undefined, configDir: string): string {
  if (override) {
    const fromOverride = deriveHubOrigin({ override });
    if (fromOverride) return fromOverride;
  }
  const state = readExposeState(join(configDir, "expose-state.json"));
  if (state?.hubOrigin) return state.hubOrigin;
  const exposeFqdn = state?.canonicalFqdn;
  return (
    deriveHubOrigin({ exposeFqdn, hubPort: readHubPort(configDir) }) ??
    `http://127.0.0.1:${HUB_DEFAULT_PORT}`
  );
}
