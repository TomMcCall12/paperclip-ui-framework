// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingLabChangesDashboardCard } from "./PendingLabChangesDashboardCard";

const mockDashboardApi = vi.hoisted(() => ({
  pendingLabChanges: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  acceptInteraction: vi.fn(),
}));

const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/api/dashboard", () => ({
  dashboardApi: mockDashboardApi,
}));

vi.mock("@/api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function renderCard(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { root, queryClient };
}

describe("PendingLabChangesDashboardCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the empty state when nothing is queued", async () => {
    mockDashboardApi.pendingLabChanges.mockResolvedValue({
      issue: null,
      commit: null,
      branch: null,
      items: [],
      confirmation: null,
      deployState: null,
    });

    const { root, queryClient } = renderCard(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PendingLabChangesDashboardCard companyId="company-1" />
        </QueryClientProvider>,
      );
    });

    await waitForMicrotaskAssertion(() => {
      expect(container.textContent).toContain("No changes are queued for the next Tom's Lab build.");
    });
    expect(container.querySelector('[data-testid="pending-lab-changes-rebuild-button"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("lists queued items, the commit, and one Rebuild button when a confirmation is pending", async () => {
    mockDashboardApi.pendingLabChanges.mockResolvedValue({
      issue: { id: "issue-1", identifier: "TOM-177", title: "Rebuild queue: next build", href: "/issues/TOM-177" },
      commit: "5d4e540867cd",
      branch: "feat/terra-simple-autonomy",
      items: [
        {
          title: "Every Claude agent run writes an audit-trail log",
          taskIdentifier: "TOM-167",
          href: "/issues/TOM-167",
          source: null,
        },
      ],
      confirmation: {
        id: "interaction-1",
        status: "pending",
        prompt: "Rebuild and deploy Tom's Lab at commit 5d4e540867cd?",
        acceptLabel: "Rebuild now",
        rejectLabel: "Not yet",
      },
      deployState: "awaiting_approval",
    });

    const { root, queryClient } = renderCard(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PendingLabChangesDashboardCard companyId="company-1" />
        </QueryClientProvider>,
      );
    });

    await waitForMicrotaskAssertion(() => {
      expect(container.textContent).toContain("Every Claude agent run writes an audit-trail log");
      expect(container.textContent).toContain("5d4e540867cd");
      expect(container.textContent).toContain("Awaiting approval");
    });

    const rebuildButtons = container.querySelectorAll('[data-testid="pending-lab-changes-rebuild-button"]');
    expect(rebuildButtons).toHaveLength(1);

    await act(async () => root.unmount());
  });

  it("calls the generic accept-interaction endpoint when Rebuild is clicked", async () => {
    mockDashboardApi.pendingLabChanges.mockResolvedValue({
      issue: { id: "issue-1", identifier: "TOM-177", title: "Rebuild queue: next build", href: "/issues/TOM-177" },
      commit: "5d4e540867cd",
      branch: "feat/terra-simple-autonomy",
      items: [],
      confirmation: {
        id: "interaction-1",
        status: "pending",
        prompt: "Rebuild and deploy Tom's Lab at commit 5d4e540867cd?",
        acceptLabel: "Rebuild now",
        rejectLabel: "Not yet",
      },
      deployState: "awaiting_approval",
    });
    mockIssuesApi.acceptInteraction.mockResolvedValue({});

    const { root, queryClient } = renderCard(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PendingLabChangesDashboardCard companyId="company-1" />
        </QueryClientProvider>,
      );
    });

    const button = await (async () => {
      let found: Element | null = null;
      await waitForMicrotaskAssertion(() => {
        found = container.querySelector('[data-testid="pending-lab-changes-rebuild-button"]');
        expect(found).not.toBeNull();
      });
      return found as unknown as Element;
    })();

    await act(async () => {
      (button as HTMLButtonElement).click();
    });
    await flushReact();

    expect(mockIssuesApi.acceptInteraction).toHaveBeenCalledWith("issue-1", "interaction-1");

    await act(async () => root.unmount());
  });

  it("does not render a Rebuild button once the confirmation is no longer pending", async () => {
    mockDashboardApi.pendingLabChanges.mockResolvedValue({
      issue: { id: "issue-1", identifier: "TOM-177", title: "Rebuild queue: next build", href: "/issues/TOM-177" },
      commit: "5d4e540867cd",
      branch: "feat/terra-simple-autonomy",
      items: [],
      confirmation: {
        id: "interaction-1",
        status: "accepted",
        prompt: "Rebuild and deploy Tom's Lab at commit 5d4e540867cd?",
        acceptLabel: "Rebuild now",
        rejectLabel: "Not yet",
      },
      deployState: "building",
    });

    const { root, queryClient } = renderCard(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PendingLabChangesDashboardCard companyId="company-1" />
        </QueryClientProvider>,
      );
    });

    await waitForMicrotaskAssertion(() => {
      expect(container.textContent).toContain("Building");
    });
    expect(container.querySelector('[data-testid="pending-lab-changes-rebuild-button"]')).toBeNull();

    await act(async () => root.unmount());
  });
});
