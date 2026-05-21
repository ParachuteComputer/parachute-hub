/**
 * /admin/modules/:short/config — generic per-module config form.
 *
 * Mounted off `/admin/modules` (the Modules page exposes a "Configure"
 * link per installed module). The page fetches three things on load:
 *
 *   1. `GET /api/modules/<short>/config/schema` — Draft-07 JSON Schema
 *   2. `GET /api/modules/<short>/config`        — current resolved values
 *   3. (renders) form fields per schema property, pre-filled from values
 *
 * Save flow:
 *
 *   1. User edits fields (each tracks dirty/clean independently).
 *   2. Submit → PUT `/api/modules/<short>/config` with ONLY changed fields.
 *      The "changed fields only" rule is what makes writeOnly secrets
 *      safe — a blank password input means "leave the stored value",
 *      not "clear it." A user who wants to clear a stored value must
 *      explicitly type "" or use the clear-CTA the field provides.
 *   3. Module responds 200 + optional `restart_required` list → success
 *      banner names the fields that need a process bounce.
 *   4. Module responds 400 → inline field errors from `errors[]`.
 *
 * Schema shape supported:
 *
 *   - `type: "string" | "number" | "integer" | "boolean"`
 *   - `enum: [...]` (renders a `<select>`)
 *   - `default` (used as schema-default placeholder when value absent)
 *   - `title`, `description`
 *   - `minimum`, `maximum` (passed to numeric inputs)
 *   - `writeOnly: true` (renders as `type=password` with leave-blank-
 *     to-preserve UX)
 *
 * Unsupported (intentionally — scribe's schemas don't use these today):
 *
 *   - nested objects / arrays / oneOf / anyOf / allOf
 *
 * `$ref` IS supported: the loaded schema is run through
 * `dereferenceSchema` (see `../lib/json-schema.ts`) once at fetch time,
 * so every downstream walk sees fully-expanded property objects. This
 * lets modules reuse shared `definitions` / `$defs` shapes (scribe's
 * `apiKeyAndModel` across openai/gemini/groq cleanup providers) without
 * inlining. Added in hub#303 to retire scribe's inline workaround.
 *
 * If/when a module ships one of the other unsupported shapes, we'll
 * either lift in `@rjsf/core` (industry-standard library) or extend
 * this renderer — neither hurries us today. Hand-rolling at v1 saves
 * the SPA bundle ~250 KB of @rjsf + ajv + a plugin surface that doesn't
 * match Parachute's narrow schema vocabulary.
 *
 * Design choice — Option A vs B for upstream auth: hub mints a short-
 * lived `<short>:admin` JWT at proxy time and forwards it to the
 * module. The SPA never sees per-module bearers; it only ever holds
 * `parachute:host:admin`. See `src/api-modules-config.ts` for the
 * server-side rationale.
 */
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type ConfigSchemaProperty,
  HttpError,
  type ModuleConfigSchema,
  type ModuleConfigValues,
  getModuleConfigSchema,
  getModuleConfigValues,
  putModuleConfigValues,
} from "../lib/api.ts";
import { dereferenceSchema } from "../lib/json-schema.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "no_schema" } // upstream 404 — module exposes no config
  | { kind: "not_installed" } // module absent from services.json
  | { kind: "ok"; schema: ModuleConfigSchema; values: ModuleConfigValues }
  | { kind: "error"; message: string };

/**
 * Per-field error from a 400 PUT response. Matches scribe's
 * `{errors: [{path, message}]}` shape; other modules following the same
 * convention slot in cleanly. Unrecognized shapes surface in the top-
 * level banner instead.
 */
interface FieldError {
  path: string;
  message: string;
}

