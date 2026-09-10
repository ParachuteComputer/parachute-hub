/**
 * The browser side of the human key door — row 4 of the design note
 * `Design/Human key door — sign in with a Nostr key`
 * (https://parachute.techne.coop/n/01M1J1CHW7KM8FD35FR1AH06HK).
 *
 * Coverage:
 *   - the error table: every wire code `nostr-login.ts` can emit has a human
 *     sentence, no raw code is ever the whole message, and unknown codes fall
 *     back to the server's description then to a generic line
 *   - both login pages (`renderAdminLogin`, `renderLogin`) carry the button,
 *     the script and the styles, hidden by default, with the password form
 *     untouched — the no-JS page is today's page
 *   - THE CLIENT FLOW ITSELF. `nostrLoginClientScript()` returns the exact
 *     source the pages inline, so we compile that source with
 *     `new Function("window", "document", "fetch", src)`, hand it a fake DOM,
 *     a `window.nostr` backed by a REAL @noble/curves schnorr keypair, and a
 *     fetch wired straight into `handleNostrLogin` over a real hub DB. The
 *     bytes under test are the bytes that ship. Cases: happy path mints a
 *     session and follows the redirect, 2FA divert navigates to /login/2fa,
 *     an unlinked key shows the unknown_pubkey sentence and re-arms the
 *     button, a declined signer shows the signer sentence, and no extension
 *     leaves the button disabled with the install hint
 *   - GET /login/2fa: renders with a live pending-login cookie, does NOT
 *     consume it, 302s to /login without one, mirrors the POST's `next`
 *     precedence, and is reachable through the real `hubFetch` dispatch
 *   - CSP: the login pages are rendered by the hub, not proxied, so they
 *     carry no CSP header and the inline script is unaffected by hub#643
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { POST_LOGIN_DEFAULT, handleAdminLoginTotpGet } from "../admin-handlers.ts";
import { renderAdminLogin } from "../admin-login-ui.ts";
import { CSRF_COOKIE_NAME } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { nostrEventId } from "../nostr-event.ts";
import {
  NOSTR_LOGIN_BUTTON_ID,
  NOSTR_LOGIN_ERROR_MESSAGES,
  NOSTR_LOGIN_GENERIC_ERROR,
  NOSTR_LOGIN_NO_SIGNER_HINT,
  NOSTR_LOGIN_SECTION_ID,
  NOSTR_LOGIN_SIGNER_REFUSED,
  NOSTR_LOGIN_STATUS_ID,
  nostrLoginClientScript,
  nostrLoginErrorMessage,
} from "../nostr-login-ui.ts";
import {
  NOSTR_LOGIN_2FA_ENV,
  NOSTR_LOGIN_VERIFY_PATH,
  _resetNostrLoginChallenges,
  handleNostrLogin,
} from "../nostr-login.ts";
import { renderLogin } from "../oauth-ui.ts";
import {
  PENDING_LOGIN_COOKIE_NAME,
  _resetPendingLogins,
  createPendingLogin,
  getPendingLogin,
} from "../pending-login.ts";
import { bindPubkeyOperatorAttested } from "../pubkey-links.ts";
import { __resetForTests as resetRateLimit } from "../rate-limit.ts";
import { generateTotpSecret } from "../totp.ts";
import { persistEnrollment } from "../two-factor-store.ts";
import { createUser } from "../users.ts";

const ORIGIN = "https://hub.example";
const BOUND = [ORIGIN];
const PASSWORD = "correct-horse-battery";

let db: Database;
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "phub-nostr-login-ui-"));
  db = openHubDb(hubDbPath(configDir));
  resetRateLimit();
  _resetNostrLoginChallenges();
  _resetPendingLogins();
  delete process.env[NOSTR_LOGIN_2FA_ENV];
});

afterEach(() => {
  db.close();
  rmSync(configDir, { recursive: true, force: true });
  delete process.env[NOSTR_LOGIN_2FA_ENV];
});

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const hexToBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));

function keypair(): { secret: Uint8Array; pubkey: string } {
  const secret = schnorr.utils.randomSecretKey();
  return { secret, pubkey: bytesToHex(schnorr.getPublicKey(secret)) };
}

async function linkedUser(username: string, pubkey: string): Promise<{ id: string }> {
  const u = await createUser(db, username, PASSWORD, { allowMulti: true, passwordChanged: true });
  const bound = bindPubkeyOperatorAttested(db, { userId: u.id, pubkey, label: "test" });
  expect(bound.ok).toBe(true);
  return { id: u.id };
}

function sessionRows(userId: string): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
      .get(userId)?.n ?? 0
  );
}

// --- the error table ------------------------------------------------------

describe("nostrLoginErrorMessage", () => {
  /**
   * Every code `nostr-login.ts` can put on the wire. Kept as a literal list
   * rather than derived from the map, so ADDING a code to the door without
   * adding a sentence here fails this test instead of silently shipping a
   * blank status line.
   */
  const WIRE_CODES = [
    "too_many_attempts",
    "invalid_request",
    "invalid_event",
    "proof_failed",
    "unknown_challenge",
    "challenge_expired",
    "unknown_pubkey",
    "csrf_origin_mismatch",
    "method_not_allowed",
    "not_found",
  ];

  test("every wire code the door can emit has a human sentence", () => {
    for (const code of WIRE_CODES) {
      const msg = nostrLoginErrorMessage(code, "raw description");
      expect(msg).toBe(NOSTR_LOGIN_ERROR_MESSAGES[code] as string);
      // Never a raw code alone, and never just the code echoed.
      expect(msg).not.toBe(code);
      expect(msg).not.toContain(code);
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).toMatch(/[.!]$/);
    }
  });

  test("the unlinked-key message names both remedies from the design note §4", () => {
    const msg = NOSTR_LOGIN_ERROR_MESSAGES.unknown_pubkey as string;
    expect(msg).toContain("operator");
    expect(msg).toContain("channel");
  });

  test("an unrecognized code falls back to the server's description, then generic", () => {
    expect(nostrLoginErrorMessage("brand_new_code", "the hub explained itself")).toBe(
      "the hub explained itself",
    );
    expect(nostrLoginErrorMessage("brand_new_code")).toBe(NOSTR_LOGIN_GENERIC_ERROR);
    expect(nostrLoginErrorMessage(null)).toBe(NOSTR_LOGIN_GENERIC_ERROR);
    expect(nostrLoginErrorMessage(undefined, "")).toBe(NOSTR_LOGIN_GENERIC_ERROR);
  });

  test("a prototype key is not mistaken for a message (no proto pollution read)", () => {
    expect(nostrLoginErrorMessage("toString")).toBe(NOSTR_LOGIN_GENERIC_ERROR);
    expect(nostrLoginErrorMessage("constructor")).toBe(NOSTR_LOGIN_GENERIC_ERROR);
  });
});

