import { useQuery } from "@tanstack/react-query";
import type { AgentModelOptions } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { Field } from "./agent-config-primitives";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono disabled:opacity-60";

function availabilityLabel(options: AgentModelOptions): string {
  if (options.status === "available") {
    return options.source === "hermes_gateway" ? "Listed by the Hermes gateway" : "Listed by the runtime";
  }
  if (options.status === "unverified") return "Catalog, not verified";
  return "Unavailable";
}

/**
 * Default model picker for an existing agent. Choices come from the server's
 * per-agent model options (the Hermes gateway's own list, or Paperclip's
 * adapter catalog), so only real model ids can be selected. When the runtime
 * cannot confirm its models the control fails closed and shows why.
 */
export function AgentDefaultModelField({
  agentId,
  companyId,
  value,
  onChange,
}: {
  agentId: string;
  companyId?: string;
  value: string;
  onChange: (model: string) => void;
}) {
  const { data: options, error, isLoading } = useQuery({
    queryKey: queryKeys.agents.modelOptions(agentId),
    queryFn: () => agentsApi.modelOptions(agentId, companyId),
  });

  const selectable = Boolean(options && (options.status === "available" || options.status === "unverified"));
  const models = options?.models ?? [];
  const savedUnlisted = value && !models.some((model) => model.id === value) ? value : null;
  const errorMessage = error
    ? `Could not load supported models: ${error instanceof Error ? error.message : String(error)}`
    : null;
  const statusMessage = errorMessage ?? (options && !selectable ? options.message : null);

  return (
    <Field
      label="Default model"
      hint="Model this agent uses when a task does not override it. Only models the runtime reports as supported can be chosen."
    >
      <div className="space-y-1">
        <select
          data-testid="agent-default-model-select"
          aria-label="Default model"
          value={value}
          disabled={!selectable}
          onChange={(event) => onChange(event.target.value)}
          className={selectClass}
        >
          <option value="">{options?.defaultLabel ?? (isLoading ? "Loading models…" : "Runtime default")}</option>
          {savedUnlisted ? (
            <option value={savedUnlisted}>{`${savedUnlisted} (saved, not listed by runtime)`}</option>
          ) : null}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label === model.id ? model.id : `${model.label} (${model.id})`}
            </option>
          ))}
        </select>
        {options ? (
          <p className="text-xs text-muted-foreground">
            {options.runtimeLabel}
            {options.provider ? ` · ${options.provider}` : ""}
            {" · "}
            {availabilityLabel(options)}
            {selectable && options.message ? ` · ${options.message}` : ""}
          </p>
        ) : null}
        {statusMessage ? (
          <p role="alert" className="text-xs text-destructive">
            {statusMessage}
          </p>
        ) : null}
      </div>
    </Field>
  );
}
