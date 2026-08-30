/**
 * The publish-on-merge decision.
 *
 * Release logic that can double-publish or silently drop a release is exactly
 * the kind that should not live untested in a YAML `run:` block. Every case
 * here is one where a wrong answer costs something real.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  coreVersion,
  decidePublish,
  disallowedStablePromotionPaths,
  distTagFor,
  driftLogArgs,
  emitOutputs,
  latestMatchingRcTag,
  matchingRcVersions,
  rcTagListArgs,
  readRegistry,
  stablePromotionDiffArgs,
  tagPrefixFor,
  unpublishedDrift,
} from "../../scripts/release-plan.ts";

describe("distTagFor", () => {
  test("prerelease → rc, release → latest", () => {
    expect(distTagFor("0.7.9-rc.2")).toBe("rc");
    expect(distTagFor("0.7.9")).toBe("latest");
  });
});

describe("compareVersions", () => {
  test("orders patch versions", () => {
    expect(compareVersions("0.7.5", "0.7.4")).toBeGreaterThan(0);
    expect(compareVersions("0.7.4", "0.7.5")).toBeLessThan(0);
    expect(compareVersions("0.7.5", "0.7.5")).toBe(0);
  });

  test("orders rc chains numerically, not lexically", () => {
    // The lexical trap: "rc.10" < "rc.9" as strings.
    expect(compareVersions("0.7.5-rc.10", "0.7.5-rc.9")).toBeGreaterThan(0);
    expect(compareVersions("0.7.5-rc.5", "0.7.5-rc.6")).toBeLessThan(0);
  });

  test("a release sorts above its own prereleases", () => {
    expect(compareVersions("0.7.5", "0.7.5-rc.99")).toBeGreaterThan(0);
  });

  test("major/minor dominate the prerelease suffix", () => {
    expect(compareVersions("0.8.0-rc.1", "0.7.9")).toBeGreaterThan(0);
  });
});

describe("decidePublish", () => {
  test("a fresh version publishes", () => {
    const d = decidePublish("0.7.9-rc.2", {
      versionExists: false,
      currentDistTagVersion: "0.7.9-rc.1",
    });
    expect(d).toMatchObject({ publish: true });
  });

  test("an already-published version is skipped — the idempotency guarantee", () => {
    // Re-runs, reverts, and merges that didn't bump must all be no-ops.
    const d = decidePublish("0.7.9-rc.1", { versionExists: true });
    expect(d).toMatchObject({ publish: false });
  });

  test("a never-published package SKIPS on a branch push — a first publish is deliberate", () => {
    // surface#220 verbatim, same hole here: a 404 package used to read
    // "0.1.0 is not on npm" → should_publish=true, and the OIDC publish 404'd.
    const d = decidePublish(
      "0.1.0",
      { versionExists: false, publishedVersions: [] },
      { branch: "main" },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/first publish is a deliberate act/);
    expect("reason" in d && d.reason).toMatch(/cannot create a package/);
  });

  test("an rc of a never-published package skips too — it's the package, not the channel", () => {
    const d = decidePublish(
      "0.1.0-rc.1",
      { versionExists: false, publishedVersions: [] },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/nothing is published under this name yet/);
  });

  test("omitted publishedVersions with no dist-tag reads as never-published — skip, don't publish", () => {
    const d = decidePublish("0.1.0-rc.1", { versionExists: false });
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/nothing is published under this name yet/);
  });

  test("a never-published package on an rc TAG PUSH still tries — a human said release this", () => {
    const d = decidePublish(
      "0.1.0-rc.1",
      { versionExists: false, publishedVersions: [] },
      { isTagPush: true },
    );
    expect(d).toMatchObject({ publish: true });
    expect("reason" in d && d.reason).toMatch(/explicit tag push/);
  });

  test("a never-published STABLE on a tag push is still refused by the from-main gate", () => {
    const d = decidePublish(
      "0.1.0",
      { versionExists: false, publishedVersions: [] },
      { isTagPush: true },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/from main only/);
  });

  test("an existing package is unaffected — one published version is enough", () => {
    const d = decidePublish(
      "0.1.0-rc.2",
      {
        versionExists: false,
        currentDistTagVersion: "0.1.0-rc.1",
        publishedVersions: ["0.1.0-rc.1"],
      },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: true });
    expect("reason" in d && d.reason).toMatch(/is not on npm/);
  });

  test("an unreadable registry is still a REFUSAL, not a never-published skip", () => {
    const ambiguous = decidePublish("0.1.0-rc.1", { ambiguous: true }, { branch: "next" });
    expect(ambiguous).toMatchObject({ refuse: true });
    expect("refuse" in ambiguous && ambiguous.reason).toMatch(/refusing to guess/);
  });

  test("REFUSES to move a dist-tag backwards — the parallel-merge hazard", () => {
    // Several open PRs each pin their own rc.N and don't necessarily merge in
    // order. Publishing rc.5 after rc.6 would leave `@rc` pointing at the
    // older one, silently downgrading anyone who installs it.
    const d = decidePublish("0.7.5-rc.5", {
      versionExists: false,
      currentDistTagVersion: "0.7.5-rc.6",
    });
    expect(d).toMatchObject({ refuse: true });
    expect("refuse" in d && d.reason).toMatch(/OLDER than the current rc/);
    expect("refuse" in d && d.reason).toMatch(/merged out of version order/);
  });

  test("rc and latest are tracked independently", () => {
    // Publishing 0.8.0-rc.1 compares against the `rc` tag, not `latest`, so a
    // newer stable doesn't block the next prerelease line.
    const d = decidePublish("0.8.0-rc.1", {
      versionExists: false,
      currentDistTagVersion: "0.7.9-rc.5",
    });
    expect(d).toMatchObject({ publish: true });
  });

  test("an ambiguous registry REFUSES rather than guessing", () => {
    // A false "not published" double-publishes; a false "published" drops a
    // release. Guessing is worse than failing loudly.
    const d = decidePublish("0.7.9", { ambiguous: true }, { branch: "main" });
    expect(d).toMatchObject({ refuse: true });
    expect("refuse" in d && d.reason).toMatch(/refusing to guess/);
  });

  test("an explicit rc tag push overrides the registry checks — a human said release this rc", () => {
    const d = decidePublish(
      "0.7.0-rc.1",
      {
        versionExists: false,
        currentDistTagVersion: "0.9.0",
      },
      { isTagPush: true },
    );
    expect(d).toMatchObject({ publish: true });
  });

  test("an rc tag push even overrides ambiguity", () => {
    const d = decidePublish("0.7.9-rc.1", { ambiguous: true }, { isTagPush: true });
    expect(d).toMatchObject({ publish: true });
  });

  test("a stable without a matching rc is refused — 0.7.13 through 0.7.16 skipped this", () => {
    // Cutting @latest with new code and no rc of the same X.Y.Z is how
    // 0.7.13–0.7.16 shipped. Stable is a suffix-drop, never a skip.
    const d = decidePublish(
      "0.7.17",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.16",
        publishedVersions: ["0.7.16", "0.7.12-rc.2"],
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ refuse: true });
    expect("refuse" in d && d.reason).toMatch(/0\.7\.17-rc/);
    expect("refuse" in d && d.reason).toMatch(/suffix-drop|Cut an rc first/i);
  });

  test("a stable whose only published rcs are a different X.Y.Z is still refused", () => {
    const d = decidePublish(
      "0.7.17",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.16",
        publishedVersions: ["0.7.16", "0.7.16-rc.1"],
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ refuse: true });
  });

  test("a stable with a matching rc publishes from main — suffix-drop is the only legal stable", () => {
    const d = decidePublish(
      "0.7.17",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.16",
        publishedVersions: ["0.7.16", "0.7.17-rc.1"],
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ publish: true });
  });

  test("omitted publishedVersions still refuses a stable when latest already exists", () => {
    // Callers that forget to plumb the version list must not silently skip
    // the gate — that's how 0.7.13–0.7.16 would keep shipping.
    const d = decidePublish(
      "0.7.17",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.16",
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ refuse: true });
  });

  test("a tag push of a stable does NOT override the matching-rc check — stables publish from main only", () => {
    const d = decidePublish(
      "0.7.17",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.16",
        publishedVersions: ["0.7.16"],
      },
      { isTagPush: true },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/from main only/);
  });

  test("next skips a stable even when a matching rc exists — tonight's hole", () => {
    // After 0.7.18-rc.9, next HEAD *is* that rc. A suffix-drop PR targeting
    // next would pass matching-rc + the version/changelog-only diff. This
    // gate is what stops it from publishing @latest.
    const d = decidePublish(
      "0.7.18",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.17",
        publishedVersions: ["0.7.17", "0.7.18-rc.9"],
      },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/from main only/);
  });

  test("next still publishes an rc", () => {
    const d = decidePublish(
      "0.7.18-rc.9",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.18-rc.8",
      },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: true });
  });

  test("a stable with no branch is refused — fail closed, don't guess the trigger", () => {
    const d = decidePublish("0.7.18", {
      versionExists: false,
      publishedVersions: ["0.7.18-rc.9"],
    });
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/from main only/);
  });
});

describe("matchingRcVersions", () => {
  test("matches only the same X.Y.Z rc chain", () => {
    expect(
      matchingRcVersions("0.7.17", ["0.7.16", "0.7.16-rc.1", "0.7.17-rc.1", "0.7.17-rc.2"]),
    ).toEqual(["0.7.17-rc.1", "0.7.17-rc.2"]);
  });

  test("a prerelease still matches siblings of its core", () => {
    expect(matchingRcVersions("0.7.17-rc.3", ["0.7.17-rc.1", "0.7.16-rc.1"])).toEqual([
      "0.7.17-rc.1",
    ]);
  });
});

describe("coreVersion", () => {
  test("strips the rc suffix and leaves a stable alone", () => {
    expect(coreVersion("0.7.17-rc.1")).toBe("0.7.17");
    expect(coreVersion("0.7.17")).toBe("0.7.17");
  });
});

describe("latestMatchingRcTag", () => {
  test("picks the highest N for hub's bare-v tags", () => {
    expect(
      latestMatchingRcTag(
        ["v0.7.16-rc.1", "v0.7.17-rc.1", "v0.7.17-rc.2", "v0.7.17"],
        "0.7.17",
        "v",
      ),
    ).toBe("v0.7.17-rc.2");
  });

  test("namespaces sub-package tags — a hub v tag is not door-contract's", () => {
    expect(
      latestMatchingRcTag(
        ["v0.7.0-rc.9", "door-contract-v0.7.0-rc.1", "door-contract-v0.7.0-rc.2"],
        "0.7.0",
        "door-contract-v",
      ),
    ).toBe("door-contract-v0.7.0-rc.2");
  });

  test("undefined when the chain has no rc tag", () => {
    expect(latestMatchingRcTag(["v0.7.16"], "0.7.17", "v")).toBeUndefined();
  });
});

describe("disallowedStablePromotionPaths", () => {
  test("version/changelog/lockfile-only is a suffix-drop", () => {
    expect(disallowedStablePromotionPaths(["package.json", "CHANGELOG.md", "bun.lock"])).toEqual(
      [],
    );
  });

  test("a source file is new code — the 0.7.13–0.7.16 skip-rc shape", () => {
    expect(disallowedStablePromotionPaths(["package.json", "src/users.ts"])).toEqual([
      "src/users.ts",
    ]);
  });
});

describe("rcTagListArgs / stablePromotionDiffArgs", () => {
  test("hub lists its own bare-v rc tags", () => {
    expect(rcTagListArgs(".", "0.7.17")).toEqual(["git", "tag", "-l", "v0.7.17-rc.*"]);
  });

  test("door-contract lists door-contract-v, not hub's v", () => {
    expect(rcTagListArgs("packages/door-contract", "0.7.0")[3]).toBe("door-contract-v0.7.0-rc.*");
  });

  test("the suffix-drop diff is name-only from the rc tag to HEAD", () => {
    expect(stablePromotionDiffArgs("v0.7.17-rc.1")).toEqual([
      "git",
      "diff",
      "--name-only",
      "v0.7.17-rc.1..HEAD",
    ]);
  });
});

describe("readRegistry", () => {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  test("reads existence + the relevant dist-tag", async () => {
    const v = await readRegistry("@openparachute/hub", "0.7.9-rc.2", (() =>
      json({
        versions: { "0.7.9-rc.1": {}, "0.7.9-rc.2": {} },
        "dist-tags": { rc: "0.7.9-rc.2", latest: "0.7.8" },
      })) as unknown as typeof fetch);
    expect(v).toMatchObject({
      versionExists: true,
      currentDistTagVersion: "0.7.9-rc.2",
      publishedVersions: ["0.7.9-rc.1", "0.7.9-rc.2"],
    });
  });

  test("picks the dist-tag matching the version's channel", async () => {
    const v = await readRegistry("@openparachute/hub", "0.7.9", (() =>
      json({
        versions: {},
        "dist-tags": { rc: "0.7.9-rc.2", latest: "0.7.8" },
      })) as unknown as typeof fetch);
    // A stable version compares against `latest`, not `rc`.
    expect(v).toMatchObject({ currentDistTagVersion: "0.7.8" });
  });

  test("a never-published package is not ambiguous — a 404 is knowledge", async () => {
    const v = await readRegistry("@openparachute/new", "0.1.0", (() =>
      json({}, 404)) as unknown as typeof fetch);
    expect(v).toMatchObject({ versionExists: false, publishedVersions: [] });
    expect(v).not.toHaveProperty("ambiguous");
  });

  test("the 404 view composes into a skip — the two halves of surface#220 line up", async () => {
    const v = await readRegistry("@openparachute/account-client", "0.1.0", (() =>
      json({}, 404)) as unknown as typeof fetch);
    expect(decidePublish("0.1.0", v, { branch: "main" })).toMatchObject({ publish: false });
  });

  test("a 5xx is ambiguous", async () => {
    const v = await readRegistry("@openparachute/hub", "1.0.0", (() =>
      json({}, 503)) as unknown as typeof fetch);
    expect(v).toMatchObject({ ambiguous: true });
  });

  test("a network throw is ambiguous, not a crash", async () => {
    const v = await readRegistry("@openparachute/hub", "1.0.0", (() =>
      Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch);
    expect(v).toMatchObject({ ambiguous: true });
  });
});

describe("unpublishedDrift", () => {
  test("no commits → not drifted", () => {
    expect(unpublishedDrift([]).drifted).toBe(false);
    expect(unpublishedDrift(["", "  "]).drifted).toBe(false);
  });

  test("commits → drifted, counted, and LISTED", () => {
    // The list is the point: "you have unpublished work" without naming what
    // leaves someone diffing tags by hand to find out.
    const d = unpublishedDrift(["abc feat: one", "def fix: two"]);
    expect(d.drifted).toBe(true);
    expect(d.count).toBe(2);
    expect(d.summary).toContain("feat: one");
    expect(d.summary).toContain("fix: two");
    expect(d.summary).toMatch(/release PR/i);
  });

  test("blank lines from git's trailing newline don't inflate the count", () => {
    expect(unpublishedDrift(["abc one", ""]).count).toBe(1);
  });
});

/**
 * hub#830: the drift advisory has to be able to RUN.
 *
 * Two independent defects made it dead code in CI:
 *
 *   1. The `plan` job used a bare `actions/checkout@v6`, which fetches
 *      `--depth=1 --no-tags`. `git log v0.7.14..HEAD` in that clone exits 128
 *      ("unknown revision"), the `proc.exitCode === 0` guard skips, and the
 *      advisory reports nothing — indistinguishable from "everything is
 *      shipped", which is the exact confusion it was built to end.
 *   2. The revision range hardcoded a `v` prefix. Sub-package tags are
 *      namespaced (`door-contract-v0.7.0`), so door-contract@0.7.0 would have
 *      been compared against HUB's `v0.7.0` tag — a real tag, pointing at
 *      unrelated history, so the advisory would have listed nine months of hub
 *      commits as "door-contract's unpublished work". Masked only by defect 1.
 *
 * The prefixes here are not invented: they're the ones `tag-record` pushes at
 * the bottom of release.yml, and the ones the `on: push: tags:` filters match.
 */