// --- the two login pages --------------------------------------------------

describe("the key door renders on BOTH login pages", () => {
  const adminPage = (): string => renderAdminLogin({ next: "/admin/vaults", csrfToken: "tok-abc" });
  const oauthPage = (): string =>
    renderLogin({
      params: {
        clientId: "c1",
        redirectUri: "https://app.example/cb",
        responseType: "code",
        scope: "vault:read",
        state: "s",
        codeChallenge: "cc",
        codeChallengeMethod: "S256",
        resource: null,
      },
      csrfToken: "tok-abc",
    });

  for (const [name, page] of [
    ["/login (admin)", adminPage],
    ["/oauth/authorize (OAuth)", oauthPage],
  ] as const) {
    test(`${name} carries the button, the script and the styles`, () => {
      const html = page();
      expect(html).toContain(`id="${NOSTR_LOGIN_SECTION_ID}"`);
      expect(html).toContain(`id="${NOSTR_LOGIN_BUTTON_ID}"`);
      expect(html).toContain(`id="${NOSTR_LOGIN_STATUS_ID}"`);
      expect(html).toContain("Sign in with Nostr key");
      // The script is inlined, and it is the same source the unit tests drive.
      expect(html).toContain("<script>");
      expect(html).toContain("/api/auth/nostr/challenge");
      expect(html).toContain(NOSTR_LOGIN_VERIFY_PATH);
      expect(html).toContain("signEvent");
      // Styles for the section rode along with it.
      expect(html).toContain(".alt-signin");
      expect(html).toContain(".btn-key");
    });

    test(`${name} hides the door by default so a no-JS page is unchanged`, () => {
      const html = page();
      // Hidden AND disabled in the markup: no-JS shows nothing, and can never
      // present an inert button.
      expect(html).toMatch(
        new RegExp(`<section class="alt-signin" id="${NOSTR_LOGIN_SECTION_ID}" hidden>`),
      );
      expect(html).toMatch(new RegExp(`id="${NOSTR_LOGIN_BUTTON_ID}"[^>]*disabled`));
      expect(html).toContain(".alt-signin[hidden] { display: none; }");
    });

    test(`${name} leaves the password form untouched`, () => {
      const html = page();
      expect(html).toContain('name="username"');
      expect(html).toContain('name="password"');
      expect(html).toContain('type="submit"');
      // The key-door button is type=button — it can never submit the form.
      expect(html).toMatch(new RegExp(`<button type="button"[^>]*id="${NOSTR_LOGIN_BUTTON_ID}"`));
    });
  }

  test("the admin page pins `next` server-side; the OAuth page leaves it to the URL", () => {
    expect(renderAdminLogin({ next: "/account/", csrfToken: "t" })).toContain(
      'data-next="/account/"',
    );
    // OAuth: no data-next → the script re-enters the current /oauth/authorize URL.
    expect(oauthPage()).not.toContain("data-next=");
  });

  test("`next` is attribute-escaped on the admin page", () => {
    const html = renderAdminLogin({ next: '/x?a="b"&c=<d>', csrfToken: "t" });
    expect(html).toContain('data-next="/x?a=&quot;b&quot;&amp;c=&lt;d>"');
    expect(html).not.toContain('data-next="/x?a="b"');
  });

  test("the inline script has no closing-tag escape into the page", () => {
    expect(nostrLoginClientScript().toLowerCase()).not.toContain("</script");
  });
});

