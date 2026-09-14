/** Optional owner attestation, reread for every poll and NIP-42 challenge.
 * Validate structure only: the relay owns signature and conditions validation.
 * Never log file contents or return parser / filesystem error messages.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

export const BUZZ_AUTH_TAG_FILE_ENV = "PARACHUTE_BUZZ_AUTH_TAG_FILE";
export const BUZZ_AUTH_TAG_FILENAME = "buzz-reader.authtag";

export function buzzAuthTagPath(
  env: NodeJS.ProcessEnv = process.env,
  configDir: string = CONFIG_DIR,
): string {
  const override = env[BUZZ_AUTH_TAG_FILE_ENV];
  if (override && override.trim().length > 0) return override.trim();
  return join(configDir, BUZZ_AUTH_TAG_FILENAME);
}

export type BuzzAuthTagFailure = "not_configured" | "unreadable" | "empty" | "malformed";
export type BuzzAuthTagResult =
  | { ok: true; tagJson: string; tag: string[]; path: string }
  | { ok: false; reason: BuzzAuthTagFailure; path: string };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function firstMeaningfulLine(contents: string): string | null {
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return line;
  }
  return null;
}

export function loadBuzzAuthTag(
  env: NodeJS.ProcessEnv = process.env,
  configDir: string = CONFIG_DIR,
): BuzzAuthTagResult {
  const path = buzzAuthTagPath(env, configDir);
  try {
    if (!statSync(path).isFile()) return { ok: false, reason: "unreadable", path };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === "ENOENT" || code === "ENOTDIR" ? "not_configured" : "unreadable",
      path,
    };
  }
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "unreadable", path };
  }
  const line = firstMeaningfulLine(contents);
  if (line === null) return { ok: false, reason: "empty", path };
  try {
    const tag: unknown = JSON.parse(line);
    if (
      !Array.isArray(tag) ||
      tag.length !== 4 ||
      !tag.every((part): part is string => typeof part === "string") ||
      tag[0] !== "auth" ||
      !HEX64.test(tag[1]!) ||
      !HEX128.test(tag[3]!)
    ) {
      return { ok: false, reason: "malformed", path };
    }
    return { ok: true, tagJson: JSON.stringify(tag), tag, path };
  } catch {
    return { ok: false, reason: "malformed", path };
  }
}
