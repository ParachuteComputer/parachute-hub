/**
 * /admin/modules/<short>/config — smoke tests for the generic
 * module-config form (hub#260).
 *
 * Covers:
 *   - initial loading state
 *   - schema + values fetched, scribe-shape form renders correctly
 *   - empty-state when module exposes no schema (404 no_config_schema)
 *   - empty-state when module not installed (raw 404)
 *   - submit sends only dirty fields (writeOnly-safe)
 *   - 4xx response surfaces field-level errors inline
 *   - writeOnly field renders as password input with placeholder
 *   - blank writeOnly + no dirty toggle = no PUT body inclusion
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { ModuleConfig } from "./ModuleConfig.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    getModuleConfigSchema: vi.fn(),
    getModuleConfigValues: vi.fn(),
    putModuleConfigValues: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderRoute(short = "scribe") {
  return render(
    <MemoryRouter initialEntries={[`/modules/${short}/config`]}>
      <Routes>
        <Route path="/modules/:short/config" element={<ModuleConfig />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Fixture mirroring scribe's actual `/.parachute/config/schema` output —
 * the golden test case the page must render correctly. Boolean + enum +
 * string + integer all in one schema so the renderer's switch hits every
 * branch.
 */
const SCRIBE_SCHEMA: api.ModuleConfigSchema = {
  type: "object",
  properties: {
    transcribeProvider: {
      type: "string",
      enum: ["parakeet-mlx", "groq", "openai"],
      title: "Transcription provider",
      description: "Engine used to turn audio into text.",
    },
    cleanupProvider: {
      type: "string",
      enum: ["none", "claude", "ollama"],
      title: "Cleanup provider",
    },
    cleanupDefault: {
      type: "boolean",
      title: "Run cleanup by default",
      description: "Applied when a request omits an explicit cleanup flag.",
    },
    port: {
      type: "integer",
      minimum: 1,
      maximum: 65535,
      title: "Server port",
    },
  },
  required: ["transcribeProvider"],
};

const SCRIBE_VALUES: api.ModuleConfigValues = {
  transcribeProvider: "parakeet-mlx",
  cleanupProvider: "none",
  cleanupDefault: true,
  port: 1943,
};

