import type { AgentModelOptions } from "@paperclipai/shared";
import { DEFAULT_CLAUDE_LOCAL_MODEL } from "@paperclipai/adapter-claude-local";
import { listHermesGatewayModelOptions } from "@paperclipai/hermes-paperclip-adapter/gateway/server";
import { listAdapterModels } from "../adapters/index.js";

/** Adapter types whose existing agents get the validated Default model control. */
export const DEFAULT_MODEL_CONTROL_ADAPTER_TYPES: ReadonlySet<string> = new Set(["hermes_gateway", "claude_local"]);

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isBedrockModelId(id: string): boolean {
  return /^\w+\.anthropic\./.test(id) || id.startsWith("arn:aws:bedrock:");
}

/**
 * Resolves the default-model choices for one agent. `runtimeConfig` must be
 * the secret-resolved adapter config for Hermes; the resolved key is only sent
 * to the configured gateway and never appears in the returned value.
 */
export async function resolveAgentModelOptions(
  adapterType: string,
  runtimeConfig: Record<string, unknown>,
  currentModel: string | null,
): Promise<AgentModelOptions> {
  if (adapterType === "hermes_gateway") {
    const result = await listHermesGatewayModelOptions(runtimeConfig);
    return {
      adapterType,
      runtimeLabel: "Hermes Gateway",
      provider: result.provider,
      source: "hermes_gateway",
      status: result.status,
      message: result.message,
      currentModel,
      currentModelListed: Boolean(currentModel && result.models.some((model) => model.id === currentModel)),
      defaultLabel: result.gatewayModel ? `Gateway default (${result.gatewayModel})` : "Gateway default",
      models: result.models,
    };
  }

  const models = await listAdapterModels(adapterType);
  const bedrock = models.length > 0 && models.every((model) => isBedrockModelId(model.id));
  return {
    adapterType,
    runtimeLabel: "Claude Code (local)",
    provider: bedrock ? "aws-bedrock" : "anthropic",
    source: "adapter_catalog",
    status: models.length > 0 ? "unverified" : "invalid_response",
    message: models.length > 0
      ? "From Paperclip's Claude model catalog. This agent's Claude login is not verified here; use Test environment to check authentication."
      : "Paperclip's Claude model catalog is empty, so no model can be selected.",
    currentModel,
    currentModelListed: Boolean(currentModel && models.some((model) => model.id === currentModel)),
    defaultLabel: `Default (${DEFAULT_CLAUDE_LOCAL_MODEL})`,
    models,
  };
}

/** Returns why `model` cannot be saved as this agent's default, or null when it is supported. */
export function unsupportedDefaultModelReason(options: AgentModelOptions, model: string): string | null {
  if (options.models.some((option) => option.id === model)) return null;
  if (options.status !== "available" && options.status !== "unverified") {
    return `Cannot save default model "${model}": ${options.message ?? "supported models could not be verified."} The saved default was kept.`;
  }
  return options.source === "hermes_gateway"
    ? `Default model "${model}" is not offered by the Hermes gateway. Choose one of the models it lists.`
    : `Default model "${model}" is not in Paperclip's Claude model catalog. Choose a listed model id.`;
}
