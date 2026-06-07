#!/usr/bin/env bun
/**
 * Cloudflare DNS-record teardown — used by the Stage 4 expose teardown to
 * delete the per-run CNAME that `cloudflared tunnel route dns` created.
 *
 * Why this exists: `cloudflared` can CREATE a proxied CNAME (`tunnel route
 * dns`) but has NO "unroute" / delete-record command, and `parachute expose
 * … off --cloudflare` deliberately LEAVES the account-side tunnel + its DNS
 * record defined in Cloudflare (it only stops the local connector). For a
 * SHARED test zone that's a leak: every run would accumulate an orphaned
 * `e2e-<id>` CNAME. So the harness deletes the record itself via the CF API.
 *
 * Where the credential comes from (self-contained — NO second secret):
 * the `cloudflared` origin cert (`~/.cloudflared/cert.pem`) that authorizes
 * `tunnel route dns` embeds an `ARGO TUNNEL TOKEN` PEM block — base64 JSON
 * `{ zoneID, accountID, apiToken }`. On a modern cert (`cloudflared tunnel
 * login`, 2023+) `apiToken` is a standard Cloudflare **API token** (`cfut_…`)
 * scoped to the selected zone — and it CREATED the record, so it can DELETE
 * it. The auth method matters:
 *
 *   - `cfut_…` (and any other modern token) → `Authorization: Bearer <token>`.
 *     This is the working path, verified against the live CF API.
 *   - legacy `serviceKey` / `s` certs → the old `X-Auth-User-Service-Key`
 *     header. We keep this only as a fallback for genuinely-old certs.
 *
 * The PRIOR bug (the orphan this fixes): the code sent the `cfut_` Bearer
 * token via `X-Auth-User-Service-Key`, which the generic `/dns_records`
 * endpoint rejects with HTTP 400 "Authentication failed" — so teardown failed
 * and leaked the CNAME. Now we send `Authorization: Bearer` first and only
 * fall back to the legacy header on a 400/401/403 auth rejection.
 *
 * Usage:
 *   bun cf-dns-cleanup.ts --cert <path> --fqdn <hostname>
 *
 * Exit 0 ONLY when the record is provably gone (deleted, or never existed) —
 * the caller relies on this for its "zero orphans" guarantee. Exit non-zero on
 * any auth/API/delete error so the caller's host-side net can retry and so a
 * genuine leak is loud. Idempotent: a not-found record is success (teardown
 * runs on the happy path AND on failure, possibly twice).
 */

interface Args {
  cert: string;
  fqdn: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    const v = argv[i + 1];
    if (k && v !== undefined) out[k] = v;
  }
  for (const req of ["cert", "fqdn"]) {
    if (!out[req]) {
      console.error(`cf-dns-cleanup: missing --${req}`);
      process.exit(2);
    }
  }
  return out as unknown as Args;
}

interface ArgoToken {
  zoneID: string;
  apiToken: string;
  /**
   * Which auth method the cert's token shape implies. Modern `cfut_…` (and any
   * unrecognized shape) → Bearer. A legacy `serviceKey`/`s` value → the old
   * X-Auth-User-Service-Key header. We still PROBE both at runtime (the prefix
   * is a hint, not a guarantee), but this picks the order to try first.
   */
  preferBearer: boolean;
}

/**
 * Extract the ARGO TUNNEL TOKEN block from a cloudflared cert.pem and decode
 * the embedded zoneID + API token. The block is a standard PEM envelope whose
 * body is base64-encoded JSON. We tolerate both the modern key names
 * (`zoneID` / `apiToken`) and the older ones (`serviceKey` / `s`).
 */
