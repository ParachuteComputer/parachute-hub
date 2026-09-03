/**
 * The hub's Buzz reader key — the one Nostr identity the hub signs with when
 * it reads from somebody else's relay.
 *
 * Channel-attached vaults (design "Channel-attached vaults — membership
 * becomes access", §2 (a)) need the hub to fetch a channel's kind 39002
 * roster. Buzz will not serve that to an anonymous caller: `POST /query` is
 * NIP-98-authenticated and the results are filtered to the channels the
 * *authenticated pubkey* can reach. So the hub needs a key, seated in the
 * community, and it needs somewhere to keep it.
 *
 * ## The config surface, and why it is a file
 *
 * ```sh
 * PARACHUTE_BUZZ_NSEC_FILE=/path/to/buzz-reader.nsec   # optional override
 * ```
 *
 * Default: `<PARACHUTE_HOME>/buzz-reader.nsec` (i.e. `~/.parachute/…`).
 *
 * The file contains ONE line: an `nsec1…` or a bare 64-char hex secret key.
 * Blank lines and `#` comments are ignored so an operator can annotate it.
 *
 * A path, not an inline `PARACHUTE_BUZZ_NSEC=nsec1…`, and the reasons are
 * specific rather than ambient:
 *
 *   - Environment is readable from outside the process. On macOS and Linux a
 *     sibling process with the same uid can read `/proc/<pid>/environ` or run
 *     `ps eww`; a file can be `chmod 600` and a directory `chmod 700`.
 *   - Every child the supervisor spawns inherits the hub's environment
 *     (`spawn-path.ts`), so an inline secret would be handed to every module
 *     the hub runs. A path is inert on its own.
 *   - Crash reporters, `parachute doctor`-style dumps, and container
 *     inspection commands all print environments. None of them print file
 *     contents.
 *   - It matches how the operator already got the key: Buzz shows an `nsec`,
 *     the operator pastes it into a file once.
 *
 * There is deliberately NO inline-secret fallback. Supporting both would mean
 * the "don't put it in the environment" rule is advice rather than a
 * mechanism, and the wrong one is always the one that gets used.
 *
 * ## What this module refuses to do
 *
 * Never logs the key or any prefix of it. Never puts it in an `Error`
 * message (a thrown bech32 error carrying its input is exactly how secrets
 * reach a stack trace). Never passes it as a command-line argument. The
 * failure reasons below are deliberately content-free — `malformed` does not
 * say *how*.
 *
 * ## Absence is not an error
 *
 * A hub with no reader key configured is the normal case; channel-attached
 * vaults are opt-in. {@link loadBuzzReaderKey} returns `not_configured` and
 * the roster fetcher reports it as a result, so nothing throws at boot and no
 * startup path gains a new way to fail.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import { decodeNsec } from "./nip19.ts";
import { pubkeyForSecret } from "./nostr-http-sign.ts";

/** Env var naming the file that holds the reader key. */
export const BUZZ_NSEC_FILE_ENV = "PARACHUTE_BUZZ_NSEC_FILE";

/** File name used under the config dir when the env var is unset. */
export const BUZZ_READER_KEY_FILENAME = "buzz-reader.nsec";

/** Where the key is read from, given an environment and a config dir. */
export function buzzReaderKeyPath(
  env: NodeJS.ProcessEnv = process.env,
  configDir: string = CONFIG_DIR,
): string {
  const override = env[BUZZ_NSEC_FILE_ENV];
  if (override && override.trim().length > 0) return override.trim();
  return join(configDir, BUZZ_READER_KEY_FILENAME);
}

/**
 * Why a key could not be loaded. Coarse on purpose — see the module header.
 *
 *   - `not_configured` — no file at the resolved path. The ordinary state of
 *     a hub that has not opted into channel-attached vaults.
 *   - `unreadable` — the path exists but could not be read (permissions, a
 *     directory, an I/O error).
 *   - `empty` — the file exists and holds no non-comment content. Distinct
 *     from `not_configured` because a truncated file is an operator mistake
 *     worth naming, not an opt-out.
 *   - `malformed` — content that is neither a valid `nsec1…` nor 64 hex
 *     characters.
 */
export type BuzzReaderKeyFailure = "not_configured" | "unreadable" | "empty" | "malformed";

export interface BuzzReaderKey {
  /**
   * 64-char lowercase hex secret key. **Secret.** Pass it to
   * `nip98AuthHeader` and nowhere else.
   */
  secretKeyHex: string;
  /** The matching x-only public key, 64-char lowercase hex. Not secret. */
  pubkey: string;
  /** The path it was loaded from. Safe to log. */
  path: string;
}

export type LoadBuzzReaderKeyResult =
  | { ok: true; key: BuzzReaderKey }
  | { ok: false; reason: BuzzReaderKeyFailure; path: string };

/**
 * First non-empty, non-comment line of the file. Everything after it is
 * ignored, so an operator can leave notes below the key.
 */
function firstMeaningfulLine(contents: string): string | null {
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    return line;
  }
  return null;
}

/**
 * Load the reader key. Never throws, never logs, and never includes file
 * contents in the result.
 *
 * Not cached: the call sites are a 60-second poll and a CLI command, so a
 * `readFileSync` of a 64-byte file is free, and re-reading means an operator
 * who rotates the key does not have to restart the hub.
 */
export function loadBuzzReaderKey(
  env: NodeJS.ProcessEnv = process.env,
  configDir: string = CONFIG_DIR,
): LoadBuzzReaderKeyResult {
  const path = buzzReaderKeyPath(env, configDir);
  try {
    // `statSync` first so a missing file is `not_configured` rather than
    // `unreadable`: the two mean very different things to an operator.
    if (!statSync(path).isFile()) return { ok: false, reason: "unreadable", path };
  } catch {
    return { ok: false, reason: "not_configured", path };
  }

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "unreadable", path };
  }

  const line = firstMeaningfulLine(contents);
  if (line === null) return { ok: false, reason: "empty", path };

  const secretKeyHex = line.startsWith("nsec1")
    ? decodeNsec(line)
    : /^[0-9a-f]{64}$/.test(line)
      ? line
      : null;
  if (secretKeyHex === null) return { ok: false, reason: "malformed", path };

  let pubkey: string;
  try {
    pubkey = pubkeyForSecret(secretKeyHex);
  } catch {
    // A 32-byte value that is not a valid secp256k1 scalar (zero, or ≥ n).
    // Astronomically unlikely from a real generator; still not a crash.
    return { ok: false, reason: "malformed", path };
  }

  return { ok: true, key: { secretKeyHex, pubkey, path } };
}
