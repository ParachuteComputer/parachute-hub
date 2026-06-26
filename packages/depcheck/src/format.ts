/**
 * The message formatter. Turns a `DepSpec` (or a missing one) into the
 * operator-facing "you're missing X, here's how to get it" block, plus the
 * structured wire shape the SPA / API consumers render.
 *
 * Message anatomy (5 parts), in order:
 *   1. line 1  — `<binary> is required to <why>, but it was not found on PATH.`
 *   2. install — an `Install it:` block. The detected-OS line leads, but all
 *                applicable families are listed so a headless reader on a
 *                different box still has the recipe. `linuxBinaryUrl` (static
 *                binary) wins over apt/dnf on Linux when it yields a recipe;
 *                unknown arch drops to docs rather than fabricating a URL.
 *   3. docs    — `Docs: <docsUrl>` — always present.
 *   4. trailer — `Or ask your system administrator to install it for you.`,
 *                REPLACED by `altHint` when the spec is `optional`.
 *
 * `interactive: false` (headless / API reader) strips ANSI and drops the
 * sysadmin/alt trailer — the reader of a JSON error IS the admin, so it gets
 * binary + why + install + docs only, no "ask someone else" noise.
 *
 * An unregistered binary (spec === undefined) yields a deliberately generic
 * line with NO fabricated install command.
 */

import type { DepSpec } from "./registry.js";

