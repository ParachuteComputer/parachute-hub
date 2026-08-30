/**
 * Decide whether a package should publish, for the publish-on-merge workflow.
 *
 * Lives here rather than inline in release.yml for two reasons: release logic
 * that can double-publish or silently skip deserves unit tests, and hub has
 * four packages that would otherwise repeat the same twenty lines of shell.
 *
 * ## What it guards against
 *
 * **Double-publishing.** Skip when the exact version already exists on npm, so
 * a re-run, a revert, or a merge that didn't bump is a no-op.
 *
 * **Silently skipping a real release.** An ambiguous registry response (5xx,
 * network failure) REFUSES rather than guessing. A false "not published"
 * double-publishes; a false "published" drops a release on the floor. Neither
 * is acceptable, so we don't pick one.
 *
 * **Publishing backwards.** This is the one the vault version of this workflow
 * doesn't have yet, and it matters as soon as PRs land in parallel: several
 * open PRs each pin their own `rc.N`, and they don't necessarily merge in
 * version order. Merging rc.6 and then rc.5 would leave the `rc` dist-tag
 * pointing at rc.5 — older than what consumers already had — so an operator
 * installing `@rc` would silently DOWNGRADE. We refuse to move a dist-tag
 * backwards. (Re-publishing an older **rc** deliberately is still possible
 * via an explicit tag push, which takes the tag branch below. A tag push of
 * a stable is refused — stables publish from `main` only.)
 *
 * **Stable that skipped rc.** 0.7.13 through 0.7.16 shipped `@latest` with
 * new code and no matching `X.Y.Z-rc.*`. Stable is a suffix-drop from an rc
 * of the same X.Y.Z, never a skip: `decidePublish` refuses a stable unless
 * npm already has that rc, and the CLI refuses again unless `git diff` from
 * the latest matching rc tag only touches version/changelog/lockfile paths.
 *
 * **Stable from `next` or a tag push.** A write token can merge to `next`
 * and can push tags; it cannot merge to `main`. So a stable version is
 * published only when the trigger is a branch push of `main`. `isTagPush`
 * still overrides the registry guards for **rc** versions (re-release, an
 * older rc, an ambiguous registry). It does not override this gate.
 *
 * **A first publish out of a merge.** npm trusted publishing (OIDC) cannot
 * CREATE a package — it can only publish a new version of one that already
 * exists and already trusts this workflow. So a package with nothing on npm
 * at all used to read as "not published → publish", and the job 404'd at the
 * registry (surface#220, `@openparachute/account-client@0.1.0`; same hole
 * here). Worse than the noise: "never published" and "registry unreachable"
 * are the two ways to see an empty registry, and only one of them is safe
 * to act on. So a never-published package SKIPS on a branch push, with a
 * reason that says how to do it deliberately. Note this is about the
 * package, not the version: once anything is on npm, merge-driven releases
 * take over as before. An explicit **tag push** of an rc still
 * short-circuits — a human pushing a tag is the deliberate act, and letting
 * it try surfaces the real npm error (`404` / "you must be logged in")
 * instead of hiding it behind our own skip.
 */

import { appendFileSync } from "node:fs";

/**
 * Append `key=value` lines to a GitHub Actions output file.
 *
 * APPEND, not write. This used to be `Bun.write`, which TRUNCATES — so
 * emitting three outputs in a row left only the last one in `$GITHUB_OUTPUT`.
 * `version` and `dist_tag` never reached the workflow at all; only
 * `should_publish` did, which is why nothing noticed (it's the one output
 * anything consumed). Latent until hub#829 made `publish-image` derive its
 * image tags from `version`.
 *
 * Exported so the append behaviour is testable without spawning the CLI (which
 * would need the network to read the registry).
 */
export function emitOutputs(
  path: string | undefined,
  entries: ReadonlyArray<readonly [string, string]>,
  log: (line: string) => void = console.log,
): void {
  for (const [key, value] of entries) {
    if (path) appendFileSync(path, `${key}=${value}\n`);
    log(`${key}=${value}`);
  }
}

