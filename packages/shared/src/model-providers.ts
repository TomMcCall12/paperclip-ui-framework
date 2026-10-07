import { ADAPTER_AGNOSTIC_KEYS } from "./constants.js";
import type { AiConnectionBinding } from "./ai-connections.js";

/**
 * Local coding agents can run on either model provider's own CLI: Claude Code
 * (`claude_local`) or Codex (`codex_local`). An agent, or a single task, can
 * move between them; the agent keeps its instructions, skills, secrets,
 * folder and run limits, and only the provider-specific settings change.
 */
export const MODEL_PROVIDER_ADAPTER_TYPES = ["claude_local", "codex_local"] as const;
export type ModelProviderAdapterType = (typeof MODEL_PROVIDER_ADAPTER_TYPES)[number];

/** The headings people see for each provider's models. */
export const MODEL_PROVIDER_LABELS: Record<ModelProviderAdapterType, string> = {
  claude_local: "Claude",
  codex_local: "OpenAI",
};

export function isModelProviderAdapterType(value: unknown): value is ModelProviderAdapterType {
  return typeof value === "string" && (MODEL_PROVIDER_ADAPTER_TYPES as readonly string[]).includes(value);
}

/** True when an agent on `from` may run on `to` instead (both are local coding CLIs). */
export function canSwitchModelProvider(from: unknown, to: unknown): boolean {
  return isModelProviderAdapterType(from) && isModelProviderAdapterType(to);
}

const INSTRUCTIONS_BUNDLE_KEYS = [
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
] as const;

/** Run settings both CLIs understand, kept as they are. */
const SHARED_RUN_KEYS = ["workspaceStrategy"] as const;

/** The setting that holds each provider's thinking effort. */
export const MODEL_PROVIDER_EFFORT_KEY: Record<ModelProviderAdapterType, "effort" | "modelReasoningEffort"> = {
  claude_local: "effort",
  codex_local: "modelReasoningEffort",
};

const EFFORTS: Record<ModelProviderAdapterType, readonly string[]> = {
  claude_local: ["low", "medium", "high"],
  codex_local: ["minimal", "low", "medium", "high", "xhigh"],
};

function readEffort(adapterType: ModelProviderAdapterType, config: Record<string, unknown>): string {
  const raw = adapterType === "codex_local"
    ? config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort
    : config.effort;
  return typeof raw === "string" ? raw.trim() : "";
}

/** The closest thinking effort the other provider accepts, or "" for its default. */
export function translateThinkingEffort(
  from: ModelProviderAdapterType,
  to: ModelProviderAdapterType,
  effort: string,
): string {
  if (!effort) return "";
  if (EFFORTS[to].includes(effort)) return effort;
  if (to === "claude_local") {
    if (effort === "minimal") return "low";
    if (effort === "xhigh" || effort === "max") return "high";
  }
  if (to === "codex_local" && effort === "max") return "xhigh";
  return EFFORTS[from].includes(effort) ? "medium" : "";
}

/**
 * The adapter config for running an agent's saved config on another provider.
 * Keeps settings both CLIs share (environment and secrets, folder, run limits,
 * instructions, skills, workspace strategy), carries the thinking effort
 * across, sets `model`, and drops settings only the old CLI understands.
 */
export function translateAdapterConfigForProvider(
  from: ModelProviderAdapterType,
  to: ModelProviderAdapterType,
  config: Record<string, unknown>,
  model?: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of [...ADAPTER_AGNOSTIC_KEYS, ...INSTRUCTIONS_BUNDLE_KEYS, ...SHARED_RUN_KEYS]) {
    if (config[key] !== undefined) next[key] = config[key];
  }
  if (from === to) {
    Object.assign(next, config);
  } else {
    const effort = translateThinkingEffort(from, to, readEffort(from, config));
    if (effort) next[MODEL_PROVIDER_EFFORT_KEY[to]] = effort;
    // Both CLIs run unattended in Paperclip; keep the same standing.
    if (to === "codex_local") next.dangerouslyBypassApprovalsAndSandbox = config.dangerouslySkipPermissions !== false;
    if (to === "claude_local") next.dangerouslySkipPermissions = config.dangerouslyBypassApprovalsAndSandbox !== false;
  }
  if (model !== undefined) next.model = model;
  return next;
}

/**
 * The AI connection an agent uses on a provider. OpenAI runs use the
 * responsible person's connected ChatGPT/OpenAI account. Claude keeps an
 * existing Anthropic connection; otherwise it returns null, meaning the
 * Claude login on the agent's machine, which is how Claude agents work
 * unless set up otherwise.
 */
export function aiConnectionForProvider(
  to: ModelProviderAdapterType,
  current: AiConnectionBinding | null | undefined,
): AiConnectionBinding | null {
  if (to === "codex_local") {
    return current?.provider === "openai"
      ? current
      : { mode: "responsible_user", method: "subscription", provider: "openai" };
  }
  return current?.provider === "anthropic" ? current : null;
}
