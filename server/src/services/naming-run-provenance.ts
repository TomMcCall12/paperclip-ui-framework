import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Shared by Line and task naming results. Returns the submitting run only when
 * it is the running, checked-out claude_local run of the hidden naming task
 * (matching origin), resolved to the expected Claude model with Anthropic
 * usage, and the submitted text was observed as a standalone provider message.
 */
export async function verifiedNamingRun(tx: any, input: {
  companyId: string;
  agentId: string;
  runId: string;
  task: typeof issues.$inferSelect | undefined;
  originKind: string;
  originId: string;
  submitted: unknown;
  model: string;
}): Promise<typeof heartbeatRuns.$inferSelect | null> {
  const { companyId, agentId, task, model } = input;
  const [run]: Array<typeof heartbeatRuns.$inferSelect> = await tx.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.agentId, agentId)));
  const dispatch = record(run?.contextSnapshot);
  const override = record(task?.assigneeAdapterOverrides);
  const config = record(override.adapterConfig);
  const usage = record(run?.usageJson);
  const providerMessages: Array<{ eventType: string; payload: unknown; sourceEventId: string | null }> = run
    ? await tx.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload, sourceEventId: heartbeatRunEvents.sourceEventId })
      .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, run.id),
        inArray(heartbeatRunEvents.eventType, ["item.completed", "line.naming.provider_message"])))
    : [];
  const submitted = typeof input.submitted === "string" ? input.submitted.trim() : null;
  const observed = submitted !== null && providerMessages.some((event) => {
    if (event.eventType === "line.naming.provider_message")
      return record(event.payload).textSha256 === createHash("sha256").update(submitted).digest("hex");
    if (!event.sourceEventId) return false;
    const providerEvent = record(record(event.payload).prpEvent);
    const message = record(providerEvent.payload);
    return (message.kind === "agentMessage" || message.kind === "assistant_message") &&
      typeof message.text === "string" && message.text.trim() === submitted;
  });
  const resolvedAdapter = dispatch.lineNamingResolvedAdapterType;
  if (!task || task.originKind !== input.originKind || task.originId !== input.originId || task.assigneeAgentId !== agentId || !run || run.status !== "running" || run.finishedAt || dispatch.issueId !== task.id || !run.startedAt ||
      (task.checkoutRunId !== run.id && task.executionRunId !== run.id) ||
      resolvedAdapter !== "claude_local" || dispatch.lineNamingResolvedModel !== model || override.adapterType !== "claude_local" || config.model !== model ||
      (usage.provider !== undefined && usage.provider !== "anthropic") || (usage.model !== undefined && usage.model !== model) || !observed)
    return null;
  return run;
}