/** Where a version stands relative to what's already published. */
export type PublishDecision =
  | { publish: true; reason: string }
  | { publish: false; reason: string }
  | { refuse: true; reason: string };

export interface RegistryView {
  /** True when this exact version is already on npm. */
  versionExists: boolean;
  /** Current version behind the dist-tag we'd move (`rc` or `latest`). */
  currentDistTagVersion?: string;
  /**
   * Every version currently on npm. Used to require an `X.Y.Z-rc.*` of the
   * same core before a stable, and — when it is empty AND no dist-tag
   * resolves — to recognise a package that has never been published at all.
   * Omitted is treated as empty, which now means "never published" and skips.
   * That is the safe direction for a plumbing mistake: a forgotten list can
   * only cost a skip, never an attempted publish of a package npm won't
   * create. An unreadable registry is `{ ambiguous: true }`, not an empty
   * list, and stays a refusal — the two must not collapse into each other.
   */
  publishedVersions?: readonly string[];
}

/** `rc` for a prerelease, `latest` otherwise. */
export function distTagFor(version: string): "rc" | "latest" {
  return /-rc\./.test(version) ? "rc" : "latest";
}

/**
 * Compare two semver-ish versions. Returns <0, 0, >0.
 *
 * Deliberately small rather than pulling a dependency into CI: handles
 * `X.Y.Z` and `X.Y.Z-rc.N`, which is the entire shape governance allows. A
 * release version always sorts ABOVE its own prereleases (0.7.5 > 0.7.5-rc.9),
 * matching semver.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("-");
    const nums = (core ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
    // No prerelease sorts above any prerelease → Infinity.
    const preNum = pre
      ? Number.parseInt(pre.replace(/^rc\./, ""), 10) || 0
      : Number.POSITIVE_INFINITY;
    return { nums, preNum };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.preNum === pb.preNum) return 0;
  return pa.preNum < pb.preNum ? -1 : 1;
}

/** `0.7.17-rc.1` → `0.7.17`; a stable is returned unchanged. */
export function coreVersion(version: string): string {
  return version.split("-")[0] ?? version;
}

/**
 * Published versions that are an `X.Y.Z-rc.N` of `version`'s core.
 * `0.7.16-rc.1` does not match a `0.7.17` stable.
 */
export function matchingRcVersions(version: string, published: readonly string[]): string[] {
  const core = coreVersion(version);
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}-rc\\.\\d+$`);
  return published.filter((v) => re.test(v)).sort(compareVersions);
}

/**
 * Files a stable promotion may touch vs the latest matching rc tag.
 * Anything else is "new code" and the publish is refused.
 */
export const STABLE_PROMOTION_ALLOWED_PATHS: readonly string[] = [
  "package.json",
  "CHANGELOG.md",
  "RELEASING.md",
  "bun.lock",
  "packages/scope-guard/package.json",
  "packages/scope-guard/CHANGELOG.md",
  "packages/depcheck/package.json",
  "packages/door-contract/package.json",
  "packages/door-contract/CHANGELOG.md",
];

export function disallowedStablePromotionPaths(
  changedPaths: readonly string[],
  allowed: readonly string[] = STABLE_PROMOTION_ALLOWED_PATHS,
): string[] {
  const allow = new Set(allowed);
  return changedPaths.filter((p) => p.length > 0 && !allow.has(p));
}

/** Highest `prefix+X.Y.Z-rc.N` tag for this version's core, or undefined. */
export function latestMatchingRcTag(
  tags: readonly string[],
  version: string,
  prefix: string,
): string | undefined {
  const core = coreVersion(version);
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedCore = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escapedPrefix}${escapedCore}-rc\\.\\d+$`);
  const matches = tags.filter((t) => re.test(t));
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => compareVersions(a.slice(prefix.length), b.slice(prefix.length)));
  return matches[matches.length - 1];
}

