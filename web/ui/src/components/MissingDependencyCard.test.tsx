/**
 * MissingDependencyCard tests — the dedicated install card the Modules
 * operations banner renders when an install fails because a required external
 * binary isn't on PATH.
 *
 * Covers:
 *   - heading + why subhead from the structured wire;
 *   - per-platform install commands rendered as copy blocks, with the
 *     detected-OS line emphasized (navigator.platform);
 *   - docs link + sysadmin hint;
 *   - Copy writing the real command to the clipboard;
 *   - the `renderOperationError` switch: install card for missing_dependency,
 *     verbatim error_description for an unrecognized type, plain error string
 *     when there's no structured detail.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissingDependencyWire } from "../lib/api.ts";
import { MissingDependencyCard, renderOperationError } from "./MissingDependencyCard.tsx";

const wire: MissingDependencyWire = {
  error: "missing_dependency",
  error_type: "missing_dependency",
  error_description: "git is required ...",
  binary: "git",
  why: "mirror your vault to a git remote",
  docs_url: "https://git-scm.com/downloads",
  install: {
    darwin: "brew install git",
    linux: "sudo apt-get install -y git\nsudo dnf install git",
  },
  sysadmin_hint: "Or ask your system administrator to install it for you.",
};

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  vi.clearAllMocks();
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setPlatform(p: string) {
  Object.defineProperty(navigator, "platform", { configurable: true, value: p });
}

describe("MissingDependencyCard", () => {
  it("renders heading, why, install commands, docs, and sysadmin hint", () => {
    setPlatform("MacIntel");
    render(<MissingDependencyCard wire={wire} />);
    expect(screen.getByText("git isn't installed")).toBeTruthy();
    expect(screen.getByText(/mirror your vault to a git remote/)).toBeTruthy();
    expect(screen.getByText("brew install git")).toBeTruthy();
    expect(screen.getByText(/sudo apt-get install -y git/)).toBeTruthy();
    expect(screen.getByText("Documentation").getAttribute("href")).toBe(
      "https://git-scm.com/downloads",
    );
    expect(screen.getByText(/system administrator/)).toBeTruthy();
  });

  it("emphasizes the macOS line when navigator.platform is mac", () => {
    setPlatform("MacIntel");
    const { container } = render(<MissingDependencyCard wire={wire} />);
    const preferred = container.querySelector(".depcard-install.preferred .depcard-os");
    expect(preferred?.textContent).toBe("macOS");
  });

  it("emphasizes the Linux line when navigator.platform is linux", () => {
    setPlatform("Linux x86_64");
    const { container } = render(<MissingDependencyCard wire={wire} />);
    const preferred = container.querySelector(".depcard-install.preferred .depcard-os");
    expect(preferred?.textContent).toBe("Linux");
  });

  it("Copy writes the command to the clipboard", async () => {
    setPlatform("MacIntel");
    render(<MissingDependencyCard wire={wire} />);
    const copyButtons = screen.getAllByRole("button", { name: /copy install command/i });
    fireEvent.click(copyButtons[0] as HTMLElement);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // The first (preferred) copy block is macOS → brew install git.
    expect(writeText).toHaveBeenCalledWith("brew install git");
  });

  it("omits the why/docs when the wire degrades them to null", () => {
    setPlatform("Win32");
    const degraded: MissingDependencyWire = {
      ...wire,
      binary: "frobnicate",
      why: null,
      docs_url: null,
      install: {},
    };
    render(<MissingDependencyCard wire={degraded} />);
    expect(screen.getByText("frobnicate isn't installed")).toBeTruthy();
    expect(screen.queryByText("Documentation")).toBeNull();
  });
});

describe("renderOperationError", () => {
  it("renders the install card for a missing_dependency error", () => {
    setPlatform("MacIntel");
    const { container } = render(renderOperationError({ errorDetail: wire }));
    expect(container.querySelector('[data-testid="missing-dependency-card"]')).toBeTruthy();
  });

  it("falls back to error_description for an unrecognized typed error", () => {
    render(
      renderOperationError({
        errorDetail: {
          error_type: "some_other_error",
          error_description: "something else went wrong",
        },
      }),
    );
    expect(screen.getByText("something else went wrong")).toBeTruthy();
  });

  it("falls back to the plain error string when there's no structured detail", () => {
    render(renderOperationError({ error: "bun add -g exited 1" }));
    expect(screen.getByText("bun add -g exited 1")).toBeTruthy();
  });

  it("returns null when there's nothing to show", () => {
    const { container } = render(renderOperationError({}));
    expect(container.textContent).toBe("");
  });
});
