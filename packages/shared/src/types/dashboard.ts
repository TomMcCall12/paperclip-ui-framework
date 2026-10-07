export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  /**
   * True failures for the day, excluding process-loss/restart kills that were
   * later recovered by a successful retry (those are surfaced in `recovered`).
   */
  failed: number;
  /**
   * Runs that terminated in a failure state (failed/timed_out) but whose retry
   * chain eventually succeeded — e.g. restart-killed runs that recovered. Kept
   * out of `failed` so the headline failure count reflects true, unrecovered
   * failures.
   */
  recovered: number;
  other: number;
  total: number;
  /**
   * Per-error-code breakdown of the (true) `failed` count for the day, so a
   * spike can be attributed to an error class (e.g. `process_lost`,
   * `provider_quota`, `workspace_validation_failed`). Recovered runs are not
   * included here. Runs with no error code are bucketed under `unknown`.
   */
  failedByErrorCode: Record<string, number>;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
}

/** One change listed in the open "Rebuild queue: …" task's build table. */
export interface PendingLabChangeItem {
  /** The change's own description (the table's "Change" column). */
  title: string;
  /** The linked task's identifier, e.g. "TOM-167", when the row names one. */
  taskIdentifier: string | null;
  /** Href to the linked task, when `taskIdentifier` is set. */
  href: string | null;
  /** The table's raw "Task" cell when it does not link a task (e.g. "Lab session, 7 Oct"). */
  source: string | null;
}

/**
 * Where the queued rebuild is, inferred from the queue task's confirmation
 * status plus the host update command's own progress comment (prefixed
 * `**Tom's Lab updater:**`). There is no structured deploy-state field yet —
 * this is the best a reader of the task thread can tell, so it is re-derived
 * the same way a human would read it.
 */
export type PendingLabChangesDeployState =
  | "awaiting_approval"
  | "declined"
  | "expired"
  | "queued"
  | "building"
  | "live"
  | "rolled_back"
  | "failed";

export interface PendingLabChangesConfirmation {
  id: string;
  status: string;
  prompt: string;
  acceptLabel: string | null;
  rejectLabel: string | null;
}

export interface PendingLabChanges {
  issue: { id: string; identifier: string; title: string; href: string } | null;
  commit: string | null;
  branch: string | null;
  items: PendingLabChangeItem[];
  confirmation: PendingLabChangesConfirmation | null;
  deployState: PendingLabChangesDeployState | null;
}