describe("tagPrefixFor", () => {
  test("the root package is hub, whose tags are bare `vX.Y.Z`", () => {
    expect(tagPrefixFor(".")).toBe("v");
    expect(tagPrefixFor("")).toBe("v");
    expect(tagPrefixFor("./")).toBe("v");
  });

  test("sub-packages get their namespaced prefix — same strings tag-record pushes", () => {
    expect(tagPrefixFor("packages/scope-guard")).toBe("scope-guard-v");
    expect(tagPrefixFor("packages/depcheck")).toBe("depcheck-v");
    expect(tagPrefixFor("packages/door-contract")).toBe("door-contract-v");
    // Trailing slash is the same package.
    expect(tagPrefixFor("packages/door-contract/")).toBe("door-contract-v");
  });

  test("the prefixes match what release.yml's tag-record actually pushes", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../.github/workflows/release.yml"),
      "utf8",
    );
    for (const [dir, prefix] of [
      [".", "v"],
      ["packages/scope-guard", "scope-guard-v"],
      ["packages/depcheck", "depcheck-v"],
      ["packages/door-contract", "door-contract-v"],
    ] as const) {
      expect(tagPrefixFor(dir)).toBe(prefix);
      expect(workflow).toMatch(
        new RegExp(`tag_if\\s+"${prefix}"\\s+"${dir === "." ? "\\." : dir}"`),
      );
    }
  });
});

