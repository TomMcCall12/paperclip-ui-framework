import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, Hammer, Loader2, RefreshCw } from "lucide-react";
import { Link } from "@/lib/router";
import { dashboardApi } from "@/api/dashboard";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { useToastActions } from "@/context/ToastContext";
import { interactionResolutionErrorMessage } from "@/lib/interaction-resolution-error";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

/**
 * State badge copy + color. Matches the palette `IssueThreadInteractionCard`
 * already uses for pending/accepted/declined confirmations, so a rebuild in
 * progress reads the same way here as it would on the queue task's own thread.
 */
const STATE_BADGE: Record<string, { label: string; className: string }> = {
  awaiting_approval: {
    label: "Awaiting approval",
    className: "border-sky-500/60 bg-sky-500/10 text-sky-900 dark:bg-sky-500/15 dark:text-sky-100",
  },
  queued: {
    label: "Queued",
    className: "border-sky-500/60 bg-sky-500/10 text-sky-900 dark:bg-sky-500/15 dark:text-sky-100",
  },
  building: {
    label: "Building…",
    className: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
  },
  live: {
    label: "Live",
    className: "border-emerald-500/60 bg-emerald-500/10 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-100",
  },
  rolled_back: {
    label: "Rolled back",
    className: "border-rose-500/60 bg-rose-500/10 text-rose-900 dark:bg-rose-500/15 dark:text-rose-100",
  },
  failed: {
    label: "Failed",
    className: "border-rose-500/60 bg-rose-500/10 text-rose-900 dark:bg-rose-500/15 dark:text-rose-100",
  },
  declined: {
    label: "Declined",
    className: "border-rose-500/60 bg-rose-500/10 text-rose-900 dark:bg-rose-500/15 dark:text-rose-100",
  },
  expired: {
    label: "Expired",
    className: "border-muted-foreground/30 bg-muted text-muted-foreground",
  },
};

/**
 * Dashboard surface for the open "Rebuild queue: …" task (toms-lab-self-update
 * skill). Reads the queue task's build table and its one pending confirmation
 * rather than owning any deploy state itself — "Rebuild" here IS Tom accepting
 * that confirmation, so the server's existing human-only resolver policy on the
 * interaction is what actually keeps an agent from triggering it; this card
 * only ever calls the same generic accept-interaction endpoint every other
 * confirmation card in the app uses.
 */
export function PendingLabChangesDashboardCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const query = useQuery({
    queryKey: queryKeys.pendingLabChanges(companyId),
    queryFn: () => dashboardApi.pendingLabChanges(companyId),
    enabled: !!companyId,
    // Poll while a rebuild could be moving through queued → building → live,
    // so the state updates without the board needing to reload the page.
    refetchInterval: 30_000,
  });

  const data = query.data;
  const confirmation = data?.confirmation;

  const accept = useMutation({
    mutationFn: () => {
      if (!data?.issue || !confirmation) throw new Error("Nothing to rebuild yet.");
      return issuesApi.acceptInteraction(data.issue.id, confirmation.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pendingLabChanges(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      pushToast({ title: "Rebuild started", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Could not start the rebuild",
        body: interactionResolutionErrorMessage(error, null),
        tone: "error",
      });
    },
  });

  if (query.isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm" data-testid="pending-lab-changes-dashboard-card">
        <p className="text-sm text-muted-foreground">Loading pending lab changes…</p>
      </div>
    );
  }

  if (query.isError || !data?.issue) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm" data-testid="pending-lab-changes-dashboard-card">
        <div className="flex items-center gap-2">
          <Hammer className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Pending lab changes</span>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4" />
          {query.isError ? "Pending lab changes are unavailable right now." : "No changes are queued for the next Tom's Lab build."}
        </p>
      </div>
    );
  }

  const state = data.deployState ? STATE_BADGE[data.deployState] : null;
  const canRebuild = confirmation?.status === "pending";

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm" data-testid="pending-lab-changes-dashboard-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Hammer className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Pending lab changes</span>
        </div>
        <Link
          to={data.issue.href}
          className="flex items-center gap-1 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground hover:text-foreground"
        >
          {data.issue.identifier}
          <ChevronRight className="h-3 w-3" />
        </Link>
      </div>

      {data.commit && (
        <p className="mt-1 text-xs text-muted-foreground">
          Commit <code className="font-mono">{data.commit}</code>
          {data.branch && (
            <>
              {" "}on <code className="font-mono">{data.branch}</code>
            </>
          )}
        </p>
      )}

      <ul className="mt-3 space-y-1.5">
        {data.items.map((item, index) => (
          <li key={`${item.title}-${index}`} className="flex items-start gap-2 text-sm">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
            <span className="min-w-0">
              <span className="text-foreground">{item.title}</span>
              {item.taskIdentifier && item.href && (
                <>
                  {" "}
                  <Link to={item.href} className="text-muted-foreground hover:text-foreground">
                    ({item.taskIdentifier})
                  </Link>
                </>
              )}
              {item.source && <span className="text-muted-foreground"> ({item.source})</span>}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center justify-between gap-3">
        {state ? (
          <Badge variant="outline" className={cn("border", state.className)}>
            {data.deployState === "building" && <Loader2 className="h-3 w-3 animate-spin" />}
            {state.label}
          </Badge>
        ) : (
          <span />
        )}

        {canRebuild && (
          <Button
            size="sm"
            disabled={accept.isPending}
            onClick={() => void accept.mutate()}
            data-testid="pending-lab-changes-rebuild-button"
          >
            {accept.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Rebuild
          </Button>
        )}
      </div>
    </div>
  );
}