export function rcTagListArgs(dir: string, version: string): string[] {
  return ["git", "tag", "-l", `${tagPrefixFor(dir)}${coreVersion(version)}-rc.*`];
}

export function stablePromotionDiffArgs(rcTag: string): string[] {
  return ["git", "diff", "--name-only", `${rcTag}..HEAD`];
}

/**
 * The decision. `isTagPush` short-circuits the registry guards for **rc**
 * versions — an explicit rc tag is a human saying "release this", including
 * a deliberate re-release of something older. It does **not** short-circuit
 * the stable-from-main gate: a write token can push a tag, and that is not
 * the same as merging to `main`.
 */
export function decidePublish(
  version: string,
  registry: RegistryView | { ambiguous: true },
  opts: { isTagPush?: boolean; branch?: string } = {},
): PublishDecision {
  // Stables publish from `main` only. Checked first so a tag push of
  // `vX.Y.Z` (or a suffix-drop merged to `next`) cannot promote `@latest`.
  if (distTagFor(version) !== "rc") {
    const fromMain = !opts.isTagPush && opts.branch === "main";
    if (!fromMain) {
      return {
        publish: false,
        reason: `${version} is a stable version — stable promotions publish from main only (not next, not a tag push)`,
      };
    }
  }
  if (opts.isTagPush) {
    return { publish: true, reason: `explicit tag push for ${version}` };
  }
  if ("ambiguous" in registry) {
    return {
      refuse: true,
      reason:
        "couldn't determine what's published (registry error) — refusing to guess, " +
        "since a wrong answer either double-publishes or drops a release",
    };
  }
  if (registry.versionExists) {
    return { publish: false, reason: `${version} is already on npm` };
  }
  // Nothing on npm under this name AT ALL — not "this version is new", but
  // "this package does not exist". Trusted publishing cannot create it, so a
  // merge-driven run would 404 (surface#220). Distinct from `ambiguous`
  // above: that is a registry we couldn't read, this is a registry that
  // answered 404. Only the second one is knowledge.
  if ((registry.publishedVersions ?? []).length === 0 && !registry.currentDistTagVersion) {
    return {
      publish: false,
      reason: `nothing is published under this name yet, and ${version} would be its first release — a first publish is a deliberate act, not a merge side-effect. npm trusted publishing cannot create a package, only add versions to one that already trusts this workflow. Publish once by hand (or push an explicit rc tag), wire up the trusted publisher, and merge-driven releases take over from the second version on.`,
    };
  }
  const current = registry.currentDistTagVersion;
  if (current && compareVersions(version, current) < 0) {
    return {
      refuse: true,
      reason:
        `${version} is OLDER than the current ${distTagFor(version)} (${current}) — ` +
        "publishing would move the dist-tag backwards and downgrade anyone installing it. " +
        "This usually means parallel PRs merged out of version order; bump and re-merge.",
    };
  }
  if (distTagFor(version) === "latest") {
    // No first-ever carve-out here any more: a package with nothing published
    // returned above, so by this point npm has *something* and a stable owes
    // us a matching rc unconditionally.
    const published = registry.publishedVersions ?? [];
    const rcs = matchingRcVersions(version, published);
    if (rcs.length === 0) {
      const core = coreVersion(version);
      return {
        refuse: true,
        reason: `${version} is a stable release but npm has no ${core}-rc.* — stable is a suffix-drop from an rc, never a skip. Cut an rc first, soak, then drop the suffix.`,
      };
    }
  }
  return { publish: true, reason: `${version} is not on npm` };
}