describe("driftLogArgs", () => {
  test("hub compares against its own bare-v tag", () => {
    expect(driftLogArgs(".", "0.7.14")).toEqual([
      "git",
      "log",
      "v0.7.14..HEAD",
      "--oneline",
      "--no-merges",
      "--",
      ".",
    ]);
  });

  test("door-contract compares against door-contract-v, NOT hub's v tag", () => {
    const args = driftLogArgs("packages/door-contract", "0.7.0");
    expect(args).toContain("door-contract-v0.7.0..HEAD");
    // The bug: `v0.7.0` is a real HUB tag, so the wrong range would have
    // resolved and listed hub's history as door-contract's drift.
    expect(args).not.toContain("v0.7.0..HEAD");
  });

  test("the listing is scoped to the package — a hub commit isn't scope-guard drift", () => {
    expect(driftLogArgs("packages/scope-guard", "0.5.1").slice(-2)).toEqual([
      "--",
      "packages/scope-guard",
    ]);
  });
});

describe("release.yml drift advisory can execute (hub#830)", () => {
  const workflow = readFileSync(
    join(import.meta.dir, "../../.github/workflows/release.yml"),
    "utf8",
  );
  // Scope every assertion to the `plan` job — the other jobs' shallow
  // checkouts are fine, only `plan` reads git history.
  const planJob = workflow.match(/\n {2}plan:\n([\s\S]*?)\n {2}[a-z][\w-]*:\n/)?.[1];

  test("the plan job is findable (guards the slicing above)", () => {
    expect(planJob).toBeTruthy();
    expect(planJob).toContain("bun scripts/release-plan.ts . @openparachute/hub");
  });

  test("the plan job's checkout fetches full history — depth=1 has no merge base", () => {
    expect(planJob).toMatch(/actions\/checkout@v6\n\s*with:\n(?:\s*.+\n)*?\s*fetch-depth:\s*0/);
  });

  test("the plan job's checkout fetches tags — the advisory's range is a TAG", () => {
    // Bare checkout passes `--no-tags`; without this the range never resolves
    // and the advisory silently reports nothing, forever.
    expect(planJob).toMatch(/fetch-tags:\s*true/);
  });
});

