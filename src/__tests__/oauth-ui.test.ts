import { describe, expect, test } from "bun:test";
import {
  type AuthorizeFormParams,
  escapeHtml,
  renderApprovePending,
  renderConsent,
  renderError,
  renderHiddenInputs,
  renderLogin,
  renderUnknownClient,
  substituteVaultDisplay,
} from "../oauth-ui.ts";

const PARAMS: AuthorizeFormParams = {
  clientId: "client-abc",
  redirectUri: "https://app.example/cb",
  responseType: "code",
  scope: "vault:read vault:admin",
  codeChallenge: "ch",
  codeChallengeMethod: "S256",
  state: "xyz",
};

const CSRF = "csrf-token-fixture";

describe("escapeHtml", () => {
  test("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<script>alert("x&y'z")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&amp;y&#39;z&quot;)&lt;/script&gt;",
    );
  });
});

describe("renderHiddenInputs", () => {
  test("emits one hidden input per non-state field, plus state when present", () => {
    const html = renderHiddenInputs(PARAMS);
    expect(html).toContain('name="client_id" value="client-abc"');
    expect(html).toContain('name="redirect_uri" value="https://app.example/cb"');
    expect(html).toContain('name="response_type" value="code"');
    expect(html).toContain('name="scope" value="vault:read vault:admin"');
    expect(html).toContain('name="code_challenge" value="ch"');
    expect(html).toContain('name="code_challenge_method" value="S256"');
    expect(html).toContain('name="state" value="xyz"');
  });

  test("omits state input when state is null", () => {
    const html = renderHiddenInputs({ ...PARAMS, state: null });
    expect(html).not.toContain('name="state"');
  });

  test("escapes hostile values into hidden inputs", () => {
    const html = renderHiddenInputs({ ...PARAMS, state: `"><script>alert(1)</script>` });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderLogin", () => {
  test("contains form, hidden inputs, and a Sign in submit", () => {
    const html = renderLogin({ params: PARAMS, csrfToken: CSRF });
    expect(html).toContain('action="/oauth/authorize"');
    expect(html).toContain('name="__action" value="login"');
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).toContain("Sign in");
    // Hidden state echoed
    expect(html).toContain('name="state" value="xyz"');
    // Brand styling present
    expect(html).toContain("Parachute");
  });

  test("renders an error banner when errorMessage is set", () => {
    const html = renderLogin({ params: PARAMS, csrfToken: CSRF, errorMessage: "bad pw" });
    expect(html).toContain("error-banner");
    expect(html).toContain("bad pw");
  });

  test("escapes the error message", () => {
    const html = renderLogin({
      params: PARAMS,
      csrfToken: CSRF,
      errorMessage: "<script>x</script>",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderConsent", () => {
  test("shows client name, client_id, and a row per scope", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "client-abc",
      clientName: "MyApp",
      scopes: ["vault:read", "vault:admin"],
    });
    expect(html).toContain("Authorize");
    expect(html).toContain("MyApp");
    expect(html).toContain("client-abc");
    expect(html).toContain("vault:read");
    expect(html).toContain("vault:admin");
    // Scope explanations from the registry
    expect(html).toContain("Read your notes");
    expect(html).toContain("Full vault access");
  });

  test("highlights admin scopes with a danger color and badge", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:admin"],
    });
    expect(html).toContain("scope-admin");
    expect(html).toContain("badge-admin");
  });

  test("renders unknown scopes verbatim with a muted explanation", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["mystery.module:do-thing"],
    });
    expect(html).toContain("scope-unknown");
    expect(html).toContain("mystery.module:do-thing");
    expect(html).toContain("no built-in description");
  });

  test("renders a placeholder when no scopes are requested", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: [],
    });
    expect(html).toContain("scope-empty");
    expect(html).toContain("No scopes requested");
  });

  test("includes Approve and Deny buttons posting __action=consent", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: [],
    });
    expect(html).toContain('name="__action" value="consent"');
    expect(html).toContain('name="approve" value="yes"');
    expect(html).toContain('name="approve" value="no"');
  });

  test("escapes a hostile client name", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "<img src=x onerror=alert(1)>",
      scopes: [],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("renders a vault picker when vaultPicker is set", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read"],
      vaultPicker: { unnamedVerbs: ["read"], availableVaults: ["work", "personal"] },
    });
    expect(html).toContain("Pick a vault");
    expect(html).toContain('name="vault_pick" value="work"');
    expect(html).toContain('name="vault_pick" value="personal"');
    // First option pre-checked so a single-vault host doesn't force a click.
    expect(html).toMatch(/name="vault_pick" value="work" checked/);
  });

  test("escapes a hostile vault name in the picker", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read"],
      vaultPicker: {
        unnamedVerbs: ["read"],
        availableVaults: [`evil"><script>alert(1)</script>`],
      },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("disables the Approve button when no vaults exist", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read"],
      vaultPicker: { unnamedVerbs: ["read"], availableVaults: [] },
    });
    expect(html).toContain("no vaults exist");
    expect(html).toContain('value="yes" class="btn btn-primary" disabled');
  });
});

