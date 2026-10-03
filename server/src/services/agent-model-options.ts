import type { AgentModelOptions } from "@paperclipai/shared";
import { DEFAULT_CLAUDE_LOCAL_MODEL } from "@paperclipai/adapter-claude-local";
import {
  allowsInsecureRemoteHttp,
  listHermesGatewayModelOptions,
} from "@paperclipai/hermes-paperclip-adapter/gateway/server";
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

/** Config keys the Hermes gateway adapter sends to its gateway as the bearer credential. */
const HERMES_CREDENTIAL_KEYS = ["apiKey", "token"] as const;

/** Where a Hermes gateway config sends its key: the base URL plus the plain-HTTP opt-in. */
function hermesDestination(config: Record<string, unknown>): string {
  const raw = nonEmpty(config.apiBaseUrl ?? config.url) ?? "";
  let base = raw;
  try {
    const url = new URL(raw);
    base = `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    // Keep the raw value; an unparseable URL still has to match exactly.
  }
  return JSON.stringify([base, allowsInsecureRemoteHttp(config)]);
}

/** Identifies a credential value or secret reference without exposing it. */
function credentialIdentity(value: unknown): string | null {
  const plain = nonEmpty(value);
  if (plain) return `plain:${plain}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "secret_ref" && nonEmpty(record.secretId)) return `secret:${nonEmpty(record.secretId)}`;
  if (record.type === "user_secret_ref" && nonEmpty(record.key)) return `user:${nonEmpty(record.key)}`;
  if (record.type === "plain" && nonEmpty(record.value)) return `plain:${nonEmpty(record.value)}`;
  return `json:${JSON.stringify(record)}`;
}

/**
 * A saved Hermes key may only be sent to the gateway it was saved for. When a
 * change moves an agent to a different gateway URL or transport, or switches
 * it onto Hermes, any key the agent already holds must not come along: the
 * same save has to supply a new key. Returns why the change is rejected, or
 * null when it may proceed. Runs before any secret is resolved.
 */
export function hermesCredentialRebindReason(input: {
  existingAdapterType: string;
  existingConfig: Record<string, unknown>;
  nextAdapterType: string;
  nextConfig: Record<string, unknown>;
}): string | null {
  if (input.nextAdapterType !== "hermes_gateway") return null;
  if (
    input.existingAdapterType === "hermes_gateway"
    && hermesDestination(input.existingConfig) === hermesDestination(input.nextConfig)
  ) {
    return null;
  }
  const saved = new Set(
    HERMES_CREDENTIAL_KEYS.map((key) => credentialIdentity(input.existingConfig[key])).filter(Boolean),
  );
  const keepsSavedKey = HERMES_CREDENTIAL_KEYS.some((key) => {
    const identity = credentialIdentity(input.nextConfig[key]);
    return identity !== null && saved.has(identity);
  });
  return keepsSavedKey
    ? "Changing the Hermes gateway URL or transport requires a new API key in the same save. "
      + "The saved key is only sent to the gateway it was saved for."
    : null;
}

/**
 * True when a Hermes gateway config names a stored company secret as its key.
 * A new gateway has no saved key to reuse, so such a reference would send an
 * existing secret to a gateway it was never saved for. Inspects shape only.
 */
export function hermesConfigUsesStoredSecret(adapterType: string, config: Record<string, unknown>): boolean {
  if (adapterType !== "hermes_gateway") return false;
  return HERMES_CREDENTIAL_KEYS.some((key) => {
    const value = config[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && (value as Record<string, unknown>).type === "secret_ref";
  });
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
