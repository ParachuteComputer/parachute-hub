/**
 * The publish-on-merge decision.
 *
 * Release logic that can double-publish or silently drop a release is exactly
 * the kind that should not live untested in a YAML `run:` block. Every case
 * here is one where a wrong answer costs something real.
 */

import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  decidePublish,
  distTagFor,
  readRegistry,
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
    const d = decidePublish("0.7.9-rc.2", { versionExists: false, currentDistTagVersion: "0.7.9-rc.1" });
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
    const d = decidePublish("0.7.0-rc.1", {
      versionExists: false,
      currentDistTagVersion: "0.9.0",
    }, { isTagPush: true });
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
      json({ versions: {}, "dist-tags": { rc: "0.7.9-rc.2", latest: "0.7.8" } })) as unknown as typeof fetch);
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
