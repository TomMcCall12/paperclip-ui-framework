import { useState } from "react";
import { Clock, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ISSUE_SCHEDULED_CHECK_NOTES_MAX_LENGTH } from "@paperclipai/shared";
import type { IssueScheduledCheck } from "@paperclipai/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import {
  formatMonitorAbsoluteFull,
  formatMonitorEta,
  useMonitorCountdown,
} from "../../lib/issue-monitor";
import { toDateTimeLocalValue } from "./helpers";

function useIssueScheduledChecks(issueId: string) {
  return useQuery({
    queryKey: queryKeys.issues.scheduledChecks(issueId),
    queryFn: () => issuesApi.listScheduledChecks(issueId),
    staleTime: 15_000,
  });
}

function isOverdue(check: IssueScheduledCheck, now: Date): boolean {
  return (
    check.status === "scheduled" &&
    check.nextCheckAt !== null &&
    new Date(check.nextCheckAt).getTime() < now.getTime()
  );
}

/**
 * Small, non-sticky badge for the issue header: a clock icon with the count
 * of pending check-ins, amber once any of them is overdue (TOM-413). Shares
 * the list query's cache key with `IssueScheduledChecksSection` so opening
 * Properties doesn't refetch.
 */
export function IssueScheduledChecksBadge({ issueId }: { issueId: string }) {
  const { data: checks } = useIssueScheduledChecks(issueId);
  const now = useMonitorCountdown(
    checks?.find((c) => c.status === "scheduled")?.nextCheckAt ?? null,
  );
  const pending = (checks ?? []).filter((c) => c.status === "scheduled");
  if (pending.length === 0) return null;
  const overdue = pending.some((c) => isOverdue(c, now));

  return (
    <span
      data-testid="issue-scheduled-checks-badge"
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium",
        overdue
          ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300"
          : "border-border text-muted-foreground",
      )}
      title={`${pending.length} scheduled check-in${pending.length === 1 ? "" : "s"}`}
    >
      <Clock className="h-3 w-3" aria-hidden="true" />
      {pending.length}
    </span>
  );
}

function creatorLabel(check: IssueScheduledCheck): string {
  if (check.createdByAgentName) return check.createdByAgentName;
  if (check.createdByUserId) return "Board";
  if (check.createdByAgentId) return "Agent";
  return "—";
}

interface CheckFormState {
  nextCheckAtInput: string;
  notes: string;
  recurrenceCron: string;
  recurrenceTimezone: string;
  cancelOnComment: boolean;
}

function emptyFormState(): CheckFormState {
  return {
    nextCheckAtInput: "",
    notes: "",
    recurrenceCron: "",
    recurrenceTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cancelOnComment: false,
  };
}

function formStateFromCheck(check: IssueScheduledCheck): CheckFormState {
  return {
    nextCheckAtInput: toDateTimeLocalValue(check.nextCheckAt),
    notes: check.notes ?? "",
    recurrenceCron: check.recurrenceCron ?? "",
    recurrenceTimezone:
      check.recurrenceTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    cancelOnComment: check.cancelOnComment,
  };
}

