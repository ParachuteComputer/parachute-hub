/**
 * Root-namespace collisions between hub and the app.
 *
 * In `serve-app` mode the app owns the origin root and hub claims a set of
 * prefixes ahead of it — the same shape GitHub uses (`/<user>/<repo>` from the
 * root, `/settings` and `/notifications` reserved). Dispatch order is what
 * enforces it: hub routes match first, and only an unclaimed GET reaches the
 * app tail.
 *
 * The risk that shape carries is one-directional and quiet: if the app ever
 * adds a top-level route named like a hub prefix, hub wins and that app route
 * becomes unreachable. It wouldn't error — the operator would get hub's page
 * where they expected the app's, or a 404 — so it can ship unnoticed.
 *
 * This test makes that collision loud at CI time instead.
 */

import { describe, expect, test } from "bun:test";
import { ROOT_SERVE_RESERVED_PREFIXES } from "../root-serve.ts";

/**
 * Top-level path segments hub claims before the serve-app tail ever runs.
 * Sourced from the route table in `hub-server.ts`'s header docstring, which is
 * the canonical dispatch-order record.
 *
 * Deliberately a hand-maintained list rather than something derived: deriving
 * it from the router would make the test agree with whatever the code does,
 * which is exactly the property a guard must NOT have. A human adding a hub
 * route should have to state that it's a root-namespace claim.
 */
const HUB_CLAIMED_SEGMENTS: readonly string[] = [
  "admin",
  "api",
  "app",
  "hub.html",
  "mcp",
  "oauth",
  "surface",
  "vault",
  "vaults",
  ".well-known",
];

/**
 * Top-level route segments `@openparachute/app` serves from its own router.
 * Update when the app adds a top-level route — the point of the exercise is
 * that adding one which collides makes this fail.
 */
const APP_TOP_LEVEL_SEGMENTS: readonly string[] = [
  "n",
  // The vault-scoped note address, `/v/<vault>/n/<note>` (parachute-app#186,
  // #194) — a note link that names its own vault. Deliberately `/v` and not
  // `/vault`: `/vault` IS a hub claim (the 301 back-compat namespace and the
  // per-vault proxy), so an app route there would be unreachable. This entry is
  // what makes that a checked fact rather than a comment in another repo.
  "v",
  "notes",
  "tags",
  "settings",
  "account",
  "vaults-list",
  "welcome",
  "activity",
  "calendar",
  "import",
  "export",
  "graph",
];

describe("hub / app root-namespace split", () => {
  test("no app route is shadowed by a hub-claimed prefix", () => {
    // A collision here means the app route is UNREACHABLE in serve-app mode:
    // hub dispatches first and the app never sees the request. The failure
    // would look like a wrong page, not an error, so catching it here is the
    // whole point.
    const collisions = APP_TOP_LEVEL_SEGMENTS.filter((seg) => HUB_CLAIMED_SEGMENTS.includes(seg));
    expect(collisions).toEqual([]);
  });

  test("every reserved prefix is a hub-claimed segment", () => {
    // `ROOT_SERVE_RESERVED_PREFIXES` keeps hub's branded 404 for protocol
    // surfaces even in serve-app mode. If one drifted out of the claimed set,
    // it would be reserving a namespace nothing else defends.
    for (const prefix of ROOT_SERVE_RESERVED_PREFIXES) {
      const seg = prefix.replace(/^\//, "").replace(/\/$/, "");
      expect(HUB_CLAIMED_SEGMENTS).toContain(seg);
    }
  });

  test("the protocol surfaces that must never be SPA-shelled are reserved", () => {
    // SPA-shelling one of these turns a genuine API/OAuth/discovery 404 into a
    // 200 of HTML, which breaks clients in a way that's hard to diagnose from
    // the other end — they get a page where they expected JSON.
    for (const required of ["/api/", "/oauth/", "/.well-known/", "/mcp/"]) {
      expect(ROOT_SERVE_RESERVED_PREFIXES).toContain(required);
    }
  });
});
