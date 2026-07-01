/**
 * Hub-authenticated git smart-HTTP transport — the Surface Git Transport
 * substrate (Phase 0a, design doc 2026-06-30-surface-git-transport.md).
 *
 * The hub provides ONE general primitive: an authenticated `git http-backend`
 * endpoint at `/git/<name>/*` backed by a bare repo per `<name>`. A client
 * (agent, human, or a standalone Claude Code session) authenticates with a
 * hub-issued JWT carrying `surface:<name>:write` (push) or `surface:<name>:read`
 * (fetch) and does a plain `git push` / `git clone`. Surfaces are the first
 * consumer; "hub-authenticated git" generalizes to any module that wants
 * versioned, authenticated, file-shaped content movement.
 *
 * What this layer does NOT do (by deliberate trust boundary, §7): it never
 * BUILDS or executes the pushed tree. The hub only receives + stores bytes;
 * the `post-receive` hook here is a Phase-0a placeholder that logs the refs.
 * Building pushed source is surface-host's sandboxed job (Phase 0b) — keeping
 * the RCE surface out of the substrate is the whole point of the split.
 *
 * The mechanism (grounded in git's smart-HTTP protocol):
 *   1. Discovery `GET /git/<name>/info/refs?service=git-(upload|receive)-pack`
 *      then transfer `POST /git/<name>/git-(upload|receive)-pack`.
 *      Scope keys PURELY off the service/path — no pack parsing:
 *        receive-pack ⇒ write, upload-pack ⇒ read.
 *   2. The 401 dance: an unauthenticated request gets `401` +
 *      `WWW-Authenticate` (LOAD-BEARING — git won't invoke its credential
 *      helper / retry without it). Enforced at BOTH the info/refs GET and the
 *      transfer POST.
 *   3. Bearer or Basic: git ≥2.46 sends `Authorization: Bearer <jwt>`; older
 *      git uses Basic with `x-access-token:<jwt>` (GitHub's compat trick).
 *      Both are accepted.
 *   4. The gate validates the JWT (signature → hub keys; `iss` ∈ the
 *      multi-origin hub-bound set; revocation — the existing
 *      `validateAccessToken` path) and checks the scope, then streams the
 *      request + response bodies through `git http-backend` with CGI env.
 *      Never buffers whole packs.
 */
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateAccessToken } from "./jwt-sign.ts";

