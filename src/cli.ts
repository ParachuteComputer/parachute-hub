#!/usr/bin/env bun

/**
 * parachute — the top-level CLI for the Parachute ecosystem.
 *
 * Run `parachute --help` or `parachute <subcommand> --help` for usage.
 */

import { MissingDependencyError } from "@openparachute/depcheck";
import pkg from "../package.json" with { type: "json" };
import { validateHubOrigin } from "./api-settings-hub-origin.ts";
import { CloudflaredStateError } from "./cloudflare/state.ts";
// Command-implementation modules are loaded LAZILY inside their switch arms (see
// `loadCommand` + each `case`), so a module that throws at eval-time is isolated
// to its own command instead of aborting the whole CLI at top-level import. The
// `import type`s below are erased at compile time (they trigger no module
// evaluation) and exist only so the arms can reference each command's options
// type for `Parameters<typeof …>`.
import type { init } from "./commands/init.ts";
import type { install } from "./commands/install.ts";
import type { setup } from "./commands/setup.ts";
import type { upgrade } from "./commands/upgrade.ts";
import { ExposeStateError } from "./expose-state.ts";
import {
  doctorHelp,
  exposeHelp,
  initHelp,
  installHelp,
  logsHelp,
  migrateHelp,
  restartHelp,
  serveHelp,
  setupHelp,
  setupWizardHelp,
  startHelp,
  statusHelp,
  stopHelp,
  topLevelHelp,
  upgradeHelp,
} from "./help.ts";
import { HUB_SVC } from "./hub-control.ts";
import { knownServices } from "./service-spec.ts";
import { ServicesManifestError } from "./services-manifest.ts";
import { TailscaleError } from "./tailscale/run.ts";

