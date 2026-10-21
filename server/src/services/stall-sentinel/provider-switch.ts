import type { ProviderQuotaSummary, QuotaWindowSummary } from "@paperclipai/shared";
import { taskAdapterTypeFor } from "../issue-assignee-override-guard.js";
import { PROVIDER_LOCKED_LABEL } from "./config.js";

/**
 * Provider usage rules for the stall sentinel.
 *
 * Board direction (21 Oct 2026): the sentinel never moves work from Claude to
 * OpenAI. When Claude is out of usage the step waits for the reset and the
 * board is told when it comes back. A task that a Claude-based agent would run
 * on OpenAI (a `codex_local` override or an OpenAI model) is moved back to
 * Claude. A task assigned to a Codex agent is provider-locked and only alerted.
 */

export type ProviderSlug = "anthropic" | "openai";

const MINUTE = 60_000;
/** Strict edges: 20% left or a reset exactly 60 minutes away is not "out". */
export const SESSION_OUT_PERCENT_LEFT = 20;
export const SESSION_OUT_RESET_HORIZON_MS = 60 * MINUTE;
export const WEEKLY_OUT_PERCENT_LEFT = 15;
export const QUOTA_CACHE_TTL_MS = 5 * MINUTE;
export const RECENT_USER_OVERRIDE_MS = 2 * 60 * MINUTE;

export function providerForAdapterType(adapterType: string | null | undefined): ProviderSlug | null {
  if (adapterType === "claude_local") return "anthropic";
  if (adapterType === "codex_local") return "openai";
  return null;
}

export function providerDisplayName(provider: ProviderSlug): string {
  return provider === "anthropic" ? "Claude" : "OpenAI";
}

/** The adapter a task runs on: the agent's own, or the other local CLI the task picked. */
export function effectiveAdapterType(agentAdapterType: string | null | undefined, overrides: unknown) {
  return taskAdapterTypeFor(agentAdapterType, overrides) ?? null;
}

interface ProviderWindows {
  session: QuotaWindowSummary | null;
  weekly: QuotaWindowSummary | null;
}

export function providerWindows(summary: ProviderQuotaSummary | null | undefined): ProviderWindows {
  if (!summary || !summary.ok) return { session: null, weekly: null };
  const weekly = summary.windows.find((w) => /week/i.test(w.label)) ?? null;
  const session = summary.windows.find((w) => w.resetsAt != null && !/week|credit|extra/i.test(w.label)) ?? null;
  return { session, weekly };
}