describe("renderError", () => {
  test("renders a card with title and message", () => {
    const html = renderError({ title: "Boom", message: "something blew up", status: 400 });
    expect(html).toContain("Boom");
    expect(html).toContain("something blew up");
    expect(html).toContain('class="card"');
    // Brand mark visible so the user knows where they are
    expect(html).toContain("Parachute");
  });

  test("escapes hostile title + message", () => {
    const html = renderError({
      title: "<script>1</script>",
      message: '"><img>',
      status: 400,
    });
    expect(html).not.toContain("<script>1</script>");
    expect(html).not.toContain('"><img>');
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderUnknownClient", () => {
  test("escapes the client_id into the page", () => {
    const html = renderUnknownClient({
      clientId: "<img src=x>",
      selfOriginRedirectPath: null,
    });
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img src=x>");
  });

  test("renders the recovery button when selfOriginRedirectPath is set", () => {
    const html = renderUnknownClient({
      clientId: "stale-id",
      selfOriginRedirectPath: "/notes/oauth/callback",
    });
    expect(html).toContain('id="unknown-client-reset"');
    expect(html).toContain('data-target="/notes/oauth/callback"');
    // The inline JS clears the Notes-side DCR cache prefix.
    expect(html).toContain("'lens:dcr:'");
  });

  test("escapes selfOriginRedirectPath into the data-target attribute", () => {
    const html = renderUnknownClient({
      clientId: "id",
      selfOriginRedirectPath: '/x"><script>alert(1)</script>',
    });
    expect(html).not.toContain("><script>alert(1)</script>");
    expect(html).toContain("&quot;");
  });

  test("omits the recovery button when selfOriginRedirectPath is null", () => {
    const html = renderUnknownClient({
      clientId: "stale-id",
      selfOriginRedirectPath: null,
    });
    expect(html).not.toContain('id="unknown-client-reset"');
    expect(html).not.toContain("'lens:dcr:'");
    // Static fallback help text still surfaces.
    expect(html).toContain("close this window");
  });
});

describe("substituteVaultDisplay", () => {
  test("undefined → leaves the scope untouched", () => {
    expect(substituteVaultDisplay("vault:read", undefined)).toBe("vault:read");
  });

  test("named vault → substitutes vault:<name>:<verb>", () => {
    expect(substituteVaultDisplay("vault:read", "work")).toBe("vault:work:read");
    expect(substituteVaultDisplay("vault:write", "default")).toBe("vault:default:write");
  });

  test("null → renders a <TBD> placeholder for the consent picker", () => {
    expect(substituteVaultDisplay("vault:read", null)).toBe("vault:<TBD>:read");
  });

  test("non-vault scope passes through regardless of displayVault", () => {
    expect(substituteVaultDisplay("scribe:transcribe", "work")).toBe("scribe:transcribe");
    expect(substituteVaultDisplay("channel:send", null)).toBe("channel:send");
  });

  test("already-named vault scope passes through (caller specified the vault)", () => {
    expect(substituteVaultDisplay("vault:other:read", "work")).toBe("vault:other:read");
  });

  test("vault admin (vault:admin) doesn't get narrowed — admin verb stays unnamed", () => {
    // vault:admin is a full-vault scope; we don't narrow it the same way
    // because per-vault admin is `vault:<name>:admin` (non-requestable) and
    // the unnamed vault:admin form is the legacy full-vault grant. Keep the
    // displayed shape as-is so the operator sees the scope they're
    // consenting to literally.
    expect(substituteVaultDisplay("vault:admin", "work")).toBe("vault:admin");
  });
});

describe("renderConsent displayVault substitution", () => {
  test("non-admin user (lockedVault) → consent shows vault:<assigned>:<verb>", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read", "vault:write"],
      vaultPicker: {
        unnamedVerbs: ["read", "write"],
        availableVaults: ["my-vault"],
        lockedVault: "my-vault",
      },
      displayVault: "my-vault",
    });
    expect(html).toContain("vault:my-vault:read");
    expect(html).toContain("vault:my-vault:write");
    // Raw unnamed form (the thing this PR fixes) must NOT appear in the
    // rendered scope-row code blocks. Scope name shows up inside
    // `<code class="scope-name">…</code>` so check the row substring.
    expect(html).not.toMatch(/<code class="scope-name">vault:read<\/code>/);
    expect(html).not.toMatch(/<code class="scope-name">vault:write<\/code>/);
  });

  test("admin user, single-vault hub → picker pre-checks the only vault, consent shows it", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read"],
      vaultPicker: { unnamedVerbs: ["read"], availableVaults: ["default"] },
      displayVault: "default",
    });
    expect(html).toContain("vault:default:read");
    expect(html).not.toMatch(/<code class="scope-name">vault:read<\/code>/);
  });

  test("admin user, multi-vault hub → displayVault=null renders <TBD> + picker hint", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read"],
      vaultPicker: { unnamedVerbs: ["read"], availableVaults: ["work", "personal"] },
      displayVault: null,
    });
    expect(html).toContain("vault:&lt;TBD&gt;:read");
    expect(html).toContain("scope-pending-note");
    expect(html).toContain("A specific vault is picked below");
    // explainScope label still resolves via the verb-form lookup.
    expect(html).toContain("Read your notes");
  });

  test("displayVault undefined preserves the legacy raw form (no substitution)", () => {
    // The existing oauth-ui.test.ts cases call renderConsent without
    // displayVault — confirming the back-compat shape stays.
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read"],
    });
    expect(html).toContain("vault:read");
  });
});

