import { afterEach, describe, expect, it } from "vitest";
import type { ProviderQuotaSummary } from "@paperclipai/shared";
import type { SentinelWakeOptions, SentinelWakeResult, StallSentinelActions } from "./actions.js";
import { readStallSentinelConfig } from "./config.js";
import type { ActivityStateRow, RolloutState } from "./dedupe.js";
import { getStallSentinelHealth, resetStallSentinelHealthForTests } from "./health-state.js";
import { createStallSentinel } from "./index.js";
import type { CompanySnapshot, SnapshotAgent, SnapshotIssue, SnapshotRun, SnapshotWake } from "./watch-units.js";

const COMPANY = "company-1";
const NOW = new Date("2026-10-21T12:00:00.000Z"); // 13:00 London
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (min: number) => new Date(NOW.getTime() - min * MIN);

const JARVIS = "agent-jarvis";
const ENGINEER = "agent-engineer";
const CODEX = "agent-codex";

let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;

function makeIssue(partial: Partial<SnapshotIssue> & { id: string }): SnapshotIssue {
  return {
    identifier: `TOM-${partial.id.replace(/\D/g, "") || "1"}`,
    title: "Task",
    status: "todo",
    parentId: null,
    lineId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    statusVersion: 1,
    originKind: "manual",
    hiddenAt: null,
    conversationAgentId: null,
    monitorNextCheckAt: null,
    unblockDescriptor: null,
    assigneeAdapterOverrides: null,
    createdAt: ago(600),
    updatedAt: ago(600),
    completedAt: null,
    cancelledAt: null,
    ...partial,
  };
}

function makeAgent(partial: Partial<SnapshotAgent> & { id: string }): SnapshotAgent {
  return { name: partial.id, role: null, status: "idle", adapterType: "claude_local", adapterConfig: {}, ...partial };
}

class World {
  issues = new Map<string, SnapshotIssue>();
  agents = new Map<string, SnapshotAgent>([
    [JARVIS, makeAgent({ id: JARVIS, name: "Jarvis" })],
    [ENGINEER, makeAgent({ id: ENGINEER, name: "Tom's Labs Engineer" })],
    [CODEX, makeAgent({ id: CODEX, name: "Codex Direct Standby", adapterType: "codex_local" })],
  ]);
  runs: SnapshotRun[] = [];
  wakes: SnapshotWake[] = [];
  relations: Array<[string, string]> = [];
  lineRootIds = new Set<string>();
  latestProgress = new Map<string, Date>();
  issuesWithWork = new Set<string>();
  waitingOnBoard = new Set<string>();
  activeRecovery = new Set<string>();
  labels = new Map<string, string[]>();

  add(partial: Partial<SnapshotIssue> & { id: string }) {
    const issue = makeIssue(partial);
    this.issues.set(issue.id, issue);
    return issue;
  }
  run(partial: Partial<SnapshotRun> & { issueId: string; agentId: string }) {
    const run: SnapshotRun = {
      id: id("run"),
      status: "succeeded",
      errorCode: null,
      createdAt: ago(60),
      startedAt: ago(60),
      finishedAt: ago(59),
      scheduledRetryAt: null,
      silenceAgeMs: null,
      ...partial,
    };
    this.runs.push(run);
    return run;
  }
  blocks(blocker: string, blocked: string) {
    this.relations.push([blocker, blocked]);
  }
  snapshot(now: Date): CompanySnapshot {
    const blocks = new Map<string, string[]>();
    const blockedBy = new Map<string, string[]>();
    for (const [a, b] of this.relations) {
      blocks.set(a, [...(blocks.get(a) ?? []), b]);
      blockedBy.set(b, [...(blockedBy.get(b) ?? []), a]);
    }
    return {
      companyId: COMPANY,
      now,
      issues: new Map([...this.issues].map(([k, v]) => [k, { ...v }])),
      lineRootIds: new Set(this.lineRootIds),
      blocks,
      blockedBy,
      runs: this.runs.map((r) => ({ ...r })),
      wakes: this.wakes.map((w) => ({ ...w })),
      agents: new Map(this.agents),
      progress: { latestByIssue: new Map(this.latestProgress), issuesWithWork: new Set(this.issuesWithWork) },
      waitingOnBoardIssueIds: new Set(this.waitingOnBoard),
      activeRecoveryIssueIds: new Set(this.activeRecovery),
      labelsByIssue: new Map(this.labels),
      lastUserOverrideAt: new Map(),
    };
  }
}

interface Calls {
  wakes: Array<{ agentId: string } & SentinelWakeOptions>;
  cancels: string[];
  overrides: Array<{ issueId: string; overrides: Record<string, unknown> | null }>;
  cancelledIssues: string[];
  comments: Array<{ issueId: string; body: string }>;
  activities: Array<{ action: string; entityId: string; details: Record<string, unknown> }>;
  telegrams: string[];
}

function harness(world: World, opts: {
  mode?: "off" | "alert_only" | "on";
  rollout?: RolloutState;
  quota?: ProviderQuotaSummary[];
  suppressed?: boolean;
  lastSweepAt?: Date | null;
  memoryRows?: ActivityStateRow[];
  store?: { fail: boolean };
  /** Decides what the wake port answers; default: queued. */
  wakeResult?: (wake: { agentId: string } & SentinelWakeOptions) => SentinelWakeResult;
  config?: Partial<ReturnType<typeof readStallSentinelConfig>>;
  /** Replaces the snapshot loader (to hang a sweep). */
  loadSnapshot?: (companyId: string, now: Date) => Promise<CompanySnapshot>;
} = {}) {
  const calls: Calls = { wakes: [], cancels: [], overrides: [], cancelledIssues: [], comments: [], activities: [], telegrams: [] };
  let clock = NOW;
  let persisted: Date | null = opts.lastSweepAt ?? null;
  const actions: StallSentinelActions = {
    async wake(agentId, wake) {
      calls.wakes.push({ agentId, ...wake });
      const answer = opts.wakeResult?.({ agentId, ...wake });
      if (answer && !answer.queued) return answer;
      world.wakes.push({
        id: id("wake"),
        agentId,
        issueId: wake.issueId,
        status: "queued",
        reason: wake.reason,
        idempotencyKey: wake.idempotencyKey,
        requestedAt: clock,
      });
      return { queued: true };
    },
    async cancelRun(runId) {
      calls.cancels.push(runId);
      const run = world.runs.find((r) => r.id === runId);
      if (run) Object.assign(run, { status: "cancelled", finishedAt: clock });
    },
    async setIssueOverrides(issueId, overrides) {
      calls.overrides.push({ issueId, overrides });
      world.issues.get(issueId)!.assigneeAdapterOverrides = overrides;
    },
    async cancelIssue(issueId) {
      calls.cancelledIssues.push(issueId);
      world.issues.get(issueId)!.status = "cancelled";
    },
    async comment(issueId, body) {
      calls.comments.push({ issueId, body });
    },
    async activity(row) {
      calls.activities.push({ action: row.action, entityId: row.entityId, details: row.details });
    },
    async telegram(_companyId, text) {
      calls.telegrams.push(text);
      return { sent: true };
    },
  };
  const env = { PAPERCLIP_STALL_SENTINEL_MODE: opts.mode ?? "on" };
  const sentinel = createStallSentinel({
    config: { ...readStallSentinelConfig(env), ...opts.config },
    now: () => clock,
    store: {
      async listCompanyIds() {
        if (opts.store?.fail) throw new Error("database down");
        return [COMPANY];
      },
      async loadSnapshot(companyId, now) {
        if (opts.loadSnapshot) return opts.loadSnapshot(companyId, now);
        return world.snapshot(now);
      },
      async loadMemoryRows() {
        return opts.memoryRows ?? [];
      },
      async loadRollout() {
        return opts.rollout ?? { startedAt: ago(25 * 60), selfRepairOnAt: ago(60) };
      },
    },
    actions,
    fetchQuota: async () => opts.quota ?? [],
    resolveSchedulingSuppression: async () => ({ suppressed: opts.suppressed ?? false }),
    persistence: {
      readLastSweepAt: () => persisted,
      writeLastSweepAt: (at) => {
        persisted = at;
      },
    },
  });
  return {
    sentinel,
    calls,
    at(minutesFromNow: number) {
      clock = new Date(NOW.getTime() + minutesFromNow * MIN);
      return clock;
    },
    sweepAt: async (minutesFromNow: number) => {
      clock = new Date(NOW.getTime() + minutesFromNow * MIN);
      return sentinel.sweep();
    },
  };
}

