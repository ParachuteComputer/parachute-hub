/**
 * /admin/settings — hub-wide operator settings.
 *
 * The first surface here is the canonical hub URL (hub#298) — the
 * runtime-settable OAuth issuer that hub stamps into every minted JWT.
 * Future hub-level settings (signing-key rotation policy, etc.) will
 * join this page rather than spawning per-feature admin pages.
 *
 * Three states the operator can be in for canonical-URL:
 *
 *   - source: "request" — no canonical URL configured. Tokens carry
 *     the request origin (Render-assigned subdomain, on-box loopback).
 *     Fine for first-boot + local dev; surfaces a Save CTA to set one.
 *   - source: "env" — `PARACHUTE_HUB_ORIGIN` is set on the container.
 *     The stored row is empty; the input field is empty. Helper text
 *     calls out that env wins until cleared, and that saving a value
 *     here overrides env.
 *   - source: "expose" — no stored row, no env var, but the box has a
 *     live `parachute expose` exposure recorded in expose-state.json.
 *     The hub derives the issuer from that exposed origin (#531) so an
 *     exposed box mints deterministic `iss` across reboots without the
 *     operator setting anything. Saving a value here overrides it.
 *   - source: "settings" — operator has saved a value via this page.
 *     Input shows the stored value; the source label confirms it's
 *     the active layer.
 *
 * Save is optimistic — the input flips to the new state before the
 * round-trip lands, with a revert on failure. Reset clears the stored
 * value (server-side PUT with `null`) and triggers a refetch so the
 * source label re-resolves through the precedence chain.
 */
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type HubOriginSetting,
  type IssuerSource,
  getHubOriginSetting,
  setHubOriginSetting,
} from "../lib/api.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; setting: HubOriginSetting }
  | { kind: "error"; message: string };

export function Settings() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // Local-only input value while the user types. Initialized + reset
  // from `setting.hub_origin` whenever the server state changes.
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const setting = await getHubOriginSetting();
      setState({ kind: "ok", setting });
      setDraft(setting.hub_origin ?? "");
      setSaveError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message: msg });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (state.kind !== "ok") return;
    const trimmed = draft.trim();
    // Empty input → store null (clear). Identical semantic to Reset
    // below; the server also normalizes "" → null but we surface that
    // shape locally for the optimistic update.
    const payload = trimmed.length === 0 ? null : trimmed;
    setSaving(true);
    setSaveError(null);
    // Optimistic: assume settings layer wins if a value was provided,
    // or whatever the precedence chain produces if we cleared. We
    // refetch to settle the source label either way.
    try {
      await setHubOriginSetting(payload);
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function onReset() {
    if (saving) return;
    if (state.kind !== "ok") return;
    setSaving(true);
    setSaveError(null);
    try {
      await setHubOriginSetting(null);
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  }

  if (state.kind === "loading") {
    return <div className="empty">Loading settings…</div>;
  }
  if (state.kind === "error") {
    return (
      <div className="empty">
        Failed to load settings: {state.message}.{" "}
        <button type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  const { setting } = state;
  const hasStored = setting.hub_origin !== null;
  const dirty = draft.trim() !== (setting.hub_origin ?? "");

  return (
    <section className="settings">
      <h1>Hub settings</h1>
      <p className="muted">
        Hub-wide operator controls. Settings here apply to every module + every minted token.
      </p>

      <section className="settings-block" aria-labelledby="canonical-hub-url-heading">
        <h2 id="canonical-hub-url-heading">Canonical hub URL</h2>

        <dl className="meta" data-testid="hub-origin-current">
          <dt>Current value</dt>
          <dd>
            <code>{setting.resolved_issuer}</code>{" "}
            <SourceLabel source={setting.source} hasStored={hasStored} />
          </dd>
        </dl>

        <form
          onSubmit={(e) => void onSave(e)}
          className="settings-form"
          data-testid="hub-origin-form"
        >
          <label htmlFor="hub-origin-input">
            <span>Canonical URL</span>
            <input
              id="hub-origin-input"
              type="url"
              inputMode="url"
              placeholder="https://hub.example.com"
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p className="muted">
            Set this when you've attached a custom domain. Tokens are minted against this URL —
            changing it invalidates any tokens already in circulation (the <code>iss</code> claim
            won't match the new issuer on verification). Leave blank to use the request origin
            (default for Render-assigned URLs).
          </p>

          <div className="actions">
            <button type="submit" disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="destructive"
              disabled={saving || !hasStored}
              onClick={() => void onReset()}
            >
              Reset to default
            </button>
          </div>

          {saveError && (
            <div className="error" data-testid="hub-origin-save-error">
              {saveError}
            </div>
          )}
        </form>
      </section>
    </section>
  );
}

interface SourceLabelProps {
  source: IssuerSource;
  hasStored: boolean;
}

/**
 * Render the source attribution for the currently-resolved issuer.
 * Distinct phrasings per layer so the operator can tell exactly which
 * precedence rung is active without reading docs. `hasStored` is
 * carried through (vs. inferring from `source === "settings"`) in case
 * a future precedence layer lands above settings — the badge can still
 * say "stored value is X" while the active source is something else.
 */
function SourceLabel({ source, hasStored: _hasStored }: SourceLabelProps) {
  if (source === "settings") {
    return (
      <span className="badge badge-info" data-testid="hub-origin-source">
        from settings
      </span>
    );
  }
  if (source === "env") {
    return (
      <span className="badge badge-info" data-testid="hub-origin-source">
        from env var <code>PARACHUTE_HUB_ORIGIN</code>
      </span>
    );
  }
  if (source === "expose") {
    return (
      <span className="badge badge-info" data-testid="hub-origin-source">
        from your <code>parachute expose</code> config
      </span>
    );
  }
  return (
    <span className="badge badge-info" data-testid="hub-origin-source">
      from request origin
    </span>
  );
}
