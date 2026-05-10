/**
 * HTTP handlers for the hub admin surface — login (`/login`) and the
 * config portal (`/admin/config`, `/admin/config/<name>`). Sessions ride the
 * same `parachute_hub_session` cookie that the OAuth login mints, since PR
 * #112 widened the cookie path from `/oauth/` to `/`.
 *
 * `/login` (was `/admin/login` pre-#231-followup) is the canonical entry
 * for ALL parachute auth — admin operators, OAuth user flows, etc. The
 * `/admin/login` and `/admin/logout` paths 301-redirect for back-compat.
 *
 * Every state-changing POST is double-submit-CSRF protected
 * (`parachute_hub_csrf` cookie + `__csrf` form field, constant-time compare),
 * and every authenticated GET issues a 302 to `/login?next=<path>` when
 * no session is found rather than rendering an inline login form — keeps
 * each route's intent clean and lets the operator bookmark `/admin/config`
 * without thinking about state.
 */
import type { Database } from "bun:sqlite";
import {
  type AdminConfigModuleView,
  type ModuleStatus,
  renderAdminConfigPage,
  renderAdminError,
  renderAdminLogin,
} from "./admin-config-ui.ts";
import {
  type ConfigurableModule,
  configPathFor,
  discoverConfigurableModules,
  readModuleConfig,
  validateAndCoerce,
  writeModuleConfig,
} from "./admin-config.ts";
import { restart as lifecycleRestart } from "./commands/lifecycle.ts";
import { CONFIG_DIR } from "./config.ts";
import { CSRF_FIELD_NAME, ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import type { ModuleManifest } from "./module-manifest.ts";
import { checkAndRecord, clientIpFromRequest } from "./rate-limit.ts";
import {
  type ServicesManifest,
  readManifest as readServicesManifest,
} from "./services-manifest.ts";
import {
  SESSION_TTL_MS,
  buildSessionClearCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  findActiveSession,
  parseSessionCookie,
} from "./sessions.ts";
import { getUserByUsername, verifyPassword } from "./users.ts";

export interface AdminDeps {
  /** Resolves the installed-services manifest (production: `services-manifest.readManifest`). */
  loadServicesManifest?: () => ServicesManifest;
  /** Per-module `.parachute/module.json` reader (production: `module-manifest.readModuleManifest`). */
  readManifest?: (installDir: string) => Promise<ModuleManifest | null>;
  /** `~/.parachute` (defaults to `CONFIG_DIR`). Module configs land at `<configDir>/<name>/config.json`. */
  configDir?: string;
  /** Test seam — defaults to `commands/lifecycle.restart`. */
  restartService?: (name: string) => Promise<number>;
  /** Test seam — defaults to logging to stderr. */
  log?: (line: string) => void;
  /** Test seam — defaults to real clock. */
  now?: () => Date;
}

function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extra },
  });
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...extra } });
}

// --- session gate ----------------------------------------------------------

function loginRedirect(req: Request, extra: Record<string, string> = {}): Response {
  const url = new URL(req.url);
  const next = `${url.pathname}${url.search}`;
  return redirect(`/login?next=${encodeURIComponent(next)}`, extra);
}

function safeNext(raw: string | null): string {
  if (!raw) return "/admin/config";
  // Only allow same-origin paths — never honor an absolute URL or scheme.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/admin/config";
  return raw;
}

// --- /login ---------------------------------------------------------------
//
// Renamed from `/admin/login` so the surface name reflects what it is — the
// canonical entry for ALL parachute auth (operators, OAuth user flows,
// etc.), not an admin-only door. `/admin/login` and `/admin/logout` 301
// to here from `hub-server.ts` for back-compat.

export function handleAdminLoginGet(_db: Database, req: Request): Response {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  return htmlResponse(renderAdminLogin({ next, csrfToken: csrf.token }), 200, extra);
}

