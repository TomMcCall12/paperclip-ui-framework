import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Sparkles } from "lucide-react";
import { Link } from "@/lib/router";
import { costsApi } from "@/api/costs";
import { queryKeys } from "@/lib/queryKeys";
import { CodexSubscriptionPanel } from "./CodexSubscriptionPanel";

const OPENAI_PROVIDER = "openai";

/**
 * Compact dashboard surface for the ChatGPT/Codex subscription quota already
 * fetched for the Costs > Providers tab. Reuses that query and the panel
 * so the dashboard never has to know the quota response shape itself —
 * mirrors ClaudeUsageDashboardCard for the OpenAI provider.
 */
export function CodexUsageDashboardCard({ companyId }: { companyId: string }) {
  const quotaQuery = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    enabled: !!companyId,
    refetchInterval: 300_000,
    staleTime: 60_000,
    retry: false,
  });

  const openaiResult = quotaQuery.data?.find((result) => result.provider === OPENAI_PROVIDER);

  return (
    <div className="border border-border px-4 py-4" data-testid="codex-usage-dashboard-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">ChatGPT usage</span>
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
          <p className="text-sm text-muted-foreground">Loading ChatGPT usage…</p>
        ) : quotaQuery.isError ? (
          <p className="text-sm text-muted-foreground">ChatGPT usage is unavailable right now.</p>
        ) : openaiResult?.ok && openaiResult.windows.length > 0 ? (
          <CodexSubscriptionPanel
            windows={openaiResult.windows}
            source={openaiResult.source}
            error={null}
          />
        ) : openaiResult && !openaiResult.ok ? (
          <p className="text-sm text-muted-foreground">
            {openaiResult.error ?? "ChatGPT usage is unavailable right now."}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No ChatGPT quota data yet.</p>
        )}
      </div>
    </div>
  );
}
