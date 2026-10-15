import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, LineListStatus } from "@paperclipai/shared";
import { Link, useLocation, useParams, useSearchParams } from "@/lib/router";
import { ArrowLeft, GitMerge } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { linesApi } from "../api/lines";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "../lib/utils";

const statuses: LineListStatus[] = ["active", "completed", "archived", "all"];

function useRouteCompanyId() {
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const { companies, selectedCompanyId } = useCompany();
  return companyPrefix
    ? companies.find((company) => company.issuePrefix.toLowerCase() === companyPrefix.toLowerCase())?.id ?? null
    : selectedCompanyId;
}

function Progress({ done, total }: { done: number; total: number }) {
  return <span className="text-sm text-muted-foreground">{done} of {total} tasks finished</span>;
}

function ErrorMessage({ message, retry }: { message: string; retry: () => void }) {
  return <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm">
    <p>{message}</p><Button variant="outline" className="mt-3" onClick={retry}>Try again</Button>
  </div>;
}

export function Lines() {
  const companyId = useRouteCompanyId();
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [params, setParams] = useSearchParams();
  const status = statuses.find((item) => item === params.get("status")) ?? "active";
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => setBreadcrumbs([{ label: "Lines" }]), [setBreadcrumbs]);
  const query = useInfiniteQuery({
    queryKey: queryKeys.lines.list(companyId ?? "", status, q),
    queryFn: ({ pageParam, signal }) => linesApi.list(companyId!, { status, q, cursor: pageParam || undefined }, { signal }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!companyId,
    refetchInterval: 30_000,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  function changeParams(next: { status?: LineListStatus; q?: string }) {
    const copy = new URLSearchParams(params);
    if (next.status !== undefined) copy.set("status", next.status);
    if (next.q !== undefined) next.q ? copy.set("q", next.q) : copy.delete("q");
    setParams(copy);
  }
  return <main className="mx-auto max-w-5xl space-y-6 p-6">
    <header className="space-y-1"><h1 className="text-2xl font-semibold">Lines</h1><p className="text-sm text-muted-foreground">Follow the work started by a root task.</p></header>
    <div className="flex flex-wrap items-end gap-3">
      <form role="search" className="flex min-w-0 flex-1 gap-2" onSubmit={(event) => { event.preventDefault(); changeParams({ q: search.trim() }); }}>
        <label className="sr-only" htmlFor="line-search">Search Lines</label>
        <Input id="line-search" name="line-search" type="search" autoComplete="off" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Lines" maxLength={200} />
        <Button type="submit" variant="outline">Search</Button>
      </form>
      <label className="flex items-center gap-2 text-sm">Show
        <select aria-label="Line status" className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-ring" value={status} onChange={(event) => changeParams({ status: event.target.value as LineListStatus })}>
          {statuses.map((item) => <option key={item} value={item}>{item[0]!.toUpperCase() + item.slice(1)}</option>)}
        </select>
      </label>
    </div>
    {!companyId ? <p>Select a company to view Lines.</p>
      : query.isPending ? <p role="status">Loading Lines…</p>
      : query.isError ? <ErrorMessage message="Could not load Lines." retry={() => void query.refetch()} />
      : rows.length === 0 ? <p className="rounded-lg border p-6 text-sm text-muted-foreground">No Lines match these filters.</p>
      : <div className="divide-y rounded-lg border">{rows.map((line) => <Link key={line.id} to={`/lines/${line.id}?fromList=${encodeURIComponent(`${location.pathname}${location.search}`)}`} className="flex items-center justify-between gap-4 p-4 hover:bg-accent focus-visible:outline-ring">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="truncate font-medium" title={line.displayName}>{line.displayName}</span>{line.archivedAt && <Badge variant="outline">Archived</Badge>}{line.namingStatus === "failed" && <Badge variant="outline">Naming failed</Badge>}</div>
            <p className="truncate text-sm text-muted-foreground">{line.rootIdentifier} · {line.rootTitle}</p></div>
          <Progress done={line.terminalIssueCount} total={line.visibleIssueCount} />
        </Link>)}</div>}
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load more"}</Button>}
  </main>;
}

export function buildLineTree(issues: Issue[]): Array<{ issue: Issue; depth: number }> {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const children = new Map<string | null, Issue[]>();
  for (const issue of issues) {
    const parent = issue.parentId && byId.has(issue.parentId) ? issue.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), issue]);
  }
  const result: Array<{ issue: Issue; depth: number }> = [];
  const seen = new Set<string>();
  function visit(issue: Issue, depth: number) {
    if (seen.has(issue.id)) return;
    seen.add(issue.id);
    result.push({ issue, depth });
    for (const child of children.get(issue.id) ?? []) visit(child, depth + 1);
  }
  for (const root of children.get(null) ?? []) visit(root, 0);
  for (const issue of issues) visit(issue, 0);
  return result;
}

