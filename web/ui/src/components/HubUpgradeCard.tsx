/**
 * "Upgrade hub" affordance for the admin SPA (design 2026-06-01 §5.3 / D4).
 *
 * The hub is NOT a supervised module, so it doesn't get a row in the Modules
 * list — it's the host. This card sits at the TOP of /admin/modules (above
 * "Installed modules"), the management surface alongside the per-module upgrade
 * buttons, and gives the no-shell (Render/Fly) operator a way to upgrade the
 * hub itself.
 *
 * THE FLOW:
 *   1. Show current hub version + target version + channel + an Upgrade button.
 *   2. On click → POST /api/hub/upgrade → 202 { mode }.
 *      - `mode: "in-place"` → the detached helper rewrites + restarts the hub.
 *        We enter the "upgrading…" state and POLL /api/hub (version) + the
 *        upgrade status until the NEW version answers (bounded timeout). The
 *        hub goes DOWN mid-upgrade, so fetches throw — that's expected; we
 *        swallow and keep polling. Success = /api/hub reports a version that
 *        differs from the pre-upgrade one (or matches the resolved target).
 *      - `mode: "redeploy-required"` → the hub is image-pinned (Render/Fly).
 *        We do NOT show a spinner; we show "redeploy from your platform
 *        dashboard" with the target version, because an in-place rewrite would
 *        be lost on the next container restart (§5.3).
 *   3. Timeout → "the hub may still be coming up — refresh shortly," plus the
 *      most recent status log line (the unit/platform hint) when available.
 *
 * Auth/Bearer rides the same `getHostAdminToken` mint-and-cache as every other
 * /api/* call (via lib/api.ts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type HubStatus,
  type HubUpgradeMode,
  type HubUpgradeStatus,
  getHubStatus,
  getHubUpgradeStatus,
  startHubUpgrade,
} from "../lib/api.ts";

/** Poll cadence while waiting for the new hub to answer. */
const POLL_INTERVAL_MS = 2000;
/** Bounded wait before we surface the "may still be coming up" timeout copy. */
const UPGRADE_TIMEOUT_MS = 120_000;

type CardState =
  | { kind: "idle" }
  /** POST sent; waiting on the 202 + detection. */
  | { kind: "starting" }
  /** in-place upgrade dispatched; polling for the new version. */
  | { kind: "upgrading"; previousVersion: string; targetVersion: string | null }
  /** new hub answered with a different version. */
  | { kind: "succeeded"; newVersion: string }
  /** bounded timeout elapsed without the new version answering. */
  | { kind: "timeout"; lastLog: string | null }
  /** image-pinned container — redeploy from the platform dashboard. */
  | { kind: "redeploy-required"; targetVersion: string | null }
  /** the upgrade failed before/at dispatch. */
  | { kind: "error"; message: string };

