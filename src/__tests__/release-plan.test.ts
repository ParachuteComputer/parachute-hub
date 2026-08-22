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
  decidePublish,
  distTagFor,
  driftLogArgs,
  emitOutputs,
  readRegistry,
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

  test("first-ever release of a package publishes", () => {
    const d = decidePublish("0.1.0", { versionExists: false });
    expect(d).toMatchObject({ publish: true });
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
    const d = decidePublish("0.7.9", { ambiguous: true });
    expect(d).toMatchObject({ refuse: true });
    expect("refuse" in d && d.reason).toMatch(/refusing to guess/);
  });

  test("an explicit tag push overrides every check — a human said release this", () => {
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

  test("a tag push even overrides ambiguity", () => {
    const d = decidePublish("0.7.9", { ambiguous: true }, { isTagPush: true });
    expect(d).toMatchObject({ publish: true });
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
    expect(v).toMatchObject({ versionExists: true, currentDistTagVersion: "0.7.9-rc.2" });
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

  test("a never-published package is not ambiguous — it's a first release", async () => {
    const v = await readRegistry("@openparachute/new", "0.1.0", (() =>
      json({}, 404)) as unknown as typeof fetch);
    expect(v).toMatchObject({ versionExists: false });
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
 * The tag-push override (hub#841).
 *
 * `decidePublish`'s `isTagPush` short-circuit is unit-tested above, but
 * unreachable unless the workflow actually passes `--tag-push` on a tag
 * push. That was the bug: the `plan` steps never passed it, so the flag path
 * was dead code and a stale comment claimed otherwise. Assert the wiring
 * directly on the YAML, same rationale as the hub#829 block below — a
 * `run:` string is otherwise only exercised by shipping a release.
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
