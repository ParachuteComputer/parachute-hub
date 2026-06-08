#!/usr/bin/env bun
/**
 * MCP-handshake probe — runs INSIDE the e2e container (Stage 1), with bun.
 *
 * Drives the FULL OAuth dance a real connector (Claude Code / claude.ai) does
 * against a freshly-bootstrapped hub, end to end over loopback:
 *
 *   1. DCR — POST /oauth/register (RFC 7591) → client_id + redirect_uri.
 *   2. Operator login — POST /login (username+password) → session cookie.
 *      (The dedicated login surface; the cookie unlocks the /oauth/authorize
 *      consent screen, same as a browser operator signing in.)
 *   3. Authorize w/ PKCE — GET /oauth/authorize?... (renders consent because
 *      the session is valid) then POST /oauth/authorize with __action=consent,
 *      approve=yes, vault_pick=<vault> → 302 with ?code=<authcode>.
 *   4. Token — POST /oauth/token (grant_type=authorization_code + code_verifier)
 *      → access_token (a vault:<name>:* JWT).
 *   5. MCP — speak streamable-HTTP JSON-RPC at /vault/<name>/mcp with the
 *      Bearer: initialize → tools/list → create-note → query-notes round-trip.
 *
 * Exit 0 iff the note round-trips (created note is found by query). Non-zero +
 * a clear reason otherwise. stdout is streamed by the host driver.
 *
 * Args (all required): --hub <origin> --vault <name> --user <u> --pass <p>
 */

import { createHash, randomBytes } from "node:crypto";

interface Args {
  hub: string;
  vault: string;
  user: string;
  pass: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    const v = argv[i + 1];
    if (k && v !== undefined) out[k] = v;
  }
  for (const req of ["hub", "vault", "user", "pass"]) {
    if (!out[req]) {
      console.error(`mcp-probe: missing --${req}`);
      process.exit(2);
    }
  }
  return out as unknown as Args;
}

const args = parseArgs(process.argv.slice(2));
const HUB = args.hub.replace(/\/+$/, "");

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Pull a cookie value out of a set-cookie header collection. */
function cookieFrom(res: Response, name: string): string | undefined {
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(res.headers) : [];
  for (const c of cookies) {
    const m = c.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (m?.[1]) return m[1];
  }
  return undefined;
}

