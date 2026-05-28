import { describe, expect, test } from "bun:test";
import {
  ADMIN_MODULES_URL,
  ERROR_TYPE_PERSISTENT,
  ERROR_TYPE_TRANSIENT,
  TRANSIENT_MAX_ATTEMPTS,
  TRANSIENT_RETRY_MS,
  renderProxyError,
  renderProxyErrorHtml,
  renderProxyErrorJson,
  statusForState,
  toResponse,
  wantsHtml,
} from "../proxy-error-ui.ts";

function req(accept?: string): Request {
  const headers: Record<string, string> = {};
  if (accept !== undefined) headers.accept = accept;
  return new Request("http://127.0.0.1/vault/default/health", { headers });
}

describe("wantsHtml — Accept-header negotiation", () => {
  test("text/html → HTML", () => {
    expect(wantsHtml(req("text/html"))).toBe(true);
  });
  test("application/json → JSON", () => {
    expect(wantsHtml(req("application/json"))).toBe(false);
  });
  test("missing Accept → HTML (browser-ish default)", () => {
    expect(wantsHtml(req())).toBe(true);
  });
  test("*/* alone → HTML", () => {
    expect(wantsHtml(req("*/*"))).toBe(true);
  });
  test("text/html,application/xhtml+xml,application/xml → HTML", () => {
    expect(wantsHtml(req("text/html,application/xhtml+xml,application/xml"))).toBe(true);
  });
  test("application/json with text/html present → HTML", () => {
    // If a client sends both, we lean HTML — matches the hub's existing
    // one-line accept check at the 404 fallthrough.
    expect(wantsHtml(req("application/json, text/html"))).toBe(true);
  });
});

describe("statusForState", () => {
  test("transient → 503", () => {
    expect(statusForState("transient")).toBe(503);
  });
  test("persistent → 502", () => {
    expect(statusForState("persistent")).toBe(502);
  });
});

describe("renderProxyErrorJson", () => {
  test("transient → 503 JSON with retry_after_ms + max_attempts + no admin_url", () => {
    const out = renderProxyErrorJson({
      short: "vault",
      serviceLabel: "parachute-vault",
      state: "transient",
      upstreamError: "ECONNREFUSED",
    });
    expect(out.status).toBe(503);
    expect(out.contentType).toBe("application/json");
    expect(out.retryAfter).toBe("2");
    const body = JSON.parse(out.body) as {
      error: string;
      error_type: string;
      retry_after_ms: number;
      max_attempts: number;
      admin_url?: string;
      service: string;
    };
    expect(body.error).toBe(ERROR_TYPE_TRANSIENT);
    expect(body.error_type).toBe(ERROR_TYPE_TRANSIENT);
    expect(body.retry_after_ms).toBe(TRANSIENT_RETRY_MS);
    expect(body.max_attempts).toBe(TRANSIENT_MAX_ATTEMPTS);
    expect(body.admin_url).toBeUndefined();
    expect(body.service).toBe("vault");
  });

  test("persistent → 502 JSON with admin_url + no retry_after_ms", () => {
    const out = renderProxyErrorJson({
      short: "scribe",
      serviceLabel: "scribe",
      state: "persistent",
      upstreamError: "ECONNREFUSED",
    });
    expect(out.status).toBe(502);
    expect(out.contentType).toBe("application/json");
    expect(out.retryAfter).toBeUndefined();
    const body = JSON.parse(out.body) as {
      error: string;
      error_type: string;
      retry_after_ms?: number;
      admin_url?: string;
    };
    expect(body.error).toBe(ERROR_TYPE_PERSISTENT);
    expect(body.error_type).toBe(ERROR_TYPE_PERSISTENT);
    expect(body.admin_url).toBe(ADMIN_MODULES_URL);
    expect(body.retry_after_ms).toBeUndefined();
  });

  test("persistent JSON folds upstreamError into error_description", () => {
    const out = renderProxyErrorJson({
      short: "vault",
      serviceLabel: "parachute-vault",
      state: "persistent",
      upstreamError: "ECONNREFUSED 127.0.0.1:1940",
    });
    const body = JSON.parse(out.body) as { error_description: string };
    expect(body.error_description).toContain("ECONNREFUSED");
    expect(body.error_description).toContain("parachute-vault");
  });
});

