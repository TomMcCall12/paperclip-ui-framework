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
 * Reads a stored company-secret reference. Returns undefined when the value is
 * not one, and null as the id when the reference names no usable secret.
 */
function storedSecretRefId(value: unknown): string | null | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== "secret_ref") return undefined;
  return typeof record.secretId === "string" && record.secretId.length > 0 ? record.secretId : null;
}

/**
 * True when a Hermes gateway config names a stored company secret as its key.
 * A new gateway has no saved key to reuse, so such a reference would send an
 * existing secret to a gateway it was never saved for. Inspects shape only.
 */
export function hermesConfigUsesStoredSecret(adapterType: string, config: Record<string, unknown>): boolean {
  if (adapterType !== "hermes_gateway") return false;
  return HERMES_CREDENTIAL_KEYS.some((key) => storedSecretRefId(config[key]) !== undefined);
}

/**
 * True when a Hermes gateway config puts a stored company secret under the
 * `token` alias. Only `apiKey` is a schema secret field, so such a reference is
 * never resolved and the gateway would run without its key. Inspects shape only.
 */
export function hermesTokenAliasHoldsStoredSecret(adapterType: string, config: Record<string, unknown>): boolean {
  return adapterType === "hermes_gateway" && storedSecretRefId(config.token) !== undefined;
}

export const HERMES_TOKEN_ALIAS_STORED_SECRET_MESSAGE =
  "A stored Hermes gateway API key must be saved as apiKey, not token.";

/**
 * A saved Hermes agent may only name, as its gateway key, a stored company
 * secret its own saved Hermes config already names under either key alias.
 * Any other stored secret, including one another agent holds, would send a key
 * this agent was never saved with. A switch onto Hermes keeps no earlier
 * reference. Returns true when the change must be rejected. Inspects shape
 * only and runs before any secret is normalized, resolved, or sent.
 */
export function hermesConfigBorrowsStoredSecret(input: {
  existingAdapterType: string;
  existingConfig: Record<string, unknown>;
  nextAdapterType: string;
  nextConfig: Record<string, unknown>;
}): boolean {
  if (input.nextAdapterType !== "hermes_gateway") return false;
  const ownSecretIds = new Set(
    input.existingAdapterType === "hermes_gateway"
      ? HERMES_CREDENTIAL_KEYS.map((key) => storedSecretRefId(input.existingConfig[key])).filter(
        (id): id is string => typeof id === "string",
      )
      : [],
  );
  return HERMES_CREDENTIAL_KEYS.some((key) => {
    const secretId = storedSecretRefId(input.nextConfig[key]);
    return secretId !== undefined && (secretId === null || !ownSecretIds.has(secretId));
  });
}

export type HermesHireApprovalViolation = {
  code: "hermes_gateway_unbound_secret_ref" | "hermes_gateway_credential_rebind_required";
  message: string;
};

/** The agent a hire approval payload names, as stored. */
export type HermesHireApprovalTarget = {
  companyId: string;
  status: string;
  adapterType: string;
  adapterConfig: unknown;
};

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The agent id a hire approval payload activates, or null for a legacy payload that creates one. */
export function hireApprovalPayloadAgentId(payload: Record<string, unknown>): string | null {
  return typeof payload.agentId === "string" && payload.agentId.length > 0 ? payload.agentId : null;
}

export type HireApprovalTargetViolation = {
  code: "hire_approval_agent_not_pending";
  message: string;
};

/**
 * A hire approval that names an agent may only activate a pending agent of the
 * approval's own company, whatever its adapter. A missing agent and another
 * company's agent get the same answer, and the message names neither.
 */
export function hireApprovalTargetViolation(input: {
  companyId: string;
  payload: Record<string, unknown>;
  target: Pick<HermesHireApprovalTarget, "companyId" | "status"> | null;
}): HireApprovalTargetViolation | null {
  if (hireApprovalPayloadAgentId(input.payload) === null) return null;
  const { target } = input;
  if (target && target.companyId === input.companyId && target.status === "pending_approval") return null;
  return {
    code: "hire_approval_agent_not_pending",
    message: "A hire approval must name a pending agent in this company. Submit a new hire request instead.",
  };
}

