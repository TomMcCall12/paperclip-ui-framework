// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";
import { queryKeys } from "@/lib/queryKeys";

const api = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));

const companyId = "test-company";

describe("AiConnectionCredentialStep", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    api.create.mockResolvedValue({ connectionId: "conn-1", grantId: "grant-1" });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const key of [
      ["ai-connections", companyId],
      queryKeys.tools.applications(companyId),
      queryKeys.tools.connections(companyId),
      queryKeys.apps.gallery(companyId),
      queryKeys.apps.attention(companyId),
    ]) client.setQueryData(key, []);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
  });

  it("invalidates the Connectors page's tools and apps caches after an API-key connect, not just ai-connections", async () => {
    const onComplete = vi.fn();
    flushSync(() => root.render(
      <QueryClientProvider client={client}>
        <AiConnectionCredentialStep
          companyId={companyId}
          provider="openrouter"
          name=""
          ownership="shared"
          agentIds={[]}
          allAgents={false}
          onComplete={onComplete}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>,
    ));

    const nameInput = container.querySelector("input")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, "My key");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const keyInput = container.querySelectorAll("input")[1] as HTMLInputElement;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(keyInput, "sk-example-only");
      keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Connect")!.click());

    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => window.setTimeout(resolve, 0));
    flushSync(() => {});

    expect(onComplete).toHaveBeenCalled();
    const isStale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated === true;
    expect(isStale(["ai-connections", companyId])).toBe(true);
    expect(isStale(queryKeys.tools.applications(companyId))).toBe(true);
    expect(isStale(queryKeys.tools.connections(companyId))).toBe(true);
    expect(isStale(queryKeys.apps.gallery(companyId))).toBe(true);
    expect(isStale(queryKeys.apps.attention(companyId))).toBe(true);
  });
});