/**
 * hub#829: the ghcr image tags are part of the release contract too.
 *
 * The `publish-image` job used to derive its version tag from the ref
 * (`type=ref,event=tag`). On a merge-triggered run the ref is `main`, so the
 * 0.7.13 merge published a bare `:stable` with an `image.version=stable`
 * label, and `:v0.7.13` / `:latest` existed only because someone pushed a tag
 * by hand afterwards. Once that manual step went away, RELEASING.md's
 * `docker pull …:vX.Y.Z` verify + rollback instructions pointed at nothing.
 *
 * Same class of bug as the dist-tag one above, and the same rule fixes it:
 * derive from the VERSION BEING PUBLISHED, never from the ref. Asserted here
 * rather than left to review because a YAML `run:`/`with:` block is otherwise
 * only exercised by shipping a release.
 */
describe("release.yml image tags (hub#829)", () => {
  const workflow = readFileSync(
    join(import.meta.dir, "../../.github/workflows/release.yml"),
    "utf8",
  );

  test("the plan job exposes the hub version, not just the publish decision", () => {
    expect(workflow).toContain("hub_version: ${{ steps.hub.outputs.version }}");
  });

  test("every publish pushes a versioned image tag", () => {
    expect(workflow).toContain("type=raw,value=v${{ needs.plan.outputs.hub_version }}");
  });

  test("no image tag is derived from the ref — on a merge run the ref is `main`", () => {
    // Anchored so the prose in the surrounding comment (which names the old
    // `type=ref,event=tag` it replaced) doesn't trip it.
    expect(workflow).not.toMatch(/^\s*type=ref/m);
    // The rc/stable/latest gates have to read the version too, or a
    // merge-published rc lands on `:stable`.
    expect(workflow).not.toMatch(/type=raw,value=(rc|stable|latest),enable=.*github\.ref_name/);
  });

  test("`latest` moves on a stable publish, and only on a stable publish", () => {
    expect(workflow).toContain(
      "type=raw,value=latest,enable=${{ !contains(needs.plan.outputs.hub_version, '-rc.') }}",
    );
    // metadata-action's own `latest=auto` only fires on tag runs, which is the
    // half of #829 that left `:latest` stuck at 0.7.13.
    expect(workflow).toMatch(/flavor:\s*\|\s*\n\s*latest=false/);
  });
});