/** A Line-less top-level root owned by Jarvis with one step child. */
function stepTree(world: World, child: Partial<SnapshotIssue> = {}) {
  const root = world.add({ id: id("root"), title: "Make silent stalls impossible", status: "in_progress", assigneeAgentId: JARVIS, createdAt: ago(600) });
  const step = world.add({
    id: id("step"),
    title: "S3: Build A",
    parentId: root.id,
    status: "todo",
    assigneeAgentId: ENGINEER,
    createdAt: ago(600),
    ...child,
  });
  return { root, step };
}

function lastProgress(world: World, issueId: string, minutesAgo: number) {
  world.latestProgress.set(issueId, ago(minutesAgo));
}

function claudeQuota(sessionLeft: number, resetInMin: number, weeklyLeft = 80): ProviderQuotaSummary[] {
  return [
    {
      provider: "anthropic",
      ok: true,
      windows: [
        { label: "Current session", usedPercent: 100 - sessionLeft, percentLeft: sessionLeft, resetsAt: new Date(NOW.getTime() + resetInMin * MIN).toISOString() },
        { label: "Current week", usedPercent: 100 - weeklyLeft, percentLeft: weeklyLeft, resetsAt: new Date(NOW.getTime() + 3 * 24 * HOUR).toISOString() },
      ],
    },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 100, percentLeft: 0, resetsAt: new Date(NOW.getTime() + 4 * HOUR).toISOString() }] },
  ];
}

const mutatingWakes = (calls: Calls) => calls.wakes.filter((w) => w.reason !== "stall_sentinel_reroute");
const actions = (calls: Calls, action: string) => calls.activities.filter((a) => a.action === action);

afterEach(() => resetStallSentinelHealthForTests());

describe("healthy trees", () => {
  it("raises no alert and takes no action while work is moving", async () => {
    const world = new World();
    const { step } = stepTree(world, { status: "in_progress" });
    world.run({ issueId: step.id, agentId: ENGINEER, status: "running", startedAt: ago(5), finishedAt: null, silenceAgeMs: 60_000 });
    const h = harness(world);
    for (const minutes of [0, 30, 60, 120]) await h.sweepAt(minutes);
    expect(h.calls.wakes).toEqual([]);
    expect(h.calls.cancels).toEqual([]);
    expect(h.calls.comments).toEqual([]);
    expect(h.calls.telegrams).toEqual([]);
    expect(getStallSentinelHealth()).toMatchObject({ mode: "on", effectiveMode: "on", lastSweepOk: true });
  });

  it("never treats a task waiting on the board as a stall", async () => {
    const world = new World();
    const { step } = stepTree(world, { status: "in_review" });
    world.waitingOnBoard.add(step.id);
    lastProgress(world, step.id, 300);
    const h = harness(world);
    await h.sweepAt(0);
    await h.sweepAt(5 * 60);
    expect(h.calls.comments).toEqual([]);
    expect(h.calls.telegrams).toEqual([]);
  });

  it("ignores Tom's own trees and chat conversations", async () => {
    const world = new World();
    world.add({ id: id("root"), status: "todo", assigneeUserId: "tom", createdAt: ago(9000) });
    world.add({ id: id("chat"), status: "in_progress", assigneeAgentId: JARVIS, conversationAgentId: JARVIS, createdAt: ago(9000) });
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.comments).toEqual([]);
  });
});

describe("lost run (L)", () => {
  it("re-queues once after 10 minutes, then alerts 15 minutes later if nothing started", async () => {
    const world = new World();
    const { root, step } = stepTree(world);
    for (const issue of [root, step]) lastProgress(world, issue.id, 9);
    const h = harness(world);

    await h.sweepAt(0);
    expect(h.calls.wakes).toEqual([]);

    await h.sweepAt(2);
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    expect(h.calls.wakes[0]).toMatchObject({
      agentId: ENGINEER,
      issueId: step.id,
      reason: "stall_sentinel_requeue",
      idempotencyKey: `stall-sentinel:L:${step.id}:1`,
      guard: { statuses: ["todo"], assigneeAgentId: ENGINEER, statusVersion: 1 },
    });
    expect(actions(h.calls, "stall_sentinel.healed")).toHaveLength(1);
    expect(h.calls.comments.at(-1)).toMatchObject({ issueId: root.id });
    expect(h.calls.telegrams).toEqual([]); // silent heal

    await h.sweepAt(10); // the wake is still queued; not restarted twice
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    expect(h.calls.telegrams).toEqual([]);

    await h.sweepAt(18);
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toMatch(/^Stalled: Make silent stalls impossible \(TOM-\d+\)\. No progress for \d+ minutes\. Why: nothing was working on S3 \(TOM-\d+\); its run was lost\. What I did: restarted it at 13:02, but it has not started\./);
    const alertComment = h.calls.comments.at(-1)!;
    expect(alertComment.issueId).toBe(root.id);
    expect(alertComment.body).toContain(`[@Jarvis](agent://${JARVIS})`);
    expect(h.calls.wakes.at(-1)).toMatchObject({ agentId: JARVIS, reason: "stall_sentinel_reroute", issueId: root.id });
    expect(mutatingWakes(h.calls)).toHaveLength(1);
  });

  it("says 'Moving again' once when the tree makes progress after an alert", async () => {
    const world = new World();
    const { root, step } = stepTree(world);
    for (const issue of [root, step]) lastProgress(world, issue.id, 11);
    const h = harness(world);
    await h.sweepAt(0);
    await h.sweepAt(16);
    expect(h.calls.telegrams).toHaveLength(1);
    world.run({ issueId: step.id, agentId: ENGINEER, status: "running", startedAt: h.at(20), finishedAt: null, silenceAgeMs: 0 });
    await h.sweepAt(20);
    expect(h.calls.telegrams).toHaveLength(2);
    expect(h.calls.telegrams[1]).toMatch(/^Moving again: Make silent stalls impossible \(TOM-\d+\)\. S3 \(TOM-\d+\) made progress at 13:20, after \d+ minutes stalled\. Nothing needed from you\.$/);
    expect(actions(h.calls, "stall_sentinel.cleared")).toHaveLength(1);
    await h.sweepAt(22);
    expect(h.calls.telegrams).toHaveLength(2);
  });
});

