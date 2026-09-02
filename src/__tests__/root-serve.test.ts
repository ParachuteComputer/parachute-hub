/**
 * Tests for `src/root-serve.ts` — serving the Parachute app AT the origin root
 * (`root_mode = serve-app`).
 *
 * Covers `serveAppAtRoot` (the static file-or-SPA-shell decision, Accept-gated,
 * reserved-prefix-guarded, traversal-guarded) and `makeAppDistResolver` (success
 * memoization + failure NON-caching for dynamic recovery).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAppDistResolver, serveAppAtRoot } from "../root-serve.ts";

let dist: string;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "phub-root-serve-"));
  dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>App</title>");
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log('app')");
  writeFileSync(join(dist, "manifest.webmanifest"), '{"name":"Parachute"}');
  writeFileSync(join(dist, "sw.js"), "self.addEventListener('install',()=>{})");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function get(pathname: string, accept?: string): Request {
  return new Request(`http://localhost${pathname}`, {
    method: "GET",
    headers: accept ? { accept } : {},
  });
}

describe("serveAppAtRoot", () => {
  test("serves index.html at `/`", async () => {
    const res = serveAppAtRoot(dist, get("/", "text/html"), "/");
    expect(res).not.toBeNull();
    expect(res?.headers.get("content-type")).toContain("text/html");
    expect(await res?.text()).toContain("<title>App</title>");
  });

  test("serves an existing asset with an inferred content-type", async () => {
    const res = serveAppAtRoot(dist, get("/assets/index-abc.js", "*/*"), "/assets/index-abc.js");
    expect(res).not.toBeNull();
    expect(res?.headers.get("content-type") ?? "").toMatch(/javascript/);
    expect(await res?.text()).toContain("console.log");
  });

  test("serves the PWA manifest with the application/manifest+json override", () => {
    const res = serveAppAtRoot(dist, get("/manifest.webmanifest", "*/*"), "/manifest.webmanifest");
    expect(res).not.toBeNull();
    expect(res?.headers.get("content-type")).toBe("application/manifest+json");
  });

  test("serves the service worker as a real file (not the SPA shell)", async () => {
    const res = serveAppAtRoot(dist, get("/sw.js", "*/*"), "/sw.js");
    expect(res).not.toBeNull();
    expect(await res?.text()).toContain("addEventListener");
  });

  test("SPA fallback: an unclaimed HTML deep link gets index.html", async () => {
    const res = serveAppAtRoot(dist, get("/some/app/route", "text/html"), "/some/app/route");
    expect(res).not.toBeNull();
    expect(await res?.text()).toContain("<title>App</title>");
  });

  test("vault-scoped note deep links get the SPA shell (parachute-app#186, #194)", async () => {
    // `/v/<vault>/n/<note>` is an APP client route, so in serve-app mode it must
    // reach the shell and let the app's router resolve it. Nothing in
    // `hub-server.ts` claims `/v` (only `/vault*` and `/vaults*`, which need the
    // full word) and it is not a reserved prefix, so this is already true — but
    // it is true by ABSENCE, which is exactly the kind of fact that regresses
    // silently when someone adds a hub route. These pin it as a contract.
    //
    // Every shape the app can be handed: a ULID id, the editor tail, the
    // percent-encoded single-segment path the app itself emits, the
    // multi-segment path a human writes out (arbitrarily deep), a vault
    // referenced by id rather than name, and the bare `/v/<vault>` address.
    const deepLinks = [
      "/v/aaron/n/01JBQZ0Q2M8T9V5X7YB3KD4WEN",
      "/v/aaron/n/01JBQZ0Q2M8T9V5X7YB3KD4WEN/edit",
      "/v/aaron/n/Projects%2F2026%2FRoadmap",
      "/v/aaron/n/Projects/2026/Roadmap",
      "/v/aaron/n/Projects/2026/Roadmap/edit",
      "/v/box.example_vault_aaron/n/01JBQZ0Q2M8T9V5X7YB3KD4WEN",
      "/v/aaron",
    ];
    for (const p of deepLinks) {
      const res = serveAppAtRoot(dist, get(p, "text/html"), p);
      expect(res, p).not.toBeNull();
      expect(await res?.text()).toContain("<title>App</title>");
    }
  });

  test("non-HTML unclaimed request → null (branded 404 tail)", () => {
    expect(serveAppAtRoot(dist, get("/nope.json", "application/json"), "/nope.json")).toBeNull();
    // A missing asset fetched with Accept: */* is not an HTML navigation → null.
    expect(serveAppAtRoot(dist, get("/assets/missing.js", "*/*"), "/assets/missing.js")).toBeNull();
  });

  test("non-GET → null (a non-GET unclaimed path keeps its default)", () => {
    const post = new Request("http://localhost/", {
      method: "POST",
      headers: { accept: "text/html" },
    });
    expect(serveAppAtRoot(dist, post, "/")).toBeNull();
  });

  test("reserved hub/protocol prefixes keep the branded 404 even for HTML nav", () => {
    for (const p of ["/api/bogus", "/oauth/typo", "/.well-known/nope"]) {
      expect(serveAppAtRoot(dist, get(p, "text/html"), p)).toBeNull();
    }
  });

  test("path traversal cannot escape dist", () => {
    // A crafted encoded traversal joins outside dist → falls through (null).
    const p = "/assets/..%2f..%2f..%2fetc%2fpasswd";
    expect(serveAppAtRoot(dist, get(p, "*/*"), p)).toBeNull();
  });

  test("a resolved dist whose index.html vanished → null (no broken shell)", () => {
    rmSync(join(dist, "index.html"));
    expect(serveAppAtRoot(dist, get("/", "text/html"), "/")).toBeNull();
  });

  test("malformed percent-encoding → null (no URIError thrown → branded 404, not 500)", () => {
    // decodeURIComponent throws URIError on a bad escape; the guard must swallow
    // it and fall through so the dispatch never 500s on a garbage asset URL.
    for (const p of ["/assets/%ZZ", "/foo%", "/%E0%A4%A", "/bar%2"]) {
      expect(() => serveAppAtRoot(dist, get(p, "*/*"), p)).not.toThrow();
      expect(serveAppAtRoot(dist, get(p, "*/*"), p)).toBeNull();
    }
    // Even an HTML navigation with bad encoding falls through (redirect-mode
    // parity) rather than shelling.
    expect(serveAppAtRoot(dist, get("/foo%", "text/html"), "/foo%")).toBeNull();
  });
});

describe("makeAppDistResolver", () => {
  test("returns the resolved dist and memoizes a success", () => {
    let calls = 0;
    const resolve = makeAppDistResolver(() => {
      calls++;
      return dist;
    });
    expect(resolve()).toBe(dist);
    expect(resolve()).toBe(dist);
    expect(calls).toBe(1); // success cached — only resolved once
  });

  test("does NOT cache a failure — recovers once the app is installed", () => {
    let installed = false;
    const resolve = makeAppDistResolver(() => {
      if (!installed) throw new Error("not installed");
      return dist;
    });
    expect(resolve()).toBeNull(); // not installed yet
    expect(resolve()).toBeNull(); // still probing, still null
    installed = true;
    expect(resolve()).toBe(dist); // picked up without a restart
  });
});
