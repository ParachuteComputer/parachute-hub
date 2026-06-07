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
 * Where the credential comes from: the `cloudflared` origin cert
 * (`~/.cloudflared/cert.pem`) that authorizes `tunnel route dns` embeds an
 * `ARGO TUNNEL TOKEN` PEM block — base64-encoded JSON
 * `{ zoneID, accountID, apiToken }` (older certs use `serviceKey`/`s`). That
 * same token authorizes DNS edits over `api.cloudflare.com/client/v4`, so we
 * reuse it rather than demanding a *separate* API-token secret. The cert is
 * already the one secret the operator provides; nothing extra to leak.
 *
 * Usage:
 *   bun cf-dns-cleanup.ts --cert <path> --fqdn <hostname>
 *
 * Exit 0 on success OR when the record simply doesn't exist (idempotent —
 * teardown runs on the happy path AND on failure, possibly twice). Exit
 * non-zero only on a real API error we couldn't classify as "already gone",
 * and even then the CALLER treats teardown as best-effort (a leaked record is
 * surfaced loudly but doesn't fail an otherwise-green stage — the stage's own
 * teardown already tried in-container; this is the defensive host-side net).
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
}

/**
 * Extract the ARGO TUNNEL TOKEN block from a cloudflared cert.pem and decode
 * the embedded zoneID + API token. The block is a standard PEM envelope whose
 * body is base64-encoded JSON. We tolerate both the modern key names
 * (`zoneID` / `apiToken`) and the older ones (`zoneID` is stable; the key has
 * historically been `apiToken`, `serviceKey`, or `s`).
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
  const apiToken =
    (typeof json.apiToken === "string" && json.apiToken) ||
    (typeof json.serviceKey === "string" && json.serviceKey) ||
    (typeof json.s === "string" && json.s) ||
    undefined;
  if (!zoneID || !apiToken) {
    throw new Error("ARGO TUNNEL TOKEN payload missing zoneID or API token");
  }
  return { zoneID, apiToken };
}

/**
 * cloudflared's cert token is a "service key", which the CF API accepts via
 * the legacy `X-Auth-User-Service-Key` header (NOT a Bearer). This is the same
 * auth path cloudflared itself uses for `tunnel route dns`.
 */
function authHeaders(apiToken: string): Record<string, string> {
  return {
    "X-Auth-User-Service-Key": apiToken,
    "Content-Type": "application/json",
  };
}

const CF_API = "https://api.cloudflare.com/client/v4";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const certPem = await Bun.file(args.cert).text();
  const { zoneID, apiToken } = parseArgoToken(certPem);
  const fqdn = args.fqdn.replace(/\.+$/, "");

  // List DNS records for the exact name (CNAME the tunnel route created; A/AAAA
  // just in case a shadow record exists). type-less query returns all types.
  const listUrl = `${CF_API}/zones/${zoneID}/dns_records?name=${encodeURIComponent(fqdn)}`;
  const listRes = await fetch(listUrl, { headers: authHeaders(apiToken) });
  const listBody = (await listRes.json()) as {
    success: boolean;
    result?: Array<{ id: string; type: string; name: string }>;
    errors?: unknown;
  };
  if (!listRes.ok || !listBody.success) {
    throw new Error(
      `CF API list dns_records failed (HTTP ${listRes.status}): ${JSON.stringify(listBody.errors ?? listBody)}`,
    );
  }
  const records = listBody.result ?? [];
  if (records.length === 0) {
    console.log(`[cf-dns-cleanup] no DNS record for ${fqdn} (already gone — ok).`);
    return;
  }
  let allDeleted = true;
  for (const rec of records) {
    const delUrl = `${CF_API}/zones/${zoneID}/dns_records/${rec.id}`;
    const delRes = await fetch(delUrl, { method: "DELETE", headers: authHeaders(apiToken) });
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
  if (!allDeleted) process.exit(1);
}

main().catch((err) => {
  console.error(`cf-dns-cleanup ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