function isHelpFlag(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

/**
 * Both stdin and stdout must be TTYs before we offer interactive prompts.
 * Stdin-only TTY would let us read keystrokes but leave prompt text going to
 * a log file; stdout-only TTY would let us write prompts but never read an
 * answer. Either asymmetry means the flag-driven path is the safer default.
 */
function isTtyInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Extract `--hub-origin=<url>` / `--hub-origin <url>` from argv. Returns the
 * URL and the remaining args (so callers can keep validating positionals
 * without the flag in the way). `error` is set on missing value.
 */
function extractHubOrigin(args: string[]): {
  hubOrigin?: string;
  rest: string[];
  error?: string;
} {
  const rest: string[] = [];
  let hubOrigin: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--hub-origin") {
      const v = args[i + 1];
      if (!v) return { rest, error: "--hub-origin requires a URL argument" };
      hubOrigin = v;
      i++;
      continue;
    }
    if (a?.startsWith("--hub-origin=")) {
      hubOrigin = a.slice("--hub-origin=".length);
      if (!hubOrigin) return { rest, error: "--hub-origin requires a URL argument" };
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  return { hubOrigin, rest };
}

/**
 * Extract `--tag=<value>` / `--tag <value>` from argv. Same shape as
 * `extractHubOrigin` so the install command can layer the two flags
 * uniformly. `error` is set on missing value.
 */
function extractTag(args: string[]): {
  tag?: string;
  rest: string[];
  error?: string;
} {
  const rest: string[] = [];
  let tag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--tag") {
      const v = args[i + 1];
      if (!v) return { rest, error: "--tag requires a value (dist-tag or version)" };
      tag = v;
      i++;
      continue;
    }
    if (a?.startsWith("--tag=")) {
      tag = a.slice("--tag=".length);
      if (!tag) return { rest, error: "--tag requires a value (dist-tag or version)" };
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  return { tag, rest };
}

/**
 * Generic `--name=<value>` / `--name <value>` extractor used for the scribe
 * install flags. Returns the matched value and argv with the flag stripped, or
 * an error when the flag is present without a value.
 */
function extractNamedFlag(
  args: string[],
  flag: string,
): { value?: string; rest: string[]; error?: string } {
  const rest: string[] = [];
  let value: string | undefined;
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      const v = args[i + 1];
      if (!v) return { rest, error: `${flag} requires a value` };
      value = v;
      i++;
      continue;
    }
    if (a?.startsWith(eqPrefix)) {
      value = a.slice(eqPrefix.length);
      if (!value) return { rest, error: `${flag} requires a value` };
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  return { value, rest };
}

/**
 * Extract every `parachute expose …` provider flag in one pass:
 *
 *   --cloudflare              boolean — pin to Cloudflare Tunnel
 *   --tailnet                 boolean — pin to Tailscale Funnel (#29)
 *   --skip-provider-check     boolean — bypass auto-detection in non-TTY,
 *                                       fall through to today's Tailscale
 *                                       default (CI escape hatch, #29)
 *   --domain=<host>           hostname for the Cloudflare path
 *   --tunnel-name=<name>      named tunnel override (#32); defaults to a
 *                                       per-hostname dedicated name (#491)
 *
 * Returns the stripped argv so the layer/action parser sees `[layer, action?]`
 * regardless of flag placement. `--tailnet` + `--cloudflare` together is
 * caller-rejected; this extractor doesn't enforce mutual exclusion so help-
 * driven error messages can stay close to the dispatch site.
 */
function extractExposeProviderFlags(args: string[]): {
  cloudflare: boolean;
  tailnet: boolean;
  skipProviderCheck: boolean;
  domain?: string;
  tunnelName?: string;
  rest: string[];
  error?: string;
} {
  const rest: string[] = [];
  let cloudflare = false;
  let tailnet = false;
  let skipProviderCheck = false;
  let domain: string | undefined;
  let tunnelName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--cloudflare") {
      cloudflare = true;
      continue;
    }
    if (a === "--tailnet" || a === "--tailscale") {
      tailnet = true;
      continue;
    }
    if (a === "--skip-provider-check") {
      skipProviderCheck = true;
      continue;
    }
    if (a === "--domain") {
      const v = args[i + 1];
      if (!v) {
        return {
          cloudflare,
          tailnet,
          skipProviderCheck,
          rest,
          error: "--domain requires a hostname argument",
        };
      }
      domain = v;
      i++;
      continue;
    }
    if (a?.startsWith("--domain=")) {
      domain = a.slice("--domain=".length);
      if (!domain) {
        return {
          cloudflare,
          tailnet,
          skipProviderCheck,
          rest,
          error: "--domain requires a hostname argument",
        };
      }
      continue;
    }
    if (a === "--tunnel-name") {
      const v = args[i + 1];
      if (!v) {
        return {
          cloudflare,
          tailnet,
          skipProviderCheck,
          rest,
          error: "--tunnel-name requires a name argument",
        };
      }
      tunnelName = v;
      i++;
      continue;
    }
    if (a?.startsWith("--tunnel-name=")) {
      tunnelName = a.slice("--tunnel-name=".length);
      if (!tunnelName) {
        return {
          cloudflare,
          tailnet,
          skipProviderCheck,
          rest,
          error: "--tunnel-name requires a name argument",
        };
      }
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  const out: {
    cloudflare: boolean;
    tailnet: boolean;
    skipProviderCheck: boolean;
    domain?: string;
    tunnelName?: string;
    rest: string[];
  } = {
    cloudflare,
    tailnet,
    skipProviderCheck,
    rest,
  };
  if (domain !== undefined) out.domain = domain;
  if (tunnelName !== undefined) out.tunnelName = tunnelName;
  return out;
}

/**
 * Lazy-load a command-implementation module, isolating an eval-time throw to the
 * command that asked for it.
 *
 * `cli.ts` used to eagerly `import` every command module at top-level. That made
 * a single broken module (e.g. a half-built `migrate-cutover.ts` with a
 * ReferenceError at eval) abort the *entire* CLI load — even `parachute --help`
 * — because top-level import evaluation runs before `run()`'s try/catch is ever
 * reached. Loading each module lazily inside its switch arm (the same pattern
 * the expose subcommands already use, e.g. `await import("./commands/expose-
 * cloudflare.ts")`) means an import rejection touches only its own command.
 *
 * On rejection we print `parachute <cmd>: failed to load (<err>)` and return
 * `undefined`; the arm turns that into exit code 1. This keeps a broken module
 * from surfacing as an unhandled promise rejection (which the top-level
 * `run()` boundary doesn't shape — it wraps execution, not import).
 */
async function loadCommand<T>(cmd: string, importer: () => Promise<T>): Promise<T | undefined> {
  try {
    return await importer();
  } catch (err) {
    console.error(
      `parachute ${cmd}: failed to load (${err instanceof Error ? err.message : String(err)})`,
    );
    return undefined;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(topLevelHelp());
      return 0;

    case "--version":
    case "-v":
      console.log(pkg.version);
      return 0;

    case "setup": {
      if (isHelpFlag(rest[0])) {
        console.log(setupHelp());
        return 0;
      }
      const tagExtract = extractTag(rest);
      if (tagExtract.error) {
        console.error(`parachute setup: ${tagExtract.error}`);
        return 1;
      }
      const noStart = tagExtract.rest.includes("--no-start");
      const remaining = tagExtract.rest.filter((a) => a !== "--no-start");
      if (remaining.length > 0) {
        console.error(`parachute setup: unknown argument "${remaining[0]}"`);
        console.error("usage: parachute setup [--tag <name>] [--no-start]");
        return 1;
      }
      const setupOpts: Parameters<typeof setup>[0] = {};
      if (tagExtract.tag) setupOpts.tag = tagExtract.tag;
      if (noStart) setupOpts.noStart = true;
      const mod = await loadCommand("setup", () => import("./commands/setup.ts"));
      if (!mod) return 1;
      return await mod.setup(setupOpts);
    }

    case "setup-wizard": {
      // hub#168 Cut 3 — the in-terminal mirror of /admin/setup. Distinct
      // from `parachute setup` (which is the multi-pick install
      // walk-through, not a wizard-handler frontend). Both surfaces stay
      // — `parachute setup` is the historical "install + configure
      // services" entry; `parachute setup-wizard` drives the same
      // handlers the browser wizard uses.
      if (isHelpFlag(rest[0])) {
        console.log(setupWizardHelp());
        return 0;
      }
      const mod = await loadCommand("setup-wizard", () => import("./commands/wizard.ts"));
      if (!mod) return 1;
      return await mod.runSetupWizardCommand(rest);
    }

    case "init": {
      if (isHelpFlag(rest[0])) {
        console.log(initHelp());
        return 0;
      }
      const originExtract = extractHubOrigin(rest);
      if (originExtract.error) {
        console.error(`parachute init: ${originExtract.error}`);
        return 1;
      }
      // Validate --hub-origin to the SAME shape `hub set-origin` enforces — the
      // value is persisted to hub_settings.hub_origin and stamps the OAuth `iss`
      // claim on every minted token, so a malformed path/scheme/credential must
      // never reach the DB. Strip a trailing slash first (browser copy-paste
      // ergonomics), then validate; pass the normalized form downstream.
      let validatedHubOrigin: string | undefined;
      if (originExtract.hubOrigin !== undefined) {
        const result = validateHubOrigin(originExtract.hubOrigin.replace(/\/+$/, ""));
        if (!result.ok) {
          console.error(`parachute init: invalid --hub-origin: ${result.description}`);
          return 1;
        }
        if (result.normalized === null) {
          console.error(
            "parachute init: invalid --hub-origin: an empty value is not a valid public origin.",
          );
          return 1;
        }
        validatedHubOrigin = result.normalized;
      }
      const exposeExtract = extractNamedFlag(originExtract.rest, "--expose");
      if (exposeExtract.error) {
        console.error(`parachute init: ${exposeExtract.error}`);
        return 1;
      }
      if (
        exposeExtract.value !== undefined &&
        exposeExtract.value !== "none" &&
        exposeExtract.value !== "tailnet" &&
        exposeExtract.value !== "cloudflare"
      ) {
        console.error(
          `parachute init: --expose must be one of none|tailnet|cloudflare (got "${exposeExtract.value}")`,
        );
        return 1;
      }
      // hub#694 bug 2: `--channel rc|latest` picks the dist-tag init installs the
      // vault module from. Without it, init always resolved @latest — DOWNGRADING
      // vault below an rc-tracking hub. Mirrors `parachute install --channel`.
      const channelExtract = extractNamedFlag(exposeExtract.rest, "--channel");
      if (channelExtract.error) {
        console.error(`parachute init: ${channelExtract.error}`);
        return 1;
      }
      if (
        channelExtract.value !== undefined &&
        channelExtract.value !== "rc" &&
        channelExtract.value !== "latest"
      ) {
        console.error(
          `parachute init: --channel must be "rc" or "latest" (got "${channelExtract.value}")`,
        );
        return 1;
      }
      // #478 Part 2: --vault-name <name> creates the first vault in one shot.
      const vaultNameExtract = extractNamedFlag(channelExtract.rest, "--vault-name");
      if (vaultNameExtract.error) {
        console.error(`parachute init: ${vaultNameExtract.error}`);
        return 1;
      }
      let validatedVaultName: string | undefined;
      if (vaultNameExtract.value !== undefined) {
        if (vaultNameExtract.value.trim() === "") {
          console.error("parachute init: --vault-name must not be empty.");
          return 1;
        }
        const { validateVaultName: vvn } = await import("./vault-name.ts");
        const vr = vvn(vaultNameExtract.value);
        if (!vr.ok) {
          console.error(`parachute init: invalid --vault-name: ${vr.error}`);
          return 1;
        }
        validatedVaultName = vr.name;
      }
      const noBrowser = vaultNameExtract.rest.includes("--no-browser");
      const noExposePrompt = vaultNameExtract.rest.includes("--no-expose-prompt");
      const cliWizard = vaultNameExtract.rest.includes("--cli-wizard");
      const browserWizard = vaultNameExtract.rest.includes("--browser-wizard");
      const known = new Set([
        "--no-browser",
        "--no-expose-prompt",
        "--cli-wizard",
        "--browser-wizard",
      ]);
      const unknown = vaultNameExtract.rest.find((a) => !known.has(a));
      if (unknown !== undefined) {
        console.error(`parachute init: unknown argument "${unknown}"`);
        console.error(
          "usage: parachute init [--no-browser] [--no-expose-prompt]\n" +
            "                     [--expose none|tailnet|cloudflare]\n" +
            "                     [--channel rc|latest]\n" +
            "                     [--hub-origin <url>]\n" +
            "                     [--vault-name <name>]\n" +
            "                     [--cli-wizard | --browser-wizard]",
        );
        return 1;
      }
      if (cliWizard && browserWizard) {
        console.error("parachute init: --cli-wizard and --browser-wizard are mutually exclusive.");
        return 1;
      }
      const initOpts: Parameters<typeof init>[0] = {};
      if (noBrowser) initOpts.noBrowser = true;
      if (noExposePrompt) initOpts.noExposePrompt = true;
      if (validatedHubOrigin) initOpts.hubOrigin = validatedHubOrigin;
      if (exposeExtract.value) {
        initOpts.exposeChoice = exposeExtract.value as "none" | "tailnet" | "cloudflare";
      }
      if (channelExtract.value === "rc" || channelExtract.value === "latest") {
        initOpts.channel = channelExtract.value;
      }
      if (validatedVaultName !== undefined) initOpts.vaultName = validatedVaultName;
      if (cliWizard) initOpts.wizardChoice = "cli";
      else if (browserWizard) initOpts.wizardChoice = "browser";
      const mod = await loadCommand("init", () => import("./commands/init.ts"));
      if (!mod) return 1;
      return await mod.init(initOpts);
    }

    case "install": {
      if (isHelpFlag(rest[0])) {
        console.log(installHelp());
        return 0;
      }
      const tagExtract = extractTag(rest);
      if (tagExtract.error) {
        console.error(`parachute install: ${tagExtract.error}`);
        return 1;
      }
      const channelExtract = extractNamedFlag(tagExtract.rest, "--channel");
      if (channelExtract.error) {
        console.error(`parachute install: ${channelExtract.error}`);
        return 1;
      }
      if (
        channelExtract.value !== undefined &&
        channelExtract.value !== "rc" &&
        channelExtract.value !== "latest"
      ) {
        console.error(
          `parachute install: --channel must be "rc" or "latest" (got "${channelExtract.value}")`,
        );
        return 1;
      }
      const providerExtract = extractNamedFlag(channelExtract.rest, "--scribe-provider");
      if (providerExtract.error) {
        console.error(`parachute install: ${providerExtract.error}`);
        return 1;
      }
      const keyExtract = extractNamedFlag(providerExtract.rest, "--scribe-key");
      if (keyExtract.error) {
        console.error(`parachute install: ${keyExtract.error}`);
        return 1;
      }
      const noStart = keyExtract.rest.includes("--no-start");
      const interactive = keyExtract.rest.includes("--interactive");
      const installArgs = keyExtract.rest.filter(
        (a) => a !== "--no-start" && a !== "--interactive",
      );
      const service = installArgs[0];
      if (!service) {
        console.error(
          "usage: parachute install <service|all> [--channel rc|latest] [--tag <name>] [--no-start] [--interactive]",
        );
        console.error(
          "       parachute install scribe [--scribe-provider <name>] [--scribe-key <key>]",
        );
        console.error(`services: ${knownServices().join(", ")}`);
        return 1;
      }
      const installOpts: Parameters<typeof install>[1] = {};
      if (tagExtract.tag) installOpts.tag = tagExtract.tag;
      if (channelExtract.value === "rc" || channelExtract.value === "latest") {
        installOpts.channel = channelExtract.value;
      }
      if (noStart) installOpts.noStart = true;
      if (interactive) installOpts.interactive = true;
      if (providerExtract.value) installOpts.scribeProvider = providerExtract.value;
      if (keyExtract.value) installOpts.scribeKey = keyExtract.value;
      const mod = await loadCommand("install", () => import("./commands/install.ts"));
      if (!mod) return 1;
      if (service === "all") {
        // Bootstrap the whole ecosystem to one dist-tag — the RC-testing payload.
        // Bail on first failure so a broken channel doesn't mask a working tag.
        for (const svc of knownServices()) {
          const code = await mod.install(svc, installOpts);
          if (code !== 0) return code;
        }
        return 0;
      }
      return await mod.install(service, installOpts);
    }

    case "status":
      if (isHelpFlag(rest[0])) {
        console.log(statusHelp());
        return 0;
      }
      // Pass an empty `supervisor` block so `status` takes the Phase 3c
      // dual-dispatch: on a box with a hub unit installed it reads the platform
      // manager + the running supervisor; on a legacy detached box it falls back
      // to the pidfile readout (design §6.4). Tests drive the seams directly.
      {
        const mod = await loadCommand("status", () => import("./commands/status.ts"));
        if (!mod) return 1;
        return await mod.status({ supervisor: {} });
      }

    case "doctor": {
      if (isHelpFlag(rest[0])) {
        console.log(doctorHelp());
        return 0;
      }
      const json = rest.includes("--json");
      const fix = rest.includes("--fix");
      const yes = rest.includes("--yes") || rest.includes("-y");
      const known = new Set(["--json", "--fix", "--yes", "-y"]);
      const unknown = rest.find((a) => !known.has(a));
      if (unknown !== undefined) {
        console.error(`parachute doctor: unknown argument "${unknown}"`);
        console.error("usage: parachute doctor [--json] [--fix [--yes]]");
        return 1;
      }
      if (json && fix) {
        console.error("parachute doctor: --json and --fix are mutually exclusive");
        return 1;
      }
      const mod = await loadCommand("doctor", () => import("./commands/doctor.ts"));
      if (!mod) return 1;
      return await mod.doctor({ json, fix, yes });
    }

    case "expose": {
      const hubExtract = extractHubOrigin(rest);
      if (hubExtract.error) {
        console.error(`parachute expose: ${hubExtract.error}`);
        return 1;
      }
      const flagExtract = extractExposeProviderFlags(hubExtract.rest);
      if (flagExtract.error) {
        console.error(`parachute expose: ${flagExtract.error}`);
        return 1;
      }
      if (flagExtract.cloudflare && flagExtract.tailnet) {
        console.error(
          "parachute expose: --tailnet and --cloudflare are mutually exclusive. Pick one.",
        );
        return 1;
      }
      const exposeArgs = flagExtract.rest;
      let layer = exposeArgs[0];
      const mode = exposeArgs[1];
      if (isHelpFlag(layer)) {
        console.log(exposeHelp());
        return 0;
      }
      // Alias: `parachute expose cloudflare [--domain X] [off]` is shorthand for
      // `parachute expose public --cloudflare …`. Cloudflare is a public-internet
      // provider, so we rewrite the layer to `public` and force the cloudflare
      // flag — the rest of the dispatch (domain prompt, off-path, etc.) is
      // identical to the canonical form.
      if (layer === "cloudflare") {
        layer = "public";
        flagExtract.cloudflare = true;
      }
      if (layer !== "tailnet" && layer !== "public") {
        console.error(`parachute expose: unknown layer "${layer ?? ""}"`);
        console.error("usage: parachute expose tailnet [off]");
        console.error("       parachute expose public  [off]");
        console.error("       parachute expose public --cloudflare --domain <hostname>");
        console.error("run `parachute expose --help` for details");
        return 1;
      }
      if (isHelpFlag(mode)) {
        console.log(exposeHelp());
        return 0;
      }
      if (mode !== undefined && mode !== "off") {
        console.error(`parachute expose ${layer}: unknown argument "${mode}"`);
        console.error(`usage: parachute expose ${layer} [off]`);
        return 1;
      }
      const action = mode === "off" ? "off" : "up";

      if (flagExtract.tailnet && layer !== "public") {
        console.error(
          "parachute expose: --tailnet pins the public layer to Tailscale Funnel; it doesn't apply to `expose tailnet`.",
        );
        return 1;
      }

      // Cloudflare mode is a separate execution path — different detector,
      // different state file, different process model (it spawns cloudflared
      // rather than driving tailscale serve/funnel). Route to it early.
      if (flagExtract.cloudflare) {
        if (layer !== "public") {
          console.error(
            "parachute expose: --cloudflare only applies to `public` (it's a public-internet path).",
          );
          return 1;
        }
        const { exposeCloudflareUp, exposeCloudflareOff } = await import(
          "./commands/expose-cloudflare.ts"
        );
        // `supervisor: {}` opts into the Phase 4 dual-dispatch (design §4.3): on
        // a box with a hub unit installed, ensure the unit + drive the running
        // supervisor for the post-expose vault restart, and leave the hub running
        // on `off`; on a legacy detached box (no unit), the unchanged path.
        const cfOpts = {
          supervisor: {},
          ...(flagExtract.tunnelName ? { tunnelName: flagExtract.tunnelName } : {}),
        };
        if (action === "off") {
          return await exposeCloudflareOff(cfOpts);
        }
        if (!flagExtract.domain) {
          // Partial flag promotion: the user told us they want Cloudflare but
          // didn't supply a hostname. In a TTY, prompt only for what's
          // missing instead of forcing them to retype the whole command. In a
          // non-TTY (scripts, CI), keep today's hard-error so automation
          // doesn't block on an invisible prompt.
          if (isTtyInteractive()) {
            const { exposePublicInteractive } = await import("./commands/expose-interactive.ts");
            // Thread `supervisor: {}` into BOTH provider opts so the interactive
            // path takes the Phase 4 unit-arm on a unit-managed box regardless of
            // which provider the operator picks (design §4.3).
            return await exposePublicInteractive({
              preselect: "cloudflare",
              exposeOpts: { supervisor: {} },
              cloudflareOpts: { supervisor: {} },
            });
          }
          console.error("parachute expose public --cloudflare: --domain <hostname> is required.");
          console.error("Example: parachute expose public --cloudflare --domain vault.example.com");
          console.error("");
          console.error("The hostname's apex domain must already be a zone on your Cloudflare");
          console.error(
            "account. If you don't have one yet: https://dash.cloudflare.com → Add site.",
          );
          console.error("");
          console.error("If you'd rather not own a domain, use Tailscale Funnel instead:");
          console.error("  parachute expose public");
          return 1;
        }
        return await exposeCloudflareUp(flagExtract.domain, cfOpts);
      }

      // `supervisor: {}` opts into the Phase 4 dual-dispatch (design §4.3): on a
      // box with a hub unit installed, ensure the unit (not a detached spawn) +
      // drive the running supervisor for the post-expose vault restart, and leave
      // the hub running on `off`; on a legacy detached box, the unchanged path.
      const exposeOpts = {
        supervisor: {},
        ...(hubExtract.hubOrigin ? { hubOrigin: hubExtract.hubOrigin } : {}),
      };

      // Lazy-load the Tailscale-Funnel entry points the same way the Cloudflare /
      // interactive / auto-pick paths above load theirs. Reaching here means we're
      // past the early Cloudflare returns, so `exposePublic` / `exposeTailnet` are
      // about to be needed by one of the branches below.
      const exposeMod = await loadCommand("expose", () => import("./commands/expose.ts"));
      if (!exposeMod) return 1;
      const { exposePublic, exposeTailnet } = exposeMod;

      // `--tailnet` is the explicit Tailscale Funnel pin — bypass both the
      // interactive picker and the non-TTY auto-pick. Goes straight to
      // exposePublic so today's Funnel flow keeps working unchanged.
      if (layer === "public" && action === "up" && flagExtract.tailnet) {
        return await exposePublic("up", exposeOpts);
      }

      // Interactive picker: `parachute expose public` with no provider flags,
      // running under a TTY on both stdin and stdout, routes through a guided
      // flow that offers Tailscale vs. Cloudflare, walks provider setup, and
      // hands back to the flag-driven entry points.
      if (layer === "public" && action === "up" && isTtyInteractive()) {
        const { exposePublicInteractive } = await import("./commands/expose-interactive.ts");
        // `exposeOpts` already carries `supervisor: {}`; thread it into the
        // Cloudflare branch too so the unit-arm applies regardless of pick.
        return await exposePublicInteractive({ exposeOpts, cloudflareOpts: { supervisor: {} } });
      }

      // Non-TTY auto-pick: detect which provider is configured and run it.
      // `--skip-provider-check` (CI escape hatch) skips detection and falls
      // through to today's Tailscale-Funnel default — useful when the
      // environment is already pre-flighted and the auto-pick would just
      // print noise. Both paths run only on `expose public up`; tailnet
      // exposure has only one provider so nothing to pick.
      //
      // `domain` and `tunnelName` are deliberately *not* threaded into
      // auto-pick. Both are Cloudflare-only flags; if a user passes them
      // without `--cloudflare`, threading would silently route them to
      // Cloudflare. Better to drop the flags here and let auto-pick decide
      // purely from what's installed — if it lands on cloudflare-only-ready,
      // it prints the explicit `--cloudflare --domain` hint instead of
      // guessing intent.
      if (layer === "public" && action === "up" && !flagExtract.skipProviderCheck) {
        const { exposePublicAutoPick } = await import("./commands/expose-public-auto.ts");
        // `tailscaleOpts` carries `supervisor: {}`; thread it into the Cloudflare
        // branch too so the Phase 4 unit-arm applies regardless of auto-pick.
        return await exposePublicAutoPick({
          tailscaleOpts: exposeOpts,
          cloudflareOpts: { supervisor: {} },
        });
      }

      // `expose public off` (no `--cloudflare`) auto-detects which provider is
      // live. The explicit `--cloudflare` off branch above still wins — this
      // path is only for users who typed plain `off` and don't want to
      // remember which provider they brought up last.
      if (layer === "public" && action === "off") {
        const { runExposePublicOffAutoDetect } = await import("./commands/expose-off-auto.ts");
        // `tailscaleOffOpts` carries `supervisor: {}`; thread it into the
        // Cloudflare teardown leg too so the Phase 4 supervisor resolution is
        // consistent across both providers on the auto-detect path (matching
        // the explicit `--cloudflare off` branch above). Harmless today
        // (exposeCloudflareOff has no stopHub call) but keeps `supervisor: {}`
        // threaded everywhere.
        return await runExposePublicOffAutoDetect({
          tailscaleOffOpts: exposeOpts,
          cloudflareOffOpts: { supervisor: {} },
        });
      }

      // `--skip-provider-check` fallthrough: pin to today's Tailscale-Funnel
      // default for `expose public up`. Made explicit (rather than letting
      // it tumble through the layer ternary) so the escape-hatch branch is
      // visible at a glance.
      if (layer === "public" && action === "up" && flagExtract.skipProviderCheck) {
        return await exposePublic("up", exposeOpts);
      }

      return await exposeTailnet(action, exposeOpts);
    }

    case "start": {
      if (isHelpFlag(rest[0])) {
        console.log(startHelp());
        return 0;
      }
      const hubExtract = extractHubOrigin(rest);
      if (hubExtract.error) {
        console.error(`parachute start: ${hubExtract.error}`);
        return 1;
      }
      // `supervisor: {}` opts into the Phase 3b dual-dispatch: on a box with a
      // hub unit installed, drive the running supervisor; on a legacy detached
      // box (no unit), fall through to the unchanged detached path (design §3.3).
      // `migrateOffer: { enabled: true }` arms the §7.5 detect-and-offer on the
      // detached arm (offers the supervised cutover when a prior detached
      // install is found; never auto-migrates).
      const startOpts = {
        supervisor: {},
        migrateOffer: { enabled: true },
        ...(hubExtract.hubOrigin ? { hubOrigin: hubExtract.hubOrigin } : {}),
      };
      const mod = await loadCommand("start", () => import("./commands/lifecycle.ts"));
      if (!mod) return 1;
      return await mod.start(hubExtract.rest[0], startOpts);
    }

    case "stop": {
      if (isHelpFlag(rest[0])) {
        console.log(stopHelp());
        return 0;
      }
      const mod = await loadCommand("stop", () => import("./commands/lifecycle.ts"));
      if (!mod) return 1;
      return await mod.stop(rest[0], { supervisor: {}, migrateOffer: { enabled: true } });
    }

    case "restart": {
      if (isHelpFlag(rest[0])) {
        console.log(restartHelp());
        return 0;
      }
      const mod = await loadCommand("restart", () => import("./commands/lifecycle.ts"));
      if (!mod) return 1;
      return await mod.restart(rest[0], { supervisor: {}, migrateOffer: { enabled: true } });
    }

    case "upgrade": {
      if (isHelpFlag(rest[0])) {
        console.log(upgradeHelp());
        return 0;
      }
      const tagExtract = extractTag(rest);
      if (tagExtract.error) {
        console.error(`parachute upgrade: ${tagExtract.error}`);
        return 1;
      }
      const channelExtract = extractNamedFlag(tagExtract.rest, "--channel");
      if (channelExtract.error) {
        console.error(`parachute upgrade: ${channelExtract.error}`);
        return 1;
      }
      if (
        channelExtract.value !== undefined &&
        channelExtract.value !== "rc" &&
        channelExtract.value !== "latest"
      ) {
        console.error(
          `parachute upgrade: --channel must be "rc" or "latest" (got "${channelExtract.value}")`,
        );
        return 1;
      }
      let remaining = channelExtract.rest;
      const allowDowngradeIdx = remaining.indexOf("--allow-downgrade");
      const allowDowngrade = allowDowngradeIdx !== -1;
      if (allowDowngrade) {
        remaining = remaining.filter((a) => a !== "--allow-downgrade");
      }
      if (remaining.length > 1) {
        console.error(`parachute upgrade: unexpected argument "${remaining[1]}"`);
        console.error(
          "usage: parachute upgrade [<service>] [--channel rc|latest] [--allow-downgrade] [--tag <name>]",
        );
        return 1;
      }
      // `supervisor: {}` opts into the Phase 4 dual-dispatch (design §5): on a
      // box with a hub unit installed, `upgrade hub` rewrites the binary then
      // restarts the UNIT via the platform manager (children re-boot from
      // services.json); on a legacy detached box, the unchanged restart path.
      const upgradeOpts: Parameters<typeof upgrade>[1] = { supervisor: {} };
      if (tagExtract.tag) upgradeOpts.tag = tagExtract.tag;
      if (channelExtract.value === "rc" || channelExtract.value === "latest") {
        upgradeOpts.channel = channelExtract.value;
      }
      if (allowDowngrade) upgradeOpts.allowDowngrade = true;
      const mod = await loadCommand("upgrade", () => import("./commands/upgrade.ts"));
      if (!mod) return 1;
      return await mod.upgrade(remaining[0], upgradeOpts);
    }

    case "logs": {
      if (isHelpFlag(rest[0])) {
        console.log(logsHelp());
        return 0;
      }
      const svc = rest[0];
      if (!svc) {
        console.error("usage: parachute logs <service> [-f]");
        console.error(`services: ${[HUB_SVC, ...knownServices()].join(", ")}`);
        return 1;
      }
      const follow = rest.includes("-f") || rest.includes("--follow");
      const mod = await loadCommand("logs", () => import("./commands/lifecycle.ts"));
      if (!mod) return 1;
      return await mod.logs(svc, { follow });
    }

    case "migrate": {
      if (isHelpFlag(rest[0])) {
        console.log(migrateHelp());
        return 0;
      }
      // §7.4 teardown — remove the hub unit (the cutover rollback path).
      if (rest.includes("--teardown")) {
        const teardownUnknown = rest.find((a) => a !== "--teardown");
        if (teardownUnknown !== undefined) {
          console.error(`parachute migrate: unknown argument "${teardownUnknown}"`);
          console.error("usage: parachute migrate --teardown");
          return 1;
        }
        const mod = await loadCommand("migrate", () => import("./commands/migrate-cutover.ts"));
        if (!mod) return 1;
        // teardownHubUnit logs the human-facing lines itself (the success
        // guidance, or "nothing to tear down"). hub#534: the CLI must still
        // own the EXIT CODE + surface any failure detail the function's
        // false-branch doesn't print — pre-fix it ignored `removed` + `messages`
        // and always exited 0, so a non-removal looked like success to a script.
        const result = mod.teardownHubUnit();
        if (result.removed) return 0;
        // removed === false: either a clean no-op (nothing was installed —
        // `messages` empty) or a real failure (the removal carried a reason in
        // `messages` the internal log didn't surface). The no-op is informational
        // (exit 0); a failure with detail is an error (print it, exit 1).
        //
        // DELIBERATE double-print on the failure path (not a bug): the function's
        // own log() already wrote a human-readable summary ("Hub-unit teardown did
        // not complete: …") to STDOUT; here we re-emit the raw reason(s) to STDERR.
        // The split is intentional — a person reading the terminal sees the framed
        // summary, while a script that captures `2>` gets the machine-parseable
        // reason alongside the non-zero exit. Mirrors the streams convention the
        // rest of the CLI uses (human guidance on stdout, error detail on stderr).
        if (result.messages.length > 0) {
          for (const line of result.messages) console.error(line);
          return 1;
        }
        return 0;
      }
      // §7.1 detached→supervised cutover. Opt-in surface (the archive sweep
      // below stays the bare `migrate` default — the cutover is destructive-
      // adjacent and must be asked for, not implicit).
      if (rest.includes("--to-supervised")) {
        const cutoverUnknown = rest.find((a) => a !== "--to-supervised");
        if (cutoverUnknown !== undefined) {
          console.error(`parachute migrate: unknown argument "${cutoverUnknown}"`);
          console.error("usage: parachute migrate --to-supervised");
          return 1;
        }
        const mod = await loadCommand("migrate", () => import("./commands/migrate-cutover.ts"));
        if (!mod) return 1;
        const result = await mod.cutoverToSupervised();
        for (const line of result.messages) console.log(line);
        // "already-migrated" / "migrated" are success; every other outcome is a
        // recoverable failure that should exit non-zero so scripts can retry.
        return result.outcome === "migrated" || result.outcome === "already-migrated" ? 0 : 1;
      }
      const dryRun = rest.includes("--dry-run");
      const list = rest.includes("--list");
      const yes = rest.includes("--yes") || rest.includes("-y");
      const unknown = rest.find(
        (a) => a !== "--dry-run" && a !== "--list" && a !== "--yes" && a !== "-y",
      );
      if (unknown !== undefined) {
        console.error(`parachute migrate: unknown argument "${unknown}"`);
        console.error(
          "usage: parachute migrate [--list] [--dry-run] [--yes] [--to-supervised] [--teardown]",
        );
        return 1;
      }
      const mod = await loadCommand("migrate", () => import("./commands/migrate.ts"));
      if (!mod) return 1;
      return await mod.migrate({ dryRun, list, yes });
    }

    case "serve": {
      if (isHelpFlag(rest[0])) {
        console.log(serveHelp());
        return 0;
      }
      if (rest.length > 0) {
        console.error(`parachute serve: unexpected argument "${rest[0]}"`);
        console.error("usage: parachute serve");
        return 1;
      }
      // `serve` returns once Bun.serve is bound; the listener keeps the
      // event loop alive until SIGINT/SIGTERM, at which point we stop the
      // server cleanly and exit. Container supervisor (tini, Render, Docker)
      // reaps us once the event loop drains.
      const mod = await loadCommand("serve", () => import("./commands/serve.ts"));
      if (!mod) return 1;
      const { stop: stopServer } = await mod.serve();
      await new Promise<void>((resolve) => {
        const handler = async () => {
          await stopServer();
          resolve();
        };
        process.on("SIGINT", handler);
        process.on("SIGTERM", handler);
      });
      return 0;
    }

    case "auth": {
      const mod = await loadCommand("auth", () => import("./commands/auth.ts"));
      if (!mod) return 1;
      return await mod.auth(rest);
    }

    case "hub": {
      const mod = await loadCommand("hub", () => import("./commands/hub.ts"));
      if (!mod) return 1;
      return await mod.hub(rest);
    }

    case "vault": {
      const mod = await loadCommand("vault", () => import("./commands/vault.ts"));
      if (!mod) return 1;
      // `parachute vault` with no args forwards --help to parachute-vault so
      // users see the actual vault surface, not a CLI-side stub. Anything
      // after `vault` (including --help) is passed through verbatim.
      if (rest.length === 0) return await mod.dispatchVault(["--help"]);

      // Intercept the delete verbs BEFORE the transparent passthrough (B3):
      // `parachute vault remove <name>` must route through the hub's identity
      // cascade (`DELETE /vaults/<name>`), NOT forward verbatim to
      // `parachute-vault remove` (mechanics-only — orphans hub-side tokens,
      // grants, user_vaults rows). `rm` is a convenience alias to the same path.
      const sub = rest[0];
      if (sub === "remove" || sub === "rm") {
        const rm = await loadCommand("vault-remove", () => import("./commands/vault-remove.ts"));
        if (!rm) return 1;
        return await rm.vaultRemove(rest.slice(1));
      }

      // Everything else under `vault` forwards transparently to `parachute-vault`.
      // `vault tokens create` used to route through a guided interactive
      // wrapper, but the pvt_* DROP (vault#412 / hub#466) removed that vault
      // subcommand — it now exits 1 with migration guidance. Access tokens are
      // hub-issued JWTs; mint them with `parachute auth mint-token` or the
      // admin SPA Connect card. We forward verbatim so the operator sees
      // vault's own migration error rather than a hub-side stub.
      return await mod.dispatchVault(rest);
    }

    default:
      console.error(`parachute: unknown command "${command}"`);
      console.error("");
      console.error("If this is a fresh install, start here:");
      console.error("  parachute init        # get the admin wizard going");
      console.error("");
      console.error("Or see all commands:");
      console.error("  parachute --help");
      return 1;
  }
}

async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err) {
    if (err instanceof MissingDependencyError) {
      // A required external binary wasn't on PATH (git / tailscale / tail /
      // …). Print the friendly install block to stderr. interactive:true so
      // the operator at a terminal sees the "ask your sysadmin" trailer; the
      // message was already formatted at construction, so we just emit it.
      console.error(err.message);
      return 1;
    }
    if (err instanceof ServicesManifestError) {
      console.error(`services.json is malformed: ${err.message}`);
      console.error("Fix or remove the file, then re-run.");
      return 1;
    }
    if (err instanceof ExposeStateError) {
      console.error(`expose-state.json is malformed: ${err.message}`);
      console.error("If you're stuck, delete ~/.parachute/expose-state.json and re-run.");
      return 1;
    }
    if (err instanceof CloudflaredStateError) {
      console.error(`cloudflared-state.json is malformed: ${err.message}`);
      console.error("If you're stuck, delete ~/.parachute/cloudflared-state.json and re-run.");
      return 1;
    }
    if (err instanceof TailscaleError) {
      console.error(`tailscale command failed: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

const code = await run(process.argv.slice(2));
process.exit(code);
