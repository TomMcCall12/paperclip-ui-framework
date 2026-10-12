// @vitest-environment jsdom

import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueScheduledCheck } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IssueScheduledChecksBadge,
  IssueScheduledChecksSection,
} from "./IssueScheduledChecks";

const mockIssuesApi = vi.hoisted(() => ({
  listScheduledChecks: vi.fn(),
  createScheduledCheck: vi.fn(),
  updateScheduledCheck: vi.fn(),
  deleteScheduledCheck: vi.fn(),
  runScheduledCheckNow: vi.fn(),
}));

vi.mock("../../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

function baseCheck(overrides: Partial<IssueScheduledCheck> = {}): IssueScheduledCheck {
  return {
    id: "check-1",
    companyId: "company-1",
    issueId: "issue-1",
    nextCheckAt: "2026-05-01T09:00:00.000Z",
    notes: "Check the deploy",
    createdByAgentId: null,
    createdByUserId: "tom",
    createdByAgentName: null,
    status: "scheduled",
    attemptCount: 0,
    lastTriggeredAt: null,
    recurrenceCron: null,
    recurrenceTimezone: null,
    cancelOnComment: false,
    isPrimary: false,
    cancelledAt: null,
    cancelReason: null,
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
    ...overrides,
  };
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderWithClient(node: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    queryClient,
    render: () =>
      act(() => {
        root.render(
          <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
        );
      }),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("IssueScheduledChecksSection", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists every scheduled check-in, not just one, with notes and who set it", async () => {
    mockIssuesApi.listScheduledChecks.mockResolvedValue([
      baseCheck({ id: "a", nextCheckAt: "2026-05-01T09:00:00.000Z", notes: "Morning check" }),
      baseCheck({ id: "b", nextCheckAt: "2026-05-02T09:00:00.000Z", notes: "Next-day check", createdByAgentName: "CodexCoder", createdByUserId: null }),
    ]);

    const { container, render, unmount } = renderWithClient(
      <IssueScheduledChecksSection issueId="issue-1" />,
    );
    await render();
    await waitForAssertion(() => {
      const rows = container.querySelectorAll('[data-testid="issue-scheduled-check-row"]');
      expect(rows.length).toBe(2);
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Morning check");
    expect(text).toContain("Next-day check");
    expect(text).toContain("CodexCoder");
    unmount();
  });

  it("shows a recurring badge and the Primary badge for the back-compat row", async () => {
    mockIssuesApi.listScheduledChecks.mockResolvedValue([
      baseCheck({ id: "primary", isPrimary: true, recurrenceCron: "30 8 * * 1", recurrenceTimezone: "UTC" }),
    ]);

    const { container, render, unmount } = renderWithClient(
      <IssueScheduledChecksSection issueId="issue-1" />,
    );
    await render();
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Recurring");
      expect(container.textContent).toContain("Primary");
    });
    unmount();
  });

  it("creates a new check-in via the add form", async () => {
    mockIssuesApi.listScheduledChecks.mockResolvedValue([]);
    mockIssuesApi.createScheduledCheck.mockResolvedValue(baseCheck({ id: "new" }));

    const { container, render, unmount } = renderWithClient(
      <IssueScheduledChecksSection issueId="issue-1" />,
    );
    await render();
    await waitForAssertion(() => {
      expect(container.textContent).toContain("No scheduled check-ins.");
    });

    const addButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Add",
    ) as HTMLButtonElement;
    await act(() => addButton.click());

    const dateInput = container.querySelector<HTMLInputElement>("#scheduled-check-at");
    expect(dateInput).toBeTruthy();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(() => {
      nativeInputValueSetter.call(dateInput, "2026-06-01T09:00");
      dateInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save",
    ) as HTMLButtonElement;
    await act(() => saveButton.click());
    await flush();

    expect(mockIssuesApi.createScheduledCheck).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ nextCheckAt: expect.stringContaining("2026-06-01") }),
    );
    unmount();
  });

  it("deletes (cancels) a check-in", async () => {
    mockIssuesApi.listScheduledChecks.mockResolvedValue([baseCheck({ id: "to-delete" })]);
    mockIssuesApi.deleteScheduledCheck.mockResolvedValue({ ok: true });

    const { container, render, unmount } = renderWithClient(
      <IssueScheduledChecksSection issueId="issue-1" />,
    );
    await render();
    await waitForAssertion(() => {
      expect(container.querySelectorAll('[data-testid="issue-scheduled-check-row"]').length).toBe(1);
    });

    const deleteButton = container.querySelector<HTMLButtonElement>('button[title="Delete"]');
    await act(() => deleteButton!.click());
    await flush();

    expect(mockIssuesApi.deleteScheduledCheck).toHaveBeenCalledWith("issue-1", "to-delete");
    unmount();
  });
});

describe("IssueScheduledChecksBadge", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows nothing when there are no pending check-ins", async () => {
    mockIssuesApi.listScheduledChecks.mockResolvedValue([]);
    const { container, render, unmount } = renderWithClient(
      <IssueScheduledChecksBadge issueId="issue-1" />,
    );
    await render();
    await flush();
    expect(container.querySelector('[data-testid="issue-scheduled-checks-badge"]')).toBeNull();
    unmount();
  });

  it("shows a count and goes amber once a check-in is overdue", async () => {
    mockIssuesApi.listScheduledChecks.mockResolvedValue([
      baseCheck({ id: "a", nextCheckAt: new Date(Date.now() - 60_000).toISOString() }),
      baseCheck({ id: "b", nextCheckAt: new Date(Date.now() + 60_000 * 60).toISOString() }),
    ]);
    const { container, render, unmount } = renderWithClient(
      <IssueScheduledChecksBadge issueId="issue-1" />,
    );
    await render();
    await waitForAssertion(() => {
      const badge = container.querySelector('[data-testid="issue-scheduled-checks-badge"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toContain("2");
      expect(badge?.className).toContain("amber");
    });
    unmount();
  });
});
