import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
const tag = ["auth", "a".repeat(64), "conditions-canary", "b".repeat(128)];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-authtag-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Import inside each pin so Step 0 reports every missing behavior separately.
test("P1 auth tag default and trimmed override paths", async () => {
  const { buzzAuthTagPath, BUZZ_AUTH_TAG_FILENAME, BUZZ_AUTH_TAG_FILE_ENV } = await import(
    "../buzz-auth-tag.ts"
  );
  expect(BUZZ_AUTH_TAG_FILENAME).toBe("buzz-reader.authtag");
  expect(BUZZ_AUTH_TAG_FILE_ENV).toBe("PARACHUTE_BUZZ_AUTH_TAG_FILE");
  expect(buzzAuthTagPath({}, dir)).toBe(join(dir, "buzz-reader.authtag"));
  expect(buzzAuthTagPath({ PARACHUTE_BUZZ_AUTH_TAG_FILE: "  /tmp/tag  " }, dir)).toBe("/tmp/tag");
  expect(buzzAuthTagPath({ PARACHUTE_BUZZ_AUTH_TAG_FILE: "  " }, dir)).toBe(
    join(dir, "buzz-reader.authtag"),
  );
});

for (const [label, contents] of [
  ["not JSON", "private-canary-not-json"],
  ["object", '{"canary":"private-canary"}'],
  ["three elements", JSON.stringify(tag.slice(0, 3))],
  ["five elements", JSON.stringify([...tag, "canary"])],
  ["wrong tag", JSON.stringify(["other", ...tag.slice(1)])],
  ["nonhex owner", JSON.stringify(["auth", "z".repeat(64), ...tag.slice(2)])],
  ["uppercase owner", JSON.stringify(["auth", "A".repeat(64), ...tag.slice(2)])],
  ["short signature", JSON.stringify([...tag.slice(0, 3), "b".repeat(127)])],
  ["nonstring", JSON.stringify([tag[0], tag[1], 7, tag[3]])],
  ["empty", "# private-comment-canary\n\n"],
] as const) {
  test(`P2/P4 auth tag rejects ${label} without logging or echoing input`, async () => {
    const { loadBuzzAuthTag } = await import("../buzz-auth-tag.ts");
    const path = join(dir, "buzz-reader.authtag");
    writeFileSync(path, contents);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(loadBuzzAuthTag({}, dir)).toEqual({
        ok: false,
        reason: label === "empty" ? "empty" : "malformed",
        path,
      });
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
}

test("P2/P4 missing, directory, and inaccessible parent are safe failures", async () => {
  const { loadBuzzAuthTag } = await import("../buzz-auth-tag.ts");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const path = join(dir, "buzz-reader.authtag");
    expect(loadBuzzAuthTag({}, dir)).toEqual({ ok: false, reason: "not_configured", path });
    mkdirSync(path);
    expect(loadBuzzAuthTag({}, dir)).toEqual({ ok: false, reason: "unreadable", path });
    const parent = join(dir, "blocked");
    mkdirSync(parent);
    const child = join(parent, "tag");
    writeFileSync(child, JSON.stringify(tag));
    chmodSync(parent, 0);
    try {
      expect(loadBuzzAuthTag({ PARACHUTE_BUZZ_AUTH_TAG_FILE: child }, dir)).toEqual({
        ok: false,
        reason: "unreadable",
        path: child,
      });
    } finally {
      chmodSync(parent, 0o700);
    }
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
});

test("P3 canonical tag ignores comments and trailing lines and rereads changes", async () => {
  const { loadBuzzAuthTag } = await import("../buzz-auth-tag.ts");
  const path = join(dir, "buzz-reader.authtag");
  writeFileSync(
    path,
    `\n# comment\n [ "auth", "${tag[1]}", "${tag[2]}", "${tag[3]}" ]\nnot JSON\n`,
  );
  expect(loadBuzzAuthTag({}, dir)).toEqual({ ok: true, path, tag, tagJson: JSON.stringify(tag) });
  const edited = ["auth", "c".repeat(64), "", "d".repeat(128)];
  writeFileSync(path, JSON.stringify(edited));
  expect(loadBuzzAuthTag({}, dir)).toEqual({
    ok: true,
    path,
    tag: edited,
    tagJson: JSON.stringify(edited),
  });
});
