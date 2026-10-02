// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentModelOptions } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentDefaultModelField } from "./AgentDefaultModelField";

const mockAgentsApi = vi.hoisted(() => ({
  modelOptions: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hermesOptions: AgentModelOptions = {
  adapterType: "hermes_gateway",
  runtimeLabel: "Hermes Gateway",
  provider: "openai-codex",
  source: "hermes_gateway",
  status: "available",
  message: null,
  currentModel: "gpt-6.1-sol",
  currentModelListed: true,
  defaultLabel: "Gateway default (gpt-6.1-sol)",
  models: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  ],
};

const roots: Root[] = [];

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  throw lastError;
}

function renderField(value: string, onChange = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AgentDefaultModelField agentId="agent-jarvis" companyId="company-1" value={value} onChange={onChange} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return { container, onChange };
}

function select(container: HTMLElement) {
  return container.querySelector('[data-testid="agent-default-model-select"]') as HTMLSelectElement | null;
}

describe("AgentDefaultModelField", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("offers only gateway-listed Hermes model ids and reports the runtime and provider", async () => {
    mockAgentsApi.modelOptions.mockResolvedValue(hermesOptions);
    const { container, onChange } = renderField("gpt-6.1-sol");

    await waitFor(() => expect(select(container)?.disabled).toBe(false));
    const control = select(container)!;
    expect(container.textContent).toContain("Default model");
    expect(Array.from(control.options).map((option) => [option.value, option.textContent])).toEqual([
      ["", "Gateway default (gpt-6.1-sol)"],
      ["gpt-6.1-sol", "GPT-6.1 Sol (gpt-6.1-sol)"],
      ["gpt-5.6-terra", "GPT-5.6 Terra (gpt-5.6-terra)"],
    ]);
    expect(control.value).toBe("gpt-6.1-sol");
    expect(container.textContent).toContain("Hermes Gateway");
    expect(container.textContent).toContain("openai-codex");
    expect(container.textContent).toContain("Listed by the Hermes gateway");
    expect(mockAgentsApi.modelOptions).toHaveBeenCalledWith("agent-jarvis", "company-1");

    act(() => {
      control.value = "gpt-5.6-terra";
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("gpt-5.6-terra");
  });

  it("keeps a saved model that the runtime no longer lists visible instead of substituting it", async () => {
    mockAgentsApi.modelOptions.mockResolvedValue({
      ...hermesOptions,
      currentModelListed: false,
      models: [{ id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }],
    });
    const { container } = renderField("gpt-6.1-sol");

    await waitFor(() => expect(select(container)?.disabled).toBe(false));
    const control = select(container)!;
    expect(control.value).toBe("gpt-6.1-sol");
    expect(control.selectedOptions[0]?.textContent).toBe("gpt-6.1-sol (saved, not listed by runtime)");
  });

  it("fails closed with the gateway's reason when supported models cannot be verified", async () => {
    mockAgentsApi.modelOptions.mockResolvedValue({
      ...hermesOptions,
      status: "auth_failed",
      message: "Hermes gateway rejected the configured API key (HTTP 401).",
      provider: null,
      defaultLabel: "Gateway default",
      currentModelListed: false,
      models: [],
    });
    const { container } = renderField("gpt-6.1-sol");

    await waitFor(() => expect(container.textContent).toContain("rejected the configured API key"));
    const control = select(container)!;
    expect(control.disabled).toBe(true);
    expect(control.value).toBe("gpt-6.1-sol");
    expect(container.textContent).not.toMatch(/authenticated/i);
  });

  it("disables the choice when the gateway does not list its current provider", async () => {
    mockAgentsApi.modelOptions.mockResolvedValue({
      ...hermesOptions,
      status: "invalid_response",
      message: 'Hermes gateway did not list models for its current provider "openai-codex".',
      provider: null,
      defaultLabel: "Gateway default",
      currentModelListed: false,
      models: [],
    });
    const { container } = renderField("gpt-6.1-sol");

    await waitFor(() => expect(container.textContent).toContain("did not list models for its current provider"));
    const control = select(container)!;
    expect(control.disabled).toBe(true);
    expect(control.value).toBe("gpt-6.1-sol");
    expect(Array.from(control.options).map((option) => option.value)).toEqual(["", "gpt-6.1-sol"]);
  });

  it("labels the Claude catalog as unverified rather than authenticated", async () => {
    mockAgentsApi.modelOptions.mockResolvedValue({
      adapterType: "claude_local",
      runtimeLabel: "Claude Code (local)",
      provider: "anthropic",
      source: "adapter_catalog",
      status: "unverified",
      message: "From Paperclip's Claude model catalog. This agent's Claude login is not verified here; use Test environment to check authentication.",
      currentModel: null,
      currentModelListed: false,
      defaultLabel: "Default (claude-opus-5)",
      models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }],
    } satisfies AgentModelOptions);
    const { container } = renderField("");

    await waitFor(() => expect(select(container)?.disabled).toBe(false));
    expect(select(container)!.value).toBe("");
    expect(container.textContent).toContain("Claude Code (local)");
    expect(container.textContent).toContain("Catalog, not verified");
  });

  it("surfaces a request failure instead of offering stale choices", async () => {
    mockAgentsApi.modelOptions.mockRejectedValue(new Error("Forbidden"));
    const { container } = renderField("gpt-6.1-sol");

    await waitFor(() => expect(container.textContent).toContain("Could not load supported models: Forbidden"));
    expect(select(container)!.disabled).toBe(true);
  });
});