/** Query npm for a package's state. Ambiguity is reported, never guessed. */
export async function readRegistry(
  npmName: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistryView | { ambiguous: true }> {
  const encoded = npmName.replace("/", "%2f");
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${encoded}`);
    if (res.status === 404) {
      // Package does not exist. publishedVersions: [] (present-and-empty)
      // is what decidePublish reads as never-published (surface#220).
      return { versionExists: false, publishedVersions: [] };
    }
    if (!res.ok) return { ambiguous: true };
    const body = (await res.json()) as {
      versions?: Record<string, unknown>;
      "dist-tags"?: Record<string, string>;
    };
    return {
      versionExists: Boolean(body.versions?.[version]),
      currentDistTagVersion: body["dist-tags"]?.[distTagFor(version)],
      publishedVersions: Object.keys(body.versions ?? {}),
    };
  } catch {
    return { ambiguous: true };
  }
}

/**
 * Commits sitting on `main` that no published version contains.
 *
 * Publish-on-merge skips silently when package.json already matches npm, which
 * is correct — but it means a fix merged just AFTER a release PR is invisibly
 * unpublished. That has now happened three times running (#794, #796, #798),
 * once leaving `@latest` with an app front door that couldn't render. The
 * version bump is a snapshot of main at merge time, and a release PR cannot see
 * what merges after it — so noticing has to happen here, on the skip path.
 *
 * Advisory only: it warns, never fails. A release that legitimately hasn't been
 * cut yet is a normal state, not an error.
 *
 * Pure so it's testable without a repo; the caller supplies the log lines.
 */
export function unpublishedDrift(commitSubjects: readonly string[]): {
  drifted: boolean;
  count: number;
  summary: string;
} {
  const commits = commitSubjects.map((c) => c.trim()).filter((c) => c.length > 0);
  if (commits.length === 0) {
    return { drifted: false, count: 0, summary: "nothing unpublished" };
  }
  return {
    drifted: true,
    count: commits.length,
    summary:
      `${commits.length} commit(s) are NOT in any published version:\n` +
      commits.map((c) => `  - ${c}`).join("\n") +
      "\nOpen a release PR to ship them.",
  };
}

/**
 * The git tag namespace a package's releases are recorded under.
 *
 * Not a detail — the drift advisory's revision range is a TAG, and hub's tags
 * are bare (`v0.7.0`) while every sub-package's are namespaced
 * (`door-contract-v0.7.0`). The advisory hardcoded `v`, so door-contract@0.7.0
 * resolved against HUB's `v0.7.0` — a tag that exists, pointing at unrelated
 * history — and would have reported ~137 hub commits as door-contract's
 * unpublished work (hub#830). A wrong-but-resolving range is worse than a
 * missing one.
 *
 * The mapping is the one `tag-record` uses at the bottom of release.yml, and
 * the one `on: push: tags:` filters against: package dir basename + `-v`, or a
 * bare `v` for the root package.
 */
export function tagPrefixFor(dir: string): string {
  const name = dir.replace(/\/+$/, "").split("/").pop() ?? "";
  if (name === "" || name === "." || name === "..") return "v";
  return `${name}-v`;
}

/**
 * The `git log` invocation behind the drift advisory.
 *
 * Split out from the CLI so the range and the pathspec are testable without a
 * repo — both were wrong in ways that only showed up in a release run.
 *
 * The trailing pathspec scopes the listing to the package: without it,
 * "commits not in any published version" for scope-guard would list every hub
 * commit merged since scope-guard last shipped, which is noise dressed as a
 * warning.
 */
export function driftLogArgs(dir: string, version: string): string[] {
  return [
    "git",
    "log",
    `${tagPrefixFor(dir)}${version}..HEAD`,
    "--oneline",
    "--no-merges",
    "--",
    dir.replace(/\/+$/, "") || ".",
  ];
}

// --- CLI -------------------------------------------------------------------
// Usage: bun scripts/release-plan.ts <package-dir> <npm-name> [--tag-push]
// Emits GitHub Actions outputs; exits non-zero on refusal.
if (import.meta.main) {
  const [dir, npmName, ...rest] = process.argv.slice(2);
  if (!dir || !npmName) {
    console.error("usage: release-plan.ts <package-dir> <npm-name> [--tag-push]");
    process.exit(2);
  }
  const pkg = await Bun.file(`${dir}/package.json`).json();
  const version: string = pkg.version;
  const registry = await readRegistry(npmName, version);
  const decision = decidePublish(version, registry, {
    isTagPush: rest.includes("--tag-push"),
    branch: process.env.GITHUB_REF_NAME,
  });

  if ("refuse" in decision) {
    console.error(`::error::${npmName}@${version}: ${decision.reason}`);
    process.exit(1);
  }
  // Stable must be a suffix-drop from the latest matching rc tag.
  // decidePublish already required that npm has an X.Y.Z-rc.*; this is the
  // "no new code" half. (Never-published packages don't reach here at all —
  // decidePublish skips them, surface#220.) Tag-push overrides, same as
  // decidePublish.
  if (
    decision.publish &&
    distTagFor(version) === "latest" &&
    !rest.includes("--tag-push") &&
    !("ambiguous" in registry) &&
    matchingRcVersions(version, registry.publishedVersions ?? []).length > 0
  ) {
    const tagProc = Bun.spawnSync(rcTagListArgs(dir, version));
    const tags = new TextDecoder()
      .decode(tagProc.stdout)
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const rcTag = latestMatchingRcTag(tags, version, tagPrefixFor(dir));
    if (!rcTag) {
      const core = coreVersion(version);
      console.error(
        `::error::${npmName}@${version}: npm has ${core}-rc.* but no matching git tag (${tagPrefixFor(dir)}${core}-rc.*) — cannot verify this stable is a suffix-drop. Fetch tags, or pass --tag-push to override.`,
      );
      process.exit(1);
    }
    const diffProc = Bun.spawnSync(stablePromotionDiffArgs(rcTag));
    if (diffProc.exitCode !== 0) {
      console.error(
        `::error::${npmName}@${version}: git diff ${rcTag}..HEAD failed — cannot verify suffix-drop.`,
      );
      process.exit(1);
    }
    const changed = new TextDecoder()
      .decode(diffProc.stdout)
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const extra = disallowedStablePromotionPaths(changed);
    if (extra.length > 0) {
      console.error(
        `::error::${npmName}@${version}: stable is not a suffix-drop from ${rcTag}. Extra paths vs the rc:\n${extra.map((p) => `  - ${p}`).join("\n")}\nPromote by branching from the rc tag and dropping -rc.N only. Do not merge next.`,
      );
      process.exit(1);
    }
  }
  // On the skip path, say whether anything is stranded. A silent skip is
  // indistinguishable from "everything is shipped", which is how three fixes
  // in a row sat unpublished on main.
  if (!decision.publish && !rest.includes("--no-drift-check")) {
    try {
      const proc = Bun.spawnSync(driftLogArgs(dir, version));
      if (proc.exitCode !== 0) {
        // Say so. This is the whole of hub#830: the plan job used a bare
        // `actions/checkout@v6` (`--depth=1 --no-tags`), git exited 128
        // "unknown revision", and this branch stayed silent — so a CI run that
        // COULDN'T check drift looked exactly like one that found none.
        console.log(
          `::notice::${npmName}: couldn't check for unpublished drift ` +
            `(${tagPrefixFor(dir)}${version} not resolvable — shallow or tagless clone?)`,
        );
      } else {
        const drift = unpublishedDrift(new TextDecoder().decode(proc.stdout).split("\n"));
        if (drift.drifted) {
          console.log(`::warning::${npmName}: ${drift.summary}`);
          const sum = process.env.GITHUB_STEP_SUMMARY;
          if (sum) {
            await Bun.write(
              sum,
              `### Unpublished work\n\n\`\`\`\n${drift.summary}\n\`\`\`\n`,
              {
                createPath: false,
              },
            );
          }
        }
      }
    } catch {
      // Never fail a run over the advisory check — a missing tag or a shallow
      // clone just means we can't tell, not that something is wrong.
    }
  }
  emitOutputs(process.env.GITHUB_OUTPUT, [
    ["version", version],
    ["dist_tag", distTagFor(version)],
    ["should_publish", String(decision.publish)],
  ]);
  console.log(`${npmName}@${version}: ${decision.reason}`);
}
