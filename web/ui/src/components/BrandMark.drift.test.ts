import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Build-time drift guard between the SPA's vendored brand mark
 * (`web/ui/src/components/BrandMark.tsx`) and the server-side source of
 * truth (`src/brand.ts`).
 *
 * The SPA can't import server-side .ts modules (different bundler, no
 * shared resolution), so the SVG paths + wordmark are vendored. Reviewer
 * on hub#402 correctly noted: without a CI gate, a future logo refresh
 * touching only `src/brand.ts` would silently leave the SPA on the old
 * mark. This test fails the build when the two PATHS strings or the
 * WORDMARK_TEXT diverge.
 *
 * If you're seeing this fail: update both files (or remove the
 * vendored copy if a build-time codegen lands).
 */
describe("BrandMark drift guard", () => {
  const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

  function extractPaths(filePath: string): string {
    const src = readFileSync(filePath, "utf8");
    const m = src.match(/^const PATHS = `([\s\S]+?)`;/m);
    if (!m) throw new Error(`PATHS const not found in ${filePath}`);
    return m[1];
  }

  function extractWordmark(filePath: string): string {
    const src = readFileSync(filePath, "utf8");
    const m = src.match(/WORDMARK_TEXT\s*=\s*"([^"]+)"/);
    if (!m) throw new Error(`WORDMARK_TEXT not found in ${filePath}`);
    return m[1];
  }

  it("PATHS in BrandMark.tsx matches PATHS in src/brand.ts byte-for-byte", () => {
    const serverPaths = extractPaths(join(REPO_ROOT, "src", "brand.ts"));
    const spaPaths = extractPaths(join(REPO_ROOT, "web", "ui", "src", "components", "BrandMark.tsx"));
    expect(spaPaths).toBe(serverPaths);
  });

  it("WORDMARK_TEXT in BrandMark.tsx matches WORDMARK_TEXT in src/brand.ts", () => {
    const serverWordmark = extractWordmark(join(REPO_ROOT, "src", "brand.ts"));
    const spaWordmark = extractWordmark(join(REPO_ROOT, "web", "ui", "src", "components", "BrandMark.tsx"));
    expect(spaWordmark).toBe(serverWordmark);
  });
});