export async function handleAdminLoginPost(
  db: Database,
  req: Request,
  deps: AdminLoginDeps = {},
): Promise<Response> {
  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    return htmlResponse(
      renderAdminError({
        title: "Invalid form submission",
        message: "The form's CSRF token did not match. Reload the page and try again.",
      }),
      400,
    );
  }
  // Rate-limit gate fires *after* CSRF (so a junk cross-site POST doesn't
  // burn a bucket slot for the victim's IP) but *before* credential check.
  // Every legitimate login attempt — wrong password, missing user, eventually
  // failed-2FA (#186) — counts toward the same bucket so an attacker can't
  // partition the cooldown across stages.
  const clientIp = clientIpFromRequest(req);
  const now = deps.now ? deps.now() : new Date();
  const gate = checkAndRecord(clientIp, now);
  if (!gate.allowed) {
    return htmlResponse(
      renderAdminError({
        title: "Too many login attempts",
        message: `Too many login attempts from this IP. Try again in ${gate.retryAfterSeconds ?? 1} seconds.`,
      }),
      429,
      { "retry-after": String(gate.retryAfterSeconds ?? 1) },
    );
  }
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));
  const csrfToken = typeof formCsrf === "string" ? formCsrf : "";
  if (!username || !password) {
    return htmlResponse(
      renderAdminLogin({ next, csrfToken, errorMessage: "Username and password are required." }),
      400,
    );
  }
  const user = getUserByUsername(db, username);
  if (!user) {
    return htmlResponse(
      renderAdminLogin({ next, csrfToken, errorMessage: "Invalid credentials." }),
      401,
    );
  }
  const ok = await verifyPassword(user, password);
  if (!ok) {
    return htmlResponse(
      renderAdminLogin({ next, csrfToken, errorMessage: "Invalid credentials." }),
      401,
    );
  }
  const session = createSession(db, { userId: user.id });
  const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
  return redirect(next, { "set-cookie": cookie });
}

/**
 * Test-injection seam for `handleAdminLoginPost`. Production callers omit
 * `deps`; tests pass a deterministic clock so the rate-limit assertions
 * don't race wall-clock time. Kept narrow — login doesn't share the wider
 * `AdminDeps` because it doesn't load services / module manifests.
 */
export interface AdminLoginDeps {
  /** Test seam — defaults to real clock. */
  now?: () => Date;
}

// --- /logout --------------------------------------------------------------

/**
 * POST-only — logout is state-changing, so it rides the same double-submit
 * CSRF discipline as login + config posts. Without CSRF, a malicious
 * cross-origin form could log the operator out (annoyance, not catastrophe,
 * but the safety belt is already on the bus).
 *
 * Always idempotent: clearing the cookie succeeds even if there's no
 * matching session row. Returns 302 → /login so the operator lands back
 * on the form ready to re-authenticate.
 */
export async function handleAdminLogoutPost(db: Database, req: Request): Promise<Response> {
  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    return htmlResponse(
      renderAdminError({
        title: "Invalid form submission",
        message: "The form's CSRF token did not match. Reload the page and try again.",
      }),
      400,
    );
  }
  const sid = parseSessionCookie(req.headers.get("cookie"));
  if (sid) deleteSession(db, sid);
  return redirect("/login", { "set-cookie": buildSessionClearCookie() });
}

// --- /admin/config ---------------------------------------------------------

export async function handleAdminConfigGet(
  db: Database,
  req: Request,
  deps: AdminDeps = {},
): Promise<Response> {
  const session = findActiveSession(db, req);
  if (!session) return loginRedirect(req);

  const csrf = ensureCsrfToken(req);
  const setCookieExtra: Record<string, string> = csrf.setCookie
    ? { "set-cookie": csrf.setCookie }
    : {};

  const modules = await loadModuleViews(deps);
  const flash = parseFlash(req);
  if (flash) applyFlashTo(modules, flash);
  return htmlResponse(
    renderAdminConfigPage({ modules, csrfToken: csrf.token }),
    200,
    setCookieExtra,
  );
}