export interface ProviderOutState {
  out: boolean;
  /** When usage comes back: the session reset, or the weekly reset when the weekly window is the cause. */
  resetsAt: Date | null;
  reason: "session" | "weekly" | null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A provider is out when the session window has under 20% left and resets more
 * than 60 minutes from now, or the weekly window has under 15% left. Unknown
 * values never count as out.
 */
export function evaluateProviderOut(summary: ProviderQuotaSummary | null | undefined, now: Date): ProviderOutState {
  const { session, weekly } = providerWindows(summary);
  if (weekly?.percentLeft != null && weekly.percentLeft < WEEKLY_OUT_PERCENT_LEFT) {
    return { out: true, resetsAt: parseDate(weekly.resetsAt), reason: "weekly" };
  }
  const sessionReset = parseDate(session?.resetsAt);
  if (
    session?.percentLeft != null &&
    session.percentLeft < SESSION_OUT_PERCENT_LEFT &&
    sessionReset &&
    sessionReset.getTime() - now.getTime() > SESSION_OUT_RESET_HORIZON_MS
  ) {
    return { out: true, resetsAt: sessionReset, reason: "session" };
  }
  return { out: false, resetsAt: sessionReset, reason: null };
}

/** Next reset time known for the provider, used when a run already failed on usage. */
export function providerResetsAt(summary: ProviderQuotaSummary | null | undefined, now: Date): Date | null {
  const out = evaluateProviderOut(summary, now);
  return out.resetsAt;
}

const OPENAI_MODEL_PATTERN = /^(gpt-|o\d|codex)/i;

export function isOpenAiModel(model: unknown): boolean {
  return typeof model === "string" && OPENAI_MODEL_PATTERN.test(model.trim());
}

/** OpenAI-to-Claude half of the design's model map. */
export function mapOpenAiModelToClaude(
  model: string | null | undefined,
  effort: string | null | undefined,
): { model: string; effort: string | null } | null {
  const m = model?.trim().toLowerCase() ?? "";
  const e = effort?.trim().toLowerCase() ?? "";
  if (m === "gpt-5.4-mini") return { model: "claude-haiku-4-5", effort: null };
  if (m === "gpt-6-sol") {
    if (e === "xhigh" || e === "max") return { model: "claude-opus-5-5", effort: "high" };
    if (e === "medium" || e === "low" || e === "minimal") return { model: "claude-sonnet-5-5", effort: "medium" };
    return { model: "claude-sonnet-5-5", effort: "high" };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ClaudeRewritePlan {
  overrides: Record<string, unknown> | null;
  fromModel: string | null;
  toModel: string | null;
  toEffort: string | null;
}

/**
 * For a Claude-based agent whose task would run on OpenAI, returns the task
 * overrides that run it on Claude instead. Returns null when nothing must change.
 * Keys that only make sense on OpenAI are dropped; the workspace and run budget
 * keys stay.
 */
export function planClaudeRewrite(agentAdapterType: string | null | undefined, overrides: unknown): ClaudeRewritePlan | null {
  if (agentAdapterType !== "claude_local" || !isRecord(overrides)) return null;
  const adapterConfig = isRecord(overrides.adapterConfig) ? overrides.adapterConfig : {};
  const onCodex = overrides.adapterType === "codex_local";
  const openAiModel = isOpenAiModel(adapterConfig.model);
  if (!onCodex && !openAiModel) return null;

  const fromModel = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
  const fromEffort =
    typeof adapterConfig.modelReasoningEffort === "string"
      ? adapterConfig.modelReasoningEffort
      : typeof adapterConfig.reasoningEffort === "string"
        ? adapterConfig.reasoningEffort
        : null;
  const mapped = openAiModel ? mapOpenAiModelToClaude(fromModel, fromEffort) : null;

  const nextConfig: Record<string, unknown> = {};
  for (const key of ["timeoutSec", "workspaceStrategy", "chrome", "maxTurnsPerRun"] as const) {
    if (adapterConfig[key] !== undefined) nextConfig[key] = adapterConfig[key];
  }
  // A Claude model set on a codex override is kept: it was the Claude choice.
  if (!openAiModel && typeof adapterConfig.model === "string") nextConfig.model = adapterConfig.model;
  if (typeof adapterConfig.effort === "string" && !mapped) nextConfig.effort = adapterConfig.effort;
  if (mapped) {
    nextConfig.model = mapped.model;
    if (mapped.effort) nextConfig.effort = mapped.effort;
  }

  const next: Record<string, unknown> = {};
  if (overrides.useProjectWorkspace !== undefined) next.useProjectWorkspace = overrides.useProjectWorkspace;
  if (Object.keys(nextConfig).length > 0) next.adapterConfig = nextConfig;
  return {
    overrides: Object.keys(next).length > 0 ? next : null,
    fromModel,
    toModel: typeof nextConfig.model === "string" ? nextConfig.model : null,
    toEffort: typeof nextConfig.effort === "string" ? nextConfig.effort : null,
  };
}

export type ProviderLockReason = "codex_agent" | "label" | "recent_user_choice";

/**
 * A provider-locked task is never moved: its assignee is not a Claude agent
 * (and the task has no Claude override), it carries the `provider-locked`
 * label, or a person set its override in the last two hours.
 */
export function providerLockReason(input: {
  agentAdapterType: string | null | undefined;
  overrides: unknown;
  labelNames: readonly string[];
  lastUserOverrideAt: Date | null;
  now: Date;
}): ProviderLockReason | null {
  if (input.labelNames.some((name) => name.trim().toLowerCase() === PROVIDER_LOCKED_LABEL)) return "label";
  if (
    input.lastUserOverrideAt &&
    input.now.getTime() - input.lastUserOverrideAt.getTime() < RECENT_USER_OVERRIDE_MS
  ) {
    return "recent_user_choice";
  }
  if (input.agentAdapterType !== "claude_local") {
    const effective = effectiveAdapterType(input.agentAdapterType, input.overrides);
    if (effective !== "claude_local") return "codex_agent";
  }
  return null;
}

/** Five-minute cache over the quota providers, per company. */
export function createQuotaCache(
  fetchSummaries: (companyId: string) => Promise<ProviderQuotaSummary[]>,
  ttlMs = QUOTA_CACHE_TTL_MS,
) {
  const cache = new Map<string, { at: number; value: ProviderQuotaSummary[] }>();
  return async function get(companyId: string, now: Date): Promise<Map<string, ProviderQuotaSummary>> {
    const hit = cache.get(companyId);
    let value: ProviderQuotaSummary[];
    if (hit && now.getTime() - hit.at < ttlMs) {
      value = hit.value;
    } else {
      value = await fetchSummaries(companyId).catch(() => []);
      cache.set(companyId, { at: now.getTime(), value });
    }
    return new Map(value.map((summary) => [summary.provider, summary]));
  };
}
