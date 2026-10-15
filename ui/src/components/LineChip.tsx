import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { linesApi } from "../api/lines";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "@/components/ui/badge";

/** The company ID is part of the cache key and checked again before rendering. */
export function LineChip({ companyId, lineId, returnHref }: { companyId: string; lineId: string | null | undefined; returnHref?: string }) {
  const query = useQuery({
    queryKey: queryKeys.lines.detail(companyId, lineId ?? ""),
    queryFn: ({ signal }) => linesApi.get(lineId!, { signal }),
    enabled: !!lineId,
  });
  const line = query.data?.companyId === companyId && query.data.id === lineId ? query.data : null;
  if (!lineId) return null;
  return <Link
    to={returnHref?.startsWith("/") && !returnHref.startsWith("//") && returnHref.includes("/lines/") ? returnHref : `/lines/${lineId}`}
    onClick={(event) => event.stopPropagation()}
    className="relative z-10 inline-flex min-w-0 max-w-full items-center focus-visible:outline-ring"
    aria-label={`Open Line ${line ? `${line.displayName}, ${line.rootIdentifier}` : "details"}`}
    title={line ? `${line.displayName} · ${line.rootIdentifier}` : "Open Line"}
  ><Badge variant="outline" className="max-w-full truncate">{line ? `${line.displayName} · ${line.rootIdentifier}` : "Line"}</Badge></Link>;
}