// --- the client flow, driven for real -------------------------------------

interface FakeEl {
  id: string;
  disabled: boolean;
  textContent: string;
  attrs: Record<string, string>;
  listeners: Array<() => void>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, fn: () => void): void;
}

function makeEl(id: string, attrs: Record<string, string> = {}): FakeEl {
  return {
    id,
    disabled: true,
    textContent: "",
    attrs: { ...attrs },
    listeners: [],
    getAttribute(name) {
      return Object.hasOwn(this.attrs, name) ? (this.attrs[name] as string) : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    addEventListener(type, fn) {
      if (type === "click") this.listeners.push(fn);
    },
  };
}

interface Harness {
  block: FakeEl;
  btn: FakeEl;
  status: FakeEl;
  assigned: string[];
  fetchCalls: Array<{ url: string; init: Record<string, unknown> }>;
  click: () => void;
  drainTimers: (n?: number) => void;
}

/**
 * Compile the SHIPPED script source against a fake DOM.
 *
 * `window`, `document` and `fetch` are free identifiers in the source — real
 * globals in a browser, function parameters here. That is the whole trick, and
 * it is why this test exercises the actual bytes rather than a reimplementation.
 */
function mount(opts: {
  nostr?: { signEvent: (e: unknown) => Promise<unknown> };
  next?: string;
  path?: string;
  search?: string;
  /** Routes the script's fetch. Defaults to the real key door over `db`. */
  fetchImpl?: (url: string, init: Record<string, unknown>) => Promise<Response>;
}): Harness {
  const block = makeEl(NOSTR_LOGIN_SECTION_ID, { hidden: "" });
  const btn = makeEl(NOSTR_LOGIN_BUTTON_ID, opts.next ? { "data-next": opts.next } : {});
  const status = makeEl(NOSTR_LOGIN_STATUS_ID);
  const assigned: string[] = [];
  const fetchCalls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const timers: Array<() => void> = [];

  const doorFetch = async (url: string, init: Record<string, unknown>): Promise<Response> => {
    const subpath = url.replace("/api/auth/nostr", "");
    const headers: Record<string, string> = {
      origin: ORIGIN,
      "x-forwarded-for": "203.0.113.99",
      ...((init.headers as Record<string, string>) ?? {}),
    };
    const req = new Request(`${ORIGIN}${url}`, {
      method: (init.method as string) ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: init.body as string }),
    });
    return handleNostrLogin(req, subpath, { db, hubBoundOrigins: BOUND });
  };

  const win = {
    ...(opts.nostr ? { nostr: opts.nostr } : {}),
    location: {
      pathname: opts.path ?? "/login",
      search: opts.search ?? "",
      assign(target: string) {
        assigned.push(target);
      },
    },
    setTimeout(fn: () => void) {
      timers.push(fn);
      return timers.length;
    },
  };
  const doc = {
    getElementById(id: string): FakeEl | null {
      if (id === NOSTR_LOGIN_SECTION_ID) return block;
      if (id === NOSTR_LOGIN_BUTTON_ID) return btn;
      if (id === NOSTR_LOGIN_STATUS_ID) return status;
      return null;
    },
  };
  const fetchFn = (url: string, init: Record<string, unknown> = {}): Promise<Response> => {
    fetchCalls.push({ url, init });
    return (opts.fetchImpl ?? doorFetch)(url, init);
  };

  // Compiling the shipped inline script is the point — see the docstring above.
  const run = new Function("window", "document", "fetch", nostrLoginClientScript());
  run(win, doc, fetchFn);

  return {
    block,
    btn,
    status,
    assigned,
    fetchCalls,
    click: () => {
      for (const fn of btn.listeners) fn();
    },
    drainTimers: (n = 5) => {
      for (let i = 0; i < n; i += 1) {
        const queued = timers.splice(0, timers.length);
        for (const fn of queued) fn();
      }
    },
  };
}