describe("ModuleConfig — load states", () => {
  it("shows loading on first paint", () => {
    vi.mocked(api.getModuleConfigSchema).mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.getModuleConfigValues).mockImplementation(() => new Promise(() => {}));
    renderRoute();
    expect(screen.getByText(/loading configuration/i)).toBeInTheDocument();
  });

  it("renders empty state when module exposes no config schema", async () => {
    vi.mocked(api.getModuleConfigSchema).mockResolvedValue(null);
    renderRoute();
    await waitFor(() =>
      expect(
        screen.getByText(/does not expose an operator-editable configuration schema/i),
      ).toBeInTheDocument(),
    );
    // No form rendered.
    expect(screen.queryByTestId("config-form")).not.toBeInTheDocument();
  });

  it("renders empty state when module not installed (404 without no_config_schema code)", async () => {
    vi.mocked(api.getModuleConfigSchema).mockRejectedValue(
      new api.HttpError(
        404,
        JSON.stringify({ error: "module_not_installed", error_description: "absent" }),
      ),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/is not installed on this hub/i)).toBeInTheDocument(),
    );
  });

  it("renders error + retry when schema fetch throws non-404", async () => {
    vi.mocked(api.getModuleConfigSchema).mockRejectedValue(new Error("network down"));
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/failed to load configuration/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("ModuleConfig — scribe golden fixture", () => {
  beforeEach(() => {
    vi.mocked(api.getModuleConfigSchema).mockResolvedValue(SCRIBE_SCHEMA);
    vi.mocked(api.getModuleConfigValues).mockResolvedValue(SCRIBE_VALUES);
  });

  it("renders one field per schema property with pre-filled values", async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("config-form")).toBeInTheDocument());

    // enum → select
    const provider = screen.getByLabelText(/transcription provider/i) as HTMLSelectElement;
    expect(provider.tagName).toBe("SELECT");
    expect(provider.value).toBe("parakeet-mlx");

    // boolean → checkbox, pre-checked
    const cleanupDefault = screen.getByLabelText(/run cleanup by default/i) as HTMLInputElement;
    expect(cleanupDefault.type).toBe("checkbox");
    expect(cleanupDefault.checked).toBe(true);

    // integer → number input
    const port = screen.getByLabelText(/server port/i) as HTMLInputElement;
    expect(port.type).toBe("number");
    expect(port.value).toBe("1943");

    // Required marker only on transcribeProvider.
    expect(screen.getByLabelText(/transcription provider/i).parentElement?.textContent).toMatch(
      /required/i,
    );
  });

  it("submit sends only dirty fields (writeOnly-safe shape)", async () => {
    vi.mocked(api.putModuleConfigValues).mockResolvedValue({ restart_required: [] });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("config-form")).toBeInTheDocument());

    // Change only the cleanup-default checkbox.
    const cleanupDefault = screen.getByLabelText(/run cleanup by default/i) as HTMLInputElement;
    fireEvent.click(cleanupDefault);

    fireEvent.submit(screen.getByTestId("config-form"));

    await waitFor(() => expect(api.putModuleConfigValues).toHaveBeenCalledTimes(1));
    const [shortArg, payload] = vi.mocked(api.putModuleConfigValues).mock.calls[0] ?? [];
    expect(shortArg).toBe("scribe");
    // Exactly the one field we changed — provider / port / cleanupProvider
    // must NOT be in the payload even though they're rendered.
    expect(payload).toEqual({ cleanupDefault: false });
  });

  it("rejects empty submit (no changes) with an inline error banner", async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("config-form")).toBeInTheDocument());
    fireEvent.submit(screen.getByTestId("config-form"));
    await waitFor(() =>
      expect(screen.getByTestId("save-error")).toHaveTextContent(/no changes to save/i),
    );
    // The PUT was never issued.
    expect(api.putModuleConfigValues).not.toHaveBeenCalled();
  });

  it("renders restart_required list on successful save", async () => {
    vi.mocked(api.putModuleConfigValues).mockResolvedValue({
      restart_required: ["transcribeProvider"],
    });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("config-form")).toBeInTheDocument());

    const provider = screen.getByLabelText(/transcription provider/i) as HTMLSelectElement;
    fireEvent.change(provider, { target: { value: "groq" } });
    fireEvent.submit(screen.getByTestId("config-form"));

    await waitFor(() => expect(screen.getByTestId("save-success")).toBeInTheDocument());
    expect(screen.getByTestId("save-success")).toHaveTextContent(/transcribeProvider/);
  });

  it("typing a field back to its original value un-dirties it (revert)", async () => {
    vi.mocked(api.putModuleConfigValues).mockResolvedValue({ restart_required: [] });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("config-form")).toBeInTheDocument());

    // Original transcribeProvider is "parakeet-mlx". Change to "groq",
    // then back to "parakeet-mlx". The PUT must NOT include the field.
    const provider = screen.getByLabelText(/transcription provider/i) as HTMLSelectElement;
    fireEvent.change(provider, { target: { value: "groq" } });
    fireEvent.change(provider, { target: { value: "parakeet-mlx" } });

    // Also touch the cleanup-default checkbox so the submit has *something*
    // dirty — otherwise the "no changes" early-exit short-circuits the PUT.
    const cleanupDefault = screen.getByLabelText(/run cleanup by default/i) as HTMLInputElement;
    fireEvent.click(cleanupDefault);

    fireEvent.submit(screen.getByTestId("config-form"));

    await waitFor(() => expect(api.putModuleConfigValues).toHaveBeenCalledTimes(1));
    const [, payload] = vi.mocked(api.putModuleConfigValues).mock.calls[0] ?? [];
    // Only the actually-changed field survives the revert.
    expect(payload).toEqual({ cleanupDefault: false });
    expect(payload).not.toHaveProperty("transcribeProvider");
  });

  it("4xx response surfaces field-level errors inline", async () => {
    vi.mocked(api.putModuleConfigValues).mockRejectedValue(
      new api.HttpError(
        400,
        JSON.stringify({
          error: "validation_failed",
          message: "Validation failed; see field errors.",
          errors: [
            { path: "transcribeProvider", message: "Must be one of parakeet-mlx, groq, openai" },
          ],
        }),
      ),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("config-form")).toBeInTheDocument());

    const provider = screen.getByLabelText(/transcription provider/i) as HTMLSelectElement;
    // Inject a value the server will reject.
    fireEvent.change(provider, { target: { value: "groq" } });
    fireEvent.submit(screen.getByTestId("config-form"));

    await waitFor(() =>
      expect(screen.getByTestId("save-error")).toHaveTextContent(/validation failed/i),
    );
    // Per-field error rendered next to the input.
    expect(screen.getByText(/must be one of parakeet-mlx/i)).toBeInTheDocument();
  });
});