export async function handleAdminConfigPost(
  db: Database,
  req: Request,
  moduleName: string,
  deps: AdminDeps = {},
): Promise<Response> {
  const session = findActiveSession(db, req);
  if (!session) return loginRedirect(req);

  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    return htmlResponse(
      renderAdminError({
        title: "Invalid form submission",
        message: "The form's CSRF token did not match. Reload the page and try again.",
      }),
      400,
    );
  }

  const modules = await discoverConfigurableModules(discoverDeps(deps));
  const target = modules.find((m) => m.name === moduleName);
  if (!target) {
    return htmlResponse(
      renderAdminError({
        title: "Unknown module",
        message: `No installed module named "${moduleName}" declares a config schema on this hub.`,
      }),
      404,
    );
  }

  const csrfToken = typeof formCsrf === "string" ? formCsrf : "";
  const submitted = collectFormValues(form, target);
  const result = validateAndCoerce(submitted, target.schema);
  if (!result.ok) {
    return rerenderWithStatus(deps, target, csrfToken, {
      fieldErrors: result.errors,
      pending: submitted,
      errorMessage: "Some fields need attention before this config can be saved.",
    });
  }

  try {
    writeModuleConfig(target.configPath, result.data ?? {});
  } catch (err) {
    return rerenderWithStatus(deps, target, csrfToken, {
      pending: submitted,
      errorMessage: `Failed to write ${target.configPath}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const restartFn = deps.restartService ?? defaultRestart(deps);
  let restartCode = 0;
  try {
    restartCode = await restartFn(target.name);
  } catch (err) {
    return successRedirect(target.name, "saved-restart-failed", err);
  }
  if (restartCode !== 0) return successRedirect(target.name, "saved-restart-failed");
  return successRedirect(target.name, "saved");
}

function defaultRestart(deps: AdminDeps): (name: string) => Promise<number> {
  return (name) =>
    lifecycleRestart(name, {
      configDir: deps.configDir ?? CONFIG_DIR,
      log: deps.log,
    });
}

function discoverDeps(deps: AdminDeps) {
  const out: Parameters<typeof discoverConfigurableModules>[0] = {
    loadServicesManifest: deps.loadServicesManifest ?? readServicesManifest,
    configDir: deps.configDir ?? CONFIG_DIR,
  };
  if (deps.readManifest) out.readManifest = deps.readManifest;
  return out;
}

async function loadModuleViews(deps: AdminDeps): Promise<AdminConfigModuleView[]> {
  const modules = await discoverConfigurableModules(discoverDeps(deps));
  return modules.map((module) => {
    const { data, parseError } = readModuleConfig(module.configPath);
    const view: AdminConfigModuleView = { module, current: data };
    if (parseError) view.parseError = parseError;
    return view;
  });
}

function collectFormValues(
  form: Awaited<ReturnType<Request["formData"]>>,
  module: ConfigurableModule,
): Record<string, string | boolean | undefined> {
  const out: Record<string, string | boolean | undefined> = {};
  for (const [key, prop] of Object.entries(module.schema.properties)) {
    if (prop.type === "boolean") {
      // Unchecked checkboxes don't appear in form data — absence = false.
      out[key] = form.has(key);
      continue;
    }
    const v = form.get(key);
    out[key] = typeof v === "string" ? v : undefined;
  }
  return out;
}

// --- flash + redirect helpers ---------------------------------------------

const FLASH_PARAM = "_status";
const FLASH_MODULE_PARAM = "_module";

function successRedirect(moduleName: string, status: string, err?: unknown): Response {
  const target = new URL("/admin/config", "http://placeholder");
  target.searchParams.set(FLASH_PARAM, status);
  target.searchParams.set(FLASH_MODULE_PARAM, moduleName);
  if (err) target.searchParams.set("_err", err instanceof Error ? err.message : String(err));
  target.hash = `module-${moduleName}`;
  return redirect(`${target.pathname}${target.search}${target.hash}`);
}

function parseFlash(req: Request): { module: string; status: string; errMessage?: string } | null {
  const url = new URL(req.url);
  const status = url.searchParams.get(FLASH_PARAM);
  const mod = url.searchParams.get(FLASH_MODULE_PARAM);
  if (!status || !mod) return null;
  const errMessage = url.searchParams.get("_err") ?? undefined;
  const out: { module: string; status: string; errMessage?: string } = { module: mod, status };
  if (errMessage) out.errMessage = errMessage;
  return out;
}

function applyFlashTo(
  views: AdminConfigModuleView[],
  flash: { module: string; status: string; errMessage?: string },
): void {
  const view = views.find((v) => v.module.name === flash.module);
  if (!view) return;
  if (flash.status === "saved") {
    view.status = { successMessage: `Saved and restarted ${view.module.displayName}.` };
    return;
  }
  if (flash.status === "saved-restart-failed") {
    const tail = flash.errMessage ? ` (${flash.errMessage})` : "";
    view.status = {
      errorMessage: `Saved ${view.module.displayName} config but the restart did not succeed${tail}. Run \`parachute restart ${view.module.name}\` and check logs.`,
    };
  }
}

async function rerenderWithStatus(
  deps: AdminDeps,
  target: ConfigurableModule,
  csrfToken: string,
  status: ModuleStatus,
): Promise<Response> {
  const views = await loadModuleViews(deps);
  const view = views.find((v) => v.module.name === target.name);
  if (view) view.status = status;
  return htmlResponse(renderAdminConfigPage({ modules: views, csrfToken }), 422);
}
