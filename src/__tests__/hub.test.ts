import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHub, writeHubFile } from "../hub.ts";

describe("renderHub", () => {
  const html = renderHub();

  test("is a self-contained HTML document with inline styles and script", () => {
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });

  test("fetches /.well-known/parachute.json and reads services[] + vaults[]", () => {
    expect(html).toContain("/.well-known/parachute.json");
    expect(html).toContain("doc.services");
    expect(html).toContain("doc.vaults");
  });

  test("uses parachute.computer sage palette and serif/sans fonts", () => {
    expect(html).toContain("#4a7c59");
    expect(html).toContain("#faf8f4");
    expect(html).toContain("Instrument Serif");
    expect(html).toContain("DM Sans");
  });

  test("supports prefers-color-scheme dark", () => {
    expect(html).toContain("prefers-color-scheme: dark");
  });

  test("falls back to a generic icon for module tiles", () => {
    expect(html).toContain("fallbackIcon");
  });

  test("renders one tile per module type, not per service instance", () => {
    expect(html).toContain("aggregate(services, vaults)");
    expect(html).toContain("renderTile");
    expect(html).toContain("MODULE_ORDER");
  });

  test("known module display order is vault → scribe → notes → claw", () => {
    expect(html).toContain("['vault', 'scribe', 'notes', 'claw']");
  });

  test("vault tile counts vaults[] (per instance) and links to /hub/vaults", () => {
    // Vault count is the length of doc.vaults — one entry per /vault/<name>
    // mount, so a single ServiceEntry with paths=[a,b,c] still shows "3
    // registered". The manage link is the hub's vault SPA, never an
    // individual vault backend.
    expect(html).toContain("vaults.length");
    expect(html).toContain("'/hub/vaults'");
  });

  test("non-vault tiles take their manageUrl from the service's path", () => {
    // shortName('parachute-scribe') = 'scribe' → tile links to svc.path,
    // which is whatever the module declared (e.g. /scribe, /notes, /claw).
    // Hardcoding the link would silently break on a custom mount.
    expect(html).toContain("manageUrl: svc.path");
  });

  test("tiles for module types with zero instances are hidden", () => {
    // Aggregate only inserts a group when the type has at least one entry;
    // tilesInOrder iterates the map. No "0 registered" surface.
    expect(html).not.toContain("0 registered");
    expect(html).toContain("count === 1 ? '1 registered'");
  });

  test("module labels are humanized (Vault / Scribe / Notes / Claw)", () => {
    expect(html).toContain("vault: 'Vault'");
    expect(html).toContain("scribe: 'Scribe'");
    expect(html).toContain("notes: 'Notes'");
    expect(html).toContain("claw: 'Claw'");
  });

  test("vault-name detection covers parachute-vault and parachute-vault-<name>", () => {
    // Phase-1 multi-vault keeps a single ServiceEntry with multiple paths
    // (parachute-vault), but the door is open for per-instance entries
    // (parachute-vault-techne). isVaultName has to accept both.
    expect(html).toContain("isVaultName");
    expect(html).toContain("'parachute-vault'");
    expect(html).toContain("'parachute-vault-'");
  });

  test("empty state when no modules are registered", () => {
    expect(html).toContain("No modules installed yet");
    expect(html).toContain("parachute install vault");
  });

  test("error state surfaces the underlying message", () => {
    expect(html).toContain("Could not load modules");
  });

  test("does not retain the per-service interactive-card / config-form code", () => {
    // The home page is now a directory of modules — per-instance config
    // forms and detail panels live behind the Manage links (vault SPA at
    // /hub/vaults, the running module's own UI elsewhere). Keeping the
    // dead code around is a maintenance trap.
    expect(html).not.toContain("renderConfigField");
    expect(html).not.toContain("fetchConfig");
    expect(html).not.toContain("kind-badge");
    expect(html).not.toContain("info.mcpUrl");
    expect(html).not.toContain("info.openInNotesUrl");
  });
});

describe("writeHubFile", () => {
  test("writes the rendered HTML to the given path, creating parent dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-hub-"));
    try {
      const path = join(dir, "well-known", "hub.html");
      const written = writeHubFile(path);
      expect(written).toBe(path);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf8");
      expect(content).toBe(renderHub());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