describe("queued runs (Q, Q2)", () => {
  it("re-queues an idle agent's queued run after 10 minutes", async () => {
    const world = new World();
    const { step } = stepTree(world);
    lastProgress(world, step.id, 30);
    world.run({ issueId: step.id, agentId: ENGINEER, status: "queued", createdAt: ago(11), startedAt: null, finishedAt: null });
    const h = harness(world);
    await h.sweepAt(0);
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    expect(h.calls.wakes[0]).toMatchObject({ reason: "stall_sentinel_requeue", issueId: step.id });
    expect(h.calls.telegrams).toEqual([]);
  });

  it("only alerts when the agent is busy elsewhere, naming the run it is busy on", async () => {
    const world = new World();
    const { root, step } = stepTree(world);
    lastProgress(world, step.id, 40);
    const other = world.add({ id: id("other"), identifier: "TOM-707", status: "in_progress", assigneeAgentId: ENGINEER, createdAt: ago(60) });
    world.run({ issueId: other.id, agentId: ENGINEER, status: "running", startedAt: ago(48), finishedAt: null, silenceAgeMs: 0 });
    world.wakes.push({ id: "w1", agentId: ENGINEER, issueId: step.id, status: "queued", reason: "assignment", idempotencyKey: null, requestedAt: ago(31) });
    const h = harness(world);
    await h.sweepAt(0);
    expect(mutatingWakes(h.calls)).toEqual([]);
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toContain("is queued for Tom's Labs Engineer, who has been busy on TOM-707 since 12:12.");
    expect(h.calls.comments.find((c) => c.issueId === root.id)?.body).toContain("agent://agent-jarvis");
  });
});

describe("stuck run (R)", () => {
  it("cancels and resumes the first stuck run, and alerts on the second", async () => {
    const world = new World();
    const { step } = stepTree(world, { status: "in_progress" });
    const stuck = world.run({ issueId: step.id, agentId: ENGINEER, status: "running", startedAt: ago(100), finishedAt: null, silenceAgeMs: 61 * MIN });
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.cancels).toEqual([stuck.id]);
    expect(h.calls.wakes[0]).toMatchObject({ reason: "stall_sentinel_resume", idempotencyKey: `stall-sentinel:R:${step.id}:${stuck.id}` });
    expect(h.calls.telegrams).toEqual([]);

    world.wakes = [];
    world.run({ issueId: step.id, agentId: ENGINEER, status: "running", startedAt: h.at(1), finishedAt: null, silenceAgeMs: 62 * MIN });
    await h.sweepAt(64);
    expect(h.calls.cancels).toHaveLength(1);
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toContain("without saving any work. What I did: stopped and restarted it at 13:00; it got stuck again.");
  });

  it("leaves a run alone that was silent for 59 minutes (one long tool call) and cancels at 61", async () => {
    const world = new World();
    const { step } = stepTree(world, { status: "in_progress" });
    const run = world.run({ issueId: step.id, agentId: ENGINEER, status: "running", startedAt: ago(100), finishedAt: null, silenceAgeMs: 59 * MIN });
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.cancels).toEqual([]);
    run.silenceAgeMs = 61 * MIN;
    await h.sweepAt(2);
    expect(h.calls.cancels).toEqual([run.id]);
  });

  it("treats a run past its timeout plus 15 minutes as stuck", async () => {
    const world = new World();
    world.agents.set(ENGINEER, makeAgent({ id: ENGINEER, name: "Tom's Labs Engineer", adapterConfig: { timeoutSec: 600 } }));
    const { step } = stepTree(world, { status: "in_progress" });
    world.run({ issueId: step.id, agentId: ENGINEER, status: "running", startedAt: ago(26), finishedAt: null, silenceAgeMs: 0 });
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.cancels).toHaveLength(1);
  });
});

describe("paused agents (A)", () => {
  it("alerts after 15 minutes and never restarts the agent", async () => {
    const world = new World();
    world.agents.set(ENGINEER, makeAgent({ id: ENGINEER, name: "Tom's Labs Engineer", status: "paused" }));
    const { step } = stepTree(world);
    lastProgress(world, step.id, 16);
    const h = harness(world);
    await h.sweepAt(0);
    expect(mutatingWakes(h.calls)).toEqual([]);
    expect(h.calls.telegrams[0]).toContain("is assigned to Tom's Labs Engineer, which is paused, so it cannot start.");
  });

  it("asks Tom to resume Jarvis when Jarvis is the paused agent, without mentioning Jarvis", async () => {
    const world = new World();
    world.agents.set(JARVIS, makeAgent({ id: JARVIS, name: "Jarvis", status: "paused" }));
    const root = world.add({ id: id("root"), title: "Root", status: "in_progress", assigneeAgentId: JARVIS });
    lastProgress(world, root.id, 16);
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.telegrams[0]).toContain("Why: Jarvis is paused, so nothing can be handed on.");
    expect(h.calls.comments[0]!.body).not.toContain("agent://");
    expect(h.calls.wakes).toEqual([]);
  });
});

