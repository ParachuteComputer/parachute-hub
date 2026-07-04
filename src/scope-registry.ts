/**
 * Scope registry — the issuer's view of which OAuth scopes are blessed.
 *
 * The hub signs JWTs whose `scope` claim is the contract the resource server
 * trusts. Issuing a token with a scope no module ever declared is a protocol
 * violation: in Phase B2 (multi-RS validation), an unknown scope reaching a
 * downstream service should be rejected, but defense-in-depth says don't
 * sign claims you don't understand. This module is the gate.
 *
 * Source of truth for scope shape: `docs/contracts/oauth-scopes.md`.
 *
 * Declared scopes come from two places:
 *   1. `FIRST_PARTY_SCOPES` — the canonical Parachute scopes hardcoded in
 *      `scope-explanations.ts` (vault:read, scribe:transcribe, …).
 *   2. Each registered service's `.parachute/module.json` `scopes.defines`
 *      array — third-party modules opt in by declaring up front.
 *
 * Resolution is per-token-request, not cached: services.json + module.json
 * lookups cost a few ms at the launch scale (<10 services), and a stale cache
 * is the kind of bug that takes days to surface. Re-read each call.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ModuleManifest, validateModuleManifest } from "./module-manifest.ts";
import { FIRST_PARTY_SCOPES } from "./scope-explanations.ts";
import { readManifestLenient as readServicesManifest } from "./services-manifest.ts";

/**
 * RFC 6749 §3.3: scope strings are 1*( SP scope-token ). We accept any
 * whitespace run (incl. tabs/newlines) per the looser parser rules in
 * `oauth-scopes.md` so a CRLF-mangled form post still parses.
 */
export function parseScopeString(scope: string): string[] {
  return scope.split(/\s+/).filter((s) => s.length > 0);
}

/**
 * Match a requested scope against the declared set, applying per-resource
 * narrowing per `oauth-scopes.md`.
 *
 *   - Exact match: `vault:read` against declared `vault:read` → true.
 *   - Narrowing: `vault:work:read` against declared `vault:read` → true
 *     (collapse middle segments to `<svc>:<verb>`). Phase 2 will treat
 *     middle segments as resource constraints, not synonyms; for now they
 *     parse but don't narrow enforcement.
 *
 * No inheritance here: `vault:admin` declared does NOT cover requested
 * `vault:read`. The issuer signs exactly what the consent screen showed —
 * inheritance is the resource server's call (vault enforces `admin ⊇ write
 * ⊇ read` at request time, not at JWT mint).
 */
export function isKnownScope(scope: string, declared: ReadonlySet<string>): boolean {
  if (declared.has(scope)) return true;
  const parts = scope.split(":");
  if (parts.length < 3) return false;
  const collapsed = `${parts[0]}:${parts[parts.length - 1]}`;
  return declared.has(collapsed);
}

export function findUnknownScopes(
  scopes: readonly string[],
  declared: ReadonlySet<string>,
): string[] {
  return scopes.filter((s) => !isKnownScope(s, declared));
}

/**
 * Read `<dir>/.parachute/module.json` and return its `scopes.defines`.
 * Returns null when no manifest is found.
 *
 * Resolution order:
 *   1. If `installDir` is provided (hub#84 stamps this on every services.json
 *      row at install time), read directly from there. This is the canonical
 *      path — services.json's `name` is the manifest's canonical short
 *      (e.g. "agent"), which doesn't match the npm package name on disk
 *      (e.g. "nanoagent" for forks). bun-globals lookup-by-name fails for
 *      that case; installDir is the source of truth.
 *   2. Fall back to `<bun-globals>/<packageName>/.parachute/module.json`
 *      for entries without installDir (older installs, or services that
 *      registered themselves before hub#84 stamped the field).
 *
 * Tolerant of malformed JSON / validation errors — those are install-time
 * problems, not token-issuance problems. A bad manifest blocking token
 * issuance is the worst kind of cascade failure.
 */
export function defaultReadModuleScopes(
  packageName: string,
  installDir?: string,
): readonly string[] | null {
  const candidates: string[] = [];
  if (installDir) candidates.push(join(installDir, ".parachute", "module.json"));
  for (const prefix of bunGlobalPrefixes()) {
    candidates.push(join(prefix, ...packageName.split("/"), ".parachute", "module.json"));
  }
  for (const path of candidates) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    let m: ModuleManifest;
    try {
      m = validateModuleManifest(raw, path);
    } catch {
      // Malformed manifest — `parachute install` would have surfaced it; the
      // token endpoint shouldn't refuse to mint over it.
      return null;
    }
    return m.scopes?.defines ?? [];
  }
  return null;
}

function bunGlobalPrefixes(): string[] {
  const prefixes: string[] = [];
  const fromEnv = process.env.BUN_INSTALL;
  if (fromEnv) prefixes.push(join(fromEnv, "install", "global", "node_modules"));
  prefixes.push(join(homedir(), ".bun", "install", "global", "node_modules"));
  return prefixes;
}

export interface LoadDeclaredScopesOpts {
  /** Path to services.json. Defaults to `~/.parachute/services.json`. */
  manifestPath?: string;
  /**
   * Test seam: read a module's declared scopes by package name. Production
   * walks bun's global prefixes for each registered service's
   * `.parachute/module.json`.
   */
  readModuleScopes?: (packageName: string, installDir?: string) => readonly string[] | null;
}

/**
 * Compute the union of scopes the issuer is willing to sign. Order:
 *   1. `FIRST_PARTY_SCOPES` — always-on baseline.
 *   2. Each registered service's `module.json` `scopes.defines`.
 *
 * Errors reading services.json fail open (return baseline only) — a missing
 * services.json shouldn't break OAuth.
 */
export function loadDeclaredScopes(opts: LoadDeclaredScopesOpts = {}): Set<string> {
  const declared = new Set<string>(FIRST_PARTY_SCOPES);
  const readModuleScopes = opts.readModuleScopes ?? defaultReadModuleScopes;
  // readServicesManifest is the lenient reader: it returns `{ services: [] }`
  // on missing/unparseable files and skips individual bad rows with a warning.
  // The for-loop below already degrades gracefully, so no try/catch needed.
  const services = readServicesManifest(opts.manifestPath).services;
  for (const svc of services) {
    const defined = readModuleScopes(svc.name, svc.installDir);
    if (!defined) continue;
    for (const scope of defined) declared.add(scope);
  }
  return declared;
}