export interface FormatOpts {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.arch`. */
  arch?: NodeJS.Architecture;
  /**
   * Whether the reader is a human at a terminal (default true). `false` ⇒
   * strip ANSI + drop the sysadmin/alt trailer (headless reader IS the admin).
   */
  interactive?: boolean;
}

/** Structured wire shape — aligns hub's `proxy-error-ui.ts` envelope
 * (`{ error, error_type, error_description }`) plus the dependency fields a
 * UI needs to render a dedicated install card. */
export interface MissingDependencyWire {
  error: "missing_dependency";
  error_type: "missing_dependency";
  error_description: string;
  binary: string;
  why: string | null;
  docs_url: string | null;
  install: {
    darwin?: string;
    linux?: string;
    generic?: string;
  };
  sysadmin_hint: string;
}

const SYSADMIN_TRAILER = "Or ask your system administrator to install it for you.";

/**
 * #634: the operator-facing block for a binary that IS present on PATH but is
 * NOT executable (a 100644 file — caught when a module's `bin` lost its +x bit
 * and the supervisor reported a misleading "<binary> not installed" despite an
 * intact symlink). Distinct from "not found on PATH": the file is right there,
 * the fix is `chmod +x`, NOT a reinstall. Self-contained (no DepSpec needed —
 * the path + chmod recipe is the whole message). `interactive: false` strips
 * ANSI for a headless / JSON reader.
 */
export function formatNonExecutable(binary: string, path: string, opts: FormatOpts = {}): string {
  const interactive = opts.interactive ?? true;
  const out = [`${binary} found at ${path} but is not executable — run chmod +x ${path}`].join(
    "\n",
  );
  return interactive ? out : stripAnsi(out);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR escapes is the point.
const ANSI_PATTERN = /\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

/**
 * Resolve the ordered list of install command lines for a spec, honoring the
 * detected platform/arch. Used both by the human formatter and (in flattened
 * form) by the wire shape.
 *
 *   - darwin            → the macOS recipe, else generic.
 *   - linux             → static-binary recipe (linuxBinaryUrl) if it yields
 *                         one for this arch; else apt + dnf; else generic.
 *   - other / unknown   → every recipe we have (the reader's box is unknown,
 *                         so list them all rather than guess).
 *
 * Returns `[]` when the spec carries no install recipe at all (foundational
 * tools like `tar` / `tail` that are "almost always present" — the formatter
 * then leans on the docs line + sysadmin trailer).
 */
export function resolveInstallCommands(spec: DepSpec, opts: FormatOpts = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const { darwin, linuxApt, linuxDnf, linuxBinaryUrl, generic } = spec.install;

  if (platform === "darwin") {
    if (darwin) return [darwin];
    if (generic) return [generic];
    return [];
  }

  if (platform === "linux") {
    // Static binary wins over distro packages when available for this arch.
    const binaryRecipe = linuxBinaryUrl?.(arch);
    if (binaryRecipe) return [binaryRecipe];
    const distro: string[] = [];
    if (linuxApt) distro.push(linuxApt);
    if (linuxDnf) distro.push(linuxDnf);
    if (distro.length > 0) return distro;
    if (generic) return [generic];
    return [];
  }

  // Unknown / non-darwin-non-linux platform (win32, etc.): we can't detect a
  // package manager, so surface everything we have. linuxBinaryUrl is only
  // listed when it yields a recipe for the (possibly unknown) arch — never
  // fabricate a URL for an arch with no published artifact.
  const all: string[] = [];
  if (darwin) all.push(darwin);
  const binaryRecipe = linuxBinaryUrl?.(arch);
  if (binaryRecipe) all.push(binaryRecipe);
  if (linuxApt) all.push(linuxApt);
  if (linuxDnf) all.push(linuxDnf);
  if (generic) all.push(generic);
  return all;
}

/**
 * Flatten a spec's install recipes into the wire shape's `install` map. The
 * map's three keys mirror what a UI groups by (macOS / Linux / generic).
 * Linux prefers the static-binary recipe for the given arch, falling back to
 * the joined apt/dnf lines. Empty recipes are omitted.
 */
function wireInstall(spec: DepSpec, arch: NodeJS.Architecture): MissingDependencyWire["install"] {
  const out: MissingDependencyWire["install"] = {};
  if (spec.install.darwin) out.darwin = spec.install.darwin;
  const binaryRecipe = spec.install.linuxBinaryUrl?.(arch);
  if (binaryRecipe) {
    out.linux = binaryRecipe;
  } else {
    const distro: string[] = [];
    if (spec.install.linuxApt) distro.push(spec.install.linuxApt);
    if (spec.install.linuxDnf) distro.push(spec.install.linuxDnf);
    if (distro.length > 0) out.linux = distro.join("\n");
  }
  if (spec.install.generic) out.generic = spec.install.generic;
  return out;
}

/** Human-readable label for the platform's install line lead. */
function platformLabel(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

/**
 * Build the operator-facing block. See module docstring for the anatomy.
 *
 * `spec === undefined` ⇒ unregistered binary ⇒ generic, no fabricated command.
 */
export function formatMissingDependency(
  binary: string,
  spec: DepSpec | undefined,
  opts: FormatOpts = {},
): string {
  const interactive = opts.interactive ?? true;

  if (!spec) {
    const generic = `${binary} is required but was not found on PATH. Ask your system administrator, or check the Parachute docs.`;
    return interactive ? generic : stripAnsi(generic);
  }

  const platform = opts.platform ?? process.platform;

  const lines: string[] = [];
  // 1. headline
  lines.push(`${binary} is required to ${spec.why}, but it was not found on PATH.`);

  // 2. install block
  const cmds = resolveInstallCommands(spec, opts);
  if (cmds.length > 0) {
    lines.push("");
    // Lead the install block with the detected OS for human readers; the
    // resolveInstallCommands list is already platform-scoped so this is a
    // label, not a second filter.
    if (platform === "darwin" || platform === "linux") {
      lines.push(`Install it (${platformLabel(platform)}):`);
    } else {
      lines.push("Install it:");
    }
    for (const cmd of cmds) {
      // Multi-line recipes (cloudflared static binary) indent each line.
      for (const sub of cmd.split("\n")) {
        lines.push(`  ${sub}`);
      }
    }
  }

  // 3. docs — always
  lines.push("");
  lines.push(`Docs: ${spec.docsUrl}`);

  // 4. trailer — sysadmin (foundational) or altHint (optional/provider).
  //    Stripped entirely in non-interactive mode (the reader IS the admin).
  if (interactive) {
    lines.push("");
    if (spec.optional && spec.altHint) {
      lines.push(spec.altHint);
    } else {
      lines.push(SYSADMIN_TRAILER);
    }
  }

  const out = lines.join("\n");
  return interactive ? out : stripAnsi(out);
}

/**
 * The structured wire shape for an API / SPA consumer. `error_description` is
 * the headless (interactive:false) formatted block — no sysadmin trailer, no
 * ANSI — so a generic error reader that only knows `error_description` still
 * gets a usable message, while a missing_dependency-aware UI reads the typed
 * fields and renders a dedicated card.
 */
export function toMissingDependencyWire(
  binary: string,
  spec: DepSpec | undefined,
  opts: FormatOpts = {},
): MissingDependencyWire {
  const arch = opts.arch ?? process.arch;
  // error_description is always the headless rendering — a JSON consumer is
  // the admin, so no "ask someone else" trailer leaks into the wire.
  const error_description = formatMissingDependency(binary, spec, { ...opts, interactive: false });

  if (!spec) {
    return {
      error: "missing_dependency",
      error_type: "missing_dependency",
      error_description,
      binary,
      why: null,
      docs_url: null,
      install: {},
      sysadmin_hint: SYSADMIN_TRAILER,
    };
  }

  return {
    error: "missing_dependency",
    error_type: "missing_dependency",
    error_description,
    binary,
    why: spec.why,
    docs_url: spec.docsUrl,
    install: wireInstall(spec, arch),
    sysadmin_hint: spec.optional && spec.altHint ? spec.altHint : SYSADMIN_TRAILER,
  };
}