describe("blocked work (C, B, K)", () => {
  it("wakes the parent's owner 15 minutes after a blocker is cancelled, then alerts 30 minutes later", async () => {
    const world = new World();
    const { root, step } = stepTree(world, { status: "blocked" });
    const blocker = world.add({ id: id("blocker"), identifier: "TOM-704", parentId: root.id, status: "cancelled", cancelledAt: ago(16) });
    world.blocks(blocker.id, step.id);
    lastProgress(world, step.id, 16);
    const h = harness(world);
    await h.sweepAt(0);
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    expect(h.calls.wakes[0]).toMatchObject({
      agentId: JARVIS,
      issueId: root.id,
      reason: "stall_sentinel_cancelled_blocker",
      payload: expect.objectContaining({ cancelledBlockerIssueId: blocker.id, dependentIssueId: step.id }),
    });
    await h.sweepAt(31);
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toContain("waits for TOM-704, which was cancelled, so it can never start. What I did: asked Jarvis at 13:00 to replace or remove that blocker.");
  });

  it("asks the assignee once to name the blocker when a task is blocked with none", async () => {
    const world = new World();
    const { step } = stepTree(world, { status: "blocked" });
    lastProgress(world, step.id, 31);
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.wakes[0]).toMatchObject({
      agentId: ENGINEER,
      reason: "stall_sentinel_blocked_without_blocker",
      payload: expect.objectContaining({ message: expect.stringContaining("Set blockedByIssueIds") }),
    });
    await h.sweepAt(10);
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    await h.sweepAt(31);
    expect(h.calls.telegrams[0]).toContain("is marked blocked but does not say what it is waiting for. What I did: asked Tom's Labs Engineer at 13:00");
    expect(mutatingWakes(h.calls)).toHaveLength(1);
  });

  it("alerts at once when a blocked task with no blocker has no agent to ask", async () => {
    const world = new World();
    const root = world.add({ id: id("root"), title: "Root", status: "in_progress", assigneeAgentId: JARVIS });
    world.add({ id: id("orphan"), parentId: root.id, status: "blocked" });
    lastProgress(world, root.id, 31);
    const h = harness(world);
    await h.sweepAt(0);
    expect(mutatingWakes(h.calls)).toEqual([]);
    expect(h.calls.telegrams[0]).toContain("and no agent owns it.");
  });

  it("wakes the parent's agent once when a checkpoint step finished and others are open", async () => {
    const world = new World();
    const root = world.add({ id: id("root"), title: "Root", status: "blocked", assigneeAgentId: JARVIS });
    const done = world.add({ id: id("s1"), title: "S1: First", parentId: root.id, status: "done", completedAt: ago(16), assigneeAgentId: ENGINEER });
    const open = world.add({ id: id("s2"), title: "S2: Second", parentId: root.id, status: "in_progress", assigneeAgentId: ENGINEER });
    world.blocks(done.id, root.id);
    world.blocks(open.id, root.id);
    world.run({ issueId: open.id, agentId: ENGINEER, status: "running", startedAt: ago(2), finishedAt: null, silenceAgeMs: 0 });
    const h = harness(world);
    await h.sweepAt(0);
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    expect(h.calls.wakes[0]).toMatchObject({
      agentId: JARVIS,
      issueId: root.id,
      reason: "stall_sentinel_checkpoint_done",
      payload: expect.objectContaining({ finishedChildIssueId: done.id }),
    });
    await h.sweepAt(5);
    expect(mutatingWakes(h.calls)).toHaveLength(1);
  });
});

describe("duplicates (D)", () => {
  it("cancels only the newer, empty copy of a step", async () => {
    const world = new World();
    const { root, step } = stepTree(world, { status: "in_progress" });
    world.run({ issueId: step.id, agentId: ENGINEER, status: "running", startedAt: ago(1), finishedAt: null, silenceAgeMs: 0 });
    const copy = world.add({ id: id("copy"), title: "S3 : Build A again", parentId: root.id, status: "todo", createdAt: ago(5) });
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.cancelledIssues).toEqual([copy.id]);
    expect(h.calls.comments.find((c) => c.issueId === copy.id)?.body).toContain("empty duplicate");
    expect(h.calls.telegrams).toEqual([]);
  });

  it("alerts when both copies already have work", async () => {
    const world = new World();
    const { root, step } = stepTree(world, { status: "in_progress", title: "S5e: Make the wrapper fail closed" });
    world.run({ issueId: step.id, agentId: ENGINEER, status: "running", startedAt: ago(1), finishedAt: null, silenceAgeMs: 0 });
    const copy = world.add({ id: id("copy"), title: "S5e: Close the fail-open reset", parentId: root.id, status: "todo", createdAt: ago(5) });
    world.issuesWithWork.add(copy.id);
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.cancelledIssues).toEqual([]);
    expect(h.calls.telegrams[0]).toMatch(/has two open copies of step S5e: TOM-\d+ and TOM-\d+\. Why: both already have work/);
  });
});

describe("unknown cause (U)", () => {
  it("is the 3-hour backstop so no open tree is ever silent", async () => {
    const world = new World();
    const root = world.add({ id: id("root"), title: "Root", status: "in_progress", assigneeAgentId: JARVIS });
    world.add({ id: id("child"), parentId: root.id, status: "todo" });
    lastProgress(world, root.id, 179);
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.telegrams).toEqual([]);
    await h.sweepAt(2);
    expect(h.calls.telegrams[0]).toContain("Why: I cannot see a cause; nothing is running and nothing is waiting on you.");
  });

  it("doubles the times for routine executions", async () => {
    const world = new World();
    const root = world.add({ id: id("root"), title: "Routine", status: "in_progress", assigneeAgentId: JARVIS, originKind: "routine_execution" });
    world.add({ id: id("child"), parentId: root.id, status: "todo" });
    lastProgress(world, root.id, 200);
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.telegrams).toEqual([]);
    await h.sweepAt(41);
    expect(h.calls.telegrams).toHaveLength(1);
  });
});

