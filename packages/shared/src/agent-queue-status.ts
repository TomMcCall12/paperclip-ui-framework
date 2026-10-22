/**
 * Per-agent view of run load: how many runs are active against
 * maxConcurrentRuns, how many assigned todo/in_progress issues are waiting
 * for a free slot, and the longest-waiting one.
 */
export interface AgentQueueStatus {
  agentId: string;
  runningCount: number;
  maxConcurrentRuns: number;
  waitingCount: number;
  oldestWaitSeconds: number | null;
  oldestWaitIssueId: string | null;
  oldestWaitIssueIdentifier: string | null;
  oldestWaitIssueTitle: string | null;
}
