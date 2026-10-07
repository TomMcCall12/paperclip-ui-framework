import { canSwitchModelProvider } from "@paperclipai/shared";

/**
 * Issue `assigneeAdapterOverrides.adapterConfig` is merged over the assignee's
 * saved adapter config right before runtime secrets are resolved, and anyone
 * who can write the issue can set it. For adapters that send a saved credential
 * to a configured destination, or whose config controls what the agent may do
 * (tools, permissions, CLI arguments, working folder), only explicitly safe
 * task-level keys may be overridden. Every other key is rejected, so a key the
 * adapter adds later is not overridable by default.
 */
const nonEmptyString = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const isBoolean = (value: unknown) => typeof value === "boolean";
const positiveInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;
// Workspace strategy overrides carry commands; issue routes authorize them
// separately (collectIssueWorkspaceCommandPaths).
const isObject = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);

const SAFE_ISSUE_OVERRIDE_ADAPTER_CONFIG: Readonly<
  Record<string, Readonly<Record<string, (value: unknown) => boolean>>>
> = {
  // Hermes gateway sends its saved apiKey/token to apiBaseUrl/url; a task may
  // only pick the model.
  hermes_gateway: {
    model: nonEmptyString,
  },
  // Local coding agents: a task may pick the model, thinking effort and run
  // budget, never tools, permissions, CLI args, folder or environment, so a
  // task cannot widen what its assignee is allowed to do.
  claude_local: {
    model: nonEmptyString,
    effort: nonEmptyString,
    chrome: isBoolean,
    timeoutSec: positiveInteger,
    maxTurnsPerRun: positiveInteger,
    workspaceStrategy: isObject,
  },
  codex_local: {
    model: nonEmptyString,
    modelReasoningEffort: nonEmptyString,
    reasoningEffort: nonEmptyString,
    timeoutSec: positiveInteger,
    workspaceStrategy: isObject,
  },
  opencode_local: {
    model: nonEmptyString,
    variant: nonEmptyString,
    workspaceStrategy: isObject,
  },
};

export const ISSUE_ASSIGNEE_OVERRIDE_NOT_ALLOWED_CODE =
  "issue_assignee_override_not_allowed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The adapter a task runs its assignee on: the agent's own, or the other
 * local coding CLI when the task picks the other model provider.
 */
export function taskAdapterTypeFor(
  agentAdapterType: string | null | undefined,
  overrides: unknown,
): string | null | undefined {
  const requested = isRecord(overrides) ? overrides.adapterType : undefined;
  return typeof requested === "string" && canSwitchModelProvider(agentAdapterType, requested)
    ? requested
    : agentAdapterType;
}

/**
 * Returns why these issue overrides may not run on an assignee with this
 * adapter type, or null when they may. Names only the offending keys, never
 * values or the assignee's saved config. When the task picks the other model
 * provider, its settings are checked against that provider's CLI.
 */
export function issueAssigneeOverrideRejectionReason(
  agentAdapterType: string | null | undefined,
  overrides: unknown,
): string | null {
  if (isRecord(overrides) && overrides.adapterType !== undefined && overrides.adapterType !== agentAdapterType) {
    if (!canSwitchModelProvider(agentAdapterType, overrides.adapterType)) {
      return "Only Claude and OpenAI (Codex) agents can run a task on another model provider. " +
        "Remove adapterType from the task overrides, or assign the task to one of those agents.";
    }
  }
  const adapterType = taskAdapterTypeFor(agentAdapterType, overrides);
  const safeKeys = adapterType
    ? SAFE_ISSUE_OVERRIDE_ADAPTER_CONFIG[adapterType]
    : undefined;
  if (!safeKeys || !isRecord(overrides)) return null;
  const adapterConfig = overrides.adapterConfig;
  if (adapterConfig === undefined || adapterConfig === null) return null;
  const allowed = Object.keys(safeKeys).join(", ");
  if (!isRecord(adapterConfig)) {
    return `Task overrides for ${adapterType} agents must be an object that sets only: ${allowed}.`;
  }
  const rejected = Object.keys(adapterConfig)
    .filter((key) => !Object.hasOwn(safeKeys, key) || !safeKeys[key]!(adapterConfig[key]))
    .sort();
  if (rejected.length === 0) return null;
  return (
    `Task overrides for ${adapterType} agents may only set ${allowed}; ` +
    `not allowed: ${rejected.join(", ")}. Change connection settings on the agent instead.`
  );
}

export const ISSUE_TASK_MODEL_UNSUPPORTED_CODE = "issue_task_model_unsupported";

/** Adapters whose issue-level model must be offered by the assignee's live model list. */
const CATALOG_CHECKED_TASK_MODEL_ADAPTER_TYPES: ReadonlySet<string> = new Set(["hermes_gateway"]);

/**
 * Returns the issue-level model that must be checked against the assignee's
 * live model list, or null when there is none to check. Call only after
 * `issueAssigneeOverrideRejectionReason` has accepted the overrides.
 */
export function issueTaskModelToVerify(
  adapterType: string | null | undefined,
  overrides: unknown,
): string | null {
  if (!adapterType || !CATALOG_CHECKED_TASK_MODEL_ADAPTER_TYPES.has(adapterType)) return null;
  if (!isRecord(overrides) || !isRecord(overrides.adapterConfig)) return null;
  const model = overrides.adapterConfig.model;
  // The adapter trims the model it sends, so compare the trimmed id.
  return typeof model === "string" && model.trim().length > 0 ? model.trim() : null;
}

/**
 * Returns why `model` cannot run as this issue's task model, or null when the
 * assignee's model list is currently available and offers that exact id.
 * `options` is null when the list could not be fetched at all. Never echoes
 * the gateway's own message, which may name its host.
 */
export function issueTaskModelUnsupportedReason(
  options: { status: string; models: ReadonlyArray<{ id: string }> } | null,
  model: string,
): string | null {
  if (options?.status === "available" && options.models.some((option) => option.id === model)) {
    return null;
  }
  if (options?.status !== "available") {
    return (
      `Cannot use task model "${model}": the assignee's Hermes gateway model list could not be verified` +
      (options ? ` (${options.status})` : "") +
      ". Try again later, or leave the task model unset."
    );
  }
  return (
    `Task model "${model}" is not offered by the assignee's Hermes gateway for its current provider. ` +
    "Choose one of the models it lists, or leave the task model unset."
  );
}