function parseArgoToken(certPem: string): ArgoToken {
  const m = certPem.match(
    /-----BEGIN ARGO TUNNEL TOKEN-----\s*([\s\S]*?)\s*-----END ARGO TUNNEL TOKEN-----/,
  );
  if (!m || !m[1]) {
    throw new Error(
      "cert.pem has no ARGO TUNNEL TOKEN block — is this a cloudflared origin cert (from `cloudflared tunnel login`)?",
    );
  }
  const b64 = m[1].replace(/\s+/g, "");
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (err) {
    throw new Error(
      `failed to decode ARGO TUNNEL TOKEN payload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const zoneID = typeof json.zoneID === "string" ? json.zoneID : undefined;
  // Modern certs carry `apiToken` (a `cfut_…` API token → Bearer). Legacy
  // certs carry `serviceKey` / `s` (→ X-Auth-User-Service-Key).
  const modern = typeof json.apiToken === "string" ? json.apiToken : undefined;
  const legacy =
    (typeof json.serviceKey === "string" && json.serviceKey) ||
    (typeof json.s === "string" && json.s) ||
    undefined;
  const apiToken = modern || legacy;
  if (!zoneID || !apiToken) {
    throw new Error("ARGO TUNNEL TOKEN payload missing zoneID or API token");
  }
  // Bearer unless the token is ONLY present under a legacy key. A `cfut_`
  // prefix is the unambiguous modern signal.
  const preferBearer = modern !== undefined || apiToken.startsWith("cfut_");
  return { zoneID, apiToken, preferBearer };
}

const CF_API = "https://api.cloudflare.com/client/v4";

function bearerHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
}
function legacyHeaders(apiToken: string): Record<string, string> {
  return { "X-Auth-User-Service-Key": apiToken, "Content-Type": "application/json" };
}

interface CfListBody {
  success: boolean;
  result?: Array<{ id: string; type: string; name: string }>;
  errors?: unknown;
}

/**
 * Resolve which auth header this token actually works with by listing records
 * once (read-only). Tries the preferred method first, then the other on an
 * auth-class rejection (400/401/403). Returns the working header set + the
 * first list result so the caller doesn't re-list. Throws with both errors if
 * neither works (a real credential problem — surfaced loudly).
 */
async function resolveAuth(
  zoneID: string,
  token: ArgoToken,
  fqdn: string,
): Promise<{ headers: Record<string, string>; records: NonNullable<CfListBody["result"]> }> {
  const listUrl = `${CF_API}/zones/${zoneID}/dns_records?name=${encodeURIComponent(fqdn)}`;
  const order: Array<{ name: string; headers: Record<string, string> }> = token.preferBearer
    ? [
        { name: "Bearer", headers: bearerHeaders(token.apiToken) },
        { name: "X-Auth-User-Service-Key", headers: legacyHeaders(token.apiToken) },
      ]
    : [
        { name: "X-Auth-User-Service-Key", headers: legacyHeaders(token.apiToken) },
        { name: "Bearer", headers: bearerHeaders(token.apiToken) },
      ];

  const failures: string[] = [];
  for (const attempt of order) {
    const res = await fetch(listUrl, { headers: attempt.headers });
    const body = (await res.json().catch(() => ({ success: false }))) as CfListBody;
    if (res.ok && body.success) {
      console.log(`[cf-dns-cleanup] authenticated via ${attempt.name}.`);
      return { headers: attempt.headers, records: body.result ?? [] };
    }
    // Only fall through to the other method on an auth-class status; a 5xx or a
    // non-auth 4xx is a different problem we shouldn't mask by retrying auth.
    failures.push(`${attempt.name}→HTTP ${res.status} ${JSON.stringify(body.errors ?? "")}`);
    if (![400, 401, 403].includes(res.status)) break;
  }
  throw new Error(`CF API list dns_records failed (no working auth): ${failures.join(" ; ")}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const certPem = await Bun.file(args.cert).text();
  const token = parseArgoToken(certPem);
  const fqdn = args.fqdn.replace(/\.+$/, "");

  const { headers, records } = await resolveAuth(token.zoneID, token, fqdn);

  if (records.length === 0) {
    console.log(`[cf-dns-cleanup] no DNS record for ${fqdn} (already gone — ok).`);
    return;
  }

  let allDeleted = true;
  for (const rec of records) {
    const delUrl = `${CF_API}/zones/${token.zoneID}/dns_records/${rec.id}`;
    const delRes = await fetch(delUrl, { method: "DELETE", headers });
    if (delRes.ok) {
      console.log(`[cf-dns-cleanup] deleted ${rec.type} ${rec.name} (${rec.id}).`);
    } else {
      allDeleted = false;
      const txt = await delRes.text().catch(() => "");
      console.error(
        `[cf-dns-cleanup] FAILED to delete ${rec.type} ${rec.name} (${rec.id}): HTTP ${delRes.status} ${txt}`,
      );
    }
  }
  if (!allDeleted) {
    process.exit(1);
  }

  // Post-delete verification (the "zero orphans" guarantee): re-list and assert
  // the record is gone from the zone's authoritative view. A delete that
  // returned 200 but left the record (CF eventual consistency, or a partial
  // match) would otherwise be a silent leak. The CF API is authoritative
  // immediately on the zone side (separate from public-resolver propagation),
  // so this is a tight, reliable check.
  const verifyUrl = `${CF_API}/zones/${token.zoneID}/dns_records?name=${encodeURIComponent(fqdn)}`;
  const vRes = await fetch(verifyUrl, { headers });
  const vBody = (await vRes.json().catch(() => ({ success: false }))) as CfListBody;
  if (vRes.ok && vBody.success && (vBody.result ?? []).length === 0) {
    console.log(`[cf-dns-cleanup] verified: ${fqdn} no longer has a zone record.`);
    return;
  }
  console.error(
    `[cf-dns-cleanup] WARNING: post-delete re-list still shows ${(vBody.result ?? []).length} record(s) for ${fqdn}.`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(`cf-dns-cleanup ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