describe("ModuleConfig — writeOnly fields", () => {
  /**
   * Forward-looking test: the canonical writeOnly UX. scribe's actual
   * schema doesn't ship a writeOnly field today, but the next module
   * (e.g. agent with API keys) will. This fixture mirrors what a
   * "groq API key" field would look like + asserts the rules:
   *
   *   - Renders as type=password
   *   - Placeholder shows when stored value exists but blank locally
   *   - Untouched (dirty=false) field is NOT sent on submit
   *   - User-typed value IS sent on submit
   */
  const WRITE_ONLY_SCHEMA: api.ModuleConfigSchema = {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        title: "API key",
        writeOnly: true,
        description: "Provider API key.",
      },
      name: {
        type: "string",
        title: "Display name",
      },
    },
  };

  it("renders writeOnly as password input with leave-blank placeholder when stored", async () => {
    vi.mocked(api.getModuleConfigSchema).mockResolvedValue(WRITE_ONLY_SCHEMA);
    // Server omits writeOnly fields from GET responses by convention.
    // SPA infers "stored" from "writeOnly=true AND value absent."
    vi.mocked(api.getModuleConfigValues).mockResolvedValue({ name: "scribe-1" });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("config-form")).toBeInTheDocument());

    const apiKey = screen.getByLabelText(/api key/i) as HTMLInputElement;
    expect(apiKey.type).toBe("password");
    expect(apiKey.value).toBe("");
    expect(apiKey.placeholder).toContain("•");
    // Hint copy points the operator at the leave-blank rule.
    expect(screen.getByText(/leave blank to keep the current value/i)).toBeInTheDocument();
  });

  it("untouched writeOnly field is NOT included in PUT payload", async () => {
    vi.mocked(api.getModuleConfigSchema).mockResolvedValue(WRITE_ONLY_SCHEMA);
    vi.mocked(api.getModuleConfigValues).mockResolvedValue({ name: "scribe-1" });
    vi.mocked(api.putModuleConfigValues).mockResolvedValue({});
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("config-form")).toBeInTheDocument());

    // Change only the name field (keep API key untouched).
    const name = screen.getByLabelText(/display name/i) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "scribe-renamed" } });
    fireEvent.submit(screen.getByTestId("config-form"));

    await waitFor(() => expect(api.putModuleConfigValues).toHaveBeenCalledTimes(1));
    const [, payload] = vi.mocked(api.putModuleConfigValues).mock.calls[0] ?? [];
    expect(payload).toEqual({ name: "scribe-renamed" });
    // API key key must be absent — leave-blank-to-preserve semantics.
    expect(payload).not.toHaveProperty("apiKey");
  });

  it("user-typed writeOnly value IS sent on submit", async () => {
    vi.mocked(api.getModuleConfigSchema).mockResolvedValue(WRITE_ONLY_SCHEMA);
    vi.mocked(api.getModuleConfigValues).mockResolvedValue({ name: "scribe-1" });
    vi.mocked(api.putModuleConfigValues).mockResolvedValue({});
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("config-form")).toBeInTheDocument());

    const apiKey = screen.getByLabelText(/api key/i) as HTMLInputElement;
    fireEvent.change(apiKey, { target: { value: "sk-new-secret" } });
    fireEvent.submit(screen.getByTestId("config-form"));

    await waitFor(() => expect(api.putModuleConfigValues).toHaveBeenCalledTimes(1));
    const [, payload] = vi.mocked(api.putModuleConfigValues).mock.calls[0] ?? [];
    expect(payload).toEqual({ apiKey: "sk-new-secret" });
  });
});

describe("ModuleConfig — $ref dereferencing (hub#303)", () => {
  /**
   * Integration check: a schema that uses `$ref` against a `definitions`
   * block must render the same as if the property were inlined. This is
   * the canonical use case scribe#47 worked around by inlining — once
   * scribe reverts to `$ref`, the SPA continues to render writeOnly /
   * required / hint copy correctly because the dereferenceSchema pass
   * runs first.
   */
  const REF_SCHEMA: api.ModuleConfigSchema = {
    type: "object",
    properties: {
      // {$ref, title} — sibling title overrides the definition's title,
      // exercising the merge path end-to-end.
      cleanup: {
        $ref: "#/definitions/apiKeyAndModel",
        title: "Cleanup credentials",
      } as unknown as api.ConfigSchemaProperty,
    },
    definitions: {
      apiKeyAndModel: {
        type: "string",
        writeOnly: true,
        title: "Generic API key",
        description: "Provider API key.",
      },
    },
  };

  it("renders a $ref-using schema as if the definition were inlined", async () => {
    vi.mocked(api.getModuleConfigSchema).mockResolvedValue(REF_SCHEMA);
    vi.mocked(api.getModuleConfigValues).mockResolvedValue({});
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("config-form")).toBeInTheDocument());

    // The sibling title wins — confirms the merge runs before render.
    const cleanup = screen.getByLabelText(/cleanup credentials/i) as HTMLInputElement;
    // writeOnly from the resolved definition propagates → password input.
    expect(cleanup.type).toBe("password");
    // Description from the definition survives the merge.
    expect(screen.getByText(/provider api key/i)).toBeInTheDocument();
  });

  it("surfaces an error state when the schema contains a broken $ref", async () => {
    const broken: api.ModuleConfigSchema = {
      type: "object",
      properties: {
        // Pointer at a definition that doesn't exist — dereferenceSchema throws.
        broken: { $ref: "#/definitions/missing" } as unknown as api.ConfigSchemaProperty,
      },
      definitions: {},
    };
    vi.mocked(api.getModuleConfigSchema).mockResolvedValue(broken);
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/schema \$ref resolution failed/i)).toBeInTheDocument(),
    );
    // No form rendered when the schema is unresolvable.
    expect(screen.queryByTestId("config-form")).not.toBeInTheDocument();
  });
});