/**
 * The adapter type a hire payload with no agent id creates, derived the same
 * way the approval decision does when it creates the agent.
 */
function hireApprovalPayloadCreatedAdapterType(payload: Record<string, unknown>): string {
  return String(payload.adapterType ?? "process");
}

/**
 * True when approving this hire payload could leave a Hermes gateway agent
 * behind, so its target agent must be read before the payload is judged. A
 * pending agent keeps its own adapter type unless the payload names one.
 */
export function hireApprovalPayloadMayTargetHermes(payload: Record<string, unknown>): boolean {
  if (hireApprovalPayloadAgentId(payload) === null) {
    return hireApprovalPayloadCreatedAdapterType(payload) === "hermes_gateway";
  }
  return typeof payload.adapterType !== "string" || payload.adapterType === "hermes_gateway";
}

/**
 * A hire approval applies its payload to the pending agent it names, or creates
 * a new agent when it names none. For a Hermes gateway result, the payload may
 * only keep a key the pending agent already holds, and only for the gateway it
 * was saved for. A payload with no pending agent has no saved key to keep, so
 * any stored company secret in it is rejected. When `requireAgentHire` is set,
 * a new Hermes agent must come from the agent hire flow, which saves its key
 * for its own gateway. Inspects shape only; never reveals secret values or ids.
 */
export function hermesHireApprovalViolation(input: {
  companyId: string;
  payload: Record<string, unknown>;
  target: HermesHireApprovalTarget | null;
  requireAgentHire: boolean;
}): HermesHireApprovalViolation | null {
  const { payload, target } = input;
  const payloadAdapterType = typeof payload.adapterType === "string" ? payload.adapterType : null;
  const payloadConfig = plainRecord(payload.adapterConfig);
  if (hireApprovalPayloadAgentId(payload) === null) {
    const createdAdapterType = hireApprovalPayloadCreatedAdapterType(payload);
    if (createdAdapterType !== "hermes_gateway") return null;
    if (input.requireAgentHire || hermesConfigUsesStoredSecret(createdAdapterType, payloadConfig ?? {})) {
      return {
        code: "hermes_gateway_unbound_secret_ref",
        message: "A new Hermes gateway agent must be requested through the agent hire flow "
          + "(POST /api/companies/:companyId/agent-hires) so its key is saved for its own gateway.",
      };
    }
    return null;
  }

  if (!target || target.companyId !== input.companyId || target.status !== "pending_approval") {
    return payloadAdapterType === "hermes_gateway"
      ? {
        code: "hermes_gateway_unbound_secret_ref",
        message: "A Hermes gateway hire approval must name a pending agent in this company.",
      }
      : null;
  }

  const existingConfig = plainRecord(target.adapterConfig) ?? {};
  const credentialInput = {
    existingAdapterType: target.adapterType,
    existingConfig,
    nextAdapterType: payloadAdapterType ?? target.adapterType,
    nextConfig: payloadConfig ?? existingConfig,
  };
  const rebindReason = hermesCredentialRebindReason(credentialInput);
  if (rebindReason) return { code: "hermes_gateway_credential_rebind_required", message: rebindReason };
  if (hermesTokenAliasHoldsStoredSecret(credentialInput.nextAdapterType, credentialInput.nextConfig)) {
    return { code: "hermes_gateway_unbound_secret_ref", message: HERMES_TOKEN_ALIAS_STORED_SECRET_MESSAGE };
  }
  if (hermesConfigBorrowsStoredSecret(credentialInput)) {
    return {
      code: "hermes_gateway_unbound_secret_ref",
      message: "This Hermes gateway can only use the stored key saved for it. Enter the gateway API key instead.",
    };
  }
  return null;
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
