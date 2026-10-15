// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const getLine = vi.hoisted(() => vi.fn());
vi.mock("../api/lines", () => ({ linesApi: { get: getLine } }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a> }));
import { LineChip } from "./LineChip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("LineChip", () => {
  const container = document.createElement("div");
  afterEach(() => { container.replaceChildren(); getLine.mockReset(); });

  it("distinguishes equal names by root task and hides another company's cached result", async () => {
    getLine.mockImplementation((id: string) => Promise.resolve({ id, companyId: "company-a", displayName: "Review work", rootIdentifier: id === "line-a" ? "TOM-1" : "TOM-2" }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={client}><LineChip companyId="company-a" lineId="line-a" /><LineChip companyId="company-a" lineId="line-b" /></QueryClientProvider>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("Review work · TOM-1");
    expect(container.textContent).toContain("Review work · TOM-2");
    await act(async () => root.render(<QueryClientProvider client={client}><LineChip companyId="company-b" lineId="line-a" /></QueryClientProvider>));
    expect(container.textContent).not.toContain("Review work");
    await act(async () => root.unmount());
  });
});