/** Logger seam — defaults to `console`. */
export interface GitTransportLog {
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

export interface GitTransportDeps {
  /** Hub DB handle — for signature/kid lookup + revocation in `validateAccessToken`. */
  db: Database;
  /**
   * Directory holding the bare repos. Each surface lives at
   * `<gitRoot>/<name>.git`. Production: `<CONFIG_DIR>/hub/git`. Tests point
   * this at a tmpdir.
   */
  gitRoot: string;
  /**
   * The SET of origins this hub legitimately answers on
   * (`buildHubBoundOrigins` — loopback ∪ expose-state ∪ platform ∪ per-request
   * issuer). Passed straight to `validateAccessToken` as the `iss` allow-set so
   * a credential minted under a still-valid prior origin keeps validating
   * across an origin switch. SECURITY: must come ONLY from
   * `buildHubBoundOrigins`, never a raw request Host (the signature is verified
   * against the hub's own key first, so this is an additive `iss` relaxation
   * only — see `validateAccessToken`).
   */
  knownIssuers: () => readonly string[];
  /** Resolved peer address, surfaced to the backend as REMOTE_ADDR. */
  peerAddr?: string | null;
  /**
   * Fired AFTER a `git-receive-pack` POST subprocess exits 0 — i.e. a push
   * landed (the refs are updated + the post-receive hook has run by the time
   * `http-backend` exits). The deploy hand-off (design §5 step 5): the hub
   * notifies surface-host over HTTP + a hub JWT, NEVER a shell-out that builds
   * the pushed tree (that exec authority belongs to the module's sandbox, not
   * this substrate). Fire-and-forget + best-effort: a notify failure never
   * affects the push response the client already received. Keyed off the
   * subprocess exit, not the streamed response, so it observes the true push
   * outcome. Phase 0b wires this in hub-server.ts; tests inject a spy.
   *
   * Precision note: this fires on every SUCCESSFUL receive-pack, not strictly
   * per ref-update — a no-op re-push (no new objects) still exits 0 and
   * notifies. surface-host's re-pull→re-build→re-serve is idempotent, so the
   * worst case is a redundant rebuild of identical bytes.
   */
  onPushed?: (name: string) => void | Promise<void>;
  log?: GitTransportLog;
}

/**
 * Surface-name charset. Kebab/alnum only — NO slashes or dots, so a parsed
 * name can never escape `gitRoot` via path traversal. A trailing `.git` on the
 * URL segment is stripped before this check (so `/git/foo.git/...` and
 * `/git/foo/...` both resolve to `foo`). Bounded length keeps a hostile name
 * from ballooning a path.
 */
const SURFACE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Which authority a request needs, keyed purely off the git service/path. */
type Access = "read" | "write";

interface ParsedGitPath {
  /** Canonical surface name (trailing `.git` stripped). */
  name: string;
  /** The git subpath after the name, e.g. `info/refs` or `git-receive-pack`. */
  gitSubpath: string;
}

/**
 * Parse `/git/<name>/<gitSubpath>` (the `<name>` may carry a trailing `.git`).
 * Returns null when the path is not a well-formed, safe git route — the caller
 * 404s (we don't distinguish malformed-name from unknown-surface, to avoid
 * leaking which names exist).
 */
export function parseGitPath(pathname: string): ParsedGitPath | null {
  if (!pathname.startsWith("/git/")) return null;
  const rest = pathname.slice("/git/".length);
  const slash = rest.indexOf("/");
  // A bare `/git/<name>` with no git subpath is never a real smart-HTTP request.
  if (slash <= 0) return null;
  const rawName = rest.slice(0, slash);
  const gitSubpath = rest.slice(slash + 1);
  if (gitSubpath.length === 0) return null;
  const name = rawName.endsWith(".git") ? rawName.slice(0, -".git".length) : rawName;
  if (!SURFACE_NAME_RE.test(name)) return null;
  // Defense-in-depth: reject any traversal sequence in the remaining subpath.
  // `git http-backend` confines itself to GIT_PROJECT_ROOT, but we never want a
  // `..` to reach it. (Legitimate subpaths are `info/refs`, `git-upload-pack`,
  // `git-receive-pack`, `objects/...` — none contain `..`.)
  if (gitSubpath.split("/").some((seg) => seg === "..")) return null;
  return { name, gitSubpath };
}

/**
 * Required authority for a request: write for receive-pack (push), read for
 * upload-pack (fetch) and any other discovery/dumb path. Keys purely off the
 * service param / path — no pack inspection.
 */
export function requiredAccess(gitSubpath: string, serviceParam: string | null): Access {
  if (gitSubpath === "git-receive-pack") return "write";
  if (gitSubpath === "git-upload-pack") return "read";
  if (gitSubpath === "info/refs") {
    return serviceParam === "git-receive-pack" ? "write" : "read";
  }
  // Dumb-HTTP object/ref fetches (objects/*, HEAD, packed-refs) are read-only.
  return "read";
}

/**
 * Extract the presented JWT from either `Authorization: Bearer <jwt>` or HTTP
 * Basic. Returns null when no credential is present.
 *
 * Basic forms accepted (GitHub-compat, §6.3):
 *   - `x-access-token:<jwt>`  → token in the password (the documented form);
 *   - `<jwt>:x-oauth-basic`   → token in the username (legacy);
 *   - `<jwt>:`                → token in the username (empty password).
 */
export function extractToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) return bearer[1].trim();
  const basic = header.match(/^Basic\s+(.+)$/i);
  if (basic?.[1]) {
    let decoded: string;
    try {
      decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
    } catch {
      return null;
    }
    const idx = decoded.indexOf(":");
    const user = idx === -1 ? decoded : decoded.slice(0, idx);
    const pass = idx === -1 ? "" : decoded.slice(idx + 1);
    if (user === "x-access-token") return pass || null;
    if (pass && pass !== "x-oauth-basic") return pass;
    return user || null;
  }
  return null;
}

