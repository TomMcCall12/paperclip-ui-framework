import { useMemo } from "react";
import type { CostByProviderModel } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { classifyModelFamily, formatCents, formatTokens, MODEL_FAMILY_LABELS, type ModelFamily } from "@/lib/utils";

interface ModelFamilyUsageCardProps {
  rows: CostByProviderModel[];
  /** Label for the aggregation period shown, e.g. "This month". */
  periodLabel: string;
}

interface FamilyTotals {
  family: ModelFamily;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  callCount: number;
}

const FAMILY_ORDER: ModelFamily[] = ["claude", "gpt", "other"];

function aggregateByFamily(rows: CostByProviderModel[]): FamilyTotals[] {
  const totals = new Map<ModelFamily, FamilyTotals>();
  for (const row of rows) {
    const family = classifyModelFamily(row.model);
    const current = totals.get(family) ?? {
      family,
      costCents: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      callCount: 0,
    };
    current.costCents += row.costCents;
    current.inputTokens += row.inputTokens;
    current.cachedInputTokens += row.cachedInputTokens;
    current.outputTokens += row.outputTokens;
    current.callCount += row.apiRunCount + row.subscriptionRunCount;
    totals.set(family, current);
  }
  return FAMILY_ORDER.map((family) => totals.get(family)).filter(
    (entry): entry is FamilyTotals => entry !== undefined,
  );
}

export function ModelFamilyUsageCard({ rows, periodLabel }: ModelFamilyUsageCardProps) {
  const families = useMemo(() => aggregateByFamily(rows), [rows]);
  const totalCostCents = families.reduce((sum, entry) => sum + entry.costCents, 0);

  return (
    <Card className="block">
      <CardHeader className="px-5 pt-5 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Model usage</CardTitle>
            <CardDescription>Claude and GPT spend, tokens, and calls — {periodLabel.toLowerCase()}.</CardDescription>
          </div>
          <Link to="/costs" className="text-sm underline underline-offset-2 text-muted-foreground shrink-0">
            View providers
          </Link>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">
        {families.length === 0 ? (
          <p className="text-sm text-muted-foreground">No model usage recorded {periodLabel.toLowerCase()}.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {families.map((entry) => {
              const sharePct = totalCostCents > 0 ? Math.round((entry.costCents / totalCostCents) * 100) : 0;
              return (
                <div key={entry.family} role="group" aria-label={`${MODEL_FAMILY_LABELS[entry.family]} usage`} className="border border-border px-4 py-3">
                  <div className="text-sm font-medium text-foreground">{MODEL_FAMILY_LABELS[entry.family]}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums">
                    {formatCents(entry.costCents)}
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">({sharePct}%)</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatTokens(entry.inputTokens + entry.cachedInputTokens)} in · {formatTokens(entry.outputTokens)} out
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {entry.callCount} call{entry.callCount === 1 ? "" : "s"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
