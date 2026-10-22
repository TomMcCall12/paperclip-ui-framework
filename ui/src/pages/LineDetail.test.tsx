// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Line } from "@paperclipai/shared";
import { LineDetail } from "./Lines";

function act(callback: () => void) {
  flushSync(callback);
}

const companyState = vi.hoisted(() => ({ companies: [], selectedCompanyId: "company-1" }));
const mockLinesApi = vi.hoisted(() => ({
  get: vi.fn(),
  setArchived: vi.fn(),
  retryNaming: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({ listAll: vi.fn(), listDocuments: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => companyState }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => companyState }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/lines", () => ({ linesApi: mockLinesApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ lineId: "line-1" }),
  useLocation: () => ({ pathname: "/lines/line-1", search: "" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync(() => {});
}
async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      assertion();
      return;
    } catch (e) {
      lastError = e;
      await flush();
    }
  }
  throw lastError;
}

function line(): Line {
  return {
    id: "line-1",
    companyId: "company-1",
    rootIssueId: "issue-1",
    rootIdentifier: "PAP-1",
    rootTitle: "Root task title",
    rootObjective: "Please build the thing exactly as described in this long pasted prompt.",
    rootStatus: "in_progress",
    name: "My Line",
    displayName: "My Line",
    namingStatus: "ready",
    namingVersion: 1,
    namingIssueId: null,
    namingAttempts: 1,
    nextNamingAttemptAt: null,
    lastNamingErrorCode: null,
    namingModel: null,
    namingRunId: null,
    namedAt: "2026-10-01T00:00:00.000Z",
    createdByType: "system",
    createdByAgentId: null,
    createdByUserId: null,
    createdByRunId: null,
    completionStatus: "active",
    visibleIssueCount: 1,
    terminalIssueCount: 0,
    blockedIssueCount: 0,
    reviewIssueCount: 0,
    lastTaskActivityAt: null,
    pendingApprovals: [],
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function renderPage(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <LineDetail />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("LineDetail", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockLinesApi.get.mockReset().mockResolvedValue(line());
    mockLinesApi.setArchived.mockReset();
    mockLinesApi.retryNaming.mockReset();
    mockIssuesApi.listAll.mockReset().mockResolvedValue([]);
    mockIssuesApi.listDocuments.mockReset().mockResolvedValue([]);
    mockAgentsApi.list.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    container.remove();
  });

  it("shows the Line name without the pasted root-task objective text beneath it", async () => {
    renderPage(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("My Line");
      expect(container.textContent).toContain("Root task: PAP-1");
    });

    expect(container.textContent).not.toContain("Please build the thing exactly as described in this long pasted prompt.");
    expect(container.textContent).not.toContain("No root objective supplied.");
  });
});
