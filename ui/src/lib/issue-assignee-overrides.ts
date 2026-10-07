import { canSwitchModelProvider } from "@paperclipai/shared";

export const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "opencode_local",
  "hermes_gateway",
]);

export type IssueModelLane = "primary" | "custom";

export interface BuildAssigneeAdapterOverridesInput {
  adapterType: string | null | undefined;
  lane: IssueModelLane;
  modelOverride: string;
  thinkingEffortOverride: string;
  chrome: boolean;
  /**
   * The provider this task runs on, when the assignee is a Claude (claude_local)
   * or OpenAI (codex_local) agent and the task picked the other provider's model.
   */
  taskAdapterType?: string | null;
}

/**
 * Build the `assigneeAdapterOverrides` payload sent to the issue create API.
 *
 * Lane semantics:
 * - "primary" → no overrides, runs on the agent's primary model.
 * - "custom"  → preserves the legacy explicit override path
 *               (`adapterConfig.model`, thinking effort, chrome).
 *
 * A `taskAdapterType` other than the assignee's own adds `adapterType`, so the
 * task runs on that provider; its settings then use that provider's keys.
 */
export function buildAssigneeAdapterOverrides(
  input: BuildAssigneeAdapterOverridesInput,
): Record<string, unknown> | null {
  const adapterType = input.adapterType ?? null;
  if (!adapterType || !ISSUE_OVERRIDE_ADAPTER_TYPES.has(adapterType)) {
    return null;
  }

  if (input.lane === "primary") {
    return null;
  }

  const switchesProvider = Boolean(input.taskAdapterType)
    && input.taskAdapterType !== adapterType
    && canSwitchModelProvider(adapterType, input.taskAdapterType);
  const runAdapterType = switchesProvider ? input.taskAdapterType! : adapterType;

  const adapterConfig: Record<string, unknown> = {};
  if (input.modelOverride) adapterConfig.model = input.modelOverride;
  if (input.thinkingEffortOverride) {
    if (runAdapterType === "codex_local") {
      adapterConfig.modelReasoningEffort = input.thinkingEffortOverride;
    } else if (runAdapterType === "opencode_local") {
      adapterConfig.variant = input.thinkingEffortOverride;
    } else if (runAdapterType === "claude_local") {
      adapterConfig.effort = input.thinkingEffortOverride;
    }
  }
  if (runAdapterType === "claude_local" && input.chrome) {
    adapterConfig.chrome = true;
  }

  if (switchesProvider) {
    return Object.keys(adapterConfig).length > 0
      ? { adapterType: runAdapterType, adapterConfig }
      : { adapterType: runAdapterType };
  }
  if (Object.keys(adapterConfig).length === 0) return null;
  return { adapterConfig };
}
