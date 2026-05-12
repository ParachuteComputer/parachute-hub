import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { HUB_SVC, readHubPort } from "../hub-control.ts";
import {
  type DetectInstallSourceDeps,
  detectHubInstallSource,
  detectInstallSource,
  formatInstallSourceLabel,
  isStale,
} from "../install-source.ts";
import { type AliveFn, defaultAlive, formatUptime, processState } from "../process-state.ts";
import { canonicalPortForManifest, getSpec, shortNameForManifest } from "../service-spec.ts";
import { type ServiceEntry, readManifest } from "../services-manifest.ts";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface StatusOpts {
  manifestPath?: string;
  fetchImpl?: FetchFn;
  print?: (line: string) => void;
  timeoutMs?: number;
  configDir?: string;
  alive?: AliveFn;
  now?: () => Date;
  /**
   * Test seam for install-source detection. Production reads the filesystem
   * + shells out to git; tests inject stubs so each case (npm / bun-linked /
   * unknown / stale) is exercised deterministically without depending on
   * the operator's actual bun globals.
   */
  installSourceDeps?: DetectInstallSourceDeps;
  /**
   * Directory containing the running hub source. Defaults to `import.meta.dir`
   * (the directory of this file). Tests override so the hub row's install
   * source classification doesn't depend on the test runner's location.
   */
  hubSrcDir?: string;
}

export interface ProbeResult {
  entry: ServiceEntry;
  healthy: boolean;
  statusCode?: number;
  error?: string;
  latencyMs: number;
}

