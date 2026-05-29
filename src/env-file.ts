import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Minimal `.env` round-tripping for files we own.
 *
 * Used by:
 *   - auto-wire (writing SCRIBE_AUTH_TOKEN / SCRIBE_URL into vault .env)
 *   - scribe provider setup (writing GROQ_API_KEY etc. into scribe .env)
 *   - lifecycle.start (reading scribe .env values into the spawn env so the
 *     process actually sees the keys it was configured with)
 *
 * Scope intentionally narrow:
 *   - `KEY=value` lines (`=` is the first character, value is everything after)
 *   - one-level surrounding quotes are stripped on read (single or double)
 *   - everything else (comments, multiline, exports, escape sequences) is
 *     preserved as-is on round-trip but not parsed as values
 */

export interface ParsedEnv {
  /** Raw file lines preserved for round-trip writes (no trailing blank). */
  lines: string[];
  /** Parsed `KEY → value` pairs (quoted values returned unquoted). */
  values: Record<string, string>;
}

export function parseEnvFileText(content: string): ParsedEnv {
  const raw = content.length === 0 ? [] : content.split("\n");
  // Drop a trailing empty string from a file that ends in "\n" so we don't
  // double up newlines when we round-trip.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const values: Record<string, string> = {};
  for (const line of raw) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return { lines: raw, values };
}

export function parseEnvFile(path: string): ParsedEnv {
  if (!existsSync(path)) return { lines: [], values: {} };
  return parseEnvFileText(readFileSync(path, "utf8"));
}

export function readEnvFileValues(path: string): Record<string, string> {
  return parseEnvFile(path).values;
}

export function upsertEnvLine(lines: string[], key: string, value: string): string[] {
  const next = [...lines];
  const prefix = `${key}=`;
  const idx = next.findIndex((line) => line.startsWith(prefix));
  if (idx >= 0) {
    next[idx] = `${key}=${value}`;
  } else {
    next.push(`${key}=${value}`);
  }
  return next;
}

/**
 * Drop every `KEY=…` line for `key`, preserving the order of the rest.
 * Returns a new array; the input is untouched. No-op (returns a copy) when
 * the key isn't present.
 */
export function removeEnvLine(lines: string[], key: string): string[] {
  const prefix = `${key}=`;
  return lines.filter((line) => !line.startsWith(prefix));
}

export function writeEnvFile(path: string, lines: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${lines.join("\n")}\n`);
  renameSync(tmp, path);
}
