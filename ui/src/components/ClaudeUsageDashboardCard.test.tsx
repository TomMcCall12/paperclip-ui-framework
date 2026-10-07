// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeUsageDashboardCard } from "./ClaudeUsageDashboardCard";

const quotaWindowsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/costs", () => ({
  costsApi: {
    quotaWindows: (c: string) => quotaWindowsMock(c),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("ClaudeUsageDashboardCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ClaudeUsageDashboardCard companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders Claude quota windows for the anthropic provider", async () => {
    quotaWindowsMock.mockResolvedValue([
      {
        provider: "anthropic",
        ok: true,
        source: "claude-code",
        windows: [
          { label: "Current session", usedPercent: 42, resetsAt: "2026-07-10T05:00:00Z", valueLabel: null },
          { label: "Current week (all models)", usedPercent: 61, resetsAt: "2026-07-14T00:00:00Z", valueLabel: null },
        ],
      },
      {
        provider: "openai",
        ok: true,
        source: null,
        windows: [{ label: "Current session", usedPercent: 10, resetsAt: null, valueLabel: null }],
      },
    ]);

    await render();

    expect(container.textContent).toContain("Claude usage");
    expect(container.textContent).toContain("Current session");
    expect(container.textContent).toContain("42% used");
    expect(container.textContent).toContain("Current week (all models)");
    expect(container.textContent).not.toContain("10% used");

    const link = container.querySelector<HTMLAnchorElement>("a");
    expect(link?.getAttribute("href")).toBe("/costs");
  });

  it("renders a graceful empty state when there is no Claude quota data", async () => {
    quotaWindowsMock.mockResolvedValue([]);

    await render();

    expect(container.textContent).toContain("No Claude quota data yet.");
  });

  it("renders a graceful error state when the quota request fails", async () => {
    quotaWindowsMock.mockRejectedValue(new Error("network down"));

    await render();

    expect(container.textContent).toContain("Claude usage is unavailable right now.");
  });
});