describe("provider usage (P), Claude only", () => {
  function quotaStall(world: World) {
    const tree = stepTree(world, { status: "in_progress" });
    world.run({ issueId: tree.step.id, agentId: ENGINEER, status: "failed", errorCode: "provider_quota", startedAt: ago(6), finishedAt: ago(5) });
    return tree;
  }

  it("Claude out: no override change, one wake at reset + 5 minutes, one T2 alert", async () => {
    const world = new World();
    const { step } = quotaStall(world);
    const h = harness(world, { quota: claudeQuota(10, 120) });
    await h.sweepAt(0);
    expect(h.calls.overrides).toEqual([]);
    expect(mutatingWakes(h.calls)).toEqual([]);
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toContain("is waiting for Claude usage, which comes back at 15:00. What I did: set it to restart at 15:05. Next: nothing needed from you.");
    expect(h.calls.telegrams[0]).not.toMatch(/OpenAI/);

    await h.sweepAt(30);
    await h.sweepAt(124);
    expect(mutatingWakes(h.calls)).toEqual([]);
    await h.sweepAt(126);
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    expect(h.calls.wakes[0]).toMatchObject({ agentId: ENGINEER, issueId: step.id, reason: "stall_sentinel_provider_reset" });
    await h.sweepAt(128);
    await h.sweepAt(130);
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    expect(h.calls.overrides).toEqual([]);
    expect(h.calls.telegrams.filter((t) => t.includes("waiting for Claude usage"))).toHaveLength(1);
  });

  it.each([
    ["19% left, reset in 61 min: alert at once", 19, 61, 80, 1],
    ["21% left, reset in 61 min: no alert yet", 21, 61, 80, 0],
    ["19% left, reset in 59 min: no alert yet", 19, 59, 80, 0],
    ["weekly 14% left: alert at once", 90, 30, 14, 1],
    ["weekly 16% left: no alert yet", 90, 30, 16, 0],
  ])("Claude-out edges: %s", async (_name, sessionLeft, resetIn, weekly, expectedAlerts) => {
    const world = new World();
    quotaStall(world);
    const h = harness(world, { quota: claudeQuota(sessionLeft, resetIn, weekly) });
    await h.sweepAt(0);
    expect(h.calls.overrides).toEqual([]);
    expect(h.calls.telegrams).toHaveLength(expectedAlerts);
  });

  it("not out: restarts at reset + 5 and alerts only if nothing restarted 15 minutes after the reset", async () => {
    const world = new World();
    quotaStall(world);
    const h = harness(world, { quota: claudeQuota(30, 20) });
    await h.sweepAt(0);
    expect(h.calls.telegrams).toEqual([]);
    await h.sweepAt(26);
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    await h.sweepAt(36);
    expect(h.calls.telegrams).toHaveLength(1);
  });

  it("OpenAI override on a Claude agent: rewritten to claude_local", async () => {
    const world = new World();
    const { step } = stepTree(world, {
      status: "in_progress",
      assigneeAdapterOverrides: { adapterType: "codex_local", adapterConfig: { model: "gpt-6-sol", modelReasoningEffort: "high" } },
    });
    world.run({ issueId: step.id, agentId: ENGINEER, status: "failed", errorCode: "provider_quota", startedAt: ago(6), finishedAt: ago(5) });
    const retry = world.run({ issueId: step.id, agentId: ENGINEER, status: "scheduled_retry", createdAt: ago(5), startedAt: null, finishedAt: null, scheduledRetryAt: new Date(NOW.getTime() + HOUR) });
    const h = harness(world, { quota: claudeQuota(80, 60) });
    await h.sweepAt(0);
    expect(h.calls.overrides).toEqual([{ issueId: step.id, overrides: { adapterConfig: { model: "claude-sonnet-5-5", effort: "high" } } }]);
    expect(h.calls.cancels).toEqual([retry.id]);
    expect(h.calls.wakes[0]).toMatchObject({ agentId: ENGINEER, reason: "stall_sentinel_provider_rewrite" });
    expect(h.calls.telegrams).toEqual([]);
    const healed = actions(h.calls, "stall_sentinel.healed")[0]!;
    expect(healed.details).toMatchObject({ action: "rewrite_to_claude", previousOverrides: { adapterType: "codex_local" } });
  });

  it("moves an idle task with a codex override to Claude even before it stalls", async () => {
    const world = new World();
    const { step } = stepTree(world, { status: "todo", assigneeAdapterOverrides: { adapterType: "codex_local" } });
    lastProgress(world, step.id, 1);
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.overrides).toEqual([{ issueId: step.id, overrides: null }]);
    expect(mutatingWakes(h.calls)).toEqual([]);
  });

  it("never moves a task from Claude to OpenAI", async () => {
    const world = new World();
    quotaStall(world);
    const h = harness(world, { quota: claudeQuota(1, 300, 1) });
    for (const minutes of [0, 60, 120]) await h.sweepAt(minutes);
    expect(h.calls.overrides).toEqual([]);
    for (const text of [...h.calls.telegrams, ...h.calls.comments.map((c) => c.body)]) expect(text).not.toMatch(/OpenAI|gpt-/);
  });

  it("Codex agent without a Claude override: alerts once and changes nothing", async () => {
    const world = new World();
    const { step } = stepTree(world, { status: "in_progress", assigneeAgentId: CODEX });
    world.run({ issueId: step.id, agentId: CODEX, status: "failed", errorCode: "provider_quota", startedAt: ago(6), finishedAt: ago(5) });
    const h = harness(world, { quota: claudeQuota(80, 60) });
    await h.sweepAt(0);
    await h.sweepAt(70);
    await h.sweepAt(200);
    expect(h.calls.overrides).toEqual([]);
    expect(mutatingWakes(h.calls)).toEqual([]);
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toContain("is waiting on Codex Direct Standby, a Codex agent that has no OpenAI usage left.");
  });

  it("groups roots waiting for the same reset into one message, with a comment on each", async () => {
    const world = new World();
    const a = quotaStall(world);
    const b = quotaStall(world);
    const h = harness(world, { quota: claudeQuota(10, 120) });
    await h.sweepAt(0);
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toMatch(/^Stalled: 2 tasks, same reason: waiting for Claude usage, which comes back at 15:00\. Tasks: TOM-\d+ and TOM-\d+\./);
    expect(h.calls.comments.filter((c) => c.issueId === a.root.id || c.issueId === b.root.id).length).toBeGreaterThanOrEqual(2);
  });
});

describe("rate limits", () => {
  it("sends at most 6 Telegram messages per company per hour; comments are not capped", async () => {
    const world = new World();
    const roots = Array.from({ length: 8 }, (_, i) => {
      const root = world.add({ id: id("root"), title: `Root ${i}`, status: "in_progress", assigneeAgentId: JARVIS });
      world.add({ id: id("child"), parentId: root.id, status: "todo" });
      lastProgress(world, root.id, 200);
      return root;
    });
    const h = harness(world);
    await h.sweepAt(0);
    expect(h.calls.telegrams).toHaveLength(6);
    expect(new Set(h.calls.comments.map((c) => c.issueId))).toEqual(new Set(roots.map((r) => r.id)));
    await h.sweepAt(30);
    expect(h.calls.telegrams).toHaveLength(6);
    await h.sweepAt(61);
    expect(h.calls.telegrams.some((t) => t.includes("2 more stalls were found this hour"))).toBe(true);
  });

  it("repeats one stall at most every 60 minutes", async () => {
    const world = new World();
    const root = world.add({ id: id("root"), title: "Root", status: "in_progress", assigneeAgentId: JARVIS });
    world.add({ id: id("child"), parentId: root.id, status: "todo" });
    lastProgress(world, root.id, 200);
    const h = harness(world);
    await h.sweepAt(0);
    await h.sweepAt(30);
    await h.sweepAt(59);
    expect(h.calls.telegrams).toHaveLength(1);
    await h.sweepAt(60);
    expect(h.calls.telegrams).toHaveLength(2);
  });

  it("does not repeat early after a restart (memory rebuilt from activity rows)", async () => {
    const world = new World();
    const root = world.add({ id: id("root"), title: "Root", status: "in_progress", assigneeAgentId: JARVIS });
    world.add({ id: id("child"), parentId: root.id, status: "todo" });
    lastProgress(world, root.id, 200);
    const first = harness(world);
    await first.sweepAt(0);
    const rows = first.calls.activities.map((a) => ({ action: a.action, entityId: a.entityId, details: a.details, createdAt: NOW }));
    const second = harness(world, { memoryRows: rows });
    await second.sweepAt(10);
    expect(second.calls.telegrams).toEqual([]);
  });
});