describe("renderApprovePending unauthenticated CTAs", () => {
  const COMMON = {
    clientName: "MyApp",
    clientId: "client-xyz",
    redirectUris: ["https://app.example/cb"],
    requestedScopes: ["vault:read"],
    hubOrigin: "https://hub.example.com",
  };

  test("renders Sign in CTA wired to /login?next=/admin/approve-client/<id>", () => {
    const html = renderApprovePending(COMMON);
    expect(html).toContain("Sign in as admin to approve");
    const expectedHref = `/login?next=${encodeURIComponent("/admin/approve-client/client-xyz")}`;
    expect(html).toContain(`href="${expectedHref}"`);
  });

  test("renders fully-qualified shareable deep link + Copy button + clipboard JS", () => {
    const html = renderApprovePending(COMMON);
    expect(html).toContain("https://hub.example.com/admin/approve-client/client-xyz");
    expect(html).toContain('id="approve-share-copy"');
    expect(html).toContain('data-link="https://hub.example.com/admin/approve-client/client-xyz"');
    // Inline JS uses navigator.clipboard.writeText with visual feedback.
    expect(html).toContain("navigator.clipboard");
    expect(html).toContain("writeText");
    expect(html).toContain("Copied!");
  });

  test("trims a trailing slash on hubOrigin so the deep link doesn't double-slash", () => {
    const html = renderApprovePending({ ...COMMON, hubOrigin: "https://hub.example.com/" });
    expect(html).toContain("https://hub.example.com/admin/approve-client/client-xyz");
    expect(html).not.toContain("https://hub.example.com//admin/");
  });

  test("retired CLI hint does NOT appear in the unauthenticated branch", () => {
    const html = renderApprovePending(COMMON);
    expect(html).not.toContain("parachute auth approve-client");
    expect(html).not.toContain("from a terminal");
  });

  test("escapes hostile client_id into href, data-link, and the visible deep link", () => {
    const html = renderApprovePending({
      ...COMMON,
      clientId: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<img src=x");
    // encodeURIComponent in both the href and the deep-link URL produces
    // %3Cimg…; that lives inside escapeHtml-wrapped attribute values.
    expect(html).toContain("%3Cimg");
  });

  test("admin-authenticated branch hides the unauth CTAs and renders the inline approve form", () => {
    const html = renderApprovePending({
      ...COMMON,
      approveForm: { csrfToken: CSRF, returnTo: "/oauth/authorize?client_id=client-xyz" },
    });
    expect(html).toContain('action="/oauth/authorize/approve"');
    expect(html).toContain("Approve and continue");
    expect(html).not.toContain("Sign in as admin to approve");
    expect(html).not.toContain("Or send this link to your hub admin");
    expect(html).not.toContain("parachute auth approve-client");
  });
});

describe("CSS / styling guarantees", () => {
  test("does not load fonts from a third-party CDN (privacy)", () => {
    const html = renderLogin({ params: PARAMS, csrfToken: CSRF });
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
  });

  test("sets referrer policy to no-referrer", () => {
    expect(renderLogin({ params: PARAMS, csrfToken: CSRF })).toContain(
      'name="referrer" content="no-referrer"',
    );
  });

  test("declares mobile-friendly viewport", () => {
    expect(renderLogin({ params: PARAMS, csrfToken: CSRF })).toContain(
      'name="viewport" content="width=device-width, initial-scale=1"',
    );
  });
});
