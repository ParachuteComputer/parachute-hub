import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveTunnelName, renderConfig, writeConfig } from "../cloudflare/config.ts";
import { isValidTunnelName } from "../commands/expose-cloudflare.ts";

describe("cloudflare config", () => {
  test("renderConfig produces a valid cloudflared YAML with one-hostname ingress + catch-all 404", () => {
    const yaml = renderConfig({
      tunnelUuid: "2c1a7c7e-1234-5678-9abc-def012345678",
      credentialsFile: "/Users/x/.cloudflared/2c1a7c7e-1234-5678-9abc-def012345678.json",
      hostname: "vault.example.com",
      servicePort: 1940,
    });
    expect(yaml).toContain("tunnel: 2c1a7c7e-1234-5678-9abc-def012345678");
    expect(yaml).toContain(
      'credentials-file: "/Users/x/.cloudflared/2c1a7c7e-1234-5678-9abc-def012345678.json"',
    );
    expect(yaml).toContain("- hostname: vault.example.com");
    expect(yaml).toContain("service: http://localhost:1940");
    expect(yaml).toContain("- service: http_status:404");
  });

  test("renderConfig double-quotes credentials-file so paths with spaces survive YAML parse", () => {
    const yaml = renderConfig({
      tunnelUuid: "uuid",
      credentialsFile: "/Users/John Doe/.cloudflared/uuid.json",
      hostname: "vault.example.com",
      servicePort: 1940,
    });
    expect(yaml).toContain('credentials-file: "/Users/John Doe/.cloudflared/uuid.json"');
  });

  test("writeConfig creates the parent directory and writes to the given path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-cfg-"));
    const path = join(dir, "nested", "subdir", "config.yml");
    try {
      writeConfig(
        {
          tunnelUuid: "uuid",
          credentialsFile: "/tmp/creds.json",
          hostname: "vault.example.com",
          servicePort: 1940,
        },
        path,
      );
      const contents = readFileSync(path, "utf8");
      expect(contents).toContain("tunnel: uuid");
      expect(contents).toContain("hostname: vault.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deriveTunnelName (#491 — per-hostname dedicated tunnels)", () => {
  test("prefixes parachute- and turns dots into hyphens", () => {
    expect(deriveTunnelName("our.parachute.computer")).toBe("parachute-our-parachute-computer");
    expect(deriveTunnelName("vault.example.com")).toBe("parachute-vault-example-com");
  });

  test("lowercases and strips characters outside [a-z0-9_-]", () => {
    // Uppercase → lowercase; a stray char that an over-permissive hostname
    // validator might let through is dropped so the result stays a valid
    // tunnel name. (Dots are already mapped to hyphens before stripping.)
    expect(deriveTunnelName("Vault.Example.COM")).toBe("parachute-vault-example-com");
    expect(deriveTunnelName("a_b-c.example.com")).toBe("parachute-a_b-c-example-com");
  });

  test("every derived name satisfies isValidTunnelName", () => {
    for (const host of [
      "our.parachute.computer",
      "vault.example.com",
      "Vault.Example.COM",
      "a_b-c.example.com",
      `${"x".repeat(200)}.example.com`,
    ]) {
      const name = deriveTunnelName(host);
      expect(isValidTunnelName(name)).toBe(true);
    }
  });

  test("truncates + appends a stable 8-hex suffix when the name would exceed 64 chars", () => {
    const longHost = `${"sub.".repeat(20)}example.com`; // way over 64 once prefixed
    const name = deriveTunnelName(longHost);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith("parachute-")).toBe(true);
    // 8-hex stable suffix on the end.
    expect(name).toMatch(/-[0-9a-f]{8}$/);
  });

  test("is deterministic — same hostname always derives the same name (idempotent re-expose)", () => {
    const longHost = `${"sub.".repeat(20)}example.com`;
    expect(deriveTunnelName(longHost)).toBe(deriveTunnelName(longHost));
    expect(deriveTunnelName("our.parachute.computer")).toBe(
      deriveTunnelName("our.parachute.computer"),
    );
  });

  test("two distinct long hostnames whose truncated bodies are identical don't collide", () => {
    // Identical leading labels long enough that the body truncation
    // (parachute- + body-slice + -<8hex>, capped at 64) cuts BEFORE the
    // differing tail — so the truncated bodies are byte-identical and only the
    // full-hostname hash distinguishes them. Verifies the suffix disambiguates.
    const sharedPrefix = "x".repeat(80); // single long label, well past the truncation point
    const a = `${sharedPrefix}.alpha.example.com`;
    const b = `${sharedPrefix}.beta.example.com`;
    const nameA = deriveTunnelName(a);
    const nameB = deriveTunnelName(b);
    expect(nameA.length).toBeLessThanOrEqual(64);
    expect(nameB.length).toBeLessThanOrEqual(64);
    // Bodies before the suffix are identical (truncation cut inside the shared
    // prefix), so the names can only differ in the trailing 8-hex hash.
    expect(nameA.slice(0, -8)).toBe(nameB.slice(0, -8));
    expect(nameA).not.toBe(nameB);
  });
});