/**
 * 401 — missing or invalid credential. The `WWW-Authenticate` header is
 * LOAD-BEARING: without it git won't invoke its credential helper or retry.
 * We advertise BOTH `Bearer` (git ≥2.46 native + modern helpers) and `Basic`
 * (older git's helper-based retry with `x-access-token:<jwt>`), so the widest
 * range of clients re-authenticates.
 */
function unauthorized(reason: string): Response {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  headers.append("www-authenticate", "Bearer");
  headers.append("www-authenticate", 'Basic realm="Parachute Surface Git"');
  return new Response(`Unauthorized: ${reason}\n`, { status: 401, headers });
}

/**
 * 403 — a VALID credential that lacks the required scope. Deliberately NOT a
 * 401: re-prompting the same identity yields no more authority, so a 401 would
 * only spin the credential helper. The `WWW-Authenticate: ... insufficient_scope`
 * header makes the reason machine-readable (RFC 6750), mirroring
 * `adminAuthErrorResponse`.
 */
function forbidden(scope: string): Response {
  return new Response(`Forbidden: token missing required scope ${scope}\n`, {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}"`,
    },
  });
}

/**
 * Ensure `<gitRoot>/<name>.git` exists as an exportable bare repo, creating it
 * on first authenticated access (Phase 1 will add a real registry; this keeps
 * it simple now). Returns the repo dir. Only ever called AFTER the auth gate
 * passes, so unauthenticated probing can never provision a repo.
 *
 * `http.receivepack = true` is REQUIRED for push: `git http-backend` enables
 * upload-pack from `GIT_HTTP_EXPORT_ALL` alone but refuses receive-pack unless
 * the repo opts in explicitly.
 */
function ensureBareRepo(gitRoot: string, name: string, log: GitTransportLog): string {
  const repoDir = join(gitRoot, `${name}.git`);
  if (existsSync(repoDir)) return repoDir;
  mkdirSync(gitRoot, { recursive: true });
  const init = spawnSync("git", ["init", "--bare", repoDir], { encoding: "utf8" });
  if (init.status !== 0) {
    throw new Error(`git init --bare failed: ${init.stderr || init.error?.message || "unknown"}`);
  }
  const cfg = spawnSync("git", ["-C", repoDir, "config", "http.receivepack", "true"], {
    encoding: "utf8",
  });
  if (cfg.status !== 0) {
    throw new Error(`git config http.receivepack failed: ${cfg.stderr || "unknown"}`);
  }
  writePostReceiveHook(repoDir, name);
  log.info(`[git-transport] provisioned bare repo for surface "${name}" at ${repoDir}`);
  return repoDir;
}

/**
 * Phase-0a placeholder hook: log the received refs (to stdout, relayed to the
 * pusher as `remote:` lines, and appended to `post-receive.log` in the repo
 * dir for verification). Phase 0b replaces the body with an HTTP + hub-JWT
 * notify to surface-host (NEVER a shell-out that builds the pushed tree — §5/§7).
 */
function writePostReceiveHook(repoDir: string, name: string): void {
  const hook = `#!/bin/sh
# Parachute Surface Git Transport — Phase 0a placeholder.
# Logs received refs only. Phase 0b: notify surface-host over HTTP + a hub JWT
# (never build the pushed tree in this process — that exec authority belongs to
# the module's sandbox, not the substrate).
while read -r oldrev newrev refname; do
  printf '[parachute] surface %s received %s (%s..%s)\\n' "${name}" "$refname" "$oldrev" "$newrev"
  printf '%s %s %s\\n' "$oldrev" "$newrev" "$refname" >> post-receive.log
done
`;
  const hookPath = join(repoDir, "hooks", "post-receive");
  writeFileSync(hookPath, hook, { mode: 0o755 });
}

