/**
 * Vault-name list — the single source of truth for "which vault instances are
 * registered on this hub right now."
 *
 * Multi-user Phase 1, PR 4 of 5 (design
 * [`parachute.computer/design/2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/)).
 * Consolidates the two pre-PR-4 copies that read services.json and emitted
 * vault names — one was private inside `oauth-handlers.ts` (used by the
 * consent vault picker + post-consent narrowing), the other was private
 * inside `api-users.ts` (used by `GET /api/users/vaults` for the admin SPA's
 * assigned-vault dropdown + `POST /api/users` validation). PR 4 wires a third
 * caller — server-side defense in `handleConsentSubmit` refusing mints
 * whose picked vault disagrees with the user's `assigned_vault` — so the
 * two private copies became three, and a duplicated read-and-derive helper
 * for "what vaults exist" is exactly the shape that needs a single owner.
 *
 * Lives next to `well-known.ts` (which already owns `isVaultEntry` +
 * `vaultInstanceNameFor`) rather than inside it: well-known's role is the
 * `/.well-known/parachute.json` document shape, and a free-floating list
 * helper would muddy that file's surface. Standalone module keeps the
 * focused-purpose contract.
 *
 * Walks both manifest shapes: single-entry-multi-path (`parachute-vault`
 * with `paths: ["/vault/work", "/vault/personal"]`) and per-vault entries
 * (`parachute-vault-work`) by delegating each (name, path) pair to
 * `vaultInstanceNameFor`.
 *
 * #478: an empty-paths vault row (e.g. `parachute-vault` with `paths: []`,
 * which vault's self-register emits at zero vaults) is "installed but no
 * servable vault instance" and is SKIPPED entirely — it must not synthesize a
 * name (the bare `parachute-vault` would otherwise resolve to a phantom
 * "default"). This mirrors the empty-paths `continue` in `admin-vaults.ts`'s
 * `findExistingVault`/`listVaultInstanceNames`, so every read path agrees: a
 * vault instance is named only by a real `/vault/<name>` mount path. This
 * supersedes the prior hub#143 manifest-suffix fallback for path-less entries
 * — a registered vault carries its mount path once a vault exists.
 */
import { type ServicesManifest, readManifestLenient } from "./services-manifest.ts";
import { isVaultEntry, vaultInstanceNameFor } from "./well-known.ts";

/**
 * Emit each vault instance's name from an in-memory manifest. Sorted output
 * keeps callers (consent picker dropdown, admin SPA dropdown, server-side
 * defense lookup) deterministic without each having to wrap in their own
 * `.sort()`.
 */
export function listVaultNames(manifest: ServicesManifest): string[] {
  const names = new Set<string>();
  for (const svc of manifest.services) {
    if (!isVaultEntry(svc)) continue;
    // #478: an empty-paths vault row means "installed but no servable vault
    // instance" — skip it so it never synthesizes a phantom "default".
    if (svc.paths.length === 0) continue;
    for (const path of svc.paths) {
      names.add(vaultInstanceNameFor(svc.name, path));
    }
  }
  return Array.from(names).sort();
}

/**
 * Read-from-disk convenience for callers that already have a manifest path
 * (e.g. `/api/users/vaults` reading the live `services.json`). Equivalent to
 * `listVaultNames(readManifestLenient(manifestPath))`.
 */
export function listVaultNamesFromPath(manifestPath: string): string[] {
  return listVaultNames(readManifestLenient(manifestPath));
}
