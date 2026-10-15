import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }));
vi.mock("./client", () => ({ api: mockApi }));

import { linesApi } from "./lines";

describe("linesApi", () => {
  beforeEach(() => { mockApi.get.mockReset(); mockApi.patch.mockReset(); mockApi.post.mockReset(); });

  it("scopes list requests and preserves search and pagination", async () => {
    await linesApi.list("company-1", { status: "archived", q: "work & review", cursor: "next/page", limit: 10 });
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/lines?status=archived&q=work+%26+review&cursor=next%2Fpage&limit=10", undefined);
  });

  it("keeps archive and naming recovery as separate mutations", async () => {
    await linesApi.setArchived("line-1", false);
    await linesApi.retryNaming("line-1");
    expect(mockApi.patch).toHaveBeenCalledWith("/lines/line-1", { archived: false });
    expect(mockApi.post).toHaveBeenCalledWith("/lines/line-1/naming/retry", {});
  });
});
