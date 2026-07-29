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
 * backwards. (Re-publishing an older version deliberately is still possible
 * via an explicit tag push, which takes the tag branch below.)
 */

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
    const preNum = pre ? Number.parseInt(pre.replace(/^rc\./, ""), 10) || 0 : Number.POSITIVE_INFINITY;
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

/**
 * The decision. `isTagPush` short-circuits every check but the shape one — an
 * explicit tag is a human saying "release this", including a deliberate
 * re-release of something older.
 */
export function decidePublish(
  version: string,
  registry: RegistryView | { ambiguous: true },
  opts: { isTagPush?: boolean } = {},
): PublishDecision {
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
      // Package has never been published at all — first release.
      return { versionExists: false };
    }
    if (!res.ok) return { ambiguous: true };
    const body = (await res.json()) as {
      versions?: Record<string, unknown>;
      "dist-tags"?: Record<string, string>;
    };
    return {
      versionExists: Boolean(body.versions?.[version]),
      currentDistTagVersion: body["dist-tags"]?.[distTagFor(version)],
    };
  } catch {
    return { ambiguous: true };
  }
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
  });

  const out = process.env.GITHUB_OUTPUT;
  const emit = async (k: string, v: string) => {
    if (out) await Bun.write(out, `${k}=${v}\n`, { createPath: false });
    console.log(`${k}=${v}`);
  };

  if ("refuse" in decision) {
    console.error(`::error::${npmName}@${version}: ${decision.reason}`);
    process.exit(1);
  }
  await emit("version", version);
  await emit("dist_tag", distTagFor(version));
  await emit("should_publish", String(decision.publish));
  console.log(`${npmName}@${version}: ${decision.reason}`);
}
