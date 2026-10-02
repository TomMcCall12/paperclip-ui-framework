import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

/**
 * Refreshes the queries a successful agent configuration save can make stale.
 * The default model options depend on the saved gateway URL, key and adapter,
 * so they are reloaded once for this agent only.
 */
export function invalidateQueriesAfterAgentConfigSave(
  queryClient: QueryClient,
  agent: { id: string; companyId: string },
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
  queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
  queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.agents.modelOptions(agent.id), exact: true });
}
