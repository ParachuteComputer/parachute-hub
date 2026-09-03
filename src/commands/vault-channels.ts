/**
 * `parachute vault attach-channel | detach-channel | list-channels` — the
 * operator surface over the `channel_vaults` binding table (migration v23).
 *
 * PR 1 of the design "Channel-attached vaults — membership becomes access".
 * The design calls the verb `attach-channel-vault`; the repo's CLI grammar is
 * `parachute vault <verb>`, so the noun is already said and the verb is
 * `attach-channel`.
 *
 * ## Why it drives the hub over loopback
 *
 * Identical reasoning to `vault-remove.ts`: the binding lives in the hub's DB,
 * which the running hub has open, and the "is this vault installed?" check
 * reads the services.json the hub owns. Deciding either locally would be a
 * second code path that drifts from the HTTP one an SPA button would use. So
 * the CLI is a thin client of `/api/channel-vaults` and decides nothing.
 *
 * Attaching does NOT create a vault — `parachute vault create <name>` does that
 * — so this command never touches the supervisor.
 *
 * ## Authority
 *
 * The endpoint gates on `parachute:host:admin` — the SAME gate as
 * `POST /vaults` — and this command presents the on-disk
 * `~/.parachute/operator.token` (read, never minted), whose default `admin`
 * scope-set carries it. That is the design's v1 answer to "who may attach":
 * a hub operator, not a channel owner. Nothing here grants vault access to
 * anyone; the reconciler that does lands in a later PR.
 */

import { CONFIG_DIR } from "../config.ts";
import { readExposeState } from "../expose-state.ts";
import { readHubPort } from "../hub-control.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { HUB_UNIT_DEFAULT_PORT } from "../hub-unit.ts";
import {
  DEFAULT_HUB_BASE_URL,
  NoOperatorTokenError,
  OperatorTokenExpiredError,
  resolveOperatorBearer,
} from "../module-ops-client.ts";

/** Subcommands this module owns, as spelled under `parachute vault`. */
export const CHANNEL_SUBCOMMANDS = ["attach-channel", "detach-channel", "list-channels"] as const;
export type ChannelSubcommand = (typeof CHANNEL_SUBCOMMANDS)[number];

export function isChannelSubcommand(value: string): value is ChannelSubcommand {
  return (CHANNEL_SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * Injectable seams, mirroring {@link ../commands/vault-remove.ts}: tests inject
 * a fake bearer resolver + fetch so the request shape is asserted without a
 * live hub or a real socket.
 */
export interface VaultChannelsDeps {
  readonly resolveBearer?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
}

const USAGE = [
  "usage:",
  "  parachute vault attach-channel --relay <host> --channel <uuid> [--vault <name>]",
  "  parachute vault detach-channel --relay <host> --channel <uuid>",
  "  parachute vault list-channels [--vault <name>]",
  "",
  "  --vault      vault instance name, which must already exist. Defaults to",
  "               ch-<first-8-of-channel>. Create it first with `parachute vault create`.",
  "  --hub-origin <url>   talk to a hub other than the loopback default.",
].join("\n");

/**
 * Resolve the hub origin the operator token's `iss` is validated against —
 * mirrors `vault-remove.ts:resolveOperatorTokenIssuer`.
 */
function resolveOperatorTokenIssuer(configDir: string): string {
  const state = readExposeState(`${configDir}/expose-state.json`);
  if (state?.hubOrigin) return state.hubOrigin;
  const port = readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

/** Read + auto-rotate the operator token. Read-never-mint. */
async function defaultResolveBearer(configDir: string): Promise<string> {
  const issuer = resolveOperatorTokenIssuer(configDir);
  const db = openHubDb(hubDbPath(configDir));
  try {
    return await resolveOperatorBearer({ db, issuer, configDir });
  } finally {
    db.close();
  }
}

interface ParsedFlags {
  relay?: string;
  channel?: string;
  vault?: string;
  hubOrigin?: string;
}

type ParseOutcome = { ok: true; flags: ParsedFlags } | { ok: false; message: string };

function parseFlags(sub: ChannelSubcommand, args: readonly string[]): ParseOutcome {
  const flags: ParsedFlags = {};
  const valued = new Map<string, (v: string) => void>([
    [
      "--relay",
      (v) => {
        flags.relay = v;
      },
    ],
    [
      "--channel",
      (v) => {
        flags.channel = v;
      },
    ],
    [
      "--vault",
      (v) => {
        flags.vault = v;
      },
    ],
    [
      "--hub-origin",
      (v) => {
        flags.hubOrigin = v;
      },
    ],
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) {
      const setter = valued.get(a.slice(0, eq));
      if (!setter) return { ok: false, message: `unknown flag "${a.slice(0, eq)}"` };
      setter(a.slice(eq + 1));
      continue;
    }
    const setter = valued.get(a);
    if (setter) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) {
        return { ok: false, message: `${a} requires a value` };
      }
      setter(v);
      i++;
      continue;
    }
    return { ok: false, message: `unexpected argument "${a}"` };
  }
  if (sub !== "list-channels") {
    if (!flags.relay) return { ok: false, message: "--relay <host> is required" };
    if (!flags.channel) return { ok: false, message: "--channel <uuid> is required" };
  }
  if (sub === "detach-channel" && flags.vault !== undefined) {
    return { ok: false, message: "detach-channel takes no --vault (the key is relay + channel)" };
  }
  return { ok: true, flags };
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function asErrorBody(body: unknown, status: number): { error: string; description: string } {
  const fallback = `hub returned HTTP ${status} with no error detail`;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    return {
      error: typeof b.error === "string" ? b.error : "error",
      description: typeof b.error_description === "string" ? b.error_description : fallback,
    };
  }
  return { error: "error", description: fallback };
}

interface BindingWire {
  relay_host?: string;
  channel_id?: string;
  vault?: string;
  mode?: string;
  synced_at?: string | null;
  created?: boolean;
  removed?: boolean;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Fixed-width render for `list-channels` — relay, channel, vault, mode, synced_at. */
function renderList(rows: BindingWire[], log: (l: string) => void): void {
  if (rows.length === 0) {
    log("No channels are attached to a vault on this hub.");
    return;
  }
  const cells = rows.map((r) => [
    str(r.relay_host),
    str(r.channel_id),
    str(r.vault),
    str(r.mode),
    r.synced_at === null || r.synced_at === undefined ? "never" : String(r.synced_at),
  ]);
  const header = ["RELAY", "CHANNEL", "VAULT", "MODE", "SYNCED"];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length)));
  const line = (c: readonly string[]) =>
    c
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  log(line(header));
  for (const c of cells) log(line(c));
}

