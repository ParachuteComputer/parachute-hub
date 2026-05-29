/**
 * Tests for the durable half of the OAuth issuer-mismatch fix: persisting the
 * hub's PUBLIC origin into `<configDir>/vault/.env` so the launchd / systemd
 * daemon — which boots vault out-of-band and never sees the `parachute start`
 * spawn env — validates hub-minted JWTs' `iss` against the public origin
 * instead of vault's loopback default. See `vault-hub-origin-env.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvFileValues } from "../env-file.ts";
import type { ExposeState } from "../expose-state.ts";
import { writeExposeState } from "../expose-state.ts";
import {
  clearVaultHubOrigin,
  isLoopbackOrigin,
  persistVaultHubOrigin,
  publicOriginFromExposeState,
  selfHealVaultHubOrigin,
} from "../vault-hub-origin-env.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pcli-vhoe-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function vaultEnv(): string {
  return join(dir, "vault", ".env");
}

describe("isLoopbackOrigin", () => {
  test("flags 127.0.0.1 / localhost / [::1] / 0.0.0.0", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:1939")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:1939")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:1939")).toBe(true);
    // 0.0.0.0 is a bind-all wildcard, not a reachable origin.
    expect(isLoopbackOrigin("http://0.0.0.0:1939")).toBe(true);
  });

  test("does not flag a public FQDN", () => {
    expect(isLoopbackOrigin("https://parachute-aaron.tailc75afc.ts.net")).toBe(false);
    expect(isLoopbackOrigin("https://hub.example.com")).toBe(false);
  });

  test("non-URL strings are treated as non-loopback (don't block persistence)", () => {
    expect(isLoopbackOrigin("not a url")).toBe(false);
  });
});

describe("persistVaultHubOrigin", () => {
  test("writes a non-loopback public origin into vault/.env", () => {
    const wrote = persistVaultHubOrigin(dir, "https://parachute-aaron.tailc75afc.ts.net", () => {});
    expect(wrote).toBe(true);
    expect(readEnvFileValues(vaultEnv()).PARACHUTE_HUB_ORIGIN).toBe(
      "https://parachute-aaron.tailc75afc.ts.net",
    );
  });

  test("refuses to persist a loopback origin (would shadow a later exposure)", () => {
    const wrote = persistVaultHubOrigin(dir, "http://127.0.0.1:1939", () => {});
    expect(wrote).toBe(false);
    expect(existsSync(vaultEnv())).toBe(false);
  });

  test("refuses to persist a 0.0.0.0 origin (--hub-origin flows straight through)", () => {
    // `--hub-origin http://0.0.0.0:1939` bypasses deriveHubOrigin and reaches
    // here verbatim; baking a bind-all wildcard into vault/.env would advertise
    // a non-functional issuer and recreate the iss-mismatch class.
    const wrote = persistVaultHubOrigin(dir, "http://0.0.0.0:1939", () => {});
    expect(wrote).toBe(false);
    expect(existsSync(vaultEnv())).toBe(false);
  });

  test("is idempotent — no rewrite when the value is already current", () => {
    const log: string[] = [];
    expect(persistVaultHubOrigin(dir, "https://hub.example.com", (l) => log.push(l))).toBe(true);
    expect(persistVaultHubOrigin(dir, "https://hub.example.com", (l) => log.push(l))).toBe(false);
    // Only the first call logged.
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/persisted PARACHUTE_HUB_ORIGIN=https:\/\/hub\.example\.com/);
  });

  test("updates a stale origin in-place and preserves sibling keys", () => {
    writeFileSync(
      mkVaultDir(),
      "SCRIBE_AUTH_TOKEN=secret\nPARACHUTE_HUB_ORIGIN=https://old.example.com\nSCRIBE_URL=http://127.0.0.1:1943\n",
    );
    const wrote = persistVaultHubOrigin(dir, "https://new.example.com", () => {});
    expect(wrote).toBe(true);
    const values = readEnvFileValues(vaultEnv());
    expect(values.PARACHUTE_HUB_ORIGIN).toBe("https://new.example.com");
    // Sibling keys untouched.
    expect(values.SCRIBE_AUTH_TOKEN).toBe("secret");
    expect(values.SCRIBE_URL).toBe("http://127.0.0.1:1943");
  });
});

describe("clearVaultHubOrigin", () => {
  test("removes a persisted origin and leaves sibling keys", () => {
    writeFileSync(
      mkVaultDir(),
      "SCRIBE_AUTH_TOKEN=secret\nPARACHUTE_HUB_ORIGIN=https://hub.example.com\n",
    );
    const wrote = clearVaultHubOrigin(dir, () => {});
    expect(wrote).toBe(true);
    const values = readEnvFileValues(vaultEnv());
    expect(values.PARACHUTE_HUB_ORIGIN).toBeUndefined();
    expect(values.SCRIBE_AUTH_TOKEN).toBe("secret");
  });

  test("no-op when no origin is present", () => {
    writeFileSync(mkVaultDir(), "SCRIBE_AUTH_TOKEN=secret\n");
    expect(clearVaultHubOrigin(dir, () => {})).toBe(false);
  });

  test("no-op when vault/.env doesn't exist", () => {
    expect(clearVaultHubOrigin(dir, () => {})).toBe(false);
  });
});

/** Create `<dir>/vault/` and return the `.env` path so writeFileSync lands. */
function mkVaultDir(): string {
  mkdirSync(join(dir, "vault"), { recursive: true });
  return vaultEnv();
}