function CheckForm({
  state,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  state: CheckFormState;
  onChange: (next: CheckFormState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <div>
        <label className="text-xs text-muted-foreground" htmlFor="scheduled-check-at">
          When
        </label>
        <Input
          id="scheduled-check-at"
          type="datetime-local"
          value={state.nextCheckAtInput}
          onChange={(e) => onChange({ ...state, nextCheckAtInput: e.target.value })}
          className="h-8 text-xs"
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground" htmlFor="scheduled-check-notes">
          Notes
        </label>
        <Textarea
          id="scheduled-check-notes"
          value={state.notes}
          maxLength={ISSUE_SCHEDULED_CHECK_NOTES_MAX_LENGTH}
          onChange={(e) => onChange({ ...state, notes: e.target.value })}
          className="min-h-16 text-xs"
          placeholder="What should the agent check?"
        />
        <div className="mt-0.5 text-right text-xs text-muted-foreground">
          {state.notes.length}/{ISSUE_SCHEDULED_CHECK_NOTES_MAX_LENGTH}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="scheduled-check-cron">
            Repeat (cron, optional)
          </label>
          <Input
            id="scheduled-check-cron"
            value={state.recurrenceCron}
            onChange={(e) => onChange({ ...state, recurrenceCron: e.target.value })}
            placeholder="30 8 * * 1"
            className="h-8 text-xs"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="scheduled-check-tz">
            Timezone
          </label>
          <Input
            id="scheduled-check-tz"
            value={state.recurrenceTimezone}
            onChange={(e) => onChange({ ...state, recurrenceTimezone: e.target.value })}
            className="h-8 text-xs"
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={state.cancelOnComment}
          onCheckedChange={(checked) =>
            onChange({ ...state, cancelOnComment: checked === true })
          }
        />
        Cancel if someone comments first
      </label>
      <div className="flex gap-2 pt-1">
        <Button type="button" size="sm" className="h-7 text-xs" disabled={saving} onClick={onSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ScheduledCheckRow({
  issueId,
  check,
  now,
}: {
  issueId: string;
  check: IssueScheduledCheck;
  now: Date;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CheckFormState>(() => formStateFromCheck(check));

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.scheduledChecks(issueId) });

  const update = useMutation({
    mutationFn: () =>
      issuesApi.updateScheduledCheck(issueId, check.id, {
        nextCheckAt: new Date(form.nextCheckAtInput).toISOString(),
        notes: form.notes.trim() || null,
        recurrenceCron: form.recurrenceCron.trim() || null,
        recurrenceTimezone: form.recurrenceCron.trim() ? form.recurrenceTimezone.trim() : null,
        cancelOnComment: form.cancelOnComment,
      }),
    onSuccess: () => {
      setEditing(false);
      void invalidate();
    },
  });
  const cancel = useMutation({
    mutationFn: () => issuesApi.deleteScheduledCheck(issueId, check.id),
    onSuccess: () => void invalidate(),
  });
  const runNow = useMutation({
    mutationFn: () => issuesApi.runScheduledCheckNow(issueId, check.id),
    onSuccess: () => void invalidate(),
  });

  const overdue = isOverdue(check, now);
  const relative = check.nextCheckAt ? formatMonitorEta(check.nextCheckAt, now) : null;

  if (editing) {
    return (
      <CheckForm
        state={form}
        onChange={setForm}
        onSave={() => update.mutate()}
        onCancel={() => {
          setForm(formStateFromCheck(check));
          setEditing(false);
        }}
        saving={update.isPending}
      />
    );
  }

  return (
    <div
      data-testid="issue-scheduled-check-row"
      className="flex items-start justify-between gap-2 rounded-md border border-border px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Clock
            className={cn("h-3.5 w-3.5 shrink-0", overdue ? "text-amber-600" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className={cn("text-sm font-medium", overdue && "text-amber-700 dark:text-amber-400")}>
            {check.status === "scheduled" && check.nextCheckAt
              ? relative
              : check.status === "fired"
                ? "Fired"
                : "Cancelled"}
          </span>
          {check.recurrenceCron ? (
            <Badge variant="outline" className="h-5 gap-1">
              <Repeat className="h-3 w-3" aria-hidden="true" />
              Recurring
            </Badge>
          ) : null}
          {check.isPrimary ? (
            <Badge variant="secondary" className="h-5">
              Primary
            </Badge>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">
          {check.nextCheckAt ? formatMonitorAbsoluteFull(check.nextCheckAt) : "—"} · set by {creatorLabel(check)}
        </div>
        {check.notes ? (
          <div className="mt-1 whitespace-pre-wrap text-xs text-foreground">{check.notes}</div>
        ) : null}
      </div>
      {check.status === "scheduled" ? (
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title="Run now"
            disabled={runNow.isPending}
            onClick={() => runNow.mutate()}
          >
            <Clock className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" title="Edit" onClick={() => setEditing(true)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title="Delete"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Lists every scheduled check-in on this issue (TOM-413) — replaces the
 * pinned top banner + composer strip, which only ever showed one monitor at
 * a time. The legacy `executionPolicy.monitor` row (if any) shows up here
 * too, tagged "Primary", via the server's back-compat sync.
 */
export function IssueScheduledChecksSection({ issueId }: { issueId: string }) {
  const { data: checks, isLoading } = useIssueScheduledChecks(issueId);
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<CheckFormState>(emptyFormState());

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.scheduledChecks(issueId) });

  const create = useMutation({
    mutationFn: () =>
      issuesApi.createScheduledCheck(issueId, {
        nextCheckAt: new Date(form.nextCheckAtInput).toISOString(),
        notes: form.notes.trim() || null,
        recurrenceCron: form.recurrenceCron.trim() || null,
        recurrenceTimezone: form.recurrenceCron.trim() ? form.recurrenceTimezone.trim() : null,
        cancelOnComment: form.cancelOnComment,
      }),
    onSuccess: () => {
      setAdding(false);
      setForm(emptyFormState());
      void invalidate();
    },
  });

  const now = useMonitorCountdown(
    checks?.find((c) => c.status === "scheduled")?.nextCheckAt ?? null,
  );
  const visible = (checks ?? []).filter((c) => c.status !== "cancelled");

  return (
    <div className="space-y-2" data-testid="issue-scheduled-checks-section">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Scheduled check-ins</span>
        {!adding ? (
          <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setAdding(true)}>
            <Plus className="h-3 w-3" />
            Add
          </Button>
        ) : null}
      </div>
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : visible.length === 0 && !adding ? (
        <div className="text-xs text-muted-foreground">No scheduled check-ins.</div>
      ) : (
        <div className="space-y-2">
          {visible.map((check) => (
            <ScheduledCheckRow key={check.id} issueId={issueId} check={check} now={now} />
          ))}
        </div>
      )}
      {adding ? (
        <CheckForm
          state={form}
          onChange={setForm}
          onSave={() => create.mutate()}
          onCancel={() => {
            setAdding(false);
            setForm(emptyFormState());
          }}
          saving={create.isPending}
        />
      ) : null}
    </div>
  );
}