/**
 * The byte offset + separator length where CGI headers end (first blank line).
 * Handles both `\r\n\r\n` (4) and `\n\n` (2). Returns null if no boundary yet.
 * Exported for unit testing.
 */
export function findHeaderEnd(buf: Uint8Array): { idx: number; sepLen: number } | null {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return { idx: i, sepLen: 2 };
    if (
      i + 3 < buf.length &&
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return { idx: i, sepLen: 4 };
    }
  }
  return null;
}

/**
 * Parse CGI response headers (the block before the first blank line) into an
 * HTTP status + Headers. `Status: NNN reason` maps to the HTTP status (default
 * 200 when absent); every other `Key: Value` line is forwarded verbatim.
 * Exported for unit testing.
 */
export function parseCgiHeaders(headerBlock: string): { status: number; headers: Headers } {
  const headers = new Headers();
  let status = 200;
  for (const rawLine of headerBlock.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.toLowerCase() === "status") {
      const code = Number.parseInt(value.split(/\s+/)[0] ?? "", 10);
      if (Number.isFinite(code) && code >= 100 && code < 600) status = code;
      continue;
    }
    headers.append(key, value);
  }
  return { status, headers };
}

const MAX_CGI_HEADER_BYTES = 64 * 1024;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Read the CGI header block off `stdout`, then return a Response whose body
 * STREAMS the remainder (leftover bytes already read + the rest of the stream).
 * Never buffers the whole pack — only the small header block is accumulated.
 */