/**
 * Run one of the channel-binding verbs. Returns the process exit code.
 */
export async function vaultChannels(
  sub: ChannelSubcommand,
  args: string[],
  deps: VaultChannelsDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const logError = deps.logError ?? ((line: string) => console.error(line));

  if (args.includes("--help") || args.includes("-h")) {
    log(USAGE);
    return 0;
  }

  const parsed = parseFlags(sub, args);
  if (!parsed.ok) {
    logError(`parachute vault ${sub}: ${parsed.message}`);
    logError(USAGE);
    return 1;
  }
  const flags = parsed.flags;

  let bearer: string;
  try {
    bearer = deps.resolveBearer
      ? await deps.resolveBearer()
      : await defaultResolveBearer(CONFIG_DIR);
  } catch (err) {
    if (err instanceof NoOperatorTokenError || err instanceof OperatorTokenExpiredError) {
      logError(`parachute vault ${sub}: ${err.message}`);
      return 1;
    }
    logError(`parachute vault ${sub}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const doFetch = deps.fetch ?? fetch;
  const baseUrl = (flags.hubOrigin ?? deps.baseUrl ?? DEFAULT_HUB_BASE_URL).replace(/\/+$/, "");

  let url = `${baseUrl}/api/channel-vaults`;
  let method = "POST";
  let body: string | undefined;
  if (sub === "attach-channel") {
    const payload: Record<string, unknown> = { relay: flags.relay, channel: flags.channel };
    if (flags.vault !== undefined) payload.vault = flags.vault;
    body = JSON.stringify(payload);
  } else if (sub === "detach-channel") {
    method = "DELETE";
    const q = new URLSearchParams({ relay: flags.relay ?? "", channel: flags.channel ?? "" });
    url = `${url}?${q.toString()}`;
  } else {
    method = "GET";
    if (flags.vault !== undefined) {
      url = `${url}?${new URLSearchParams({ vault: flags.vault }).toString()}`;
    }
  }

  let res: Response;
  try {
    const init: RequestInit = {
      method,
      headers: body
        ? { authorization: `Bearer ${bearer}`, "content-type": "application/json" }
        : { authorization: `Bearer ${bearer}` },
    };
    if (body !== undefined) init.body = body;
    res = await doFetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const refused = /econnrefused|connection refused|failed to fetch|unable to connect/i.test(msg);
    if (refused) {
      logError(`parachute vault ${sub}: the hub must be running to manage channel bindings.`);
      logError("Run `parachute start`, then retry.");
      return 1;
    }
    logError(`parachute vault ${sub}: request failed: ${msg}`);
    return 1;
  }

  const payload = await parseJsonSafe(res);

  if (res.status === 200 || res.status === 201) {
    if (sub === "list-channels") {
      const rows = (payload as { channel_vaults?: unknown } | undefined)?.channel_vaults;
      renderList(Array.isArray(rows) ? (rows as BindingWire[]) : [], log);
      return 0;
    }
    const wire = (payload ?? {}) as BindingWire;
    if (sub === "detach-channel") {
      if (wire.removed === true) {
        log(
          `Detached channel ${str(wire.channel_id, flags.channel ?? "")} on ${str(wire.relay_host, flags.relay ?? "")} from vault "${str(wire.vault)}".`,
        );
        log("The vault itself is untouched — use `parachute vault remove` to destroy it.");
      } else {
        log("That channel was not attached to a vault on this hub. Nothing to do.");
      }
      return 0;
    }
    // attach-channel
    const vaultName = str(wire.vault, flags.vault ?? "");
    if (wire.created === false) {
      log(
        `Channel ${str(wire.channel_id, flags.channel ?? "")} is already attached to vault "${vaultName}". Nothing to do.`,
      );
      return 0;
    }
    log(
      `Attached channel ${str(wire.channel_id, flags.channel ?? "")} on ${str(wire.relay_host, flags.relay ?? "")} to vault "${vaultName}".`,
    );
    log(`  mode:   ${str(wire.mode, "sync")}`);
    log("  synced: never — membership sync lands in a later PR; no access was granted.");
    return 0;
  }

  const { error, description } = asErrorBody(payload, res.status);

  if (res.status === 401 || res.status === 403) {
    logError(`parachute vault ${sub}: the hub rejected the operator token (${description}).`);
    logError("Run `parachute auth rotate-operator` to mint a fresh one, then retry.");
    return 1;
  }
  if (error === "vault_not_found") {
    logError(`parachute vault ${sub}: ${description}`);
    return 1;
  }
  logError(`parachute vault ${sub}: ${error}: ${description}`);
  return 1;
}

export { NoOperatorTokenError, OperatorTokenExpiredError };
