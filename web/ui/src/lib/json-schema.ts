/**
 * JSON Schema (Draft-07) `$ref` dereferencing for the admin SPA.
 *
 * Background — why this lives here, why now (hub#303).
 *
 * The admin SPA's `ModuleConfig` form walks `schema.properties` directly:
 * it has no awareness of `$ref`, `definitions`, or `$defs`. Modules that
 * want to reuse a shared property block (e.g. scribe's `apiKeyAndModel`
 * across openai/gemini/groq cleanup providers) hit a wall — they either
 * inline the block per provider (the workaround scribe#47 took) or watch
 * the SPA render an "unsupported type" fallback for any `{$ref: ...}`
 * property.
 *
 * This helper resolves `$ref` ONCE at schema-load time so every downstream
 * walk (property iteration, oneOf arms, future structural rendering) sees
 * a fully-expanded schema. The renderer stays `$ref`-unaware; the resolve-
 * once pass is the single seam.
 *
 * Resolution rules (Draft-07-compatible subset):
 *
 *   - `$ref: "#/definitions/<name>"`  → `root.definitions[<name>]`
 *   - `$ref: "#/$defs/<name>"`        → `root.$defs[<name>]` (newer keyword)
 *   - Sibling keywords next to a `$ref` (e.g. `{$ref, title}`) — MERGE
 *     them on top of the resolved object. JSON Schema Draft-07 says this
 *     isn't compliant, but tools commonly support it and modules use it to
 *     override the title / description of a shared shape per-call-site.
 *   - Circular refs (a → b → a) — detected via a visited set, throws.
 *   - External refs (URLs, file paths) — refused with a clear error so
 *     they don't get silently swallowed.
 *   - Unknown ref paths — refused.
 *
 * Out of scope for this PR (hub#303 explicitly defers these):
 *
 *   - `$ref` *inside* `oneOf` / `anyOf` / `allOf` arms — those arms aren't
 *     structurally rendered today (the fallback path shows them as JSON).
 *     We still recurse into them so a resolved schema is internally
 *     consistent, but the SPA renderer doesn't act on them.
 *   - Arbitrary path-based refs (`#/properties/foo`) — supported via the
 *     generic resolver, but the only documented shape is the two
 *     definition-table conventions.
 */

export type JsonSchema = Record<string, unknown>;

/** Internal — the visited set carries the resolved-pointer strings so we
 * can detect cycles without lugging the original object identities around
 * (cheap structural-equality check on the pointer key). */
type VisitedRefs = ReadonlySet<string>;

/**
 * Walk `schema` (and every nested object / array) replacing each `$ref`
 * with the resolved value from `root`. Returns a new schema — never
 * mutates the input. The output is structurally cloned along the way, so
 * it's safe to read from concurrently if anything (including React's
 * reconciliation) holds onto a reference.
 *
 * @param schema  The schema to resolve. Usually the same object as `root`
 *   on the first call; recursive calls pass sub-objects.
 * @param root    Optional override for the resolution root. Defaults to
 *   `schema` so `dereferenceSchema(s)` is the common usage. Useful when
 *   you've sliced off a sub-tree and still want refs to resolve against
 *   the full document.
 */
export function dereferenceSchema(schema: JsonSchema, root?: JsonSchema): JsonSchema {
  const rootSchema = root ?? schema;
  return resolveValue(schema, rootSchema, new Set<string>()) as JsonSchema;
}

/**
 * Recursive walker. Each call returns a structurally-cloned value with
 * every `$ref` replaced. The `visited` set tracks pointer-strings on the
 * resolution chain so a → b → a throws clearly instead of recursing
 * forever.
 */
function resolveValue(value: unknown, root: JsonSchema, visited: VisitedRefs): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, root, visited));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const obj = value as JsonSchema;
  if (typeof obj.$ref === "string") {
    return resolveRef(obj, root, visited);
  }
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = resolveValue(v, root, visited);
  }
  return out;
}

/**
 * Resolve a `{$ref: "..."}` object against `root`. Sibling keywords on
 * the same object (e.g. `{$ref, title}`) override the resolved
 * definition — convenient for "use the shared shape but rename the
 * label per call-site." Same recurse-with-visited so a chain of refs
 * (a → b → c) fully resolves and a cycle (a → b → a) throws.
 */
function resolveRef(refObj: JsonSchema, root: JsonSchema, visited: VisitedRefs): unknown {
  const ref = refObj.$ref;
  if (typeof ref !== "string") {
    throw new Error(`Invalid $ref: expected string, got ${typeof ref}`);
  }
  if (!ref.startsWith("#")) {
    throw new Error(
      `Unsupported $ref "${ref}": external refs (URLs / file paths) are not supported`,
    );
  }
  if (visited.has(ref)) {
    throw new Error(`Circular $ref detected: "${ref}" already on resolution path`);
  }
  const target = lookupPointer(ref, root);
  if (target === undefined) {
    throw new Error(`Unknown $ref "${ref}": no definition at that path`);
  }
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw new Error(`Invalid $ref target at "${ref}": expected object, got ${typeof target}`);
  }
  // Recurse into the resolved value with the visited set extended — handles
  // nested refs (a → b → c) and surfaces cycles cleanly.
  const nextVisited = new Set(visited);
  nextVisited.add(ref);
  const resolved = resolveValue(target, root, nextVisited) as JsonSchema;

  // Merge sibling keywords on top of the resolved object. Draft-07 says
  // a $ref-bearing object should ignore siblings; in practice tools merge
  // them, and modules use the pattern to override title/description per
  // call-site. We drop the $ref key itself so the merged output is fully
  // dereferenced.
  const siblings: JsonSchema = {};
  for (const [k, v] of Object.entries(refObj)) {
    if (k === "$ref") continue;
    siblings[k] = resolveValue(v, root, nextVisited);
  }
  return { ...resolved, ...siblings };
}

/**
 * Resolve a JSON Pointer fragment (`#/definitions/X`, `#/$defs/X`,
 * `#/properties/foo/items`) against `root`. Returns the target value or
 * `undefined` if any segment is missing.
 *
 * Segments are URI-decoded and `~0` / `~1` un-escaped per RFC 6901, so a
 * definition literally named `apiKey/secret` (with the slash escaped) is
 * looked up correctly. The common path — alphanumeric definition names —
 * doesn't trigger any of that, but it's cheap to do right.
 */
function lookupPointer(ref: string, root: JsonSchema): unknown {
  // Strip the leading `#`. An empty string ("" after the hash) is the
  // root document itself per RFC 6901.
  const fragment = ref.slice(1);
  if (fragment === "") return root;
  if (!fragment.startsWith("/")) {
    throw new Error(`Unsupported $ref "${ref}": fragment must start with "/"`);
  }
  const segments = fragment
    .slice(1)
    .split("/")
    .map((seg) => decodeURIComponent(seg).replace(/~1/g, "/").replace(/~0/g, "~"));
  let cursor: unknown = root;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}
