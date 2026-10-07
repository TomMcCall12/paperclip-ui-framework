import { useQuery } from "@tanstack/react-query";
import {
  MODEL_PROVIDER_ADAPTER_TYPES,
  MODEL_PROVIDER_LABELS,
  type ModelProviderAdapterType,
} from "@paperclipai/shared";
import { DEFAULT_CLAUDE_LOCAL_MODEL } from "@paperclipai/adapter-claude-local";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { Field } from "./agent-config-primitives";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono disabled:opacity-60";

const SEPARATOR = "|";

/** `${adapterType}|${model}`; the model is empty for the provider's default. */
export function encodeProviderModel(adapterType: string, model: string) {
  return `${adapterType}${SEPARATOR}${model}`;
}

export function decodeProviderModel(value: string): { adapterType: ModelProviderAdapterType; model: string } | null {
  const index = value.indexOf(SEPARATOR);
  if (index < 0) return null;
  const adapterType = value.slice(0, index);
  if (!(MODEL_PROVIDER_ADAPTER_TYPES as readonly string[]).includes(adapterType)) return null;
  return { adapterType: adapterType as ModelProviderAdapterType, model: value.slice(index + 1) };
}

type ModelChoice = { id: string; label: string };

/**
 * One model list for agents that run on Claude Code or Codex, with a heading
 * per provider. Choosing a model under the other heading moves the agent to
 * that provider (see `onChange`); its instructions, skills, secrets and folder
 * stay as they are.
 *
 * A Claude agent's own Claude models come from its server-checked model
 * options, as on the single-provider picker; the other lists come from each
 * provider's catalog.
 */
export function ProviderModelField({
  agentId,
  companyId,
  adapterType,
  savedAdapterType,
  value,
  onChange,
}: {
  agentId: string;
  companyId?: string;
  /** The provider the form currently has selected. */
  adapterType: ModelProviderAdapterType;
  /** The provider the agent is saved with. */
  savedAdapterType: ModelProviderAdapterType;
  value: string;
  onChange: (adapterType: ModelProviderAdapterType, model: string) => void;
}) {
  const savedOnClaude = savedAdapterType === "claude_local";
  const claudeOptions = useQuery({
    queryKey: queryKeys.agents.modelOptions(agentId),
    queryFn: () => agentsApi.modelOptions(agentId, companyId),
    enabled: savedOnClaude,
  });
  const claudeCatalog = useQuery({
    queryKey: companyId
      ? queryKeys.agents.adapterModels(companyId, "claude_local", null, undefined)
      : ["agents", "none", "adapter-models", "claude_local"],
    queryFn: () => agentsApi.adapterModels(companyId!, "claude_local"),
    enabled: Boolean(companyId) && !savedOnClaude,
  });
  const openaiCatalog = useQuery({
    queryKey: companyId
      ? queryKeys.agents.adapterModels(companyId, "codex_local", null, undefined)
      : ["agents", "none", "adapter-models", "codex_local"],
    queryFn: () => agentsApi.adapterModels(companyId!, "codex_local"),
    enabled: Boolean(companyId),
  });

  const claudeSelectable = Boolean(
    claudeOptions.data && (claudeOptions.data.status === "available" || claudeOptions.data.status === "unverified"),
  );
  const lists: Record<ModelProviderAdapterType, ModelChoice[]> = {
    claude_local: savedOnClaude ? (claudeSelectable ? claudeOptions.data!.models : []) : claudeCatalog.data ?? [],
    codex_local: openaiCatalog.data ?? [],
  };
  const defaultLabels: Record<ModelProviderAdapterType, string> = {
    claude_local: (savedOnClaude ? claudeOptions.data?.defaultLabel : null) ?? `Default (${DEFAULT_CLAUDE_LOCAL_MODEL})`,
    codex_local: "Default",
  };
  const loading = claudeOptions.isLoading || claudeCatalog.isLoading || openaiCatalog.isLoading;
  const savedUnlisted = value && !lists[adapterType].some((model) => model.id === value) ? value : null;
  const switched = adapterType !== savedAdapterType;
  const claudeUnavailable = savedOnClaude && claudeOptions.data && !claudeSelectable ? claudeOptions.data.message : null;

  return (
    <Field
      label="Model"
      hint="Pick any Claude or OpenAI model. Choosing one under the other heading moves this agent to that provider; it keeps its instructions, skills, secrets and folder."
    >
      <div className="space-y-1">
        <select
          data-testid="provider-model-select"
          aria-label="Model"
          value={encodeProviderModel(adapterType, value)}
          onChange={(event) => {
            const next = decodeProviderModel(event.target.value);
            if (next) onChange(next.adapterType, next.model);
          }}
          className={selectClass}
        >
          {MODEL_PROVIDER_ADAPTER_TYPES.map((type) => (
            <optgroup key={type} label={MODEL_PROVIDER_LABELS[type]}>
              <option value={encodeProviderModel(type, "")}>{defaultLabels[type]}</option>
              {type === adapterType && savedUnlisted ? (
                <option value={encodeProviderModel(type, savedUnlisted)}>{`${savedUnlisted} (saved, not listed)`}</option>
              ) : null}
              {lists[type].map((model) => (
                <option key={model.id} value={encodeProviderModel(type, model.id)}>
                  {model.label === model.id ? model.id : `${model.label} (${model.id})`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {loading
            ? "Loading models…"
            : adapterType === "codex_local"
              ? "Runs on OpenAI (Codex) with the responsible person's connected ChatGPT/OpenAI account."
              : "Runs on Claude (Claude Code) with this agent's Claude login."}
          {claudeUnavailable ? ` Claude models: ${claudeUnavailable}` : ""}
          {switched && savedAdapterType === "claude_local"
            ? " When you save, Claude-only settings such as Chrome, Claude account connectors and the chat model are dropped."
            : switched
              ? " When you save, Codex-only settings are dropped."
              : ""}
        </p>
      </div>
    </Field>
  );
}
