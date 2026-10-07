// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { CostByProviderModel } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelFamilyUsageCard } from "./ModelFamilyUsageCard";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

function row(overrides: Partial<CostByProviderModel>): CostByProviderModel {
  return {
    provider: "anthropic",
    biller: "anthropic",
    billingType: "metered_api",
    model: "claude-sonnet-5",
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    apiRunCount: 0,
    subscriptionRunCount: 0,
    subscriptionCachedInputTokens: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
    ...overrides,
  };
}

describe("ModelFamilyUsageCard", () => {
  let container: HTMLDivElement;

  afterEach(() => {
    container?.remove();
  });

  function mount(rows: CostByProviderModel[]) {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => {
      root.render(<ModelFamilyUsageCard rows={rows} periodLabel="This month" />);
    });
    return container;
  }

  it("groups rows by model family and shows cost share", () => {
    const el = mount([
      row({ model: "claude-sonnet-5", costCents: 750, inputTokens: 1_000_000, outputTokens: 500_000, apiRunCount: 3 }),
      row({ provider: "openai", biller: "openai", model: "gpt-6-astra", costCents: 250, inputTokens: 200_000, outputTokens: 100_000, apiRunCount: 2 }),
    ]);

    expect(el.textContent).toContain("Claude");
    expect(el.textContent).toContain("GPT");
    expect(el.textContent).toContain("$7.50");
    expect(el.textContent).toContain("$2.50");
    expect(el.textContent).toContain("75%");
    expect(el.textContent).toContain("25%");
    expect(el.textContent).toContain("3 calls");
    expect(el.textContent).toContain("2 calls");
  });

  it("shows an empty state when there is no usage in the period", () => {
    const el = mount([]);
    expect(el.textContent).toContain("No model usage recorded this month.");
  });
});
