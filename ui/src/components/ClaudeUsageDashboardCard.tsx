import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Sparkles } from "lucide-react";
import { Link } from "@/lib/router";
import { costsApi } from "@/api/costs";
import { queryKeys } from "@/lib/queryKeys";
import { ClaudeSubscriptionPanel } from "./ClaudeSubscriptionPanel";

const ANTHROPIC_PROVIDER = "anthropic";

/**
 * Compact dashboard surface for the Anthropic subscription quota already
 * fetched for the Costs > Providers tab. Reuses that query and the panel
 * so the dashboard never has to know the quota response shape itself.
 */
export function ClaudeUsageDashboardCard({ companyId }: { companyId: string }) {
  const quotaQuery = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    enabled: !!companyId,
    refetchInterval: 300_000,
    staleTime: 60_000,
    retry: false,
  });

  const anthropicResult = quotaQuery.data?.find((result) => result.provider === ANTHROPIC_PROVIDER);

  return (
    <div className="border border-border px-4 py-4" data-testid="claude-usage-dashboard-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Claude usage</span>
        </div>
        <Link
          to="/costs"
          className="flex items-center gap-1 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground hover:text-foreground"
        >
          Costs
          <ChevronRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="mt-3">
        {quotaQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading Claude usage…</p>
        ) : quotaQuery.isError ? (
          <p className="text-sm text-muted-foreground">Claude usage is unavailable right now.</p>
        ) : anthropicResult?.ok && anthropicResult.windows.length > 0 ? (
          <ClaudeSubscriptionPanel
            windows={anthropicResult.windows}
            source={anthropicResult.source}
            error={null}
          />
        ) : anthropicResult && !anthropicResult.ok ? (
          <p className="text-sm text-muted-foreground">
            {anthropicResult.error ?? "Claude usage is unavailable right now."}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No Claude quota data yet.</p>
        )}
      </div>
    </div>
  );
}
