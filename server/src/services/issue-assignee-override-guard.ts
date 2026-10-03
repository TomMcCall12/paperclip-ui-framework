/**
 * Issue `assigneeAdapterOverrides.adapterConfig` is merged over the assignee's
 * saved adapter config right before runtime secrets are resolved, and anyone
 * who can write the issue can set it. For adapters that send a saved credential
 * to a configured destination, only explicitly safe task-level keys may be
 * overridden. Every other key is rejected, so a credential or transport key the
 * adapter adds later is not overridable by default.
 */
const SAFE_ISSUE_OVERRIDE_ADAPTER_CONFIG: Readonly<
  Record<string, Readonly<Record<string, (value: unknown) => boolean>>>
> = {
  // Hermes gateway sends its saved apiKey/token to apiBaseUrl/url; a task may
  // only pick the model.
  hermes_gateway: {
    model: (value) => typeof value === "string" && value.trim().length > 0,
  },
};

export const ISSUE_ASSIGNEE_OVERRIDE_NOT_ALLOWED_CODE =
  "issue_assignee_override_not_allowed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns why these issue overrides may not run on an assignee with this
 * adapter type, or null when they may. Names only the offending keys, never
 * values or the assignee's saved config.
 */
export function issueAssigneeOverrideRejectionReason(
  adapterType: string | null | undefined,
  overrides: unknown,
): string | null {
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