export function LineDetail() {
  const companyId = useRouteCompanyId();
  const { lineId, companyPrefix } = useParams<{ lineId: string; companyPrefix?: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const lineQuery = useQuery({ queryKey: queryKeys.lines.detail(companyId ?? "", lineId ?? ""), queryFn: ({ signal }) => linesApi.get(lineId!, { signal }), enabled: !!companyId && !!lineId, refetchInterval: 15_000 });
  const tasksQuery = useQuery({ queryKey: queryKeys.lines.tasks(companyId ?? "", lineId ?? ""), queryFn: ({ signal }) => issuesApi.listAll(companyId!, { lineId: lineId! }, { signal }), enabled: !!companyId && !!lineId, refetchInterval: 15_000 });
  const agentsQuery = useQuery({ queryKey: queryKeys.agents.list(companyId ?? ""), queryFn: () => agentsApi.list(companyId!), enabled: !!companyId });
  const line = lineQuery.data?.companyId === companyId ? lineQuery.data : null;
  const tasks = tasksQuery.data?.filter((issue) => issue.companyId === companyId && issue.lineId === lineId) ?? [];
  const status = params.get("status") ?? "all";
  const assignee = params.get("assignee") ?? "all";
  const fromList = params.get("fromList");
  const listHref = fromList?.startsWith(`/${companyPrefix}/lines`) && !fromList.startsWith("//") ? fromList : "/lines";
  const tree = useMemo(() => buildLineTree(tasks), [tasks]);
  const visible = tree.filter(({ issue }) => (status === "all" || issue.status === status) && (assignee === "all" || (assignee === "unassigned" ? !issue.assigneeAgentId && !issue.assigneeUserId : issue.assigneeAgentId === assignee || issue.assigneeUserId === assignee)));
  useEffect(() => setBreadcrumbs([{ label: "Lines", href: "/lines" }, { label: line?.displayName ?? "Line" }]), [line?.displayName, setBreadcrumbs]);
  const mutation = useMutation({
    mutationFn: (action: "archive" | "unarchive" | "retry") => action === "retry" ? linesApi.retryNaming(lineId!) : linesApi.setArchived(lineId!, action === "archive"),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.lines.all(companyId!) }); },
  });
  function filter(key: string, value: string) {
    const copy = new URLSearchParams(params);
    value === "all" ? copy.delete(key) : copy.set(key, value);
    setParams(copy);
  }
  const returnHref = `${location.pathname}${location.search}`;
  const issueQuery = `?from=lines&fromHref=${encodeURIComponent(returnHref)}`;
  return <main className="mx-auto max-w-5xl space-y-6 p-6">
    <Link to={listHref} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-ring"><ArrowLeft className="h-4 w-4" aria-hidden="true" />All Lines</Link>
    {!companyId ? <p>Select a company to view this Line.</p>
      : lineQuery.isPending ? <p role="status">Loading Line…</p>
      : lineQuery.isError || !line ? <ErrorMessage message="Could not load this Line. It may belong to another company." retry={() => void lineQuery.refetch()} />
      : <>
        <header className="space-y-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h1 className="break-words text-2xl font-semibold">{line.displayName}</h1><p className="text-sm text-muted-foreground">{line.archivedAt ? "Archived" : line.completionStatus === "completed" ? "Completed" : "Active"} Line</p></div>
          <div className="flex flex-wrap gap-2">{line.namingStatus === "failed" || line.namingStatus === "ready" ? <Button variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate("retry")}>{line.namingStatus === "failed" ? "Retry naming" : "Regenerate name"}</Button> : null}
            <Button variant="outline" disabled={mutation.isPending || (!line.archivedAt && line.terminalIssueCount < line.visibleIssueCount)} onClick={() => mutation.mutate(line.archivedAt ? "unarchive" : "archive")}>{line.archivedAt ? "Reopen Line" : "Archive Line"}</Button></div></div>
          {!line.archivedAt && line.terminalIssueCount < line.visibleIssueCount ? <p className="text-sm text-muted-foreground">Finish or cancel open tasks before archiving this Line.</p> : null}
          {line.namingStatus === "pending" || line.namingStatus === "generating" ? <p role="status" className="text-sm text-muted-foreground">A temporary name is shown while naming runs.</p> : null}
          {line.namingStatus === "failed" ? <p role="alert" className="text-sm text-destructive">Naming failed. You can retry it without changing the tasks.</p> : null}
          {mutation.isError ? <p role="alert" className="text-sm text-destructive">{mutation.error instanceof ApiError ? mutation.error.message : "The Line could not be updated."} Try again.</p> : null}
          <div className="flex flex-wrap items-center gap-3 text-sm"><Link to={`/issues/${line.rootIdentifier}${issueQuery}`} state={createIssueDetailLocationState("Lines", returnHref, "lines")} className="text-primary hover:underline">Root task: {line.rootIdentifier}</Link><Link to={`/issues/${line.rootIdentifier}${issueQuery}#document-blueprint`} state={createIssueDetailLocationState("Lines", returnHref, "lines")} className="text-primary hover:underline">Blueprint</Link></div>
          <Progress done={line.terminalIssueCount} total={line.visibleIssueCount} />
        </header>
        <section className="space-y-4" aria-label="Line tasks"><div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-lg font-semibold">Task tree</h2>
          <select aria-label="Task status" className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-ring" value={status} onChange={(event) => filter("status", event.target.value)}><option value="all">All statuses</option>{[...new Set(tasks.map((task) => task.status))].map((item) => <option key={item} value={item}>{item}</option>)}</select>
          <select aria-label="Task assignee" className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-ring" value={assignee} onChange={(event) => filter("assignee", event.target.value)}><option value="all">All assignees</option><option value="unassigned">Unassigned</option>{[...new Set(tasks.flatMap((task) => [task.assigneeAgentId, task.assigneeUserId]).filter((id): id is string => !!id))].map((id) => <option key={id} value={id}>{agentsQuery.data?.find((agent) => agent.id === id)?.name ?? id}</option>)}</select></div>
          {tasksQuery.isPending ? <p role="status">Loading tasks…</p> : tasksQuery.isError ? <ErrorMessage message="Could not load this Line’s tasks." retry={() => void tasksQuery.refetch()} /> : visible.length === 0 ? <p className="rounded-lg border p-6 text-sm text-muted-foreground">No tasks match these filters.</p> : <div className="divide-y rounded-lg border">{visible.map(({ issue, depth }) => <Link key={issue.id} to={`/issues/${issue.identifier ?? issue.id}${issueQuery}`} state={createIssueDetailLocationState("Lines", returnHref, "lines")} aria-label={`Level ${depth + 1}: ${issue.identifier ?? "Task"}, ${issue.title}`} className={cn("flex flex-wrap items-center gap-2 p-3 hover:bg-accent focus-visible:outline-ring", ["pl-3", "pl-7", "pl-11", "pl-15", "pl-19", "pl-23", "pl-27", "pl-31", "pl-35"][Math.min(depth, 8)])}><GitMerge className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1 truncate" title={issue.title}>{issue.title}</span><Badge variant="outline">{issue.status}</Badge><span className="text-xs text-muted-foreground">{issue.identifier}</span></Link>)}</div>}
        </section>
      </>}
  </main>;
}
