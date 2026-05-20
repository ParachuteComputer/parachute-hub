import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHub, writeHubFile } from "../hub.ts";

describe("renderHub", () => {
  const html = renderHub();

  test("is a self-contained HTML document with inline styles and script", () => {
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });

  test("fetches /.well-known/parachute.json for the Use section", () => {
    expect(html).toContain("/.well-known/parachute.json");
    expect(html).toContain("doc.services");
  });

  test("uses parachute.computer sage palette and serif/sans fonts", () => {
    expect(html).toContain("#4a7c59");
    expect(html).toContain("#faf8f4");
    expect(html).toContain("Instrument Serif");
    expect(html).toContain("DM Sans");
  });

  test("supports prefers-color-scheme dark", () => {
    expect(html).toContain("prefers-color-scheme: dark");
  });

  test("renders two sections: Services and Admin, each with its own heading + grid", () => {
    expect(html).toContain('id="services-section"');
    expect(html).toContain('id="admin-section"');
    expect(html).toContain('id="services-grid"');
    expect(html).toContain('id="admin-grid"');
    expect(html).toContain("<h2>Services</h2>");
    expect(html).toContain("<h2>Admin</h2>");
  });

  test("Services section sub-text frames the section as service-owned surfaces", () => {
    // Services-vs-Admin axis is OWNERSHIP (services own their UIs vs
    // hub owns host admin), not function. The sub-text reflects that —
    // earlier "Browse, transcribe, and run" framing put it on the
    // function axis, which broke down once you noticed services have
    // UIs that mix use / config / admin.
    expect(html).toContain("Surfaces provided by services");
  });

  test("Services tiles are data-driven from each service's uiUrl + displayName", () => {
    // Phase D consumer-side: SERVICE_LABELS / SERVICE_ORDER hardcoding
    // retired. Each well-known services[] row carries displayName + uiUrl
    // (sourced from module.json via hub-server's loadServiceUiMetadata);
    // tiles render directly from those.
    expect(html).toContain("svc.uiUrl");
    expect(html).toContain("svc.displayName");
    // No more hardcoded short→label map.
    expect(html).not.toContain("'Notes', desc:");
    expect(html).not.toContain("['notes', 'scribe', 'agent']");
  });

  test("Services skip rule emerges from data, not name-checks (vault has no uiUrl)", () => {
    // The previous `isVaultName` hardcoded skip is gone — vault doesn't
    // declare uiUrl, so it naturally doesn't render. Other API-only
    // modules (current or future) get the same treatment for free.
    expect(html).toContain("if (!svc || !svc.uiUrl) continue;");
    // The function definition is gone (the comment may still mention the
    // name as historical context — we only care about the active code).
    expect(html).not.toContain("function isVaultName");
  });

  test("Services tiles sort alphabetically by displayName", () => {
    // Per the module-json-extensibility pattern doc — default ordering
    // until a `displayOrder` field surfaces. localeCompare keeps the
    // ordering stable across locales for ASCII labels.
    expect(html).toContain("a.title.localeCompare(b.title)");
  });

  test("Admin section is hardcoded (always visible) with three entries", () => {
    expect(html).toContain("ADMIN_ENTRIES");
    expect(html).toContain("/admin/vaults");
    expect(html).toContain("/admin/permissions");
    expect(html).toContain("/admin/tokens");
  });

  test("Admin section renders synchronously (does not depend on the well-known fetch)", () => {
    // Even if the fetch is slow or fails, the operator should see Admin
    // surfaces — they may be the reason the operator landed on /.
    expect(html).toContain("renderAdmin();");
    expect(html).toContain("Admin section is static");
  });

  test("Services section empty state guides operators to declare uiUrl", () => {
    // Empty state under Phase D means "no installed service has declared
    // uiUrl yet" — different shape from pre-D ("none installed at all").
    // Hint points at the pattern doc since the fix is in module.json,
    // not at install time.
    expect(html).toContain("No services with a UI declared yet");
    expect(html).toContain("module-json-extensibility");
  });

  test("Use section error state surfaces the underlying message", () => {
    expect(html).toContain("Could not load services");
  });

  test("discovery page fetches with cache: 'no-store' (hub#268 Item 1)", () => {
    // Without `cache: 'no-store'` the browser's HTTP cache can return
    // a stale services list when the operator clicks back to / after
    // installing a module via /admin/modules. Server-side also sets
    // cache-control: no-store on the well-known doc.
    expect(html).toContain("cache: 'no-store'");
  });

  test("discovery page re-fetches on bfcache restore via pageshow (hub#268 Item 1)", () => {
    // When the operator clicks back from /admin/modules to / the
    // browser may restore the prior DOM without re-running the IIFE.
    // The pageshow handler re-runs loadServices() when the page was
    // restored from cache (`e.persisted === true`).
    expect(html).toContain("addEventListener('pageshow'");
    expect(html).toContain("e.persisted");
  });

  test("does not retain the old aggregate-by-module-type code", () => {
    // The Vault collapse + per-module aggregation pattern is gone — Use
    // entries are direct service-path → label lookups; Admin is hardcoded.
    expect(html).not.toContain("aggregate(services, vaults)");
    expect(html).not.toContain("MODULE_LABELS");
    expect(html).not.toContain("renderConfigField");
    expect(html).not.toContain("kind-badge");
  });

  test("default render (no session) emits the 'Sign in' affordance", () => {
    expect(html).toContain('class="auth-indicator"');
    expect(html).toContain("Sign in");
    expect(html).toContain('href="/login?next=/"');
    // No POST form, no CSRF input — those only appear when signed in.
    expect(html).not.toContain('action="/logout"');
    expect(html).not.toContain("__csrf");
  });
});

describe("renderHub — signed-in indicator (rc.13)", () => {
  test("session user → 'Signed in as <name>' + inline POST form with CSRF", () => {
    const html = renderHub({
      session: { displayName: "aaron", csrfToken: "csrf-token-xyz" },
    });
    expect(html).toContain('class="auth-indicator"');
    expect(html).toContain("Signed in as");
    expect(html).toContain("aaron");
    // Inline POST form for sign-out — CSRF token embedded as the
    // existing `__csrf` field name (matches /logout's expectations).
    expect(html).toContain('method="POST" action="/logout"');
    expect(html).toContain('name="__csrf"');
    expect(html).toContain('value="csrf-token-xyz"');
    expect(html).toContain("Sign out");
    // No "Sign in" affordance when signed in.
    expect(html).not.toContain('href="/login?next=/"');
  });

  test("displayName with HTML special chars is escaped", () => {
    // Username field allows alphanumerics historically, but the
    // displayName field on the wire is forward-compatible with profile
    // names that may contain &, <, >. Escape at render time.
    const html = renderHub({
      session: { displayName: "<aaron>&friends", csrfToken: "tok" },
    });
    expect(html).toContain("&lt;aaron&gt;&amp;friends");
    expect(html).not.toContain("<aaron>&friends");
  });

  test("CSRF token with HTML special chars is escaped in the value attribute", () => {
    const html = renderHub({
      session: { displayName: "aaron", csrfToken: 'token"with"quotes' },
    });
    expect(html).toContain('value="token&quot;with&quot;quotes"');
  });
});

describe("writeHubFile", () => {
  test("writes the rendered HTML to the given path, creating parent dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-hub-"));
    try {
      const path = join(dir, "well-known", "hub.html");
      const written = writeHubFile(path);
      expect(written).toBe(path);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf8");
      expect(content).toBe(renderHub());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
