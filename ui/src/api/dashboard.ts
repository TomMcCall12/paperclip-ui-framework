import type { DashboardSummary, PendingLabChanges } from "@paperclipai/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  pendingLabChanges: (companyId: string) =>
    api.get<PendingLabChanges>(`/companies/${companyId}/dashboard/pending-lab-changes`),
};