export function ModuleConfig() {
  const { short = "" } = useParams<{ short: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // `draft` mirrors the user's typed values per field. `dirty` is the
  // per-field "did the user touch this?" gate that drives the changed-
  // fields-only PUT shape. `originalValues` is a frozen snapshot of the
  // GET response so the dirty-tracker can un-dirty a field when the
  // user types a value back to its original — without this, typing
  // 'baz' then back to 'bar' would still include 'foo' in the PUT.
  const [draft, setDraft] = useState<ModuleConfigValues>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [originalValues, setOriginalValues] = useState<ModuleConfigValues>({});
  const [saving, setSaving] = useState(false);
  const [saveBanner, setSaveBanner] = useState<
    | { kind: "success"; message: string; restartRequired: readonly string[] }
    | { kind: "error"; message: string }
    | null
  >(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setState({ kind: "loading" });
    setDraft({});
    setDirty({});
    setOriginalValues({});
    setSaveBanner(null);
    setFieldErrors({});
    try {
      const rawSchema = await getModuleConfigSchema(short);
      if (rawSchema === null) {
        setState({ kind: "no_schema" });
        return;
      }
      // Resolve every `$ref` against `definitions` / `$defs` up front, so
      // the downstream renderer walks fully-expanded property objects.
      // Modules can use shared definition blocks without forcing the SPA
      // to learn JSON Schema pointer-resolution at every walk site
      // (hub#303). Errors here (circular, unknown, external) surface as
      // the same "error" load state the network-failure path uses — the
      // operator can retry, but the broken schema needs a module-side
      // fix.
      let schema: ModuleConfigSchema;
      try {
        schema = dereferenceSchema(rawSchema) as ModuleConfigSchema;
      } catch (refErr) {
        const refMsg = refErr instanceof Error ? refErr.message : String(refErr);
        setState({ kind: "error", message: `Schema $ref resolution failed — ${refMsg}` });
        return;
      }
      const values = await getModuleConfigValues(short);
      setState({ kind: "ok", schema, values });
      // Pre-fill the draft from current values so the form shows what's
      // stored. writeOnly fields are absent from `values` by convention
      // (the module omits them from GET responses) — the draft entry
      // stays undefined and the input renders empty with placeholder.
      setDraft({ ...values });
      // Snapshot the same values for dirty-tracker comparison. Frozen
      // here, refreshed only on next load / save-refresh.
      setOriginalValues({ ...values });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // 404 with no `no_config_schema` code = module not installed.
        // The schema fetch already pre-handles the no_schema case.
        setState({ kind: "not_installed" });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message: msg });
    }
  }, [short]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function onChangeField(name: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [name]: value }));
    // Un-dirty on revert: if the user types a value back to what the
    // server returned, drop it from the PUT payload. writeOnly fields
    // are special — the server omits them from GET responses, so there's
    // no "original" to compare against; any non-empty user input counts
    // as dirty.
    const schema = state.kind === "ok" ? state.schema.properties?.[name] : undefined;
    const isWriteOnly = schema?.writeOnly === true;
    if (isWriteOnly) {
      const typed = value !== "" && value !== undefined && value !== null;
      setDirty((prev) => ({ ...prev, [name]: typed }));
    } else {
      setDirty((prev) => ({ ...prev, [name]: value !== originalValues[name] }));
    }
    // Clear any prior field error as the user edits — keeps the banner
    // honest about which fields are still in error.
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (state.kind !== "ok") return;
    setSaving(true);
    setSaveBanner(null);
    setFieldErrors({});

    // Build the payload: only fields the user actually changed. This is
    // the writeOnly-safe shape — a blank password input the user didn't
    // touch is `dirty=false`, so we don't send the empty string and the
    // module preserves its stored secret.
    const payload: ModuleConfigValues = {};
    for (const [name, isDirty] of Object.entries(dirty)) {
      if (!isDirty) continue;
      payload[name] = draft[name];
    }
    if (Object.keys(payload).length === 0) {
      setSaving(false);
      setSaveBanner({
        kind: "error",
        message: "No changes to save. Edit a field first.",
      });
      return;
    }

    try {
      const result = await putModuleConfigValues(short, payload);
      setSaveBanner({
        kind: "success",
        message: "Configuration saved.",
        restartRequired: Array.isArray(result.restart_required) ? result.restart_required : [],
      });
      // Reset dirty flags so the next submit picks up only fields edited
      // after this save. We do NOT re-fetch values automatically —
      // some modules (like scribe) only apply provider changes on
      // restart, and re-fetching would show the old value with no
      // visual cue. The success banner's restart_required list is
      // the operator's signal.
      setDirty({});
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) {
        // Parse the 400 body for `errors[]` field-level details. Scribe
        // and the canonical pattern surface `{error, message, errors[]}`.
        try {
          const body = JSON.parse(err.message) as {
            error?: string;
            message?: string;
            errors?: readonly FieldError[];
            error_description?: string;
          };
          const errs = Array.isArray(body.errors) ? body.errors : [];
          if (errs.length > 0) {
            const map: Record<string, string> = {};
            for (const fe of errs) {
              if (typeof fe?.path === "string" && typeof fe?.message === "string") {
                map[fe.path] = fe.message;
              }
            }
            setFieldErrors(map);
            setSaveBanner({
              kind: "error",
              message: body.message ?? body.error_description ?? "Validation failed.",
            });
            return;
          }
          setSaveBanner({
            kind: "error",
            message: body.message ?? body.error_description ?? "Validation failed.",
          });
          return;
        } catch {
          // Fall through to generic display.
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      setSaveBanner({ kind: "error", message: `Save failed — ${msg}` });
    } finally {
      setSaving(false);
    }
  }

  if (state.kind === "loading") {
    return <div className="empty">Loading configuration…</div>;
  }
  if (state.kind === "not_installed") {
    return (
      <section className="module-config">
        <h1>Configure {short}</h1>
        <div className="empty">
          <p>
            <code>{short}</code> is not installed on this hub.
          </p>
          <p>
            Visit <Link to="/modules">Modules</Link> to install it first.
          </p>
        </div>
      </section>
    );
  }
  if (state.kind === "no_schema") {
    return (
      <section className="module-config">
        <h1>Configure {short}</h1>
        <div className="empty">
          <p>
            <code>{short}</code> does not expose an operator-editable configuration schema.
          </p>
          <p>
            Some modules are configured entirely through environment variables or files on disk —
            check the module's documentation, or visit <Link to="/modules">Modules</Link>.
          </p>
        </div>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section className="module-config">
        <h1>Configure {short}</h1>
        <div className="empty">
          Failed to load configuration: {state.message}.{" "}
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const { schema } = state;
  const properties = schema.properties ?? {};
  const requiredSet = new Set(schema.required ?? []);
  const propertyEntries = Object.entries(properties);

  return (
    <section className="module-config">
      <header className="module-config-header">
        <h1>Configure {short}</h1>
        <p className="muted">
          Edit values and save. Some changes apply immediately; others (provider, port) require
          restarting the module to take effect. <Link to="/modules">Back to modules</Link>.
        </p>
      </header>

      {propertyEntries.length === 0 && (
        <div className="empty">
          <p>This module's schema defines no editable properties.</p>
        </div>
      )}

      <form
        onSubmit={(e) => void onSave(e)}
        className="module-config-form"
        data-testid="config-form"
      >
        <fieldset>
          {propertyEntries.map(([name, prop]) => (
            <ConfigField
              key={name}
              name={name}
              property={prop}
              value={draft[name]}
              required={requiredSet.has(name)}
              // `name in values` distinguishes "GET omitted this key"
              // (= stored writeOnly secret) from "GET included it with
              // a falsy value." Falsy-coercion would conflate the two.
              writeOnlyStored={prop.writeOnly === true && !(name in state.values)}
              error={fieldErrors[name]}
              dirty={Boolean(dirty[name])}
              onChange={(v) => onChangeField(name, v)}
            />
          ))}
        </fieldset>

        <div className="actions">
          <button type="submit" disabled={saving || propertyEntries.length === 0}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="destructive"
            disabled={saving}
            onClick={() => void refresh()}
          >
            Discard changes
          </button>
        </div>

        {saveBanner?.kind === "success" && (
          <div className="banner banner-success" data-testid="save-success">
            <strong>{saveBanner.message}</strong>
            {saveBanner.restartRequired.length > 0 && (
              <>
                <p className="muted">Restart {short} to apply these field changes:</p>
                <ul>
                  {saveBanner.restartRequired.map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {saveBanner?.kind === "error" && (
          <div className="banner banner-error error" data-testid="save-error">
            {saveBanner.message}
          </div>
        )}
      </form>
    </section>
  );
}

interface ConfigFieldProps {
  name: string;
  property: ConfigSchemaProperty;
  value: unknown;
  required: boolean;
  /**
   * True when the property is `writeOnly` AND the module's GET response
   * omitted this key (= a stored value exists, just hidden). Drives
   * the "leave blank to keep current" placeholder. When false +
   * writeOnly, we're either: (a) the value was never set, or (b) the
   * caller cleared `dirty` post-save and we're showing the new state.
   * Either way, no need for the "leave blank" hint.
   */
  writeOnlyStored: boolean;
  error: string | undefined;
  /** True once the user has edited this field. Drives "leave blank" copy display. */
  dirty: boolean;
  onChange: (value: unknown) => void;
}

/**
 * One rendered field. Switches on `property.type` + `property.enum` +
 * `property.writeOnly` to pick the right input. All values land in the
 * draft as their natural JS type (string / number / boolean) — the
 * module's PUT handler re-validates against the schema, so the SPA
 * doesn't need to coerce defensively.
 */
function ConfigField({
  name,
  property,
  value,
  required,
  writeOnlyStored,
  error,
  dirty,
  onChange,
}: ConfigFieldProps) {
  const id = `config-field-${name}`;
  const label = property.title ?? name;
  const description = property.description;
  const hasEnum = Array.isArray(property.enum) && property.enum.length > 0;

  // Boolean → checkbox.
  if (property.type === "boolean") {
    return (
      <div className={`field field-inline ${error ? "field-invalid" : ""}`} data-field={name}>
        <label htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="field-label-inline">{label}</span>
        </label>
        {description && <p className="muted field-hint">{description}</p>}
        {error && <p className="error field-error">{error}</p>}
      </div>
    );
  }

  // Enum → select.
  if (hasEnum) {
    const options = property.enum as ReadonlyArray<string | number>;
    return (
      <div className={`field ${error ? "field-invalid" : ""}`} data-field={name}>
        <label htmlFor={id}>
          <span className="field-label">
            {label}
            {required && <span className="muted"> (required)</span>}
          </span>
          <select
            id={id}
            value={value == null ? "" : String(value)}
            onChange={(e) => {
              const raw = e.target.value;
              // Re-coerce to number when the schema says so — selects are
              // string-only DOM-side but the module wants the typed value
              // back.
              if (property.type === "number" || property.type === "integer") {
                onChange(raw === "" ? undefined : Number(raw));
              } else {
                onChange(raw === "" ? undefined : raw);
              }
            }}
          >
            {!required && <option value="">(unset)</option>}
            {options.map((opt) => (
              <option key={String(opt)} value={String(opt)}>
                {String(opt)}
              </option>
            ))}
          </select>
        </label>
        {description && <p className="muted field-hint">{description}</p>}
        {error && <p className="error field-error">{error}</p>}
      </div>
    );
  }

  // writeOnly string → password input with leave-blank affordance.
  if (property.type === "string" && property.writeOnly === true) {
    return (
      <div className={`field ${error ? "field-invalid" : ""}`} data-field={name}>
        <label htmlFor={id}>
          <span className="field-label">
            {label}
            {required && <span className="muted"> (required)</span>}
          </span>
          <input
            id={id}
            type="password"
            autoComplete="new-password"
            placeholder={writeOnlyStored && !dirty ? "••••••••" : ""}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        <p className="muted field-hint">
          {description && <>{description} </>}
          {writeOnlyStored ? (
            <em>Leave blank to keep the current value.</em>
          ) : (
            <em>Secret — sent only when saved.</em>
          )}
        </p>
        {error && <p className="error field-error">{error}</p>}
      </div>
    );
  }

  // String → text input.
  if (property.type === "string") {
    return (
      <div className={`field ${error ? "field-invalid" : ""}`} data-field={name}>
        <label htmlFor={id}>
          <span className="field-label">
            {label}
            {required && <span className="muted"> (required)</span>}
          </span>
          <input
            id={id}
            type="text"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        {description && <p className="muted field-hint">{description}</p>}
        {error && <p className="error field-error">{error}</p>}
      </div>
    );
  }

  // Number / integer → number input.
  if (property.type === "number" || property.type === "integer") {
    return (
      <div className={`field ${error ? "field-invalid" : ""}`} data-field={name}>
        <label htmlFor={id}>
          <span className="field-label">
            {label}
            {required && <span className="muted"> (required)</span>}
          </span>
          <input
            id={id}
            type="number"
            step={property.type === "integer" ? 1 : "any"}
            min={property.minimum}
            max={property.maximum}
            value={typeof value === "number" ? value : ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") onChange(undefined);
              else onChange(Number(raw));
            }}
          />
        </label>
        {description && <p className="muted field-hint">{description}</p>}
        {error && <p className="error field-error">{error}</p>}
      </div>
    );
  }

  // Fallback for schema shapes the renderer doesn't understand. Surface
  // a read-only debug view so the operator sees the field exists +
  // can edit via the underlying module's own admin UI / CLI.
  return (
    <div className="field" data-field={name}>
      <span className="field-label">
        {label} <span className="muted">(unsupported type)</span>
      </span>
      <pre className="muted">{JSON.stringify(property, null, 2)}</pre>
      {description && <p className="muted field-hint">{description}</p>}
    </div>
  );
}