/**
 * The rc tag-push override (hub#841).
 *
 * `decidePublish`'s `isTagPush` short-circuit (rc versions only) is
 * unit-tested above, but unreachable unless the workflow actually passes
 * `--tag-push` on a tag push. That was the bug: the `plan` steps never
 * passed it, so the flag path was dead code and a stale comment claimed
 * otherwise. Assert the wiring directly on the YAML, same rationale as the
 * hub#829 block below — a `run:` string is otherwise only exercised by
 * shipping a release. Stables are refused even with this flag; the wiring
 * is still required so an rc tag-push reaches the short-circuit.
 */
describe("release.yml tag-push override (hub#841)", () => {
  const workflow = readFileSync(
    join(import.meta.dir, "../../.github/workflows/release.yml"),
    "utf8",
  );

  test("every plan step passes --tag-push on a tag push, nothing on a merge", () => {
    const flag = "${{ github.ref_type == 'tag' && '--tag-push' || '' }}";
    for (const cmd of [
      "bun scripts/release-plan.ts . @openparachute/hub",
      "bun scripts/release-plan.ts packages/scope-guard @openparachute/scope-guard",
      "bun scripts/release-plan.ts packages/depcheck @openparachute/depcheck",
      "bun scripts/release-plan.ts packages/door-contract @openparachute/door-contract",
    ]) {
      expect(workflow).toContain(`${cmd} ${flag}`);
    }
  });

  test("publish jobs consult plan even on a tag push — a tag is not a bypass of the stable-from-main gate", () => {
    // The hole: `github.ref_type == 'tag' && <prefix>` without consulting
    // plan published a stable from a write-token tag push. Both npm and
    // ghcr used that shape.
    const oldBypass =
      "(github.ref_type == 'tag' && (!startsWith(github.ref_name, 'scope-guard-') && !startsWith(github.ref_name, 'depcheck-') && !startsWith(github.ref_name, 'door-contract-'))) || (github.ref_type != 'tag' && needs.plan.outputs.hub == 'true')";
    expect(workflow).not.toContain(oldBypass);
    const gated =
      "needs.plan.outputs.hub == 'true' && (github.ref_type != 'tag' || (!startsWith(github.ref_name, 'scope-guard-') && !startsWith(github.ref_name, 'depcheck-') && !startsWith(github.ref_name, 'door-contract-')))";
    expect(workflow).toContain(gated);
    // Two jobs share it: publish-hub-npm and publish-image.
    expect(workflow.split(gated).length - 1).toBe(2);
  });
});

