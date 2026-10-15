export type LineNamingStatus = "pending" | "generating" | "ready" | "failed";
export type LineListStatus = "active" | "completed" | "archived" | "all";
export type LineCompletionStatus = "active" | "completed" | "cancelled";

export interface Line {
  id: string;
  companyId: string;
  rootIssueId: string;
  rootIdentifier: string;
  rootTitle: string;
  name: string | null;
  /** Display only; `Line <root identifier>` is temporary while name is null. */
  displayName: string;
  namingStatus: LineNamingStatus;
  namingVersion: number;
  namingIssueId: string | null;
  namingAttempts: number;
  nextNamingAttemptAt: string | null;
  lastNamingErrorCode: string | null;
  namingModel: string | null;
  namingRunId: string | null;
  namedAt: string | null;
  createdByType: "agent" | "user" | "system";
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  completionStatus: LineCompletionStatus;
  visibleIssueCount: number;
  terminalIssueCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedLines {
  items: Line[];
  nextCursor: string | null;
}
