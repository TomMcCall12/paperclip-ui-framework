import type { Line, LineListStatus, PaginatedLines } from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

export const linesApi = {
  list(companyId: string, filters: { status: LineListStatus; q?: string; cursor?: string; limit?: number }, options?: RequestOptions) {
    const params = new URLSearchParams({ status: filters.status });
    if (filters.q) params.set("q", filters.q);
    if (filters.cursor) params.set("cursor", filters.cursor);
    if (filters.limit) params.set("limit", String(filters.limit));
    return api.get<PaginatedLines>(`/companies/${companyId}/lines?${params}`, options);
  },
  get(lineId: string, options?: RequestOptions) {
    return api.get<Line>(`/lines/${lineId}`, options);
  },
  setArchived(lineId: string, archived: boolean) {
    return api.patch<Line>(`/lines/${lineId}`, { archived });
  },
  retryNaming(lineId: string) {
    return api.post<Line>(`/lines/${lineId}/naming/retry`, {});
  },
};