describe("kill switch and rollout", () => {
  function everyCause(world: World) {
    // Lost run, stuck run, blocked without blocker, cancelled blocker, duplicate, codex override.
    const lost = stepTree(world);
    lastProgress(world, lost.step.id, 20);
    const stuck = stepTree(world, { status: "in_progress" });
    world.run({ issueId: stuck.step.id, agentId: ENGINEER, status: "running", startedAt: ago(100), finishedAt: null, silenceAgeMs: 40 * MIN });
    const blocked = stepTree(world, { status: "blocked" });
    lastProgress(world, blocked.step.id, 40);
    const dependent = stepTree(world, { status: "blocked" });
    const gone = world.add({ id: id("gone"), parentId: dependent.root.id, status: "cancelled", cancelledAt: ago(20) });
    world.blocks(gone.id, dependent.step.id);
    world.add({ id: id("dup"), title: "S3: copy", parentId: stuck.root.id, status: "todo", createdAt: ago(3) });
    const rewrite = stepTree(world, { assigneeAdapterOverrides: { adapterType: "codex_local" } });
    lastProgress(world, rewrite.step.id, 1);
    return world;
  }

  it("off: no sweep, no actions, no alerts", async () => {
    const world = everyCause(new World());
    const h = harness(world, { mode: "off" });
    const result = await h.sweepAt(0);
    expect(result.skipped).toBe(true);
    expect(h.calls).toEqual({ wakes: [], cancels: [], overrides: [], cancelledIssues: [], comments: [], activities: [], telegrams: [] });
    expect(getStallSentinelHealth()).toMatchObject({ mode: "off" });
  });

  it("alert_only: alerts and comments, but no task is mutated, no run cancelled and no heal wake queued", async () => {
    const world = everyCause(new World());
    const before = JSON.stringify([...world.issues.values()]);
    const h = harness(world, { mode: "alert_only" });
    await h.sweepAt(0);
    await h.sweepAt(60);
    expect(h.calls.overrides).toEqual([]);
    expect(h.calls.cancels).toEqual([]);
    expect(h.calls.cancelledIssues).toEqual([]);
    expect(mutatingWakes(h.calls)).toEqual([]);
    expect(JSON.stringify([...world.issues.values()])).toBe(before);
    expect(actions(h.calls, "stall_sentinel.would_heal").length).toBeGreaterThanOrEqual(5);
    expect(actions(h.calls, "stall_sentinel.healed")).toEqual([]);
    expect(h.calls.telegrams.length).toBeGreaterThan(0);
    expect(h.calls.telegrams.join("\n")).toContain("Self-repair is off; I would have");
    expect(h.calls.comments.some((c) => c.body.includes("I would have done this"))).toBe(true);
  });

  it("on: alert-only for 24 hours after the first sweep, then self-repair with one message", async () => {
    const world = new World();
    const { step } = stepTree(world);
    lastProgress(world, step.id, 20);
    const h = harness(world, { rollout: { startedAt: null, selfRepairOnAt: null } });
    await h.sweepAt(0);
    expect(actions(h.calls, "stall_sentinel.rollout")[0]!.details).toMatchObject({ phase: "started" });
    expect(h.calls.telegrams[0]).toMatch(/^Stall alarm started\. .*Self-repair starts tomorrow at 13:00\. Nothing needed from you\.$/);
    expect(mutatingWakes(h.calls)).toEqual([]);
    expect(actions(h.calls, "stall_sentinel.would_heal")).toHaveLength(1);
    expect(getStallSentinelHealth()).toMatchObject({ mode: "on", effectiveMode: "alert_only" });

    await h.sweepAt(23 * 60);
    expect(mutatingWakes(h.calls)).toEqual([]);

    world.wakes = [];
    await h.sweepAt(24 * 60 + 1);
    const t16 = h.calls.telegrams.filter((t) => t.startsWith("Stall alarm: self-repair is now on."));
    expect(t16).toHaveLength(1);
    expect(getStallSentinelHealth()).toMatchObject({ effectiveMode: "on" });
    await h.sweepAt(24 * 60 + 3);
    expect(h.calls.telegrams.filter((t) => t.startsWith("Stall alarm: self-repair is now on."))).toHaveLength(1);
  });

  it("lists trees stuck for over a day in the start-up digest instead of one message each", async () => {
    const world = new World();
    for (let i = 0; i < 3; i += 1) {
      const root = world.add({ id: id("root"), title: `Old ${i}`, status: "in_progress", assigneeAgentId: JARVIS, createdAt: ago(3 * 24 * 60) });
      world.add({ id: id("child"), parentId: root.id, status: "todo", createdAt: ago(3 * 24 * 60) });
    }
    const h = harness(world, { rollout: { startedAt: null, selfRepairOnAt: null } });
    await h.sweepAt(0);
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toMatch(/^Stall alarm started\. 3 tasks were already stuck for over a day: TOM-\d+, TOM-\d+ and TOM-\d+\. I will remind you about them once a day at 09:00\./);
    await h.sweepAt(120);
    expect(h.calls.telegrams).toHaveLength(1);
  });
});

