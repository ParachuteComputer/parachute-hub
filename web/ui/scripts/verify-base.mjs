// Regression check mirroring paraclaw's verify-base: the canonical-mount
// default build must produce asset URLs prefixed with `/hub/`. If
// `vite.config.ts`'s `base` ever drifts back to `/`, the bundle HTML loses
// the prefix and 404s under the hub mount — the same silent failure
// paraclaw#25 codified in mount-path-convention.md.
//
// Skipped when VITE_BASE_PATH is set explicitly (legitimate override).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const override = process.env.VITE_BASE_PATH;
if (override && override !== "/hub/") {
  console.log(`verify-base: VITE_BASE_PATH=${override} (override) — skipping default-mount check.`);
  process.exit(0);
}

const html = readFileSync(resolve("dist/index.html"), "utf8");
const wantPrefix = "/hub/assets/";
const hasMounted = html.includes(`src="${wantPrefix}`) || html.includes(`href="${wantPrefix}`);
if (!hasMounted) {
  console.error(
    "✖ verify-base: dist/index.html is missing /hub/-prefixed asset URLs.\n" +
      "  This means vite's `base` resolved to something other than `/hub/`.\n" +
      "  Check web/ui/vite.config.ts (default should be `/hub/`) and any\n" +
      "  VITE_BASE_PATH env var leaking into the build environment.",
  );
  process.exit(1);
}
console.log("verify-base: ✓ dist/index.html references /hub/-prefixed assets.");
