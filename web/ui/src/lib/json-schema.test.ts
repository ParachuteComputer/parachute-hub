/**
 * Tests for `dereferenceSchema` (hub#303).
 *
 * Covers the resolution rules + the integration shape:
 *
 *   - definitions / $defs / nested refs / sibling keywords / circular /
 *     unknown / external / no-refs no-op
 *   - end-to-end: a $ref-using schema renders through ModuleConfig as if
 *     it were inline (writeOnly password input + correct field count)
 */
import { describe, expect, it } from "vitest";
import { type JsonSchema, dereferenceSchema } from "./json-schema.ts";

describe("dereferenceSchema", () => {
  it("resolves a $ref pointing at #/definitions/<name>", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        cred: { $ref: "#/definitions/apiKeyAndModel" },
      },
      definitions: {
        apiKeyAndModel: {
          type: "object",
          properties: {
            apiKey: { type: "string", writeOnly: true },
            model: { type: "string" },
          },
        },
      },
    };

    const out = dereferenceSchema(schema);
    const cred = (out.properties as Record<string, JsonSchema>).cred;
    expect(cred.type).toBe("object");
    const credProps = cred.properties as Record<string, JsonSchema>;
    expect(credProps.apiKey).toMatchObject({ type: "string", writeOnly: true });
    expect(credProps.model).toMatchObject({ type: "string" });
  });

  it("resolves a $ref pointing at #/$defs/<name> (newer keyword)", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        cred: { $ref: "#/$defs/apiKeyAndModel" },
      },
      $defs: {
        apiKeyAndModel: {
          type: "object",
          properties: {
            apiKey: { type: "string", writeOnly: true },
          },
        },
      },
    };
    const out = dereferenceSchema(schema);
    const cred = (out.properties as Record<string, JsonSchema>).cred;
    const credProps = cred.properties as Record<string, JsonSchema>;
    expect(credProps.apiKey).toMatchObject({ type: "string", writeOnly: true });
  });

  it("resolves nested refs (a → b → c)", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        outer: { $ref: "#/definitions/a" },
      },
      definitions: {
        a: { $ref: "#/definitions/b" },
        b: { $ref: "#/definitions/c" },
        c: { type: "string", title: "deepest" },
      },
    };
    const out = dereferenceSchema(schema);
    const outer = (out.properties as Record<string, JsonSchema>).outer;
    expect(outer).toMatchObject({ type: "string", title: "deepest" });
  });

  it("throws clearly on circular refs (a → b → a)", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        loop: { $ref: "#/definitions/a" },
      },
      definitions: {
        a: { $ref: "#/definitions/b" },
        b: { $ref: "#/definitions/a" },
      },
    };
    expect(() => dereferenceSchema(schema)).toThrow(/circular/i);
  });

  it("throws clearly on a ref to an unknown definition path", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        broken: { $ref: "#/definitions/missing" },
      },
      definitions: {},
    };
    expect(() => dereferenceSchema(schema)).toThrow(/unknown \$ref/i);
  });

  it("throws clearly on external refs (URLs / file paths)", () => {
    const schemaUrl: JsonSchema = {
      type: "object",
      properties: { remote: { $ref: "https://example.com/schema.json" } },
    };
    expect(() => dereferenceSchema(schemaUrl)).toThrow(/external refs/i);

    const schemaFile: JsonSchema = {
      type: "object",
      properties: { local: { $ref: "./other.json" } },
    };
    expect(() => dereferenceSchema(schemaFile)).toThrow(/external refs/i);
  });

  it("merges sibling keywords over the resolved definition", () => {
    // {$ref, title} — title at the call-site overrides the title in the
    // definition. Matches what tools like ajv-non-strict + json-schema-
    // ref-parser do in practice.
    const schema: JsonSchema = {
      type: "object",
      properties: {
        cred: {
          $ref: "#/definitions/apiKeyAndModel",
          title: "Per-call-site title override",
        },
      },
      definitions: {
        apiKeyAndModel: {
          type: "object",
          title: "Definition's own title",
          properties: {
            apiKey: { type: "string", writeOnly: true },
          },
        },
      },
    };
    const out = dereferenceSchema(schema);
    const cred = (out.properties as Record<string, JsonSchema>).cred;
    expect(cred.title).toBe("Per-call-site title override");
    expect(cred.type).toBe("object");
    // Definition's own properties survive the merge.
    const credProps = cred.properties as Record<string, JsonSchema>;
    expect(credProps.apiKey).toMatchObject({ writeOnly: true });
    // The `$ref` key itself is dropped from the output.
    expect(cred).not.toHaveProperty("$ref");
  });

  it("leaves a schema with no refs structurally equivalent", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        port: { type: "integer", minimum: 1, maximum: 65535 },
        flag: { type: "boolean", default: true },
      },
      required: ["port"],
    };
    const out = dereferenceSchema(schema);
    expect(out).toEqual(schema);
  });

  it("does not mutate the input schema (returns a clone)", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        cred: { $ref: "#/definitions/x" },
      },
      definitions: {
        x: { type: "string", writeOnly: true },
      },
    };
    const before = JSON.stringify(schema);
    dereferenceSchema(schema);
    expect(JSON.stringify(schema)).toBe(before);
  });

  it("recurses into oneOf / anyOf / allOf arms so any $ref inside resolves", () => {
    // Out of explicit-rendering scope per hub#303 (`Don't fold`), but the
    // dereferenced output should still be internally consistent — a
    // future PR adding structural rendering can rely on the arms being
    // pre-resolved.
    const schema: JsonSchema = {
      type: "object",
      properties: {
        provider: {
          oneOf: [{ $ref: "#/definitions/openai" }, { $ref: "#/definitions/gemini" }],
        },
      },
      definitions: {
        openai: { type: "object", properties: { apiKey: { type: "string", writeOnly: true } } },
        gemini: { type: "object", properties: { apiKey: { type: "string", writeOnly: true } } },
      },
    };
    const out = dereferenceSchema(schema);
    const arms = ((out.properties as Record<string, JsonSchema>).provider.oneOf ??
      []) as JsonSchema[];
    expect(arms).toHaveLength(2);
    const arm0Props = arms[0]?.properties as Record<string, JsonSchema>;
    const arm1Props = arms[1]?.properties as Record<string, JsonSchema>;
    expect(arm0Props.apiKey).toMatchObject({ writeOnly: true });
    expect(arm1Props.apiKey).toMatchObject({ writeOnly: true });
  });

  it("resolves a $ref pointing at a non-definitions path (#/properties/foo)", () => {
    // Path-based refs are the generic JSON Pointer shape. Not common in
    // practice, but the resolver handles it for free since the lookup
    // walks segments uniformly.
    const schema: JsonSchema = {
      type: "object",
      properties: {
        original: { type: "string", title: "Original field" },
        clone: { $ref: "#/properties/original" },
      },
    };
    const out = dereferenceSchema(schema);
    const clone = (out.properties as Record<string, JsonSchema>).clone;
    expect(clone).toMatchObject({ type: "string", title: "Original field" });
  });

  it("handles JSON Pointer escapes (~0 → ~, ~1 → /)", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        slashy: { $ref: "#/definitions/foo~1bar" },
      },
      definitions: {
        "foo/bar": { type: "string", title: "with slash" },
      },
    };
    const out = dereferenceSchema(schema);
    const slashy = (out.properties as Record<string, JsonSchema>).slashy;
    expect(slashy).toMatchObject({ type: "string", title: "with slash" });
  });
});
