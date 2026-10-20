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
import { StatusIcon } from "../components/StatusIcon";
import { cn } from "../lib/utils";

const statuses: LineListStatus[] = ["active", "completed", "archived", "all"];
const taskStatusLabel = (status: string) => status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const namingFailureReason = (code: string | null) => ({
  summarizer_not_configured: "no naming model is set up",
  openai_override_unavailable: "the naming agent cannot use OpenAI",
  naming_setup_failed: "the naming task could not start",
  naming_timeout_or_task_finished: "the naming run ended before returning a name",
  invalid_output: "the model returned an invalid name",
}[code ?? ""] ?? "the naming run failed");

function useRouteCompanyId() {
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const { companies, selectedCompanyId } = useCompany();
  return companyPrefix
    ? companies.find((company) => company.issuePrefix.toLowerCase() === companyPrefix.toLowerCase())?.id ?? null
    : selectedCompanyId;
}

function Progress({ done, total }: { done: number; total: number }) {
  return <span className="text-sm text-muted-foreground">{done} of {total} {total === 1 ? "task" : "tasks"} finished</span>;
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
      <form role="search" className="flex w-full min-w-0 flex-wrap gap-2 sm:w-auto sm:flex-1 sm:flex-nowrap" onSubmit={(event) => { event.preventDefault(); changeParams({ q: search.trim() }); }}>
        <label className="sr-only" htmlFor="line-search">Search Lines</label>
        <Input id="line-search" name="line-search" type="search" autoComplete="off" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Lines" maxLength={200} className="min-h-11 min-w-0 flex-1 basis-full sm:basis-auto" />
        <Button type="submit" variant="outline" className="min-h-11">Search</Button>
      </form>
      <label className="flex items-center gap-2 text-sm">Show
        <select aria-label="Line status" className="min-h-11 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-ring" value={status} onChange={(event) => changeParams({ status: event.target.value as LineListStatus })}>
          {statuses.map((item) => <option key={item} value={item}>{item[0]!.toUpperCase() + item.slice(1)}</option>)}
        </select>
      </label>
    </div>
    {!companyId ? <p>Select a company to view Lines.</p>
      : query.isPending ? <p role="status">Loading Lines…</p>
      : query.isError ? <ErrorMessage message="Could not load Lines." retry={() => void query.refetch()} />
      : rows.length === 0 ? <div className="rounded-lg border p-6 text-sm text-muted-foreground"><p>{!q && status === "active" ? "No Lines yet. A Line starts when a root task begins work." : "No Lines match these filters."}</p>{(q || status !== "active") && <Button variant="outline" className="mt-3" onClick={() => changeParams({ q: "", status: "active" })}>Clear filters</Button>}</div>
      : <div className="divide-y rounded-lg border">{rows.map((line) => <Link key={line.id} to={`/lines/${line.id}?fromList=${encodeURIComponent(`${location.pathname}${location.search}`)}`} className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-accent focus-visible:outline-ring sm:flex-nowrap sm:gap-4">
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="truncate font-medium" title={line.displayName}>{line.displayName}</span>{line.archivedAt && <Badge variant="outline">Archived</Badge>}{line.namingStatus === "failed" && <Badge variant="outline">Naming failed</Badge>}{["pending", "generating"].includes(line.namingStatus) && <Badge variant="outline">Naming…</Badge>}</div>
            <p className="truncate text-sm text-muted-foreground">{line.rootIdentifier} · {line.rootTitle}</p>
            <p className="text-sm text-muted-foreground">{taskStatusLabel(line.rootStatus)}{line.blockedIssueCount > 0 ? ` · ${line.blockedIssueCount} blocked` : ""}{line.reviewIssueCount > 0 ? ` · ${line.reviewIssueCount} in review` : ""}{line.lastTaskActivityAt ? ` · Updated ${new Date(line.lastTaskActivityAt).toLocaleDateString()}` : ""}</p></div>
          <span className="w-full sm:w-auto"><Progress done={line.terminalIssueCount} total={line.visibleIssueCount} /></span>
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

export function filterLineTree(tree: Array<{ issue: Issue; depth: number }>, status: string, assignee: string) {
  const byId = new Map(tree.map(({ issue }) => [issue.id, issue]));
  const matches = new Set(tree.filter(({ issue }) =>
    (status === "all" || issue.status === status) &&
    (assignee === "all" || (assignee === "unassigned" ? !issue.assigneeAgentId && !issue.assigneeUserId
      : issue.assigneeAgentId === assignee || issue.assigneeUserId === assignee))).map(({ issue }) => issue.id));
  const included = new Set(matches);
  for (const id of matches) {
    const visited = new Set([id]);
    let parentId = byId.get(id)?.parentId;
    while (parentId && byId.has(parentId) && !visited.has(parentId)) {
      included.add(parentId);
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
  }
  return tree.filter(({ issue }) => included.has(issue.id)).map((entry) => {
    const ancestors: string[] = [];
    const visited = new Set([entry.issue.id]);
    let parentId = entry.issue.parentId;
    while (parentId && byId.has(parentId) && !visited.has(parentId)) {
      const parent = byId.get(parentId)!;
      ancestors.unshift(parent.identifier ?? parent.title);
      visited.add(parentId);
      parentId = parent.parentId;
    }
    return { ...entry, matched: matches.has(entry.issue.id), parentPath: ancestors.join(" › ") };
  });
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
  const visible = filterLineTree(tree, status, assignee);
  const documentsQuery = useQuery({ queryKey: ["line-root-documents", companyId, line?.rootIssueId],
    queryFn: () => issuesApi.listDocuments(line!.rootIssueId), enabled: !!line });
  const rootDocuments = new Set(documentsQuery.data?.map((document) => document.key) ?? []);
  useEffect(() => setBreadcrumbs([{ label: "Lines", href: "/lines" }, { label: line?.displayName ?? "Line" }]), [line?.displayName, setBreadcrumbs]);
  const mutation = useMutation({
    mutationFn: (action: "archive" | "unarchive" | "retry") => action === "retry" ? linesApi.retryNaming(lineId!) : linesApi.setArchived(lineId!, action === "archive"),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.lines.all(companyId!) }); },
  });
  const retryFailedAgain = mutation.variables === "retry" && mutation.data?.namingStatus === "failed";
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
        <header className="space-y-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h1 className="break-words text-2xl font-semibold">{line.displayName}</h1><p className="text-sm text-muted-foreground">{line.archivedAt ? "Archived" : line.completionStatus === "completed" ? "Completed" : line.completionStatus === "cancelled" ? "Cancelled" : "Active"} Line</p></div>
          <div className="flex flex-wrap gap-2">{!line.archivedAt && (line.namingStatus === "failed" || line.namingStatus === "ready") ? <Button variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate("retry")}>{mutation.isPending && mutation.variables === "retry" ? "Retrying…" : line.namingStatus === "failed" ? "Retry naming" : "Regenerate name"}</Button> : null}
            <Button variant="outline" disabled={mutation.isPending || (!line.archivedAt && line.terminalIssueCount < line.visibleIssueCount)} onClick={() => mutation.mutate(line.archivedAt ? "unarchive" : "archive")}>{line.archivedAt ? "Reopen Line" : "Archive Line"}</Button></div></div>
          {!line.archivedAt && line.terminalIssueCount < line.visibleIssueCount ? <p className="text-sm text-muted-foreground">Finish or cancel open tasks before archiving this Line.</p> : null}
          {line.namingStatus === "pending" || line.namingStatus === "generating" ? <p role="status" className="text-sm text-muted-foreground">{line.lastNamingErrorCode === "waiting_for_dispatch" ? "Naming is waiting for the agent to resume or for budget to become available." : "A temporary name is shown while naming runs."}</p> : null}
          {line.namingStatus === "failed" ? <p role="alert" className="text-sm text-destructive">{retryFailedAgain ? `Naming failed again at ${new Date(mutation.submittedAt).toLocaleTimeString()}: ` : "Naming failed: "}{namingFailureReason(mutation.data?.lastNamingErrorCode ?? line.lastNamingErrorCode)}. The tasks are unchanged.</p> : null}
          {mutation.isError ? <p role="alert" className="text-sm text-destructive">{mutation.error instanceof ApiError ? mutation.error.message : "The Line could not be updated."} Try again.</p> : null}
          <p className="text-sm text-muted-foreground">{line.rootObjective || "No root objective supplied."}</p>
          <div className="flex flex-wrap items-center gap-3 text-sm"><Link to={`/issues/${line.rootIdentifier}${issueQuery}`} state={createIssueDetailLocationState("Lines", returnHref, "lines")} className="text-primary underline hover:no-underline focus-visible:outline-ring">Root task: {line.rootIdentifier}</Link>{rootDocuments.has("plan") ? <Link to={`/issues/${line.rootIdentifier}${issueQuery}#document-plan`} state={createIssueDetailLocationState("Lines", returnHref, "lines")} className="text-primary underline hover:no-underline focus-visible:outline-ring">Plan</Link> : null}{rootDocuments.has("blueprint") ? <Link to={`/issues/${line.rootIdentifier}${issueQuery}#document-blueprint`} state={createIssueDetailLocationState("Lines", returnHref, "lines")} className="text-primary underline hover:no-underline focus-visible:outline-ring">Blueprint</Link> : documentsQuery.isSuccess ? <span className="text-muted-foreground">No blueprint yet</span> : null}</div>
          {documentsQuery.isError && <ErrorMessage message="Could not check the root task’s documents." retry={() => void documentsQuery.refetch()} />}
          <Progress done={line.terminalIssueCount} total={line.visibleIssueCount} />
        </header>
        <section className="space-y-4" aria-label="Line tasks"><div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-lg font-semibold">Task tree</h2>
          <select aria-label="Task status" className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-ring" value={status} onChange={(event) => filter("status", event.target.value)}><option value="all">All statuses</option>{[...new Set(tasks.map((task) => task.status))].map((item) => <option key={item} value={item}>{taskStatusLabel(item)}</option>)}</select>
          <select aria-label="Task assignee" className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-ring" value={assignee} onChange={(event) => filter("assignee", event.target.value)}><option value="all">All assignees</option><option value="unassigned">Unassigned</option>{[...new Set(tasks.flatMap((task) => [task.assigneeAgentId, task.assigneeUserId]).filter((id): id is string => !!id))].map((id) => <option key={id} value={id}>{agentsQuery.data?.find((agent) => agent.id === id)?.name ?? id}</option>)}</select></div>
          {tasksQuery.isPending ? <p role="status">Loading tasks…</p> : tasksQuery.isError ? <ErrorMessage message="Could not load this Line’s tasks." retry={() => void tasksQuery.refetch()} /> : visible.length === 0 ? <p className="rounded-lg border p-6 text-sm text-muted-foreground">No tasks match these filters.</p> : <div className="divide-y rounded-lg border">{visible.map(({ issue, depth, matched, parentPath }) => {
            const issueHref = `/issues/${issue.identifier ?? issue.id}${issueQuery}`;
            const blocker = issue.blockedBy?.find((item) => item.status !== "done" && item.status !== "cancelled");
            const pendingApproval = line.pendingApprovals.find((approval) => approval.issueId === issue.id);
            return <div key={issue.id} className={cn("flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-center", !matched && "bg-muted/30 text-muted-foreground", ["sm:pl-3", "sm:pl-7", "sm:pl-11", "sm:pl-15", "sm:pl-19", "sm:pl-23", "sm:pl-27", "sm:pl-31", "sm:pl-35"][Math.min(depth, 8)])}>
              <div className="flex min-w-0 flex-1 items-start gap-2"><GitMerge className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><Link to={issueHref} state={createIssueDetailLocationState("Lines", returnHref, "lines")} aria-label={`${parentPath ? `${parentPath} › ` : ""}${issue.identifier ?? "Task"}: ${issue.title}`} className="min-w-0 break-words text-primary hover:underline focus-visible:outline-ring sm:truncate" title={issue.title}>{issue.title}</Link></div>
              <div className="flex flex-wrap items-center gap-2 pl-6 text-xs sm:pl-0"><StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} showLabel /><span className="text-muted-foreground">{issue.identifier}</span>{!matched && <Badge variant="outline">Context</Badge>}
                {blocker && <Link to={`/issues/${blocker.identifier ?? blocker.id}${issueQuery}`} className="text-primary underline hover:no-underline focus-visible:outline-ring">Blocked by {blocker.identifier ?? blocker.title}</Link>}
                {issue.status === "in_review" && <Link to={issueHref} className="text-primary underline hover:no-underline focus-visible:outline-ring">Review pending</Link>}
                {pendingApproval && <Link to={`/approvals/${pendingApproval.approvalId}`} className="text-primary underline hover:no-underline focus-visible:outline-ring">Approval pending</Link>}
                {issue.status === "in_progress" && issue.executionRunId && issue.assigneeAgentId && <Link to={`/agents/${issue.assigneeAgentId}/runs/${issue.executionRunId}`} className="text-primary underline hover:no-underline focus-visible:outline-ring">Running</Link>}
              </div>
            </div>;
          })}</div>}
        </section>
      </>}
  </main>;
}
