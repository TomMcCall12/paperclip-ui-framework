// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClaudeLocalAdvancedFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
];

function render(overrides: Partial<AdapterConfigFieldsProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const props: AdapterConfigFieldsProps = {
    mode: "edit",
    isCreate: false,
    adapterType: "claude_local",
    values: null,
    set: null,
    config: { model: "claude-opus-5-5", chatModel: "claude-sonnet-5" },
    eff: (_group, _field, original) => original,
    mark: vi.fn(),
    models: MODELS,
    ...overrides,
  };
  act(() => {
    root.render(
      <TooltipProvider>
        <ClaudeLocalAdvancedFields {...props} />
      </TooltipProvider>,
    );
  });
  return { container, root, props };
}

function selectFor(container: HTMLElement, label: string) {
  const field = Array.from(container.querySelectorAll("label"))
    .find((element) => element.textContent?.trim() === label)
    ?.closest("div")?.parentElement;
  return field?.querySelector("select") ?? null;
}

describe("Claude chat model settings", () => {
  const roots: Root[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("shows the chat model and lets the board change or clear it", () => {
    const { container, root, props } = render();
    roots.push(root);
    const select = selectFor(container, "Chat model");
    expect(select?.value).toBe("claude-sonnet-5");
    expect(Array.from(select!.options).map((option) => option.textContent)).toEqual([
      "Same as tasks", "Claude Opus 5.5", "Claude Sonnet 5",
    ]);

    act(() => {
      select!.value = "";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.mark).toHaveBeenCalledWith("adapterConfig", "chatModel", undefined);
    expect(selectFor(container, "Chat effort")?.value).toBe("");
  });

  it("is not offered when creating an agent", () => {
    const { container, root } = render({ isCreate: true, mode: "create", values: {} as never, set: vi.fn() });
    roots.push(root);
    expect(selectFor(container, "Chat model")).toBeNull();
  });
});
