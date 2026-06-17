import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModuleManifestError,
  readModuleManifest,
  validateModuleManifest,
} from "../module-manifest.ts";

const VALID = {
  name: "demo",
  manifestName: "@example/demo",
  port: 1950,
  paths: ["/demo"],
  health: "/healthz",
} as const;

describe("validateModuleManifest", () => {
  test("accepts a minimal valid manifest", () => {
    const m = validateModuleManifest(VALID, "test");
    expect(m.name).toBe("demo");
    expect(m.port).toBe(1950);
    expect(m.paths).toEqual(["/demo"]);
    expect(m.health).toBe("/healthz");
  });

  test("rejects non-object root", () => {
    expect(() => validateModuleManifest("nope", "where")).toThrow(ModuleManifestError);
    expect(() => validateModuleManifest([1, 2], "where")).toThrow(/root must be an object/);
  });

  test("parses connectionTemplates (boundary D2 — channel's link-to-vault shape)", () => {
    const m = validateModuleManifest(
      {
        ...VALID,
        connectionTemplates: [
          {
            key: "link-to-vault",
            title: "Link a channel to a vault",
            description: "Back a channel with a vault.",
            requestedBy: "agent",
            source: {
              module: "vault",
              event: "note.created",
              filter: { tags: ["#agent-message/inbound"] },
            },
            sink: { module: "agent", action: "message.deliver" },
            parameters: [
              { key: "vault", target: "source.vault", title: "Vault" },
              { key: "channel", target: "sink.params.channel", example: "eng" },
            ],
          },
        ],
      },
      "test",
    );
    const t = m.connectionTemplates?.[0];
    expect(t?.key).toBe("link-to-vault");
    expect(t?.source).toEqual({
      module: "vault",
      event: "note.created",
      filter: { tags: ["#agent-message/inbound"] },
    });
    expect(t?.sink).toEqual({ module: "agent", action: "message.deliver" });
    expect(t?.parameters?.[1]).toEqual({
      key: "channel",
      target: "sink.params.channel",
      example: "eng",
    });
  });

  test('accepts a source/sink-less config template (scribe\'s kind: "config" shape)', () => {
    // Scribe's real module.json ships a `kind: "config"` template with
    // provider/target instead of source/sink. The validator must NOT reject
    // it (a strict source/sink requirement would make every read of scribe's
    // manifest throw — install, catalog, lifecycle).
    const m = validateModuleManifest(
      {
        ...VALID,
        connectionTemplates: [
          {
            key: "link-to-vault",
            kind: "config",
            title: "Auto-transcribe a vault's audio",
            requestedBy: "demo",
            provider: { module: "demo", action: "transcribe" },
            target: { module: "vault", setting: "auto_transcribe.enabled" },
            parameters: [{ key: "vault", target: "target.vault", title: "Vault" }],
          },
        ],
      },
      "test",
    );
    const t = m.connectionTemplates?.[0];
    expect(t?.kind).toBe("config");
    expect(t?.source).toBeUndefined();
    expect(t?.sink).toBeUndefined();
    expect(t?.parameters?.[0]?.target).toBe("target.vault");
  });

  test("rejects malformed connectionTemplates", () => {
    expect(() => validateModuleManifest({ ...VALID, connectionTemplates: "x" }, "t")).toThrow(
      /connectionTemplates/,
    );
    expect(() =>
      validateModuleManifest(
        { ...VALID, connectionTemplates: [{ key: "k", title: "T", source: {}, sink: {} }] },
        "t",
      ),
    ).toThrow(/source\.module/);
    expect(() =>
      validateModuleManifest(
        {
          ...VALID,
          connectionTemplates: [
            {
              key: "k",
              title: "T",
              source: { module: "vault", event: "note.created" },
              sink: { module: "agent", action: "message.deliver" },
              parameters: [{ key: "p" }],
            },
          ],
        },
        "t",
      ),
    ).toThrow(/parameters\[0\]\.target/);
  });

  test("rejects missing required fields", () => {
    expect(() => validateModuleManifest({ ...VALID, name: undefined }, "x")).toThrow(/name/);
    expect(() => validateModuleManifest({ ...VALID, port: -1 }, "x")).toThrow(/port/);
    expect(() => validateModuleManifest({ ...VALID, port: 99999 }, "x")).toThrow(/port/);
    expect(() => validateModuleManifest({ ...VALID, paths: "not-array" }, "x")).toThrow(/paths/);
    expect(() => validateModuleManifest({ ...VALID, health: "no-leading-slash" }, "x")).toThrow(
      /health/,
    );
  });

  // hub#301 Phase C/D (#330): the `kind` field is fully retired. Hub doesn't
  // read it anymore; module.json values are silently ignored. Validation just
  // doesn't inspect the field — present, absent, valid string, typo, wrong
  // type — none of it errors and none of it surfaces on the parsed manifest.
  test("kind values in module.json are silently ignored (hub#330)", () => {
    // No matter what the author wrote, the validator passes through without
    // throwing and the parsed manifest exposes no `kind` field.
    expect(() => validateModuleManifest({ ...VALID, kind: "frontend" }, "x")).not.toThrow();
    expect(() => validateModuleManifest({ ...VALID, kind: "api" }, "x")).not.toThrow();
    expect(() => validateModuleManifest({ ...VALID, kind: "tool" }, "x")).not.toThrow();
    expect(() => validateModuleManifest({ ...VALID, kind: "static" }, "x")).not.toThrow();
    expect(() => validateModuleManifest({ ...VALID, kind: 42 }, "x")).not.toThrow();
    expect(() => validateModuleManifest({ ...VALID, kind: null }, "x")).not.toThrow();
    // The parsed manifest type has no `kind` field at all — confirm the
    // validator doesn't smuggle it through as a hidden property.
    const m = validateModuleManifest({ ...VALID, kind: "frontend" }, "x");
    expect((m as { kind?: unknown }).kind).toBeUndefined();
  });

  test("rejects invalid name shape", () => {
    expect(() => validateModuleManifest({ ...VALID, name: "Demo" }, "x")).toThrow(/name/);
    expect(() => validateModuleManifest({ ...VALID, name: "1demo" }, "x")).toThrow(/name/);
    expect(() => validateModuleManifest({ ...VALID, name: "a_b" }, "x")).toThrow(/name/);
  });

  test("scope namespace must match module name", () => {
    expect(() =>
      validateModuleManifest({ ...VALID, scopes: { defines: ["vault:read"] } }, "x"),
    ).toThrow(/namespace.*does not match/);
    const ok = validateModuleManifest(
      { ...VALID, scopes: { defines: ["demo:read", "demo:write"] } },
      "x",
    );
    expect(ok.scopes?.defines).toEqual(["demo:read", "demo:write"]);
  });

  test("scope without colon is rejected", () => {
    expect(() => validateModuleManifest({ ...VALID, scopes: { defines: ["demo"] } }, "x")).toThrow(
      /namespaced/,
    );
  });

  test("dependencies block accepts optional + scopes", () => {
    const m = validateModuleManifest(
      {
        ...VALID,
        dependencies: {
          "parachute-vault": { optional: false, scopes: ["vault:read"] },
          "parachute-scribe": { optional: true },
        },
      },
      "x",
    );
    expect(m.dependencies?.["parachute-vault"]?.optional).toBe(false);
    expect(m.dependencies?.["parachute-vault"]?.scopes).toEqual(["vault:read"]);
    expect(m.dependencies?.["parachute-scribe"]?.optional).toBe(true);
  });

  test("startCmd must be non-empty if present", () => {
    expect(() => validateModuleManifest({ ...VALID, startCmd: [] }, "x")).toThrow(/startCmd/);
    const m = validateModuleManifest({ ...VALID, startCmd: ["bin", "--flag"] }, "x");
    expect(m.startCmd).toEqual(["bin", "--flag"]);
  });

  test("optional displayName + tagline pass through", () => {
    const m = validateModuleManifest(
      { ...VALID, displayName: "Demo", tagline: "a demo module" },
      "x",
    );
    expect(m.displayName).toBe("Demo");
    expect(m.tagline).toBe("a demo module");
  });

  test("managementUrl accepts a leading-slash path", () => {
    const m = validateModuleManifest({ ...VALID, managementUrl: "/admin" }, "x");
    expect(m.managementUrl).toBe("/admin");
  });

  test("managementUrl accepts an absolute https URL", () => {
    const m = validateModuleManifest(
      { ...VALID, managementUrl: "https://admin.example.com/" },
      "x",
    );
    expect(m.managementUrl).toBe("https://admin.example.com/");
  });

  test("managementUrl accepts the relative (per-instance) form — B4", () => {
    // Unified URL semantics (2026-06-09 hub-module-boundary, B4): a relative
    // path (no leading slash) is the per-instance form resolvers join under
    // the module's mount. Vault's new manifest declares `"admin/"`.
    expect(validateModuleManifest({ ...VALID, managementUrl: "admin/" }, "x").managementUrl).toBe(
      "admin/",
    );
    expect(
      validateModuleManifest({ ...VALID, managementUrl: "deep/admin" }, "x").managementUrl,
    ).toBe("deep/admin");
  });

  test("managementUrl rejects empty / non-string / bad-scheme / traversal", () => {
    expect(() => validateModuleManifest({ ...VALID, managementUrl: "" }, "x")).toThrow(
      /managementUrl/,
    );
    expect(() => validateModuleManifest({ ...VALID, managementUrl: 7 }, "x")).toThrow(
      /managementUrl/,
    );
    expect(() =>
      validateModuleManifest({ ...VALID, managementUrl: "ftp://example.com" }, "x"),
    ).toThrow(/http:.*https:/);
    // Scheme-bearing non-URL strings must not smuggle through as "relative".
    expect(() =>
      validateModuleManifest({ ...VALID, managementUrl: "javascript:alert(1)" }, "x"),
    ).toThrow(/managementUrl/);
    // The relative form can only deepen its mount — no `..` traversal.
    expect(() =>
      validateModuleManifest({ ...VALID, managementUrl: "../other/admin" }, "x"),
    ).toThrow(/\.\./);
    // Backslash-traversal closure: WHATWG URL parsing treats `\` as `/` in
    // http(s) schemes, so `a\..\b` would normalize to `a/../b` post-join and
    // pop a segment past the `..`-segment check. Any backslash → invalid.
    expect(() => validateModuleManifest({ ...VALID, managementUrl: "a\\..\\b" }, "x")).toThrow(
      /backslash/,
    );
  });

  test("percent-encoded ..%2f is inert in the relative form (URL base-join doesn't decode)", () => {
    // The validator ACCEPTS `..%2f...` — it isn't a literal ".." segment and
    // needs no guard, because `new URL()` does not decode percent-escapes
    // during base-join: the segment stays the literal "..%2fadmin" and never
    // traverses. Pin the resolution behavior the safety argument rests on.
    const m = validateModuleManifest({ ...VALID, managementUrl: "..%2fadmin" }, "x");
    expect(m.managementUrl).toBe("..%2fadmin");
    const joined = new URL("/vault/default/..%2fadmin", "https://x.example/");
    expect(joined.pathname).toBe("/vault/default/..%2fadmin"); // no segment popped
  });

  // --- 2026-06-09 modular-UI architecture P1 fields: focus / configUiUrl /
  //     adminCapabilities / events / actions. All optional + additive. ---

  test("focus accepts core / experimental and rejects anything else", () => {
    expect(validateModuleManifest({ ...VALID, focus: "core" }, "x").focus).toBe("core");
    expect(validateModuleManifest({ ...VALID, focus: "experimental" }, "x").focus).toBe(
      "experimental",
    );
    // Absent stays absent (hub falls back to its default map downstream).
    expect(validateModuleManifest(VALID, "x").focus).toBeUndefined();
    expect(() => validateModuleManifest({ ...VALID, focus: "headline" }, "x")).toThrow(/focus/);
    expect(() => validateModuleManifest({ ...VALID, focus: 1 }, "x")).toThrow(/focus/);
  });

  test("configUiUrl follows the path-or-url shape (incl. the B4 relative form)", () => {
    expect(
      validateModuleManifest({ ...VALID, configUiUrl: "/scribe/admin" }, "x").configUiUrl,
    ).toBe("/scribe/admin");
    expect(
      validateModuleManifest({ ...VALID, configUiUrl: "https://cfg.example.com/" }, "x")
        .configUiUrl,
    ).toBe("https://cfg.example.com/");
    // Relative = the per-instance mount-joined form (B4) — valid.
    expect(validateModuleManifest({ ...VALID, configUiUrl: "admin/" }, "x").configUiUrl).toBe(
      "admin/",
    );
    expect(() => validateModuleManifest({ ...VALID, configUiUrl: "//evil.com" }, "x")).toThrow(
      /configUiUrl/,
    );
  });

  test("adminCapabilities accepts a string array, rejects non-arrays", () => {
    expect(
      validateModuleManifest({ ...VALID, adminCapabilities: ["config", "logs"] }, "x")
        .adminCapabilities,
    ).toEqual(["config", "logs"]);
    expect(() => validateModuleManifest({ ...VALID, adminCapabilities: "config" }, "x")).toThrow(
      /adminCapabilities/,
    );
    expect(() => validateModuleManifest({ ...VALID, adminCapabilities: [1, 2] }, "x")).toThrow(
      /adminCapabilities/,
    );
  });

  test("events parse key + title (+ optional filterSchema), reject malformed entries", () => {
    const m = validateModuleManifest(
      {
        ...VALID,
        events: [
          { key: "note.created", title: "Note created", filterSchema: { type: "object" } },
          { key: "note.deleted", title: "Note deleted" },
        ],
      },
      "x",
    );
    expect(m.events?.map((e) => e.key)).toEqual(["note.created", "note.deleted"]);
    expect(m.events?.[0]?.filterSchema).toEqual({ type: "object" });
    expect(m.events?.[1]?.filterSchema).toBeUndefined();
    expect(() => validateModuleManifest({ ...VALID, events: "nope" }, "x")).toThrow(/events/);
    expect(() => validateModuleManifest({ ...VALID, events: [{ title: "no key" }] }, "x")).toThrow(
      /events\[0\]\.key/,
    );
  });

  test("actions parse key + title (+ optional inputSchema / provision), reject malformed entries", () => {
    const m = validateModuleManifest(
      {
        ...VALID,
        actions: [
          {
            key: "message.send",
            title: "Send message",
            inputSchema: { type: "object" },
            provision: { kind: "vault-trigger" },
          },
        ],
      },
      "x",
    );
    expect(m.actions?.[0]?.key).toBe("message.send");
    expect(m.actions?.[0]?.inputSchema).toEqual({ type: "object" });
    expect(m.actions?.[0]?.provision).toEqual({ kind: "vault-trigger" });
    expect(() => validateModuleManifest({ ...VALID, actions: [{ key: "x" }] }, "x")).toThrow(
      /actions\[0\]\.title/,
    );
  });

  test("actions parse endpoint + scope (the connection-wiring fields, P5)", () => {
    // The scope namespace must match the module name (VALID is "demo"), so use
    // a demo-namespaced scope here; the cross-namespace rejection is exercised
    // in the namespace-guard test below.
    const m = validateModuleManifest(
      {
        ...VALID,
        actions: [
          {
            key: "message.deliver",
            title: "Deliver",
            endpoint: "/api/vault/inbound",
            scope: "demo:send",
            provision: { type: "vault-trigger" },
          },
        ],
      },
      "x",
    );
    expect(m.actions?.[0]?.endpoint).toBe("/api/vault/inbound");
    expect(m.actions?.[0]?.scope).toBe("demo:send");
    // endpoint must be a leading-slash path.
    expect(() =>
      validateModuleManifest(
        { ...VALID, actions: [{ key: "a", title: "A", endpoint: "no-slash" }] },
        "x",
      ),
    ).toThrow(/actions\[0\]\.endpoint/);
    // scope must be a non-empty string.
    expect(() =>
      validateModuleManifest({ ...VALID, actions: [{ key: "a", title: "A", scope: 7 }] }, "x"),
    ).toThrow(/actions\[0\]\.scope/);
  });

  test("action.scope namespace MUST match the declaring module name (privilege-escalation guard)", () => {
    // A malicious manifest named "widget" declaring an action scoped to ANOTHER
    // module's namespace (vault:default:admin) would trick the hub into minting a
    // 90-day cross-module bearer when an operator wires a Connection to it.
    // Reject it at validation, mirroring the `scopes.defines` namespace rule.
    expect(() =>
      validateModuleManifest(
        {
          ...VALID,
          name: "widget",
          actions: [{ key: "thing.do", title: "Do", scope: "vault:default:admin" }],
        },
        "x",
      ),
    ).toThrow(/namespace "vault" does not match module name "widget"/);
    // An un-namespaced scope is rejected too.
    expect(() =>
      validateModuleManifest(
        { ...VALID, name: "widget", actions: [{ key: "a", title: "A", scope: "bare" }] },
        "x",
      ),
    ).toThrow(/must be namespaced as "<name>:<verb>"/);
    // A matching-namespace scope still validates — the real agent case
    // (message.deliver → agent:send).
    const okm = validateModuleManifest(
      {
        ...VALID,
        name: "agent",
        actions: [
          {
            key: "message.deliver",
            title: "Deliver",
            endpoint: "/api/vault/inbound",
            scope: "agent:send",
          },
        ],
      },
      "x",
    );
    expect(okm.actions?.[0]?.scope).toBe("agent:send");
  });

  test("uiUrl accepts a leading-slash path (Phase D)", () => {
    const m = validateModuleManifest({ ...VALID, uiUrl: "/notes" }, "x");
    expect(m.uiUrl).toBe("/notes");
  });

  test("uiUrl accepts an absolute https URL", () => {
    const m = validateModuleManifest({ ...VALID, uiUrl: "https://app.example.com/" }, "x");
    expect(m.uiUrl).toBe("https://app.example.com/");
  });

  test("uiUrl accepts the relative (per-instance) form — B4 (mirrors managementUrl)", () => {
    expect(validateModuleManifest({ ...VALID, uiUrl: "admin/" }, "x").uiUrl).toBe("admin/");
  });

  test("uiUrl rejects empty / non-string / bad-scheme / traversal (mirrors managementUrl)", () => {
    expect(() => validateModuleManifest({ ...VALID, uiUrl: "" }, "x")).toThrow(/uiUrl/);
    expect(() => validateModuleManifest({ ...VALID, uiUrl: 7 }, "x")).toThrow(/uiUrl/);
    expect(() => validateModuleManifest({ ...VALID, uiUrl: "ftp://example.com" }, "x")).toThrow(
      /http:.*https:/,
    );
    expect(() => validateModuleManifest({ ...VALID, uiUrl: "../sneaky" }, "x")).toThrow(/\.\./);
  });

  test("uiUrl absent stays absent", () => {
    const m = validateModuleManifest(VALID, "x");
    expect(m.uiUrl).toBeUndefined();
  });

  // Open-redirect regression: protocol-relative paths like "//evil.com" pass
  // a naive `startsWith("/")` check but `new URL("//evil.com", base)` resolves
  // to the foreign origin. A malicious third-party module could plant such a
  // value in module.json:uiUrl and turn a discovery tile into an off-origin
  // redirect. Both uiUrl and managementUrl are validated by the shared
  // asPathOrUrl helper, so cover both.
  test("uiUrl rejects protocol-relative paths (open-redirect regression)", () => {
    expect(() => validateModuleManifest({ ...VALID, uiUrl: "//evil.com" }, "x")).toThrow(/uiUrl/);
    expect(() => validateModuleManifest({ ...VALID, uiUrl: "//evil.com/path" }, "x")).toThrow(
      /uiUrl/,
    );
  });

  test("managementUrl rejects protocol-relative paths (open-redirect regression)", () => {
    expect(() => validateModuleManifest({ ...VALID, managementUrl: "//evil.com" }, "x")).toThrow(
      /managementUrl/,
    );
    expect(() =>
      validateModuleManifest({ ...VALID, managementUrl: "//evil.com/admin" }, "x"),
    ).toThrow(/managementUrl/);
  });

  test("managementUrl absent stays absent", () => {
    const m = validateModuleManifest(VALID, "x");
    expect(m.managementUrl).toBeUndefined();
  });

  test("stripPrefix accepts boolean true and false; rejects non-boolean", () => {
    expect(validateModuleManifest({ ...VALID, stripPrefix: true }, "x").stripPrefix).toBe(true);
    expect(validateModuleManifest({ ...VALID, stripPrefix: false }, "x").stripPrefix).toBe(false);
    expect(() => validateModuleManifest({ ...VALID, stripPrefix: "yes" }, "x")).toThrow(
      /stripPrefix/,
    );
  });

  test("stripPrefix absent stays absent", () => {
    const m = validateModuleManifest(VALID, "x");
    expect(m.stripPrefix).toBeUndefined();
  });
});

describe("readModuleManifest", () => {
  function tmp(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "pcli-manifest-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("returns null when .parachute/module.json is absent", async () => {
    const { dir, cleanup } = tmp();
    try {
      expect(await readModuleManifest(dir)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("reads + validates a real on-disk manifest", async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, ".parachute"));
      writeFileSync(join(dir, ".parachute", "module.json"), JSON.stringify(VALID));
      const m = await readModuleManifest(dir);
      expect(m?.name).toBe("demo");
    } finally {
      cleanup();
    }
  });

  test("throws ModuleManifestError on malformed JSON", async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, ".parachute"));
      writeFileSync(join(dir, ".parachute", "module.json"), "{not json");
      await expect(readModuleManifest(dir)).rejects.toThrow(ModuleManifestError);
    } finally {
      cleanup();
    }
  });

  test("throws ModuleManifestError on validation failure", async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, ".parachute"));
      writeFileSync(join(dir, ".parachute", "module.json"), JSON.stringify({ name: "x" }));
      await expect(readModuleManifest(dir)).rejects.toThrow(ModuleManifestError);
    } finally {
      cleanup();
    }
  });
});
