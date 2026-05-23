/**
 * Persistent footer affordance showing hub version + uptime (hub#348).
 *
 * Aaron's motivating framing: "I can't really tell with mine if it's
 * updated or not. And I'm not sure how I would queue it to update or if
 * it just already did." Render auto-deploys on every push to source —
 * the operator doesn't actively trigger updates and needs to see the
 * result land somewhere visible.
 *
 * Renders a single muted line in the page footer:
 *
 *   Hub 0.5.13-rc.23 · running 2h 13m · container
 *
 * Click expands to a detail panel:
 *
 *   Hub:        @openparachute/hub 0.5.13-rc.23
 *   Source:     container
 *   Started:    2026-05-23 14:23:45 UTC (2h 13m ago)
 *   Built:      2026-05-23 14:21:00 UTC                     (if applicable)
 *
 * Plus a Refresh button — useful for "I just pushed; did the new version
 * land yet?" Refresh triggers an immediate refetch.
 *
 * Auto-refresh shapes:
 *   - Polls every 30s while mounted (so a quiet operator-tab still picks up
 *     a redeploy without manual click).
 *   - Refetches on focus (when the operator returns to the tab after a
 *     deploy).
 *
 * 401/403 from /api/hub silently collapses the badge (renders null). The
 * SPA's other surfaces handle the redirect-to-login on their own auth
 * failures; the badge is decorative-enough not to drive its own flow.
 */
import { useCallback, useEffect, useState } from "react";
import { type HubStatus, getHubStatus } from "../lib/api.ts";

/** Auto-refresh interval. 30s feels often enough to confirm a deploy without thrashing. */
const POLL_INTERVAL_MS = 30_000;

/** Human-friendly uptime — mirrors `formatUptime` in src/process-state.ts. */
export function formatUptime(uptimeMs: number): string {
  const ms = Math.max(0, uptimeMs);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/**
 * Format an ISO timestamp as `YYYY-MM-DD HH:MM:SS UTC`. Plain UTC string
 * (not the operator's local timezone) so it lines up with `parachute
 * status` and the CHANGELOG dates the operator is cross-referencing.
 */
export function formatTimestampUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** Human-friendly source label. Mirrors the SOURCE column in `parachute status`. */
function sourceLabel(status: HubStatus): string {
  if (status.source === "container") return "container";
  if (status.source === "npm") return "npm";
  if (status.source === "bun-linked") {
    const basename = status.bun_linked_path?.split("/").filter(Boolean).pop();
    if (basename && status.git_head) return `bun-linked → ${basename} @ ${status.git_head}`;
    if (basename) return `bun-linked → ${basename}`;
    return "bun-linked";
  }
  return "unknown";
}

export function HubVersionBadge() {
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await getHubStatus();
      setStatus(next);
      setLastCheckedAt(new Date());
    } catch {
      // 401 / 403 / network blip — leave the previously-rendered status
      // in place (or null if first-load). Silent: the rest of the SPA
      // will surface auth failures via its own routes.
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [refresh]);

  if (!status) return null;

  return (
    <footer className="hub-version-badge" data-testid="hub-version-badge">
      <button
        type="button"
        className="hub-version-badge-summary"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        data-testid="hub-version-badge-summary"
      >
        Hub <strong>{status.version}</strong> · running{" "}
        <span data-testid="hub-version-badge-uptime">{formatUptime(status.uptime_ms)}</span> ·{" "}
        <span className="hub-version-badge-source" data-testid="hub-version-badge-source">
          {status.source}
        </span>
      </button>
      {expanded ? (
        <div className="hub-version-badge-panel" data-testid="hub-version-badge-panel">
          <dl>
            <dt>Hub</dt>
            <dd>
              <code>@openparachute/hub {status.version}</code>
            </dd>
            <dt>Source</dt>
            <dd>{sourceLabel(status)}</dd>
            <dt>Started</dt>
            <dd>
              {formatTimestampUtc(status.started_at)} ({formatUptime(status.uptime_ms)} ago)
            </dd>
            {status.container_build_time ? (
              <>
                <dt>Built</dt>
                <dd>{formatTimestampUtc(status.container_build_time)}</dd>
              </>
            ) : null}
            {lastCheckedAt ? (
              <>
                <dt>Last checked</dt>
                <dd>{formatTimestampUtc(lastCheckedAt.toISOString())}</dd>
              </>
            ) : null}
          </dl>
          <button
            type="button"
            className="hub-version-badge-refresh secondary"
            onClick={() => void refresh()}
            disabled={refreshing}
            data-testid="hub-version-badge-refresh"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      ) : null}
    </footer>
  );
}