export function HubUpgradeCard() {
  const [hub, setHub] = useState<HubStatus | null>(null);
  const [state, setState] = useState<CardState>({ kind: "idle" });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadlineRef = useRef<number>(0);

  const loadHub = useCallback(async () => {
    try {
      setHub(await getHubStatus());
    } catch {
      // 401/403/network — the badge + this card collapse silently; the rest of
      // the SPA drives the auth redirect.
    }
  }, []);

  useEffect(() => {
    void loadHub();
  }, [loadHub]);

  // Clean up the poll timer on unmount.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /**
   * Poll /api/hub for a version change + the upgrade status log. The hub is
   * down mid-restart, so both fetches may throw — swallow and keep polling
   * until the new version answers or the bounded deadline passes.
   */
  const pollForNewVersion = useCallback(
    (previousVersion: string) => {
      deadlineRef.current = Date.now() + UPGRADE_TIMEOUT_MS;
      stopPolling();
      pollRef.current = setInterval(() => {
        void (async () => {
          let newStatus: HubStatus | null = null;
          let upgradeStatus: HubUpgradeStatus | null = null;
          try {
            newStatus = await getHubStatus();
          } catch {
            // hub still restarting — expected.
          }
          try {
            upgradeStatus = await getHubUpgradeStatus();
          } catch {
            // status endpoint unreachable mid-restart — expected.
          }
          if (newStatus && newStatus.version !== previousVersion) {
            stopPolling();
            setHub(newStatus);
            setState({ kind: "succeeded", newVersion: newStatus.version });
            return;
          }
          if (upgradeStatus?.phase === "failed") {
            stopPolling();
            setState({
              kind: "error",
              message: upgradeStatus.error ?? "the hub upgrade failed — check the platform log",
            });
            return;
          }
          if (Date.now() >= deadlineRef.current) {
            stopPolling();
            const lastLog = upgradeStatus?.log.at(-1) ?? null;
            setState({ kind: "timeout", lastLog });
          }
        })();
      }, POLL_INTERVAL_MS);
    },
    [stopPolling],
  );

  async function onUpgrade() {
    if (!hub) return;
    const previousVersion = hub.version;
    setState({ kind: "starting" });
    try {
      const accepted = await startHubUpgrade();
      const mode: HubUpgradeMode = accepted.mode;
      if (mode === "redeploy-required") {
        setState({ kind: "redeploy-required", targetVersion: accepted.target_version });
        return;
      }
      setState({ kind: "upgrading", previousVersion, targetVersion: accepted.target_version });
      pollForNewVersion(previousVersion);
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!hub) return null;

  return (
    <section className="hub-upgrade-card install-card" data-testid="hub-upgrade-card">
      <div className="install-card-body">
        <h3>
          Hub <span className="muted">(@openparachute/hub)</span>
        </h3>
        <p className="install-card-meta muted">
          Installed <code data-testid="hub-current-version">v{hub.version}</code> · source{" "}
          <code>{hub.source}</code>
        </p>
        <HubUpgradeStatusLine state={state} />
      </div>
      <div className="install-card-actions">
        <HubUpgradeAction state={state} onUpgrade={() => void onUpgrade()} />
      </div>
    </section>
  );
}

function HubUpgradeAction({
  state,
  onUpgrade,
}: {
  state: CardState;
  onUpgrade: () => void;
}) {
  // Redeploy-required: NO upgrade button that would no-op. Direct to the
  // platform dashboard instead.
  if (state.kind === "redeploy-required") {
    return (
      <span className="muted" data-testid="hub-redeploy-hint">
        Redeploy from your platform dashboard
      </span>
    );
  }
  const busy = state.kind === "starting" || state.kind === "upgrading";
  return (
    <button type="button" onClick={onUpgrade} disabled={busy} data-testid="hub-upgrade-button">
      {busy ? "Upgrading…" : "Upgrade hub"}
    </button>
  );
}

function HubUpgradeStatusLine({ state }: { state: CardState }) {
  switch (state.kind) {
    case "idle":
      return null;
    case "starting":
      return (
        <p className="muted" data-testid="hub-upgrade-state-starting">
          Starting the hub upgrade…
        </p>
      );
    case "upgrading":
      return (
        <p className="muted" data-testid="hub-upgrade-state-upgrading">
          Upgrading{state.targetVersion ? ` to v${state.targetVersion}` : ""}… the hub will restart;
          this page reconnects automatically.
        </p>
      );
    case "succeeded":
      return (
        <p className="muted" data-testid="hub-upgrade-state-success">
          Upgraded — the hub is now running <code>v{state.newVersion}</code>.
        </p>
      );
    case "timeout":
      return (
        <p className="warn-banner" data-testid="hub-upgrade-state-timeout">
          The hub may still be coming up — refresh shortly.
          {state.lastLog ? (
            <>
              {" "}
              <span className="dim">Last status: {state.lastLog}</span>
            </>
          ) : null}
        </p>
      );
    case "redeploy-required":
      return (
        <p className="warn-banner" data-testid="hub-upgrade-state-redeploy">
          This hub is baked into its container image, so an in-place upgrade wouldn't survive a
          restart.{" "}
          {state.targetVersion ? (
            <>
              Redeploy from your platform dashboard to move to <code>v{state.targetVersion}</code>.
            </>
          ) : (
            <>Redeploy from your platform dashboard to pick up the latest hub.</>
          )}
        </p>
      );
    case "error":
      return (
        <p className="error-banner" data-testid="hub-upgrade-state-error">
          Upgrade failed: {state.message}
        </p>
      );
  }
}