describe("holds, gaps and failures", () => {
  it("all runs held: one plain alert after 60 minutes and no per-tree action", async () => {
    const world = new World();
    const { step } = stepTree(world);
    lastProgress(world, step.id, 300);
    const h = harness(world, { suppressed: true });
    await h.sweepAt(0);
    await h.sweepAt(59);
    expect(h.calls.telegrams).toEqual([]);
    await h.sweepAt(61);
    expect(h.calls.telegrams).toEqual(["Paused: no new agent work has started for 1 hour 1 minute. Why: Paperclip is holding all new runs. What I did: nothing, because someone set this hold on purpose. Next: if you did not plan this, open Paperclip and lift the hold. I will tell you again at 15:01."]);
    expect(h.calls.wakes).toEqual([]);
  });

  it("tells the board once when the alarm was not running for over 10 minutes", async () => {
    const world = new World();
    const h = harness(world, { lastSweepAt: ago(132) });
    await h.sweepAt(0);
    await h.sweepAt(2);
    expect(h.calls.telegrams).toEqual([
      "Stall alarm: I was not running from 10:48 to 13:00 (2 hours 12 minutes). What I did: checked every task again just now. Next: nothing needed from you; anything still stuck gets its own message.",
    ]);
  });

  it("after 3 failed sweeps in a row, sends one plain message and health fails", async () => {
    const world = new World();
    const store = { fail: false };
    const h = harness(world, { store });
    h.at(0);
    await h.sentinel.tick();
    store.fail = true;
    for (let i = 1; i <= 2; i += 1) {
      h.at(i * 3);
      await h.sentinel.tick();
    }
    expect(h.calls.telegrams).toEqual([]);
    for (let i = 3; i <= 5; i += 1) {
      h.at(i * 3);
      await h.sentinel.tick();
    }
    expect(h.calls.telegrams).toEqual(["Stall alarm: my last 3 checks failed. Next: Jarvis has been asked to look."]);
    expect(getStallSentinelHealth()).toMatchObject({ lastSweepOk: false });
    store.fail = false;
    h.at(18);
    await h.sentinel.tick();
    expect(getStallSentinelHealth()).toMatchObject({ lastSweepOk: true });
  });

  it("skips a tick within 2 minutes of the last sweep start", async () => {
    const world = new World();
    const h = harness(world);
    h.at(0);
    expect(await h.sentinel.tick()).not.toBeNull();
    h.at(1);
    expect(await h.sentinel.tick()).toBeNull();
    h.at(2);
    expect(await h.sentinel.tick()).not.toBeNull();
  });
});

