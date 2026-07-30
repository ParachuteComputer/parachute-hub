/**
 * Un-wiring scribe from vault's `.env` on uninstall.
 *
 * Found on a live box: `parachute install scribe` writes `SCRIBE_URL` +
 * `SCRIBE_AUTH_TOKEN` into vault's env for the operator, and uninstall left
 * them there. The result was a vault whose transcription worker announced
 * `worker started → http://127.0.0.1:1943` on a machine where nothing had
 * listened on 1943 since the uninstall. Nothing errors; audio simply stops
 * being transcribed.
 *
 * The second-order damage is worse: vault#640 falls back to the local provider
 * only when no scribe is CONFIGURED, and a stale `SCRIBE_URL` looks exactly
 * like configuration. So the box that most needs the local default is the one
 * guaranteed not to get it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwireScribeAuth } from "../auto-wire.ts";

function boxWithVaultEnv(contents: string): string {
  const configDir = mkdtempSync(join(tmpdir(), "unwire-"));
  mkdirSync(join(configDir, "vault"), { recursive: true });
  writeFileSync(join(configDir, "vault", ".env"), contents);
  return configDir;
}

const readEnv = (configDir: string) => readFileSync(join(configDir, "vault", ".env"), "utf8");

describe("unwireScribeAuth", () => {
  test("removes exactly the two keys install wrote", () => {
    const dir = boxWithVaultEnv(
      "SCRIBE_AUTH_TOKEN=2cb68667b193\nSCRIBE_URL=http://127.0.0.1:1943\n",
    );
    const res = unwireScribeAuth({ configDir: dir });
    expect(res.changed).toBe(true);
    expect(res.removed.sort()).toEqual(["SCRIBE_AUTH_TOKEN", "SCRIBE_URL"]);
    expect(readEnv(dir)).not.toMatch(/SCRIBE_URL/);
    expect(readEnv(dir)).not.toMatch(/SCRIBE_AUTH_TOKEN/);
  });

  test("leaves every unrelated key untouched", () => {
    // The whole file is the operator's; only the machine-written keys are ours
    // to remove. Truncating it would destroy real configuration.
    const dir = boxWithVaultEnv(
      [
        "# my vault config",
        "PARACHUTE_GITHUB_CLIENT_ID=Iv1.abc",
        "SCRIBE_URL=http://127.0.0.1:1943",
        "EMBEDDINGS_ENABLED=true",
        "SCRIBE_AUTH_TOKEN=deadbeef",
        "TRANSCRIPTION_MODEL=whisper-base.en",
        "",
      ].join("\n"),
    );
    unwireScribeAuth({ configDir: dir });
    const after = readEnv(dir);
    expect(after).toMatch(/# my vault config/);
    expect(after).toMatch(/PARACHUTE_GITHUB_CLIENT_ID=Iv1\.abc/);
    expect(after).toMatch(/EMBEDDINGS_ENABLED=true/);
    expect(after).toMatch(/TRANSCRIPTION_MODEL=whisper-base\.en/);
    expect(after).not.toMatch(/SCRIBE/);
  });

  test("is a no-op when the keys aren't there (uninstall must stay idempotent)", () => {
    const dir = boxWithVaultEnv("EMBEDDINGS_ENABLED=true\n");
    const res = unwireScribeAuth({ configDir: dir });
    expect(res.changed).toBe(false);
    expect(res.removed).toEqual([]);
    expect(readEnv(dir)).toBe("EMBEDDINGS_ENABLED=true\n");
  });

  test("running it twice is safe", () => {
    const dir = boxWithVaultEnv("SCRIBE_URL=http://127.0.0.1:1943\n");
    expect(unwireScribeAuth({ configDir: dir }).changed).toBe(true);
    expect(unwireScribeAuth({ configDir: dir }).changed).toBe(false);
  });

  test("no vault installed at all → no-op, no crash", () => {
    // Uninstalling scribe on a scribe-only box must not fail because vault
    // isn't there to unwire.
    const dir = mkdtempSync(join(tmpdir(), "unwire-novault-"));
    const res = unwireScribeAuth({ configDir: dir });
    expect(res.changed).toBe(false);
    expect(existsSync(join(dir, "vault", ".env"))).toBe(false);
  });

  test("removes only one key when only one was written", () => {
    const dir = boxWithVaultEnv("SCRIBE_URL=http://127.0.0.1:1943\nOTHER=1\n");
    const res = unwireScribeAuth({ configDir: dir });
    expect(res.removed).toEqual(["SCRIBE_URL"]);
    expect(readEnv(dir)).toMatch(/OTHER=1/);
  });

  test("the log names the consequence and the next step", () => {
    // "removed SCRIBE_URL" alone doesn't tell an operator that transcription
    // just changed hands, or what to run.
    const dir = boxWithVaultEnv("SCRIBE_URL=http://127.0.0.1:1943\n");
    const lines: string[] = [];
    unwireScribeAuth({ configDir: dir, log: (l) => lines.push(l) });
    const out = lines.join("\n");
    expect(out).toMatch(/transcription install/);
  });

  test("the live-box shape: stale URL, no scribe, no token", () => {
    // Exactly what was found in the wild after `parachute uninstall scribe`:
    // the URL survived, pointing at a dead port, which reads to vault#640 as
    // "a scribe is configured" and suppresses the local-provider fallback.
    const dir = boxWithVaultEnv(
      "SCRIBE_AUTH_TOKEN=2cb68667b19385ecfc2b6e14563a0a0127656ffa1c6224b11c0c9978a1f86f3a\nSCRIBE_URL=http://127.0.0.1:1943\n",
    );
    unwireScribeAuth({ configDir: dir });
    expect(readEnv(dir).trim()).toBe("");
  });
});