function exposeStatePath(): string {
  return join(dir, "expose-state.json");
}

/** Cloudflare-shaped expose state (subdomain mode, single hub-catchall entry). */
function cloudflareState(overrides: Partial<ExposeState> = {}): ExposeState {
  return {
    version: 1,
    layer: "public",
    mode: "subdomain",
    canonicalFqdn: "gitcoin-parachute.unforced.dev",
    port: 1939,
    funnel: false,
    entries: [{ kind: "proxy", mount: "/", target: "http://localhost:1939", service: "hub" }],
    hubOrigin: "https://gitcoin-parachute.unforced.dev",
    ...overrides,
  };
}

/** Tailnet-shaped expose state (path mode). */
function tailnetState(overrides: Partial<ExposeState> = {}): ExposeState {
  return {
    version: 1,
    layer: "tailnet",
    mode: "path",
    canonicalFqdn: "parachute-aaron.tailc75afc.ts.net",
    port: 1939,
    funnel: false,
    entries: [{ kind: "proxy", mount: "/", target: "http://localhost:1939", service: "hub" }],
    hubOrigin: "https://parachute-aaron.tailc75afc.ts.net",
    ...overrides,
  };
}

describe("publicOriginFromExposeState", () => {
  test("undefined when no expose-state file exists", () => {
    expect(publicOriginFromExposeState(exposeStatePath())).toBeUndefined();
  });

  test("returns the cloudflare hubOrigin", () => {
    writeExposeState(cloudflareState(), exposeStatePath());
    expect(publicOriginFromExposeState(exposeStatePath())).toBe(
      "https://gitcoin-parachute.unforced.dev",
    );
  });

  test("returns the tailnet hubOrigin", () => {
    writeExposeState(tailnetState(), exposeStatePath());
    expect(publicOriginFromExposeState(exposeStatePath())).toBe(
      "https://parachute-aaron.tailc75afc.ts.net",
    );
  });

  test("synthesizes https://<canonicalFqdn> when hubOrigin is absent (pre-Phase-0 state)", () => {
    // hubOrigin is optional on older state files; canonicalFqdn is mandatory.
    const { hubOrigin, ...rest } = cloudflareState();
    void hubOrigin;
    writeExposeState(rest as ExposeState, exposeStatePath());
    expect(publicOriginFromExposeState(exposeStatePath())).toBe(
      "https://gitcoin-parachute.unforced.dev",
    );
  });
});