describe("recovery-owned issues", () => {
  it("leaves issues with an active recovery action to the recovery loop", async () => {
    const world = new World();
    const { step } = stepTree(world);
    lastProgress(world, step.id, 20);
    world.activeRecovery.add(step.id);
    const h = harness(world);
    await h.sweepAt(0);
    expect(mutatingWakes(h.calls)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S10: fixes for the S8 review (TOM-723). Each case failed on e72888b3.
// ---------------------------------------------------------------------------

describe("a requeue that worked (S8 blocking 1)", () => {
  it("run started and succeeded, task idle for 8 minutes: no T4", async () => {
    const world = new World();
    const { root, step } = stepTree(world, { status: "in_progress" });
    for (const issue of [root, step]) lastProgress(world, issue.id, 11);
    const h = harness(world);

    await h.sweepAt(0); // lost run for 11 min: re-queued
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    expect(h.calls.telegrams).toEqual([]);

    world.wakes = [];
    world.run({ issueId: step.id, agentId: ENGINEER, status: "succeeded", createdAt: h.at(1), startedAt: h.at(1), finishedAt: h.at(8) });
    world.latestProgress.set(step.id, h.at(8));

    await h.sweepAt(10);
    await h.sweepAt(16); // 16 min after the heal, 8 min after real progress
    await h.sweepAt(60);
    expect(h.calls.telegrams).toEqual([]);
    expect(h.calls.wakes.filter((w) => w.reason === "stall_sentinel_reroute")).toEqual([]);
  });

  it("a requeue whose run starts and finishes sends nothing, then one 'Moving again' after an earlier alert", async () => {
    const world = new World();
    const { root, step } = stepTree(world, { status: "in_progress" });
    for (const issue of [root, step]) lastProgress(world, issue.id, 11);
    const h = harness(world);
    await h.sweepAt(0);
    await h.sweepAt(16); // no run started: T4 is right here
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toContain("its run was lost");

    world.wakes = [];
    world.run({ issueId: step.id, agentId: ENGINEER, status: "succeeded", createdAt: h.at(17), startedAt: h.at(17), finishedAt: h.at(25) });
    world.latestProgress.set(step.id, h.at(25));
    await h.sweepAt(27);
    await h.sweepAt(80);
    expect(h.calls.telegrams.filter((t) => t.startsWith("Moving again"))).toHaveLength(1);
    expect(h.calls.telegrams.filter((t) => t.includes("its run was lost"))).toHaveLength(1);
  });

  it("still alerts when the requeue produced no run at all", async () => {
    const world = new World();
    const { root, step } = stepTree(world, { status: "in_progress" });
    for (const issue of [root, step]) lastProgress(world, issue.id, 11);
    const h = harness(world);
    await h.sweepAt(0);
    await h.sweepAt(14);
    expect(h.calls.telegrams).toEqual([]);
    await h.sweepAt(16);
    expect(h.calls.telegrams).toHaveLength(1);
  });
});

describe("a wake that was dropped is 'not asked' (S8 blocking 2)", () => {
  function checkpointWorld() {
    const world = new World();
    const root = world.add({ id: id("root"), title: "Root", status: "blocked", assigneeAgentId: JARVIS });
    const done = world.add({ id: id("s1"), title: "S1: First", parentId: root.id, status: "done", completedAt: ago(16), assigneeAgentId: ENGINEER });
    const open = world.add({ id: id("s2"), title: "S2: Second", parentId: root.id, status: "in_progress", assigneeAgentId: ENGINEER });
    world.blocks(done.id, root.id);
    world.blocks(open.id, root.id);
    world.run({ issueId: open.id, agentId: ENGINEER, status: "running", startedAt: ago(2), finishedAt: null, silenceAgeMs: 0 });
    return { world, root, done, open };
  }

  it("K: a dropped checkpoint wake is not reported as 'woke Jarvis, who has not picked it up'", async () => {
    const { world, root } = checkpointWorld();
    const h = harness(world, { wakeResult: () => ({ queued: false, reason: "not_queued" }) });
    await h.sweepAt(0);
    expect(actions(h.calls, "stall_sentinel.healed")[0]!.details).toMatchObject({ asked: false, wake: "dropped" });
    const comment = h.calls.comments.find((c) => c.issueId === root.id)!;
    expect(comment.body).not.toMatch(/I woke|I asked|so I restarted/);
    expect(comment.body).toContain("not accepted");
    await h.sweepAt(31);
    expect(h.calls.telegrams.some((t) => t.includes("has not picked it up"))).toBe(false);
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toContain("I cannot see a cause");
  });

  it("K: a wake that is queued and picked up (a run starts after the finished step) never alerts", async () => {
    const { world, root } = checkpointWorld();
    const h = harness(world);
    await h.sweepAt(0);
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    world.run({ issueId: root.id, agentId: JARVIS, status: "succeeded", createdAt: h.at(3), startedAt: h.at(3), finishedAt: h.at(6) });
    await h.sweepAt(40);
    expect(h.calls.telegrams).toEqual([]);
  });

  it("C: a dropped cancelled-blocker wake is not reported as 'asked to replace the blocker'", async () => {
    const world = new World();
    const root = world.add({ id: id("root"), title: "Root", status: "in_progress", assigneeAgentId: JARVIS });
    const cancelled = world.add({ id: id("s1"), title: "S1: First", parentId: root.id, status: "cancelled", cancelledAt: ago(20), assigneeAgentId: ENGINEER });
    const blocked = world.add({ id: id("s2"), title: "S2: Second", parentId: root.id, status: "blocked", assigneeAgentId: ENGINEER });
    world.blocks(cancelled.id, blocked.id);
    lastProgress(world, root.id, 20);
    const h = harness(world, { wakeResult: () => ({ queued: false, reason: "not_queued" }) });
    await h.sweepAt(0);
    const comment = h.calls.comments.find((c) => c.issueId === root.id)!.body;
    expect(comment).not.toContain("I asked");
    expect(comment).toContain("not accepted");
    await h.sweepAt(31);
    expect(h.calls.telegrams.join("\n")).not.toContain("asked to replace");
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toContain("I cannot see a cause");
  });

  it("an earlier wake that is still waiting is reported as waiting, not as 'restarted'", async () => {
    const world = new World();
    const { root, step } = stepTree(world, { status: "in_progress" });
    for (const issue of [root, step]) lastProgress(world, issue.id, 11);
    const h = harness(world, { wakeResult: () => ({ queued: false, reason: "already_pending" }) });
    await h.sweepAt(0);
    const comment = h.calls.comments.find((c) => c.issueId === root.id)!.body;
    expect(comment).not.toContain("so I restarted it");
    expect(comment).toContain("already waiting");
  });
});

describe("alert-only mode (S8 non-blocking 1)", () => {
  it("queues no wake at all, not even a reroute wake for Jarvis", async () => {
    const world = new World();
    world.agents.set(ENGINEER, makeAgent({ id: ENGINEER, name: "Tom's Labs Engineer", status: "paused" }));
    const { step } = stepTree(world);
    lastProgress(world, step.id, 20);
    const h = harness(world, { mode: "alert_only" });
    await h.sweepAt(0);
    await h.sweepAt(60);
    await h.sweepAt(120);
    expect(h.calls.wakes).toEqual([]);
    expect(h.calls.telegrams.length).toBeGreaterThan(0);
    expect(h.calls.telegrams.join("\n")).not.toContain("Jarvis has been asked");
  });

  it("alerts at the cause's alert time (heal due + 15 min), not at heal-due time", async () => {
    const world = new World();
    const { root, step } = stepTree(world, { status: "in_progress" });
    for (const issue of [root, step]) lastProgress(world, issue.id, 11);
    const h = harness(world, { mode: "alert_only" });
    await h.sweepAt(0); // lost run for 11 min: heal would be due (10 min)
    expect(actions(h.calls, "stall_sentinel.would_heal")).toHaveLength(1);
    expect(h.calls.telegrams).toEqual([]);
    await h.sweepAt(13);
    expect(h.calls.telegrams).toEqual([]);
    await h.sweepAt(15);
    expect(h.calls.telegrams).toHaveLength(1);
    expect(h.calls.telegrams[0]).toContain("Self-repair is off");
  });
});

describe("heal keys (S8 non-blocking 3)", () => {
  it("a Claude rewrite does not block the wait-for-reset wake on the same task", async () => {
    const world = new World();
    const { step } = stepTree(world, {
      status: "todo",
      assigneeAdapterOverrides: { adapterType: "codex_local", adapterConfig: { model: "gpt-5" } },
    });
    lastProgress(world, step.id, 5);
    const h = harness(world, { quota: claudeQuota(10, 120) });
    await h.sweepAt(0);
    expect(h.calls.overrides).toHaveLength(1); // the OpenAI override was rewritten to Claude
    world.runs.push({
      id: id("run"), issueId: step.id, agentId: ENGINEER, status: "failed", errorCode: "provider_quota",
      createdAt: h.at(1), startedAt: h.at(1), finishedAt: h.at(2), scheduledRetryAt: null, silenceAgeMs: null,
    });
    world.wakes = [];
    await h.sweepAt(4); // Claude is out: the one wake at reset + 5 min must still be scheduled
    const restart = actions(h.calls, "stall_sentinel.healed").filter((a) => a.details.action === "restart_after_reset");
    expect(restart).toHaveLength(1);
  });
});

describe("sweep time limit (S8 non-blocking 2)", () => {
  it("a sweep past the limit blocks a second sweep, double-sends nothing and cannot overwrite health", async () => {
    const world = new World();
    const { root, step } = stepTree(world, { status: "in_progress" });
    for (const issue of [root, step]) lastProgress(world, issue.id, 120);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    const h = harness(world, {
      config: { sweepTimeoutMs: 20, sweepIntervalMs: 1_000 },
      loadSnapshot: async (_companyId, now) => {
        loads += 1;
        if (loads === 1) await gate;
        return world.snapshot(now);
      },
    });
    h.at(0);
    expect(await h.sentinel.tick()).toBeNull(); // timed out
    expect(getStallSentinelHealth()).toMatchObject({ lastSweepOk: false });

    h.at(10); // well past the interval, but the first sweep is still running
    expect(await h.sentinel.tick()).toBeNull();
    expect(loads).toBe(1);

    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The late sweep did nothing and wrote nothing.
    expect(h.calls.wakes).toEqual([]);
    expect(h.calls.telegrams).toEqual([]);
    expect(getStallSentinelHealth()).toMatchObject({ lastSweepOk: false });

    h.at(20); // the old sweep has stopped: a new one may start
    expect(await h.sentinel.tick()).not.toBeNull();
    expect(loads).toBe(2);
    expect(getStallSentinelHealth()).toMatchObject({ lastSweepOk: true });
  });
});

describe("rollout flip (would-heal notes never block a real heal)", () => {
  it("a would-heal recorded in the alert-only window does not stop the real heal once self-repair is on", async () => {
    const world = new World();
    const { root, step } = stepTree(world, { status: "in_progress" });
    for (const issue of [root, step]) lastProgress(world, issue.id, 0);
    const h = harness(world, { rollout: { startedAt: null, selfRepairOnAt: null } });
    await h.sweepAt(0); // healthy: the rollout window starts
    for (const issue of [root, step]) world.latestProgress.set(issue.id, h.at(49));
    await h.sweepAt(60); // 11 minutes without progress, still alert-only
    expect(actions(h.calls, "stall_sentinel.would_heal")).toHaveLength(1);
    expect(mutatingWakes(h.calls)).toEqual([]);
    await h.sweepAt(24 * 60 + 1); // self-repair is on; the note is 23 hours old
    expect(mutatingWakes(h.calls)).toHaveLength(1);
    expect(actions(h.calls, "stall_sentinel.healed")).toHaveLength(1);
  });
});
