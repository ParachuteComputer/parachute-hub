/**
 * Renders a structured missing-dependency error (`error_type ===
 * "missing_dependency"`) as a dedicated install card: heading, why subhead,
 * per-platform install commands as copy-to-clipboard blocks (keyed to
 * `navigator.platform` so the operator's own OS leads), a docs link, and the
 * muted sysadmin hint.
 *
 * Consumers (e.g. the Modules operations banner) should switch on
 * `error_type === "missing_dependency"` and render this; for any unrecognized
 * error type, fall back to the plain `error_description` (see
 * `renderOperationError` below).
 *
 * Wire shape mirrors the hub's `@openparachute/depcheck` `MissingDependencyWire`.
 */
import { type ReactElement, useState } from "react";
import type { MissingDependencyWire } from "../lib/api.ts";

/** Best-effort OS detection from navigator.platform so we lead with the
 * operator's own install line. Falls back to "generic" (lists everything). */
function detectOs(): "darwin" | "linux" | "other" {
  if (typeof navigator === "undefined") return "other";
  const p = (navigator.platform || "").toLowerCase();
  if (p.includes("mac")) return "darwin";
  if (p.includes("linux")) return "linux";
  return "other";
}

interface InstallLine {
  label: string;
  command: string;
  /** True when this line matches the detected OS — rendered first + emphasized. */
  preferred: boolean;
}

function installLines(
  install: MissingDependencyWire["install"],
  os: ReturnType<typeof detectOs>,
): InstallLine[] {
  const lines: InstallLine[] = [];
  if (install.darwin) {
    lines.push({ label: "macOS", command: install.darwin, preferred: os === "darwin" });
  }
  if (install.linux) {
    lines.push({ label: "Linux", command: install.linux, preferred: os === "linux" });
  }
  if (install.generic) {
    // "generic" applies anywhere; it's preferred only when no OS-specific line
    // matched the detected OS (so the operator still gets a lead command).
    const hasOsMatch = lines.some((l) => l.preferred);
    lines.push({ label: "Any platform", command: install.generic, preferred: !hasOsMatch });
  }
  // Preferred line(s) first.
  return lines.sort((a, b) => Number(b.preferred) - Number(a.preferred));
}

function CopyBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (insecure context / permissions) — the command
      // is still visible + selectable, so this degrades gracefully.
    }
  }
  return (
    <div className="depcard-cmd">
      <pre className="depcard-cmd-text">{command}</pre>
      <button
        type="button"
        className="btn btn-secondary depcard-copy"
        onClick={() => void copy()}
        aria-label="Copy install command"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function MissingDependencyCard({ wire }: { wire: MissingDependencyWire }) {
  const os = detectOs();
  const lines = installLines(wire.install, os);
  return (
    <div className="depcard" data-testid="missing-dependency-card">
      <h3 className="depcard-heading">{wire.binary} isn't installed</h3>
      {wire.why ? <p className="depcard-why muted">It's needed to {wire.why}.</p> : null}
      {lines.length > 0 ? (
        <div className="depcard-installs">
          <p className="depcard-installs-label">Install it:</p>
          {lines.map((l) => (
            <div
              key={l.label}
              className={l.preferred ? "depcard-install preferred" : "depcard-install"}
            >
              <span className="depcard-os">{l.label}</span>
              <CopyBlock command={l.command} />
            </div>
          ))}
        </div>
      ) : null}
      {wire.docs_url ? (
        <p className="depcard-docs">
          <a href={wire.docs_url} target="_blank" rel="noreferrer noopener">
            Documentation
          </a>
        </p>
      ) : null}
      {wire.sysadmin_hint ? <p className="depcard-hint muted">{wire.sysadmin_hint}</p> : null}
    </div>
  );
}

/**
 * Shared switch: render the dedicated install card for missing_dependency
 * errors, FALL BACK to the verbatim `error_description` for any other typed
 * error, and to the plain `error` string when there's no structured detail.
 * Returns null when there's nothing to show.
 */
export function renderOperationError(opts: {
  error?: string;
  errorDetail?: { error_type: string } & Partial<Omit<MissingDependencyWire, "error_type">>;
}): ReactElement | null {
  const { error, errorDetail } = opts;
  if (errorDetail?.error_type === "missing_dependency") {
    return <MissingDependencyCard wire={errorDetail as unknown as MissingDependencyWire} />;
  }
  if (errorDetail?.error_description) {
    return <span className="depcard-fallback">{errorDetail.error_description}</span>;
  }
  if (error) return <span className="depcard-fallback">{error}</span>;
  return null;
}