describe("selfHealVaultHubOrigin (Cloudflare 401 self-heal)", () => {
  test("writes the cloudflare public origin when vault/.env is UNSET", () => {
    // The exact broken-deploy shape: expose-state carries a public cloudflare
    // hubOrigin but vault/.env has no PARACHUTE_HUB_ORIGIN, so the daemon falls
    // back to loopback and 401s every hub token. Restart self-corrects it.
    writeExposeState(cloudflareState(), exposeStatePath());
    const wrote = selfHealVaultHubOrigin(dir, () => {}, exposeStatePath());
    expect(wrote).toBe(true);
    expect(readEnvFileValues(vaultEnv()).PARACHUTE_HUB_ORIGIN).toBe(
      "https://gitcoin-parachute.unforced.dev",
    );
  });

  test("overwrites a LOOPBACK value already persisted in vault/.env", () => {
    writeExposeState(cloudflareState(), exposeStatePath());
    writeFileSync(mkVaultDir(), "PARACHUTE_HUB_ORIGIN=http://127.0.0.1:1939\n");
    const wrote = selfHealVaultHubOrigin(dir, () => {}, exposeStatePath());
    expect(wrote).toBe(true);
    expect(readEnvFileValues(vaultEnv()).PARACHUTE_HUB_ORIGIN).toBe(
      "https://gitcoin-parachute.unforced.dev",
    );
  });

  test("tailnet shape still self-heals (no regression)", () => {
    writeExposeState(tailnetState(), exposeStatePath());
    const wrote = selfHealVaultHubOrigin(dir, () => {}, exposeStatePath());
    expect(wrote).toBe(true);
    expect(readEnvFileValues(vaultEnv()).PARACHUTE_HUB_ORIGIN).toBe(
      "https://parachute-aaron.tailc75afc.ts.net",
    );
  });

  test("does NOT persist when there's no exposure (genuine loopback / local dev)", () => {
    // No expose-state file → no public origin → vault keeps its loopback
    // default. Persisting loopback would shadow a later exposure.
    const wrote = selfHealVaultHubOrigin(dir, () => {}, exposeStatePath());
    expect(wrote).toBe(false);
    expect(existsSync(vaultEnv())).toBe(false);
  });

  test("leaves a DIFFERENT non-loopback value alone (deliberate --hub-origin override)", () => {
    writeExposeState(cloudflareState(), exposeStatePath());
    writeFileSync(mkVaultDir(), "PARACHUTE_HUB_ORIGIN=https://custom.example.com\n");
    const wrote = selfHealVaultHubOrigin(dir, () => {}, exposeStatePath());
    expect(wrote).toBe(false);
    // Untouched — self-heal only fixes unset/loopback, never clobbers a public
    // value an operator may have set on purpose.
    expect(readEnvFileValues(vaultEnv()).PARACHUTE_HUB_ORIGIN).toBe("https://custom.example.com");
  });

  test("no-op (no double-write) when the persisted value already equals the public origin", () => {
    writeExposeState(cloudflareState(), exposeStatePath());
    writeFileSync(mkVaultDir(), "PARACHUTE_HUB_ORIGIN=https://gitcoin-parachute.unforced.dev\n");
    const wrote = selfHealVaultHubOrigin(dir, () => {}, exposeStatePath());
    expect(wrote).toBe(false);
  });

  test("expose-state with a loopback hubOrigin is treated as no public exposure", () => {
    // A loopback hubOrigin (local-dev hub) must never be persisted — it would
    // recreate the iss mismatch on the daemon boot path.
    writeExposeState(cloudflareState({ hubOrigin: "http://127.0.0.1:1939" }), exposeStatePath());
    // canonicalFqdn is still public here, but hubOrigin wins — we honor the
    // explicit value the writer chose.
    const wrote = selfHealVaultHubOrigin(dir, () => {}, exposeStatePath());
    expect(wrote).toBe(false);
    expect(existsSync(vaultEnv())).toBe(false);
  });
});
