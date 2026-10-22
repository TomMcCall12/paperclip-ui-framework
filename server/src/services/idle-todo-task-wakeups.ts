export const IDLE_TODO_TASK_WAKE_REASON = "idle_todo_task";

// A `todo` task counts as idle once this much time has passed since the
// issue was last touched (status/assignee change, comment, run activity —
// all of these bump `issues.updatedAt`) with no live execution path.
export const IDLE_TODO_TASK_IDLE_THRESHOLD_MS = 10 * 60 * 1000;

// At most one idle-todo-task wake per issue inside this window.
export const IDLE_TODO_TASK_WAKE_COOLDOWN_MS = 60 * 60 * 1000;

export type IdleTodoTaskCandidateIssue = {
  id: string;
  status: string;
  assigneeAgentId: string | null;
  updatedAt: Date;
};

export function isIssueIdleTodoTaskCandidate(
  issue: Pick<IdleTodoTaskCandidateIssue, "status" | "assigneeAgentId">,
): boolean {
  return issue.status === "todo" && Boolean(issue.assigneeAgentId);
}

export function isIdleTodoTaskStale(input: {
  lastActivityAt: Date;
  now: Date;
  idleThresholdMs?: number;
}): boolean {
  const thresholdMs = input.idleThresholdMs ?? IDLE_TODO_TASK_IDLE_THRESHOLD_MS;
  return input.now.getTime() - input.lastActivityAt.getTime() >= thresholdMs;
}

export function isIdleTodoTaskWakeCooldownActive(input: {
  lastWakeAt: Date | null | undefined;
  now: Date;
  cooldownMs?: number;
}): boolean {
  if (!input.lastWakeAt) return false;
  const cooldownMs = input.cooldownMs ?? IDLE_TODO_TASK_WAKE_COOLDOWN_MS;
  return input.now.getTime() - input.lastWakeAt.getTime() < cooldownMs;
}

// Pure decision for one candidate issue. Kept free of the database so every
// combination (stale/fresh, live/idle, invokable/paused, cooled-down/recent)
// can be asserted in milliseconds; the sweep only wires real snapshots in.
export function shouldWakeIdleTodoTask(input: {
  issue: IdleTodoTaskCandidateIssue;
  now: Date;
  hasLiveExecutionPath: boolean;
  agentInvokable: boolean;
  lastWakeAt: Date | null;
  idleThresholdMs?: number;
  cooldownMs?: number;
}): boolean {
  if (!isIssueIdleTodoTaskCandidate(input.issue)) return false;
  if (input.hasLiveExecutionPath) return false;
  if (!input.agentInvokable) return false;
  if (
    !isIdleTodoTaskStale({
      lastActivityAt: input.issue.updatedAt,
      now: input.now,
      idleThresholdMs: input.idleThresholdMs,
    })
  )
    return false;
  if (
    isIdleTodoTaskWakeCooldownActive({
      lastWakeAt: input.lastWakeAt,
      now: input.now,
      cooldownMs: input.cooldownMs,
    })
  )
    return false;
  return true;
}

export function buildIdleTodoTaskWakeIdempotencyKey(
  issueId: string,
  requestedAtIso: string,
) {
  return `${IDLE_TODO_TASK_WAKE_REASON}:${issueId}:${requestedAtIso}`;
}
