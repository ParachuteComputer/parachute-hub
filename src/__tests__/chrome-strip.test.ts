import { describe, expect, test } from "bun:test";
import {
  CHROME_OPT_OUT_PREFIXES,
  MAX_INJECT_SIZE_BYTES,
  buildChromeForRequest,
  injectChromeIntoHtml,
  injectChromeIntoResponse,
  renderChromeStrip,
  shouldInjectChrome,
} from "../chrome-strip.ts";

// Workstream G — persistent cross-surface chrome strip injected into proxied
// HTML responses. The injection seam sits in hub-server.ts; this suite
// pins the pure behavior of the chrome-strip module itself.

describe("renderChromeStrip", () => {
  test("signed-out: renders Sign in link with default next=/ when no displayName", () => {
    const html = renderChromeStrip({});
    expect(html).toContain("pc-chrome");
    expect(html).toContain('href="/login?next=%2F"');
    expect(html).toContain("Sign in");
    expect(html).not.toContain("Signed in as");
    expect(html).not.toContain("Sign out");
  });

  test("signed-out: nextPath is URL-encoded into the Sign in link", () => {
    const html = renderChromeStrip({ nextPath: "/admin/vaults?show=all" });
    expect(html).toContain('href="/login?next=%2Fadmin%2Fvaults%3Fshow%3Dall"');
  });

  test("signed-in: renders 'Signed in as <name>' + Sign out form with CSRF input", () => {
    const html = renderChromeStrip({
      displayName: "aaron",
      csrfToken: "tok-abc123",
    });
    expect(html).toContain("Signed in as <strong>aaron</strong>");
    expect(html).toContain('action="/logout"');
    expect(html).toContain('method="POST"');
    expect(html).toContain('value="tok-abc123"');
    expect(html).toContain("Sign out");
    expect(html).not.toContain("Sign in</a>");
  });

  test("signed-in: HTML-escapes displayName to prevent XSS", () => {
    const html = renderChromeStrip({
      displayName: '<img src=x onerror="alert(1)">',
      csrfToken: "tok",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("includes the inlined SVG brand mark + Parachute wordmark", () => {
    const html = renderChromeStrip({});
    expect(html).toContain("<svg");
    expect(html).toContain("pc-chrome-mark-clip");
    expect(html).toContain(">Parachute<");
  });

  test("includes a Home link in the nav cluster", () => {
    const html = renderChromeStrip({});
    expect(html).toMatch(/<nav[^>]+pc-chrome-nav[^>]+>[\s\S]*<a href="\/">Home<\/a>/);
  });

  test("emits a self-contained <style> block so the strip works on token-less surfaces", () => {
    const html = renderChromeStrip({});
    expect(html).toContain("<style>");
    expect(html).toContain(".pc-chrome");
    // Token shim fallbacks present so surfaces without --bg-soft / --fg /
    // --accent declared still get a usable strip.
    expect(html).toContain("--pc-chrome-bg-soft: var(--bg-soft");
    expect(html).toContain("--pc-chrome-fg: var(--fg");
    expect(html).toContain("--pc-chrome-accent: var(--accent");
  });
});

describe("shouldInjectChrome", () => {
  test("default: returns true for typical proxied paths", () => {
    expect(shouldInjectChrome("/")).toBe(true);
    expect(shouldInjectChrome("/admin/vaults")).toBe(true);
    expect(shouldInjectChrome("/scribe/admin")).toBe(true);
    expect(shouldInjectChrome("/vault/default/admin/")).toBe(true);
    expect(shouldInjectChrome("/app/admin/modules")).toBe(true);
  });

  test("default: opts out the Notes PWA at /app/notes/*", () => {
    expect(shouldInjectChrome("/app/notes")).toBe(false);
    expect(shouldInjectChrome("/app/notes/")).toBe(false);
    expect(shouldInjectChrome("/app/notes/index.html")).toBe(false);
    expect(shouldInjectChrome("/app/notes/assets/index-XXX.js")).toBe(false);
  });

  test("opt-out prefix matching does not over-match sibling paths", () => {
    // `/app/notesbook` must NOT match `/app/notes/` — startsWith check
    // requires a trailing slash boundary.
    expect(shouldInjectChrome("/app/notesbook")).toBe(true);
    expect(shouldInjectChrome("/app/notes-archive/")).toBe(true);
  });

  test("custom opt-out list is honored", () => {
    expect(shouldInjectChrome("/foo/bar", ["/foo/"])).toBe(false);
    expect(shouldInjectChrome("/baz", ["/foo/"])).toBe(true);
  });

  test("trailing slashes in opt-out prefixes are normalized", () => {
    expect(shouldInjectChrome("/foo", ["/foo/"])).toBe(false);
    expect(shouldInjectChrome("/foo", ["/foo"])).toBe(false);
    expect(shouldInjectChrome("/foo/bar", ["/foo/"])).toBe(false);
    expect(shouldInjectChrome("/foo/bar", ["/foo"])).toBe(false);
  });

  test("the canonical opt-out list contains /app/notes/", () => {
    expect(CHROME_OPT_OUT_PREFIXES).toContain("/app/notes/");
  });
});

describe("injectChromeIntoHtml", () => {
  const chrome = "<header>CHROME</header>";

  test("inserts immediately after <body>", () => {
    const html = "<!doctype html><html><body><h1>Hello</h1></body></html>";
    const out = injectChromeIntoHtml(html, chrome);
    expect(out).toBe(
      "<!doctype html><html><body><header>CHROME</header><h1>Hello</h1></body></html>",
    );
  });

  test("handles <body> with attributes", () => {
    const html = '<html><body class="dark" data-theme="dark"><div>x</div></body></html>';
    const out = injectChromeIntoHtml(html, chrome);
    expect(out).toBe(
      '<html><body class="dark" data-theme="dark"><header>CHROME</header><div>x</div></body></html>',
    );
  });

  test("handles <BODY> (uppercase) case-insensitively", () => {
    const html = "<HTML><BODY><P>x</P></BODY></HTML>";
    const out = injectChromeIntoHtml(html, chrome);
    expect(out).toContain("<BODY><header>CHROME</header><P>");
  });

  test("idempotent: skips injection when pc-chrome is already present", () => {
    const html = '<html><body><header class="pc-chrome">existing</header></body></html>';
    const out = injectChromeIntoHtml(html, chrome);
    expect(out).toBe(html);
  });

  test("returns the original HTML when no <body> tag is present (fragment shape)", () => {
    const html = "<div>just a fragment</div>";
    const out = injectChromeIntoHtml(html, chrome);
    expect(out).toBe(html);
  });

  test("inserts at the first <body> only, not at sub-occurrences in content", () => {
    const html =
      "<html><body><p>The body of an email mentions <body>twice</body></p></body></html>";
    const out = injectChromeIntoHtml(html, chrome);
    // Confirm the first injection happens at the real <body>, content after
    // is preserved literally.
    expect(out.indexOf(chrome)).toBe(html.indexOf("<body>") + "<body>".length);
    // Original (literal) content body-tags still present in the slice that
    // follows the injection point.
    expect(out).toContain("mentions <body>twice</body>");
  });
});

describe("injectChromeIntoResponse", () => {
  const chrome = "<header>CHROME</header>";

  test("injects into 200 text/html responses", async () => {
    const res = new Response("<html><body>hi</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const out = await injectChromeIntoResponse(res, {
      chromeHtml: chrome,
      pathname: "/some/admin",
    });
    const body = await out.text();
    expect(body).toContain("<header>CHROME</header>");
    expect(body).toContain("<body><header>CHROME</header>hi</body>");
    expect(out.status).toBe(200);
    expect(out.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("strips Content-Length after rewrite so the framework recomputes it", async () => {
    const original = "<html><body>hi</body></html>";
    const res = new Response(original, {
      status: 200,
      headers: {
        "content-type": "text/html",
        "content-length": String(original.length),
      },
    });
    const out = await injectChromeIntoResponse(res, {
      chromeHtml: chrome,
      pathname: "/x",
    });
    expect(out.headers.get("content-length")).toBeNull();
  });

  test("preserves other headers (set-cookie, cache-control, x-foo)", async () => {
    const res = new Response("<html><body>x</body></html>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "set-cookie": "foo=bar; HttpOnly",
        "cache-control": "no-store",
        "x-debug": "yep",
      },
    });
    const out = await injectChromeIntoResponse(res, {
      chromeHtml: chrome,
      pathname: "/x",
    });
    expect(out.headers.get("set-cookie")).toBe("foo=bar; HttpOnly");
    expect(out.headers.get("cache-control")).toBe("no-store");
    expect(out.headers.get("x-debug")).toBe("yep");
  });

  test("passes through non-HTML responses unchanged", async () => {
    const payload = JSON.stringify({ ok: true });
    const res = new Response(payload, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const out = await injectChromeIntoResponse(res, {
      chromeHtml: chrome,
      pathname: "/api/something",
    });
    // Identity: same Response instance is returned untouched.
    expect(out).toBe(res);
    expect(await out.text()).toBe(payload);
  });

  test("passes through JS / CSS asset responses unchanged (text/javascript, text/css)", async () => {
    const js = new Response("console.log(1);", {
      status: 200,
      headers: { "content-type": "text/javascript" },
    });
    const css = new Response(".x{color:red}", {
      status: 200,
      headers: { "content-type": "text/css" },
    });
    const jsOut = await injectChromeIntoResponse(js, { chromeHtml: chrome, pathname: "/x.js" });
    const cssOut = await injectChromeIntoResponse(css, { chromeHtml: chrome, pathname: "/x.css" });
    expect(jsOut).toBe(js);
    expect(cssOut).toBe(css);
  });

  test("passes through responses on opt-out paths (/app/notes/) unchanged", async () => {
    const res = new Response("<html><body>notes</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const out = await injectChromeIntoResponse(res, {
      chromeHtml: chrome,
      pathname: "/app/notes/",
    });
    expect(out).toBe(res);
    expect(await out.text()).toBe("<html><body>notes</body></html>");
  });

  test("passes through responses on opt-out sub-paths (/app/notes/assets/x.js)", async () => {
    const res = new Response("<html><body>notes</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const out = await injectChromeIntoResponse(res, {
      chromeHtml: chrome,
      pathname: "/app/notes/index.html",
    });
    expect(out).toBe(res);
  });

  test("passes through non-200 responses unchanged (redirects, errors)", async () => {
    const r301 = new Response(null, { status: 301, headers: { location: "/x" } });
    const r404 = new Response("<html><body>404</body></html>", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
    const r500 = new Response("<html><body>oops</body></html>", {
      status: 500,
      headers: { "content-type": "text/html" },
    });
    expect(await injectChromeIntoResponse(r301, { chromeHtml: chrome, pathname: "/x" })).toBe(r301);
    expect(await injectChromeIntoResponse(r404, { chromeHtml: chrome, pathname: "/x" })).toBe(r404);
    expect(await injectChromeIntoResponse(r500, { chromeHtml: chrome, pathname: "/x" })).toBe(r500);
  });

  test("skips injection (preserves bytes verbatim) when buffered body exceeds the size cap", async () => {
    const small = 1024; // 1 KB cap, easy to exceed in test
    const big = `<html><body>${"x".repeat(small + 200)}</body></html>`;
    const res = new Response(big, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const out = await injectChromeIntoResponse(res, {
      chromeHtml: chrome,
      pathname: "/big",
      maxSizeBytes: small,
    });
    const outBody = await out.text();
    expect(outBody).toBe(big);
    expect(outBody).not.toContain("<header>CHROME</header>");
  });

  test("short-circuits via declared Content-Length when it exceeds the cap (no buffer drain)", async () => {
    const declared = MAX_INJECT_SIZE_BYTES + 1;
    const res = new Response("<html><body>doesnt matter</body></html>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "content-length": String(declared),
      },
    });
    const out = await injectChromeIntoResponse(res, {
      chromeHtml: chrome,
      pathname: "/x",
    });
    // Identity-pass — original response untouched. The content-length
    // hint diverts before the buffer drain.
    expect(out).toBe(res);
  });

  test("malformed Content-Length (non-numeric) does not abort injection — falls through to buffer path", async () => {
    const res = new Response("<html><body>hi</body></html>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "content-length": "not-a-number",
      },
    });
    const out = await injectChromeIntoResponse(res, {
      chromeHtml: chrome,
      pathname: "/x",
    });
    const body = await out.text();
    expect(body).toContain("<header>CHROME</header>");
  });

  test("HTML response without a <body> tag is passed through (no double-wrap)", async () => {
    const res = new Response("<div>fragment</div>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const out = await injectChromeIntoResponse(res, {
      chromeHtml: chrome,
      pathname: "/x",
    });
    expect(await out.text()).toBe("<div>fragment</div>");
    expect(out.headers.get("content-type")).toBe("text/html");
  });

  test("response that already contains pc-chrome is left untouched (idempotence)", async () => {
    const body = '<html><body><header class="pc-chrome">existing</header>x</body></html>';
    const res = new Response(body, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const out = await injectChromeIntoResponse(res, {
      chromeHtml: chrome,
      pathname: "/x",
    });
    expect(await out.text()).toBe(body);
  });
});

describe("buildChromeForRequest", () => {
  test("signed-out: returns chromeHtml + no setCookie when there's no active session", () => {
    const req = new Request("https://hub.example/admin/vaults");
    const { chromeHtml, setCookie } = buildChromeForRequest(req, {
      findActiveSession: () => null,
      getUsername: () => null,
    });
    expect(chromeHtml).toContain("Sign in");
    expect(setCookie).toBeUndefined();
  });

  test("signed-out: passes the current pathname+search through as the login next= target", () => {
    const req = new Request("https://hub.example/admin/vaults?show=all");
    const { chromeHtml } = buildChromeForRequest(req, {
      findActiveSession: () => null,
      getUsername: () => null,
    });
    expect(chromeHtml).toContain('href="/login?next=%2Fadmin%2Fvaults%3Fshow%3Dall"');
  });

  test("signed-in: returns chromeHtml carrying the username", () => {
    const req = new Request("https://hub.example/admin/vaults", {
      headers: { cookie: "parachute_hub_session=sid; parachute_hub_csrf=fixed-csrf-token" },
    });
    const { chromeHtml } = buildChromeForRequest(req, {
      findActiveSession: () => ({ userId: "user-1" }),
      getUsername: () => "aaron",
    });
    expect(chromeHtml).toContain("Signed in as <strong>aaron</strong>");
    expect(chromeHtml).toContain('value="fixed-csrf-token"');
  });

  test("signed-in: mints a CSRF cookie when none is present, threads setCookie back", () => {
    const req = new Request("https://hub.example/admin/vaults", {
      headers: { cookie: "parachute_hub_session=sid" },
    });
    const { chromeHtml, setCookie } = buildChromeForRequest(req, {
      findActiveSession: () => ({ userId: "user-1" }),
      getUsername: () => "aaron",
    });
    expect(chromeHtml).toContain("Signed in as");
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("parachute_hub_csrf=");
  });

  test("session resolved but user lookup misses: degrades to signed-out chrome", () => {
    const req = new Request("https://hub.example/admin/vaults");
    const { chromeHtml, setCookie } = buildChromeForRequest(req, {
      findActiveSession: () => ({ userId: "user-1" }),
      getUsername: () => null,
    });
    expect(chromeHtml).toContain("Sign in");
    expect(setCookie).toBeUndefined();
  });
});