/** Poll a real-timer condition; the script's chain is genuinely async. */
async function waitFor(what: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (what()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** A NIP-07 `window.nostr` backed by a real key — signs whatever it is handed. */
function fakeSigner(secret: Uint8Array): { signEvent: (e: unknown) => Promise<unknown> } {
  return {
    signEvent: async (draft: unknown) => {
      const d = draft as { kind: number; created_at: number; tags: string[][]; content: string };
      const unsigned = {
        pubkey: bytesToHex(schnorr.getPublicKey(secret)),
        created_at: d.created_at,
        kind: d.kind,
        tags: d.tags,
        content: d.content,
      };
      const id = nostrEventId(unsigned);
      return { ...unsigned, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), secret)) };
    },
  };
}

describe("the client script — challenge → sign → verify, against the real door", () => {
  test("happy path: mints a session and follows the SERVER's redirect", async () => {
    const { secret, pubkey } = keypair();
    const user = await linkedUser("keyholder", pubkey);
    const h = mount({ nostr: fakeSigner(secret), next: "/account/" });

    // Signer present → the section is revealed and the button armed.
    expect(h.block.getAttribute("hidden")).toBeNull();
    expect(h.btn.disabled).toBe(false);

    h.click();
    await waitFor(() => h.assigned.length > 0, "a redirect");

    expect(h.assigned[0]).toBe("/account/");
    expect(sessionRows(user.id)).toBe(1);
    // Two calls, both same-origin credentialed, verify is a POST.
    expect(h.fetchCalls.map((c) => c.url)).toEqual([
      "/api/auth/nostr/challenge",
      NOSTR_LOGIN_VERIFY_PATH,
    ]);
    for (const c of h.fetchCalls) expect(c.init.credentials).toBe("same-origin");
    expect(h.fetchCalls[1]?.init.method).toBe("POST");
    // The `next` from the page rode along in the body.
    const body = JSON.parse(h.fetchCalls[1]?.init.body as string) as { next: string };
    expect(body.next).toBe("/account/");
  });

  test("with no data-next it carries the CURRENT url — the OAuth authorize page's case", async () => {
    const { secret, pubkey } = keypair();
    await linkedUser("oauth-keyholder", pubkey);
    const h = mount({
      nostr: fakeSigner(secret),
      path: "/oauth/authorize",
      search: "?client_id=c1&state=s",
    });
    h.click();
    await waitFor(() => h.assigned.length > 0, "a redirect");
    const body = JSON.parse(h.fetchCalls[1]?.init.body as string) as { next: string };
    expect(body.next).toBe("/oauth/authorize?client_id=c1&state=s");
    // And the server honoured it, so the OAuth leg re-enters where it left off.
    expect(h.assigned[0]).toBe("/oauth/authorize?client_id=c1&state=s");
  });

  test("a 2FA-enrolled member is navigated to /login/2fa and gets NO session", async () => {
    const { secret, pubkey } = keypair();
    const user = await linkedUser("twofa-keyholder", pubkey);
    await persistEnrollment(db, user.id, generateTotpSecret("twofa-keyholder").secret);

    const h = mount({ nostr: fakeSigner(secret), next: "/admin/vaults" });
    h.click();
    await waitFor(() => h.assigned.length > 0, "the 2FA redirect");

    expect(h.assigned[0]).toBe("/login/2fa");
    expect(sessionRows(user.id)).toBe(0);
  });

  test("an unlinked key shows the unknown_pubkey sentence and re-arms the button", async () => {
    // A user exists (so the door is reachable) but this key is not linked.
    await linkedUser("somebody-else", keypair().pubkey);
    const stranger = keypair();
    const h = mount({ nostr: fakeSigner(stranger.secret), next: "/admin/vaults" });

    h.click();
    await waitFor(() => h.status.getAttribute("data-tone") === "error", "the error message");

    expect(h.status.textContent).toBe(NOSTR_LOGIN_ERROR_MESSAGES.unknown_pubkey as string);
    expect(h.status.getAttribute("data-tone")).toBe("error");
    expect(h.assigned).toEqual([]);
    // Re-armed, so the member can switch keys in their signer and retry.
    expect(h.btn.disabled).toBe(false);
  });

  test("a declined signer shows the signer sentence, not a hub code", async () => {
    await linkedUser("declines", keypair().pubkey);
    const h = mount({
      nostr: {
        signEvent: () => Promise.reject(new Error("user rejected")),
      },
      next: "/admin/vaults",
    });
    h.click();
    await waitFor(() => h.status.getAttribute("data-tone") === "error", "the signer message");
    expect(h.status.textContent).toBe(NOSTR_LOGIN_SIGNER_REFUSED);
    expect(h.status.getAttribute("data-tone")).toBe("error");
    expect(h.btn.disabled).toBe(false);
  });

  test("a 429 from the door shows the rate-limit sentence", async () => {
    const h = mount({
      nostr: fakeSigner(keypair().secret),
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "too_many_attempts", error_description: "raw" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    });
    h.click();
    await waitFor(() => h.status.getAttribute("data-tone") === "error", "the limiter message");
    expect(h.status.textContent).toBe(NOSTR_LOGIN_ERROR_MESSAGES.too_many_attempts as string);
  });

  test("no NIP-07 extension: section shown, button disabled, one-line install hint", () => {
    const h = mount({ next: "/admin/vaults" });
    // Shown immediately (JS runs, so the state is knowable) but not yet giving up.
    expect(h.block.getAttribute("hidden")).toBeNull();
    expect(h.btn.disabled).toBe(true);
    expect(h.status.textContent).toBe("");

    // The script re-checks on a backoff before it settles — extensions inject
    // window.nostr at different points in page life.
    h.drainTimers();
    expect(h.btn.disabled).toBe(true);
    expect(h.status.textContent).toBe(NOSTR_LOGIN_NO_SIGNER_HINT);
    expect(h.status.getAttribute("data-tone")).toBe("hint");
    // Clicking a disabled-state button never calls the door.
    h.click();
    expect(h.fetchCalls).toEqual([]);
  });
});