/**
 * The step outputs are the wire between `plan` and every publish job. Losing
 * one is silent — the consuming expression just interpolates to an empty
 * string.
 */
describe("emitOutputs", () => {
  test("APPENDS every output — `Bun.write` truncated, keeping only the last", () => {
    const dir = mkdtempSync(join(tmpdir(), "phub-release-plan-"));
    try {
      const out = join(dir, "github_output");
      writeFileSync(out, "");
      emitOutputs(
        out,
        [
          ["version", "0.7.15"],
          ["dist_tag", "latest"],
          ["should_publish", "true"],
        ],
        () => {},
      );
      expect(readFileSync(out, "utf8")).toBe(
        "version=0.7.15\ndist_tag=latest\nshould_publish=true\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps whatever an earlier step already wrote to the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "phub-release-plan-"));
    try {
      const out = join(dir, "github_output");
      writeFileSync(out, "earlier=kept\n");
      emitOutputs(out, [["version", "0.7.15"]], () => {});
      expect(readFileSync(out, "utf8")).toBe("earlier=kept\nversion=0.7.15\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("logs every output even with no output file (local runs)", () => {
    const lines: string[] = [];
    emitOutputs(
      undefined,
      [
        ["version", "0.7.15"],
        ["dist_tag", "latest"],
      ],
      (l) => lines.push(l),
    );
    expect(lines).toEqual(["version=0.7.15", "dist_tag=latest"]);
  });
});
