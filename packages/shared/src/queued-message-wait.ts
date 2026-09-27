const ACTION_REQUIRED_WAIT_REASONS = new Set([
  "execution_reconciliation_required",
  "adapter_evidence_missing",
  "adapter_changed",
  "retry_unavailable",
  "workspace_repair_required",
]);

/** Whether a saved queued message needs a user action before it can execute. */
export function queuedMessageWaitRequiresAction(reason: string | null | undefined): boolean {
  return typeof reason === "string" && ACTION_REQUIRED_WAIT_REASONS.has(reason);
}