// --- GET /login/2fa — the gap hub#949 left open ---------------------------

describe("GET /login/2fa", () => {
  async function enrolled(username = "owner"): Promise<{ id: string }> {
    const u = await createUser(db, username, PASSWORD, {
      allowMulti: true,
      passwordChanged: true,
    });
    await persistEnrollment(db, u.id, generateTotpSecret(username).secret);
    return { id: u.id };
  }

  function get(path: string, cookie?: string): Request {
    return new Request(`${ORIGIN}${path}`, {
      method: "GET",
      ...(cookie ? { headers: { cookie } } : {}),
    });
  }

  test("renders the challenge with a live pending-login cookie", async () => {
    const u = await enrolled();
    const token = createPendingLogin(u.id, "/admin/tokens");
    const res = handleAdminLoginTotpGet(
      db,
      get("/login/2fa", `${PENDING_LOGIN_COOKIE_NAME}=${token}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Two-factor authentication");
    expect(html).toContain('action="/login/2fa"');
    expect(html).toContain('name="code"');
    // The pending login's own `next` is what the form carries.
    expect(html).toContain('name="next" value="/admin/tokens"');
  });

  test("does NOT consume the pending login — reload, back button, retry all work", async () => {
    const u = await enrolled();
    const token = createPendingLogin(u.id, "/admin/tokens");
    const req = (): Request => get("/login/2fa", `${PENDING_LOGIN_COOKIE_NAME}=${token}`);

    expect(handleAdminLoginTotpGet(db, req()).status).toBe(200);
    expect(handleAdminLoginTotpGet(db, req()).status).toBe(200);
    // The store still holds it — this is the SAME lookup the POST will do.
    expect(getPendingLogin(token)).not.toBeNull();
    expect(getPendingLogin(token)?.userId).toBe(u.id);
  });

  test("302s to /login with no pending-login cookie", async () => {
    await enrolled();
    const res = handleAdminLoginTotpGet(db, get("/login/2fa"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("302s to /login on a stale or forged pending token, without minting anything", async () => {
    await enrolled();
    const res = handleAdminLoginTotpGet(
      db,
      get("/login/2fa", `${PENDING_LOGIN_COOKIE_NAME}=not-a-real-token`),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    // No session anywhere on the hub.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()?.n).toBe(0);
  });

  test("carries `next` back to /login when there is nothing pending", async () => {
    await enrolled();
    const res = handleAdminLoginTotpGet(db, get("/login/2fa?next=%2Faccount%2F"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/account/")}`);
  });

  test("`next` precedence mirrors the POST: pending wins unless it is the default", async () => {
    const u = await enrolled();
    // Pending carries a real destination → URL `next` is ignored.
    const pinned = createPendingLogin(u.id, "/account/");
    const a = await handleAdminLoginTotpGet(
      db,
      get("/login/2fa?next=%2Fadmin%2Fusers", `${PENDING_LOGIN_COOKIE_NAME}=${pinned}`),
    ).text();
    expect(a).toContain('name="next" value="/account/"');

    // Pending carries the bare default → the URL's `next` is honoured.
    const bare = createPendingLogin(u.id, POST_LOGIN_DEFAULT);
    const b = await handleAdminLoginTotpGet(
      db,
      get("/login/2fa?next=%2Faccount%2F", `${PENDING_LOGIN_COOKIE_NAME}=${bare}`),
    ).text();
    expect(b).toContain('name="next" value="/account/"');
  });

  test("an open-redirect `next` is normalized through safeNext", async () => {
    await enrolled();
    const res = handleAdminLoginTotpGet(db, get("/login/2fa?next=https%3A%2F%2Fevil.example%2Fx"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("a pending login whose user lost 2FA mid-flight 302s rather than rendering a dead form", async () => {
    const u = await createUser(db, "no-2fa", PASSWORD, { allowMulti: true, passwordChanged: true });
    const token = createPendingLogin(u.id, "/admin/vaults");
    const res = handleAdminLoginTotpGet(
      db,
      get("/login/2fa", `${PENDING_LOGIN_COOKIE_NAME}=${token}`),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("issues a CSRF cookie so the rendered form can actually be submitted", async () => {
    const u = await enrolled();
    const token = createPendingLogin(u.id, "/admin/vaults");
    const res = handleAdminLoginTotpGet(
      db,
      get("/login/2fa", `${PENDING_LOGIN_COOKIE_NAME}=${token}`),
    );
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`))).toBe(true);
  });
});

// --- dispatch wiring + CSP ------------------------------------------------

describe("dispatch wiring — the GET is reachable on the real server", () => {
  function handler(): (req: Request) => Response | Promise<Response> {
    return hubFetch(configDir, {
      getDb: () => db,
      issuer: ORIGIN,
      manifestPath: join(configDir, "services.json"),
      connectionsStorePath: join(configDir, "connections.json"),
      loadExposeHubOrigin: () => undefined,
    });
  }

  test("GET /login/2fa renders through hubFetch with a live pending cookie", async () => {
    const u = await createUser(db, "wired-2fa", PASSWORD, {
      allowMulti: true,
      passwordChanged: true,
    });
    await persistEnrollment(db, u.id, generateTotpSecret("wired-2fa").secret);
    const token = createPendingLogin(u.id, "/admin/vaults");
    const res = await handler()(
      new Request(`${ORIGIN}/login/2fa`, {
        headers: { cookie: `${PENDING_LOGIN_COOKIE_NAME}=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Two-factor authentication");
  });

  test("GET /login/2fa 302s to /login through hubFetch without a pending cookie", async () => {
    await createUser(db, "wired-none", PASSWORD, { allowMulti: true, passwordChanged: true });
    const res = await handler()(new Request(`${ORIGIN}/login/2fa`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("PUT /login/2fa is still 405 — the GET is additive", async () => {
    await createUser(db, "wired-put", PASSWORD, { allowMulti: true, passwordChanged: true });
    const res = await handler()(new Request(`${ORIGIN}/login/2fa`, { method: "PUT" }));
    expect(res.status).toBe(405);
  });

  test("the login page carries NO CSP — hub#643 Tier-1 stamps proxied pages only", async () => {
    await createUser(db, "wired-login", PASSWORD, { allowMulti: true, passwordChanged: true });
    const res = await handler()(new Request(`${ORIGIN}/login`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`id="${NOSTR_LOGIN_BUTTON_ID}"`);
    // The inline script is unaffected by the Tier-1 policy because that policy
    // is stamped by `withProxySecurityHeaders` on PROXIED text/html only; this
    // page is rendered by the hub itself. (And Tier-1 sets no `script-src`.)
    expect(res.headers.get("content-security-policy")).toBeNull();
  });
});
