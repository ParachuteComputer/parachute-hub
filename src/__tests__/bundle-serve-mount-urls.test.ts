/**
 * Re-rooting a mounted bundle's absolute URLs.
 *
 * Found live, immediately after `parachute install app` on a self-hosted box:
 * the app loaded as an unstyled blank page with
 *
 *   GET https://host/assets/index-*.css  404
 *   GET https://host/assets/index-*.js   404
 *   GET https://host/manifest.webmanifest 404
 *
 * The mount serves those files perfectly at `/app/assets/...` — the HTML just
 * never asks for them there, because the published bundle is built with an
 * absolute Vite base. One package is served at several mounts (`/app`,
 * `/notes`, `/surface/<name>`, and the origin root), so no single build-time
 * base is correct for all of them; the mount is only known at serve time.
 */

import { describe, expect, test } from "bun:test";
import { injectMountMeta, rewriteManifestScope, rewriteRootAbsoluteUrls } from "../bundle-serve.ts";

const REAL_SHELL = `<!doctype html>
<html lang="en">
  <head>
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png" />
    <script type="module" crossorigin src="/assets/index-BhV_u6Bm.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-rEtUY3V3.css">
    <link rel="manifest" href="/manifest.webmanifest"></head>
  <body><div id="root"></div></body>
</html>`;

describe("rewriteRootAbsoluteUrls", () => {
  test("re-roots every asset the real app shell asks for", () => {
    const out = rewriteRootAbsoluteUrls(REAL_SHELL, "/app");
    expect(out).toContain('src="/app/assets/index-BhV_u6Bm.js"');
    expect(out).toContain('href="/app/assets/index-rEtUY3V3.css"');
    expect(out).toContain('href="/app/manifest.webmanifest"');
    expect(out).toContain('href="/app/icon.svg"');
    expect(out).toContain('href="/app/favicon.ico"');
    expect(out).toContain('href="/app/apple-touch-icon-180x180.png"');
    // Nothing left pointing at the origin root.
    expect(out).not.toMatch(/(src|href)="\/(?!app\/)/);
  });

  test("an empty mount is a no-op — the origin-root case must not change", () => {
    // Served at `/`, absolute URLs are already correct. Rewriting would break
    // the exact deployment the bundle was built for.
    expect(rewriteRootAbsoluteUrls(REAL_SHELL, "")).toBe(REAL_SHELL);
  });

  test("leaves protocol-relative and absolute URLs alone", () => {
    const html = `<script src="//cdn.example.com/a.js"></script>
<link href="https://fonts.example.com/f.css">
<a href="http://example.com/x">x</a>`;
    expect(rewriteRootAbsoluteUrls(html, "/app")).toBe(html);
  });

  test("touches only src/href — never inline script or style bodies", () => {
    // A naive s#/#/app/# would corrupt CSS and JS. This is the regression that
    // would be invisible until something inside a style block broke.
    const html = `<style>.a{background:url(/bg.png)}</style>
<script>const path = "/api/notes";</script>
<img src="/logo.png">`;
    const out = rewriteRootAbsoluteUrls(html, "/app");
    expect(out).toContain("url(/bg.png)");
    expect(out).toContain('"/api/notes"');
    expect(out).toContain('src="/app/logo.png"');
  });

  test("a root href becomes the mount root, not a bare slash", () => {
    expect(rewriteRootAbsoluteUrls('<a href="/">home</a>', "/app")).toBe(
      '<a href="/app/">home</a>',
    );
  });

  test("relative URLs are left alone (already correct under a mount)", () => {
    const html = '<script src="./assets/x.js"></script><link href="sub/y.css">';
    expect(rewriteRootAbsoluteUrls(html, "/app")).toBe(html);
  });

  test("works for a nested mount", () => {
    const out = rewriteRootAbsoluteUrls('<script src="/assets/x.js"></script>', "/surface/notes");
    expect(out).toContain('src="/surface/notes/assets/x.js"');
  });
});

describe("rewriteManifestScope", () => {
  test("re-roots start_url and scope so the PWA doesn't claim the whole origin", () => {
    // scope "/" with the app at /app means the installed PWA captures /admin
    // and every vault URL too.
    const out = JSON.parse(
      rewriteManifestScope(JSON.stringify({ start_url: "/", scope: "/", name: "P" }), "/app"),
    );
    expect(out.start_url).toBe("/app/");
    expect(out.scope).toBe("/app/");
    expect(out.name).toBe("P");
  });

  test("leaves RELATIVE icon srcs alone — they resolve against the manifest URL", () => {
    // The manifest now lives at /app/manifest.webmanifest, so a relative icon
    // already resolves under the mount. Prefixing would double it.
    const out = JSON.parse(
      rewriteManifestScope(
        JSON.stringify({ scope: "/", icons: [{ src: "pwa-64x64.png" }] }),
        "/app",
      ),
    );
    expect(out.icons[0].src).toBe("pwa-64x64.png");
  });

  test("a deeper start_url keeps its path", () => {
    const out = JSON.parse(rewriteManifestScope(JSON.stringify({ start_url: "/inbox" }), "/app"));
    expect(out.start_url).toBe("/app/inbox");
  });

  test("an empty mount is a no-op", () => {
    const json = JSON.stringify({ start_url: "/", scope: "/" });
    expect(rewriteManifestScope(json, "")).toBe(json);
  });

  test("malformed JSON degrades to untouched, never throws", () => {
    // A broken manifest should cost the install prompt, not the whole page.
    expect(rewriteManifestScope("{not json", "/app")).toBe("{not json");
  });

  test("already-absolute URLs in start_url are left alone", () => {
    const out = JSON.parse(
      rewriteManifestScope(JSON.stringify({ start_url: "https://x.example/" }), "/app"),
    );
    expect(out.start_url).toBe("https://x.example/");
  });
});

describe("injectMountMeta", () => {
  test("tells the bundle where it's mounted, in <head>, before the module script", () => {
    // `@openparachute/app` resolves its router basename from
    // `<meta name="parachute-mount">` — its own documented, highest-priority
    // contract — and nothing was injecting one. Its pathname fallback knows
    // `/surface/<slug>` and `/notes/` but NOT `/app`, so a bundle served at
    // `/app` fell through to ROOT_FALLBACK ("") and believed it lived at the
    // origin root: opening a note produced `/n/<id>` instead of `/app/n/<id>`.
    const out = injectMountMeta("<html><head><script src=x></script></head></html>", "/app");
    expect(out).toContain('<meta name="parachute-mount" content="/app">');
    expect(out.indexOf("parachute-mount")).toBeLessThan(out.indexOf("<script"));
  });

  test("does NOT override a tag the host already injected", () => {
    // A surface host injects its own; the host's contract must win, or we'd
    // silently remount someone else's embed.
    const html = '<html><head><meta name="parachute-mount" content="/surface/notes"></head></html>';
    expect(injectMountMeta(html, "/app")).toBe(html);
  });

  test("empty mount is a no-op — the origin-root case is already correct", () => {
    const html = "<html><head></head></html>";
    expect(injectMountMeta(html, "")).toBe(html);
  });

  test("works for a nested mount", () => {
    expect(injectMountMeta("<html><head></head></html>", "/surface/notes")).toContain(
      'content="/surface/notes"',
    );
  });
});
