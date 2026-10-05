/**
 * An agent's chat settings (`chatModel`, `chatEffort` in its adapter config),
 * applied only to Agent Chat conversations so quick back-and-forth can use a
 * cheaper model while task work keeps the agent's main model.
 */
export function chatModelConfigOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (typeof config.chatModel === "string" && config.chatModel.trim()) overrides.model = config.chatModel.trim();
  if (typeof config.chatEffort === "string" && config.chatEffort.trim()) overrides.effort = config.chatEffort.trim();
  return overrides;
}
