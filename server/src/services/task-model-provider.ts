import {
  aiConnectionBindingSchema,
  aiConnectionForProvider,
  canSwitchModelProvider,
  MODEL_PROVIDER_LABELS,
  translateAdapterConfigForProvider,
  type ModelProviderAdapterType,
} from "@paperclipai/shared";

type AgentLike = { adapterType: string; adapterConfig: unknown; runtimeConfig: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The agent as it runs for one task that picks the other model provider
 * (`assigneeAdapterOverrides.adapterType`, Claude Code or Codex). It keeps the
 * agent's instructions, skills, secrets, folder and run limits; the task's own
 * `adapterConfig` (model, effort) is merged over this later, as for any task
 * override. Returns null when the task runs on the agent's own provider.
 */
export function agentForTaskProvider<T extends AgentLike>(agent: T, overrides: unknown): T | null {
  const requested = isRecord(overrides) ? overrides.adapterType : undefined;
  if (typeof requested !== "string" || requested === agent.adapterType) return null;
  if (!canSwitchModelProvider(agent.adapterType, requested)) return null;
  const from = agent.adapterType as ModelProviderAdapterType;
  const to = requested as ModelProviderAdapterType;
  const runtimeConfig: Record<string, unknown> = isRecord(agent.runtimeConfig) ? { ...agent.runtimeConfig } : {};
  const current = aiConnectionBindingSchema.safeParse(runtimeConfig.aiConnection).data ?? null;
  const binding = aiConnectionForProvider(to, current);
  if (binding) runtimeConfig.aiConnection = binding;
  else delete runtimeConfig.aiConnection;
  return {
    ...agent,
    adapterType: to,
    adapterConfig: translateAdapterConfigForProvider(from, to, isRecord(agent.adapterConfig) ? agent.adapterConfig : {}),
    runtimeConfig,
  };
}

/** One line for the run log, so the run says which provider ran it. */
export function taskProviderRunNote(agentAdapterType: string, taskAdapterType: string, model: unknown): string {
  const label = (type: string) => MODEL_PROVIDER_LABELS[type as ModelProviderAdapterType] ?? type;
  const modelPart = typeof model === "string" && model.trim() ? ` (${model.trim()})` : "";
  return `This task runs on ${label(taskAdapterType)}${modelPart} instead of the agent's usual ${label(agentAdapterType)}.`;
}
