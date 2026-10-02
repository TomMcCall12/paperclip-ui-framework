// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDetail as AgentDetailRecord } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { AgentRevisionsTab } from "./AgentDetail";
import { AgentConfigurePage } from "./AgentDetail.production";
import { queryKeys } from "../lib/queryKeys";

const mockAgentsApi = vi.hoisted(() => ({
  listConfigRevisions: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  adapterModels: vi.fn(() => new Promise(() => {})),
  listKeys: vi.fn(() => new Promise(() => {})),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../components/AgentConfigForm", () => ({
  AgentConfigForm: () => <div data-testid="agent-config-form" />,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agent = {
  id: "agent-jarvis",
  companyId: "company-1",
  name: "Jarvis",
  urlKey: "jarvis",
  role: "engineer",
  status: "active",
  adapterType: "hermes_gateway",
  adapterConfig: {},
  runtimeConfig: {},
  permissions: {},
  access: { canAssignTasks: false, taskAssignSource: "none", membership: null, grants: [] },
} as unknown as AgentDetailRecord;

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

function render(node: ReactNode, queryClient: QueryClient) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/agents/jarvis/configuration"]}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <TooltipProvider>{node}</TooltipProvider>
          </ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  return container;
}

function buttonByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.includes(text));
  if (!button) throw new Error(`No "${text}" button`);
  return button as HTMLButtonElement;
}

function modelOptionInvalidations(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter(([filters]: unknown[]) =>
    JSON.stringify((filters as { queryKey?: unknown } | undefined)?.queryKey)
      === JSON.stringify(queryKeys.agents.modelOptions(agent.id)));
}

describe("agent configuration rollback", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "revisions tab",
      open: false,
      node: <AgentRevisionsTab agent={agent} companyId="company-1" />,
    },
    {
      name: "production configure page",
      open: true,
      node: (
        <AgentConfigurePage
          agent={agent}
          agentId={agent.id}
          companyId="company-1"
          onDirtyChange={vi.fn()}
          onSaveActionChange={vi.fn()}
          onCancelActionChange={vi.fn()}
          onSavingChange={vi.fn()}
          updatePermissions={{ mutate: vi.fn(), isPending: false }}
        />
      ),
    },
  ])("reloads this agent's default model options once after a $name restore", async ({ open, node }) => {
    mockAgentsApi.listConfigRevisions.mockResolvedValue([
      { id: "revision-1", createdAt: new Date(0).toISOString(), source: "patch", changedKeys: ["adapterConfig"] },
    ]);
    mockAgentsApi.rollbackConfigRevision.mockResolvedValue(agent);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const container = render(node, queryClient);
    if (open) {
      await waitFor(() => expect(buttonByText(container, "Configuration Revisions")).toBeTruthy());
      act(() => buttonByText(container, "Configuration Revisions").click());
    }
    await waitFor(() => expect(buttonByText(container, "Restore")).toBeTruthy());

    act(() => buttonByText(container, "Restore").click());

    await waitFor(() => expect(mockAgentsApi.rollbackConfigRevision).toHaveBeenCalledWith(agent.id, "revision-1", "company-1"));
    await waitFor(() => expect(modelOptionInvalidations(invalidate)).toHaveLength(1));
    expect(modelOptionInvalidations(invalidate)[0]?.[0]).toEqual({
      queryKey: queryKeys.agents.modelOptions(agent.id),
      exact: true,
    });
  });
});