function fail(msg: string): never {
  console.error(`mcp-probe FAIL: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`[mcp-probe] hub=${HUB} vault=${args.vault}`);

  // --- 1. DCR ---------------------------------------------------------------
  // redirect_uri is on the hub's own origin so the authorize-flow's
  // self-origin recovery never trips and the picker stays clean.
  const redirectUri = `${HUB}/admin/oauth-callback`;
  const regRes = await fetch(`${HUB}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "e2e-mcp-probe",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (regRes.status !== 200 && regRes.status !== 201) {
    fail(`DCR /oauth/register returned ${regRes.status}: ${(await regRes.text()).slice(0, 300)}`);
  }
  const reg = (await regRes.json()) as { client_id: string };
  if (!reg.client_id) fail("DCR response carried no client_id");
  console.log(`[mcp-probe] registered client_id=${reg.client_id}`);

  // --- 2. Operator login → session cookie -----------------------------------
  // GET /login first to obtain a CSRF cookie + token, then POST credentials.
  const loginGet = await fetch(`${HUB}/login`, { redirect: "manual" });
  const csrfCookie = cookieFrom(loginGet, "parachute_hub_csrf");
  const loginHtml = await loginGet.text();
  // The login form embeds the CSRF token in a hidden input named `__csrf`
  // (CSRF_FIELD_NAME). The double-submit check matches it against the cookie.
  const csrfField = loginHtml.match(/name="__csrf"\s+value="([^"]+)"/)?.[1] ?? csrfCookie ?? "";

  const loginBody = new URLSearchParams({
    __csrf: csrfField,
    username: args.user,
    password: args.pass,
  });
  const loginHeaders: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (csrfCookie) loginHeaders.cookie = `parachute_hub_csrf=${csrfCookie}`;
  const loginRes = await fetch(`${HUB}/login`, {
    method: "POST",
    headers: loginHeaders,
    body: loginBody,
    redirect: "manual",
  });
  // Successful login 302s to /admin (or similar) and sets the session cookie.
  const sessionCookie = cookieFrom(loginRes, "parachute_hub_session");
  if (!sessionCookie) {
    fail(
      `POST /login did not set a session cookie (status ${loginRes.status}): ${(await loginRes.text()).slice(0, 200)}`,
    );
  }
  console.log("[mcp-probe] operator logged in (session cookie acquired)");

  // --- 3. Authorize w/ PKCE -------------------------------------------------
  const { verifier, challenge } = makePkce();
  const authQuery = new URLSearchParams({
    client_id: reg.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: `vault:${args.vault}:read vault:${args.vault}:write`,
    state: "e2e-state",
    resource: `${HUB}/vault/${args.vault}`,
  });
  // GET /oauth/authorize. Two valid outcomes a real MCP client (Claude Code /
  // claude.ai) must handle — and the probe now handles BOTH:
  //   200 — the consent SCREEN is rendered. First-time client (no prior trust).
  //         We parse the form, POST __action=consent, and read the auth code
  //         from the resulting 302 callback Location. (Stage 1 loopback path:
  //         the probe's client is brand-new.)
  //   302 — consent was AUTO-APPROVED (hub#409 trust-by-client_name): a client
  //         with the same client_name was already approved, so the hub skips
  //         the consent screen and 302s straight to the callback with ?code=.
  //         (Stage 3 public path: the probe registers a SECOND client with the
  //         same client_name as Stage 1's, so trust-by-client_name fires.)
  // Either way we end up with an auth code → /oauth/token → MCP. A 302 carrying
  // ?error= (denied / invalid) is a REAL failure and fails loudly.
  const authGet = await fetch(`${HUB}/oauth/authorize?${authQuery.toString()}`, {
    headers: { cookie: `parachute_hub_session=${sessionCookie}` },
    redirect: "manual",
  });

  let code: string | null = null;

  if (authGet.status === 302) {
    // Auto-approved path (hub#409). The code is already in the redirect target.
    const loc = authGet.headers.get("location") ?? "";
    const locUrl = new URL(loc, HUB);
    const errParam = locUrl.searchParams.get("error");
    if (errParam) {
      fail(
        `GET /oauth/authorize auto-redirect carried ?error=${errParam} (${locUrl.searchParams.get("error_description") ?? "no description"}): ${loc}`,
      );
    }
    // Verify the state round-trips (CSRF / response-binding sanity).
    const returnedState = locUrl.searchParams.get("state");
    if (returnedState !== "e2e-state") {
      fail(`auto-approve redirect state mismatch: expected "e2e-state", got "${returnedState}"`);
    }
    code = locUrl.searchParams.get("code");
    if (!code) fail(`auto-approve redirect carried no ?code= : ${loc}`);
    console.log("[mcp-probe] authorization code obtained (auto-approved — hub#409 trust-by-client_name)");
  } else if (authGet.status === 200) {
    // Consent-screen path (first-time client). Parse + POST the consent form.
    const authHtml = await authGet.text();
    if (!authHtml.includes('value="consent"')) {
      fail(`GET /oauth/authorize did not render the consent screen: ${authHtml.slice(0, 300)}`);
    }
    const authCsrfCookie = cookieFrom(authGet, "parachute_hub_csrf") ?? csrfCookie;
    const authCsrfField =
      authHtml.match(/name="__csrf"\s+value="([^"]+)"/)?.[1] ?? authCsrfCookie ?? "";

    const consentBody = new URLSearchParams({
      __action: "consent",
      __csrf: authCsrfField,
      approve: "yes",
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: `vault:${args.vault}:read vault:${args.vault}:write`,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "e2e-state",
      resource: `${HUB}/vault/${args.vault}`,
      vault_pick: args.vault,
    });
    const consentCookies = [`parachute_hub_session=${sessionCookie}`];
    if (authCsrfCookie) consentCookies.push(`parachute_hub_csrf=${authCsrfCookie}`);
    const consentRes = await fetch(`${HUB}/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: consentCookies.join("; "),
      },
      body: consentBody,
      redirect: "manual",
    });
    if (consentRes.status !== 302) {
      fail(
        `consent POST returned ${consentRes.status} (expected 302): ${(await consentRes.text()).slice(0, 300)}`,
      );
    }
    const loc = consentRes.headers.get("location") ?? "";
    const locUrl = new URL(loc, HUB);
    const errParam = locUrl.searchParams.get("error");
    if (errParam) fail(`consent redirect carried ?error=${errParam} : ${loc}`);
    code = locUrl.searchParams.get("code");
    if (!code) fail(`consent redirect carried no ?code= : ${loc}`);
    console.log("[mcp-probe] authorization code obtained (consent screen — first-time client)");
  } else {
    const body = await authGet.text();
    fail(
      `GET /oauth/authorize returned ${authGet.status} (expected 200 consent or 302 auto-approve): ${body.slice(0, 300)}`,
    );
  }

  // Both branches above either set a non-null `code` or `fail()` (→ never), so
  // this is belt-and-suspenders — and it narrows `code` to `string` for the
  // token exchange below.
  if (!code) fail("no authorization code obtained from /oauth/authorize");

  // --- 4. Token exchange ----------------------------------------------------
  const tokenRes = await fetch(`${HUB}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (tokenRes.status !== 200) {
    fail(`POST /oauth/token returned ${tokenRes.status}: ${(await tokenRes.text()).slice(0, 300)}`);
  }
  const tok = (await tokenRes.json()) as { access_token: string; scope?: string };
  if (!tok.access_token) fail("token response carried no access_token");
  console.log(`[mcp-probe] access token minted (scope: ${tok.scope ?? "?"})`);

  // --- 5. MCP round-trip ----------------------------------------------------
  const mcpUrl = `${HUB}/vault/${args.vault}/mcp`;
  const bearer = tok.access_token;
  let rpcId = 0;
  async function rpc(method: string, params: unknown): Promise<any> {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        // Streamable-HTTP requires the client advertise both JSON + SSE.
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const text = await res.text();
    if (res.status !== 200) {
      fail(`MCP ${method} HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    // enableJsonResponse:true returns a JSON body; some SDK versions wrap in
    // an SSE `data:` frame — handle both.
    let body = text.trim();
    if (body.startsWith("event:") || body.startsWith("data:")) {
      const dataLine = body.split("\n").find((l) => l.startsWith("data:"));
      body = dataLine ? dataLine.slice(5).trim() : body;
    }
    const parsed = JSON.parse(body) as { result?: unknown; error?: { message?: string } };
    if (parsed.error)
      fail(`MCP ${method} JSON-RPC error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
    return parsed.result;
  }

  // initialize
  const initResult = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "e2e-mcp-probe", version: "1.0.0" },
  });
  console.log(
    `[mcp-probe] MCP initialize ok (server: ${(initResult as any)?.serverInfo?.name ?? "?"})`,
  );

  // tools/list — must include create-note + query-notes (write scope present)
  const toolsResult = (await rpc("tools/list", {})) as { tools: Array<{ name: string }> };
  const toolNames = (toolsResult.tools ?? []).map((t) => t.name);
  console.log(`[mcp-probe] tools/list → ${toolNames.join(", ")}`);
  for (const need of ["create-note", "query-notes"]) {
    if (!toolNames.includes(need)) fail(`tools/list missing "${need}" (write scope not honored?)`);
  }

  // create-note (write round-trip)
  const marker = `e2e-marker-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const createResult = (await rpc("tools/call", {
    name: "create-note",
    arguments: { content: `E2E probe note ${marker}`, tags: ["e2e"] },
  })) as { content?: Array<{ type: string; text?: string }> };
  const createText = (createResult.content ?? []).map((c) => c.text ?? "").join("\n");
  console.log(`[mcp-probe] create-note → ${createText.slice(0, 120)}`);

  // query-notes (read it back). Query by the `e2e` tag rather than a
  // full-text search of the marker: the marker is hyphen-heavy and SQLite
  // FTS tokenizes hyphens as separators, so a `search:` of the whole marker
  // string wouldn't match it as a single term. The tag query is exact and
  // returns the note's preview, which carries the marker — a real read-back.
  const queryResult = (await rpc("tools/call", {
    name: "query-notes",
    arguments: { tag: "e2e" },
  })) as { content?: Array<{ type: string; text?: string }> };
  const queryText = (queryResult.content ?? []).map((c) => c.text ?? "").join("\n");
  if (!queryText.includes(marker)) {
    fail(
      `query-notes (tag:e2e) did not return the just-created note (marker ${marker}): ${queryText.slice(0, 300)}`,
    );
  }
  console.log(`[mcp-probe] query-notes round-trip OK — note ${marker} found`);
  console.log("mcp-probe PASS");
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