export async function probe(
  entry: ServiceEntry,
  fetchImpl: FetchFn,
  timeoutMs: number,
): Promise<ProbeResult> {
  const url = `http://localhost:${entry.port}${entry.health}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    const latencyMs = Math.round(performance.now() - start);
    return {
      entry,
      healthy: res.ok,
      statusCode: res.status,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      entry,
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatRow(cells: string[], widths: number[]): string {
  return cells
    .map((c, i) => c.padEnd(widths[i] ?? 0, " "))
    .join("  ")
    .trimEnd();
}

interface StatusRow {
  service: string;
  port: string;
  version: string;
  processLabel: string;
  pidLabel: string;
  uptimeLabel: string;
  healthLabel: string;
  latencyLabel: string;
  sourceLabel: string;
  url: string | undefined;
  healthy: boolean;
  skipped: boolean;
  /**
   * Canonical-port drift warning. Set when the entry has a known canonical
   * port (first-party / known short) AND the actual port differs. Surfaced
   * as a continuation line under the row so operators see a silent miswire
   * (e.g. parachute-hub#195: scribe + agent both at 1944) without us
   * hard-erroring on a deliberate operator port change.
   */
  driftWarning?: string;
  /**
   * Version-drift indicator (hub#243). Set when a bun-linked service's
   * `services.json.version` lags the live `package.json` version at its
   * checkout. Surfaced as a continuation line so operators can spot a
   * stale-after-rebuild row without comparing columns by eye.
   */
  staleNote?: string;
}

/**
 * Canonical reachable URL for a row. Spec-driven where possible (vault appends
 * `/mcp`, scribe is at the root, …). Unknown services fall back to bare
 * `http://127.0.0.1:<port>` plus the first declared path so third-party
 * services still get a useful pointer rather than an empty cell.
 */
function urlForEntry(entry: ServiceEntry, short: string | undefined): string | undefined {
  const spec = short ? getSpec(short) : undefined;
  const fromSpec = spec?.urlForEntry?.(entry);
  if (fromSpec) return fromSpec;
  const first = entry.paths[0]?.replace(/\/+$/, "") ?? "";
  return `http://127.0.0.1:${entry.port}${first}`;
}

function hubRow(
  configDir: string,
  alive: AliveFn,
  nowDate: Date,
  hubSrcDir: string,
  installSourceDeps: DetectInstallSourceDeps,
): StatusRow | undefined {
  const proc = processState(HUB_SVC, configDir, alive);
  if (proc.status === "unknown") return undefined;
  const port = readHubPort(configDir);
  const portLabel = port !== undefined ? String(port) : "-";
  const processLabel = proc.status === "running" ? "running" : "stopped";
  const pidLabel = proc.status === "running" && proc.pid !== undefined ? String(proc.pid) : "-";
  const uptimeLabel =
    proc.status === "running" && proc.startedAt ? formatUptime(proc.startedAt, nowDate) : "-";
  const source = detectHubInstallSource(hubSrcDir, installSourceDeps);
  return {
    service: "parachute-hub (internal)",
    port: portLabel,
    version: source.livePackageVersion ?? "-",
    processLabel,
    pidLabel,
    uptimeLabel,
    healthLabel: "-",
    latencyLabel: "-",
    sourceLabel: formatInstallSourceLabel(source),
    url: port !== undefined ? `http://127.0.0.1:${port}` : undefined,
    healthy: true,
    skipped: true,
  };
}

export async function status(opts: StatusOpts = {}): Promise<number> {
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const print = opts.print ?? ((line) => console.log(line));
  const timeoutMs = opts.timeoutMs ?? 1500;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const alive = opts.alive ?? defaultAlive;
  const now = opts.now ?? (() => new Date());
  const installSourceDeps = opts.installSourceDeps ?? {};
  const hubSrcDir = opts.hubSrcDir ?? import.meta.dir;

  const manifest = readManifest(manifestPath);
  if (manifest.services.length === 0) {
    print("No services installed yet.");
    print("Try: parachute install vault");
    return 0;
  }

  const nowDate = now();

  /**
   * Per-row resolution: look up the short name so we can read PID state,
   * skip the health probe when the process is known-stopped (ECONNREFUSED
   * noise isn't informative), and report it as running/stopped + uptime.
   *
   * Third-party services we don't know about fall back to probing and show
   * "-" for process columns.
   */
  const rows: StatusRow[] = await Promise.all(
    manifest.services.map(async (entry) => {
      // Third-party rows (with `installDir`) live under `~/.parachute/<entry.name>/`,
      // matching what `parachute start` uses as the short. First-party rows still
      // map manifestName → short via the canonical fallback.
      const short = shortNameForManifest(entry.name) ?? (entry.installDir ? entry.name : undefined);
      const proc = short ? processState(short, configDir, alive) : undefined;

      const processLabel =
        proc?.status === "running" ? "running" : proc?.status === "stopped" ? "stopped" : "-";
      const pidLabel =
        proc?.status === "running" && proc.pid !== undefined ? String(proc.pid) : "-";
      const uptimeLabel =
        proc?.status === "running" && proc.startedAt ? formatUptime(proc.startedAt, nowDate) : "-";

      const url = urlForEntry(entry, short);

      // Canonical-port drift detection (hub#195). Only fires for known
      // first-party services where we have a canonical assignment. Third-party
      // rows have no canonical to compare against. Warning is informational —
      // operators may have moved a service off canonical deliberately.
      // Note: multi-vault instance rows (`parachute-vault-<instance>`) don't
      // match a canonical manifest name, so drift warnings don't fire for
      // them. Intentional — see `canonicalPortForManifest` for the rationale.
      const canonical = canonicalPortForManifest(entry.name);
      const driftWarning =
        canonical !== undefined && canonical !== entry.port
          ? `canonical port is ${canonical}`
          : undefined;

      // Install-source detection (hub#243). One filesystem walk + maybe one
      // `git rev-parse` per row. Failures degrade silently to `unknown` —
      // status output should never error out on a missing checkout dir.
      const detectArgs: { entryName: string; installDir?: string } = { entryName: entry.name };
      if (entry.installDir !== undefined) detectArgs.installDir = entry.installDir;
      const source = detectInstallSource(detectArgs, installSourceDeps);
      const sourceLabel = formatInstallSourceLabel(source);
      const staleNote = isStale(entry.version, source)
        ? `STALE: services.json cached ${entry.version}; live package.json ${source.livePackageVersion}`
        : undefined;

      // Only skip probe when we know the process is dead (PID file was
      // present but kill(pid, 0) failed). "unknown" status (no PID file)
      // still probes — externally-managed services should report health.
      if (proc?.status === "stopped") {
        return {
          service: entry.name,
          port: String(entry.port),
          version: entry.version,
          processLabel,
          pidLabel,
          uptimeLabel,
          healthLabel: "-",
          latencyLabel: "-",
          sourceLabel,
          url,
          healthy: false,
          skipped: true,
          driftWarning,
          staleNote,
        };
      }

      const p = await probe(entry, fetchImpl, timeoutMs);
      const healthLabel = p.healthy
        ? "ok"
        : p.statusCode !== undefined
          ? `http ${p.statusCode}`
          : (p.error ?? "down");
      return {
        service: entry.name,
        port: String(entry.port),
        version: entry.version,
        processLabel,
        pidLabel,
        uptimeLabel,
        healthLabel,
        latencyLabel: `${p.latencyMs}ms`,
        sourceLabel,
        url,
        healthy: p.healthy,
        skipped: false,
        driftWarning,
        staleNote,
      };
    }),
  );

  // Hub is an internal service — not in services.json, but users notice
  // when it's dead. Only show it if we've seen it run.
  const hub = hubRow(configDir, alive, nowDate, hubSrcDir, installSourceDeps);
  if (hub) rows.push(hub);

  const header = [
    "SERVICE",
    "PORT",
    "VERSION",
    "PROCESS",
    "PID",
    "UPTIME",
    "HEALTH",
    "LATENCY",
    "SOURCE",
  ];
  const textRows = rows.map((r) => [
    r.service,
    r.port,
    r.version,
    r.processLabel,
    r.pidLabel,
    r.uptimeLabel,
    r.healthLabel,
    r.latencyLabel,
    r.sourceLabel,
  ]);
  const widths = header.map((_, i) =>
    Math.max(header[i]?.length ?? 0, ...textRows.map((r) => r[i]?.length ?? 0)),
  );
  print(formatRow(header, widths));
  // URL, drift, and stale notes stay on continuation lines rather than
  // columns. URLs are long (vault's MCP path runs ~40 chars); SOURCE labels
  // can be long for bun-linked rows. Spreading them across columns would
  // push the table well past 80 cols on every install — continuation lines
  // keep the table scannable. The "  → " / "  ! " prefixes group visually
  // with the row above without misleading the table widths.
  for (let i = 0; i < textRows.length; i++) {
    const cells = textRows[i];
    const row = rows[i];
    if (!cells || !row) continue;
    print(formatRow(cells, widths));
    if (row.url) print(`  → ${row.url}`);
    if (row.driftWarning) print(`  ! ${row.driftWarning}`);
    if (row.staleNote) print(`  ! ${row.staleNote}`);
  }

  /**
   * Overall exit: non-zero if any *probed* service is unhealthy. A stopped
   * service is expected ("I haven't started it yet"), not a failure — users
   * want `parachute status` to return 0 after a fresh install before they
   * `parachute start`. Health regressions among running services still 1.
   */
  const anyUnhealthy = rows.some((r) => !r.skipped && !r.healthy);
  return anyUnhealthy ? 1 : 0;
}
