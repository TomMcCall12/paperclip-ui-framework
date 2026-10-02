// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentModelOptions } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentDefaultModelField } from "../components/AgentDefaultModelField";
import { invalidateQueriesAfterAgentConfigSave } from "./agent-config-save";
import { queryKeys } from "./queryKeys";

const mockAgentsApi = vi.hoisted(() => ({
  modelOptions: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function hermesOptions(models: string[]): AgentModelOptions {
  return {
    adapterType: "hermes_gateway",
    runtimeLabel: "Hermes Gateway",
    provider: "openai-codex",
    source: "hermes_gateway",
    status: "available",
    message: null,
    currentModel: null,
    currentModelListed: false,
    defaultLabel: "Gateway default",
    models: models.map((id) => ({ id, label: id })),
  };
}

const roots: Root[] = [];

async function settle(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

function optionValues(container: HTMLElement, agentId: string) {
  const control = container.querySelector(`[data-agent="${agentId}"] [data-testid="agent-default-model-select"]`) as HTMLSelectElement | null;
  return control ? Array.from(control.options).map((option) => option.value) : [];
}

describe("invalidateQueriesAfterAgentConfigSave", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("reloads the saved agent's default model options once, and no other agent's", async () => {
    const gatewayModels: Record<string, string[]> = {
      "agent-jarvis": ["old-gateway-model"],
      "agent-other": ["other-model"],
    };
    mockAgentsApi.modelOptions.mockImplementation(async (agentId: string) => hermesOptions(gatewayModels[agentId] ?? []));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <div data-agent="agent-jarvis">
              <AgentDefaultModelField agentId="agent-jarvis" companyId="company-1" value="" onChange={vi.fn()} />
            </div>
            <div data-agent="agent-other">
              <AgentDefaultModelField agentId="agent-other" companyId="company-1" value="" onChange={vi.fn()} />
            </div>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(optionValues(container, "agent-jarvis")).toEqual(["", "old-gateway-model"]));
    await waitFor(() => expect(optionValues(container, "agent-other")).toEqual(["", "other-model"]));

    // The save pointed Jarvis at a different gateway.
    gatewayModels["agent-jarvis"] = ["new-gateway-model"];
    act(() => {
      invalidateQueriesAfterAgentConfigSave(queryClient, { id: "agent-jarvis", companyId: "company-1" });
    });

    await waitFor(() => expect(optionValues(container, "agent-jarvis")).toEqual(["", "new-gateway-model"]));
    await settle(50);
    const callsFor = (agentId: string) => mockAgentsApi.modelOptions.mock.calls.filter(([id]) => id === agentId).length;
    expect(callsFor("agent-jarvis")).toBe(2);
    expect(callsFor("agent-other")).toBe(1);
    expect(queryClient.getQueryState(queryKeys.agents.modelOptions("agent-jarvis"))?.isInvalidated).toBe(false);
  });
});