async function cgiResponse(stdout: ReadableStream<Uint8Array>): Promise<Response> {
  const reader = stdout.getReader();
  let buf: Uint8Array = new Uint8Array(0);
  let boundary: { idx: number; sepLen: number } | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (value && value.length > 0) {
      buf = concatBytes(buf, value);
      boundary = findHeaderEnd(buf);
      if (boundary) break;
      if (buf.length > MAX_CGI_HEADER_BYTES) {
        reader.cancel().catch(() => {});
        return new Response("bad gateway: git http-backend emitted no CGI header block\n", {
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    if (done) break;
  }

  const headerEnd = boundary ? boundary.idx : buf.length;
  const sepLen = boundary ? boundary.sepLen : 0;
  const headerBlock = new TextDecoder().decode(buf.slice(0, headerEnd));
  const leftover = buf.slice(headerEnd + sepLen);
  const { status, headers } = parseCgiHeaders(headerBlock);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (leftover.length > 0) controller.enqueue(leftover);
      if (boundary === null) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value && value.length > 0) controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, { status, headers });
}

/**
 * Handle a `/git/<name>/*` request: parse → auth-gate → ensure bare repo →
 * stream-proxy to `git http-backend`. Always returns a Response (the caller
 * gates on the `/git/` prefix). A null `parseGitPath` 404s.
 */
export async function handleGitTransport(req: Request, deps: GitTransportDeps): Promise<Response> {
  const log = deps.log ?? console;
  const url = new URL(req.url);
  const parsed = parseGitPath(url.pathname);
  if (!parsed) return new Response("not found", { status: 404 });
  const { name, gitSubpath } = parsed;

  const serviceParam = url.searchParams.get("service");
  const access = requiredAccess(gitSubpath, serviceParam);

  // --- Auth gate (BEFORE touching the filesystem or spawning anything) ------
  const token = extractToken(req);
  if (!token) return unauthorized("a hub access token is required");

  let sub: string;
  let scopes: string[];
  try {
    const validated = await validateAccessToken(deps.db, token, deps.knownIssuers());
    const subClaim = validated.payload.sub;
    if (typeof subClaim !== "string" || subClaim.length === 0) {
      return unauthorized("token missing required `sub` claim");
    }
    sub = subClaim;
    const scopeClaim = (validated.payload as { scope?: unknown }).scope;
    scopes = typeof scopeClaim === "string" ? scopeClaim.split(/\s+/).filter(Boolean) : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return unauthorized(`invalid token: ${msg}`);
  }

  // Authority check. Write requires `surface:<name>:write`. Read is satisfied
  // by either `surface:<name>:read` OR `surface:<name>:write` (write ⊇ read —
  // a writer can always fetch, matching GitHub's model).
  const writeScope = `surface:${name}:write`;
  const readScope = `surface:${name}:read`;
  const ok =
    access === "write"
      ? scopes.includes(writeScope)
      : scopes.includes(readScope) || scopes.includes(writeScope);
  if (!ok) return forbidden(access === "write" ? writeScope : readScope);

  // --- Provision (first access) + proxy -------------------------------------
  try {
    ensureBareRepo(deps.gitRoot, name, log);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[git-transport] repo provisioning failed for "${name}": ${msg}`);
    return new Response("internal error: could not provision surface repo\n", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Minimal CGI env — we deliberately do NOT inherit the hub's full process
  // env (no hub secrets reach the subprocess). REMOTE_USER is the validated
  // token subject only. GIT_PROTOCOL passes the client's protocol negotiation
  // (v2) through; QUERY_STRING/CONTENT_TYPE/REQUEST_METHOD are standard CGI.
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_PROJECT_ROOT: deps.gitRoot,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${name}.git/${gitSubpath}`,
    REQUEST_METHOD: req.method,
    QUERY_STRING: query,
    CONTENT_TYPE: req.headers.get("content-type") ?? "",
    REMOTE_USER: sub,
    REMOTE_ADDR: deps.peerAddr ?? "",
    GIT_PROTOCOL: req.headers.get("git-protocol") ?? "",
  };
  // Set CONTENT_LENGTH only for non-chunked bodies. Large pushes use chunked
  // transfer (no Content-Length): the smart-service POST path reads the
  // self-delimiting pkt-line/pack stream off stdin to its natural end, so we
  // simply pipe the request body and let stdin EOF terminate it — never
  // buffering the pack to compute a length.
  const contentLength = req.headers.get("content-length");
  if (contentLength) env.CONTENT_LENGTH = contentLength;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", "http-backend"], {
      env,
      // Stream the request body straight to the backend's stdin (Bun pumps it
      // concurrently with our stdout read — no deadlock, no buffering). GET
      // discovery has no body.
      stdin: req.body ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[git-transport] failed to spawn git http-backend: ${msg}`);
    return new Response("internal error: git http-backend unavailable\n", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Drain stderr in the background — surfaces hook output + backend errors in
  // the hub log without blocking the response stream.
  void (async () => {
    try {
      const text = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
      if (text.trim().length > 0) log.info(`[git-transport] ${name}: ${text.trim()}`);
    } catch {
      // stderr drain is best-effort.
    }
  })();

  // Deploy hand-off (§5 step 5). On a SUCCESSFUL push (receive-pack POST exits
  // 0 → refs updated, post-receive ran), notify the surface module so it pulls
  // + builds + serves. Fire-and-forget, observed off the subprocess exit (not
  // the streamed response), and fully decoupled from the client's response:
  // a notify error is logged, never surfaced to the pusher. The hub NEVER
  // builds here — `onPushed` only sends an authenticated HTTP notify.
  if (access === "write" && gitSubpath === "git-receive-pack" && deps.onPushed) {
    const onPushed = deps.onPushed;
    void (async () => {
      let code: number;
      try {
        code = await proc.exited;
      } catch {
        return; // subprocess vanished — nothing to notify about
      }
      if (code !== 0) return;
      try {
        await onPushed(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[git-transport] post-push notify failed for "${name}": ${msg}`);
      }
    })();
  }

  return cgiResponse(proc.stdout as ReadableStream<Uint8Array>);
}