describe("renderProxyErrorHtml", () => {
  test("transient HTML → 503 + meta-refresh + Retry-After + poll script", () => {
    const out = renderProxyErrorHtml({
      short: "vault",
      serviceLabel: "parachute-vault",
      state: "transient",
      upstreamError: "ECONNREFUSED",
    });
    expect(out.status).toBe(503);
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.retryAfter).toBe("2");
    expect(out.body).toContain(`<meta http-equiv="refresh" content="2">`);
    expect(out.body).toContain("Just a moment");
    expect(out.body).toContain("/api/ready");
    expect(out.body).toContain("ready_modules");
    expect(out.body).toContain(`maxAttempts = ${TRANSIENT_MAX_ATTEMPTS}`);
    // Transient page MUST NOT include an admin link (Aaron design (d)).
    expect(out.body).not.toContain("/admin/modules");
  });

  test("persistent HTML → 502 + no meta-refresh + admin link + manual refresh", () => {
    const out = renderProxyErrorHtml({
      short: "vault",
      serviceLabel: "parachute-vault",
      state: "persistent",
      upstreamError: "ECONNREFUSED",
    });
    expect(out.status).toBe(502);
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.retryAfter).toBeUndefined();
    expect(out.body).not.toContain(`http-equiv="refresh"`);
    expect(out.body).toContain("Module unreachable");
    expect(out.body).toContain("/admin/modules");
    expect(out.body).toContain("View module status");
    // No periodic poll on the persistent page — only the manual-refresh
    // listener. Assert by checking that maxAttempts/intervalMs constants
    // aren't emitted into the script.
    expect(out.body).not.toContain("maxAttempts");
  });

  test("HTML escapes the service short name into the body", () => {
    // Constructing a malicious short shouldn't break the page. ServiceEntry
    // names are validated upstream but the renderer is defense-in-depth.
    const out = renderProxyErrorHtml({
      short: "<script>alert(1)</script>",
      serviceLabel: "<malicious>",
      state: "persistent",
      upstreamError: "x",
    });
    expect(out.body).not.toContain("<script>alert(1)</script>");
    expect(out.body).toContain("&lt;script&gt;");
  });
});

describe("renderProxyError — Accept-driven dispatch", () => {
  test("JSON-accepting request → JSON renderer", () => {
    const out = renderProxyError(req("application/json"), {
      short: "vault",
      serviceLabel: "parachute-vault",
      state: "transient",
      upstreamError: "x",
    });
    expect(out.contentType).toBe("application/json");
  });
  test("HTML-accepting request → HTML renderer", () => {
    const out = renderProxyError(req("text/html"), {
      short: "vault",
      serviceLabel: "parachute-vault",
      state: "transient",
      upstreamError: "x",
    });
    expect(out.contentType).toBe("text/html; charset=utf-8");
  });
});

describe("toResponse", () => {
  test("attaches Retry-After when present", () => {
    const out = toResponse({
      body: "{}",
      status: 503,
      contentType: "application/json",
      retryAfter: "2",
    });
    expect(out.status).toBe(503);
    expect(out.headers.get("retry-after")).toBe("2");
    expect(out.headers.get("content-type")).toBe("application/json");
    expect(out.headers.get("cache-control")).toBe("no-store");
  });
  test("omits Retry-After when absent", () => {
    const out = toResponse({
      body: "{}",
      status: 502,
      contentType: "application/json",
    });
    expect(out.headers.get("retry-after")).toBeNull();
  });
});
