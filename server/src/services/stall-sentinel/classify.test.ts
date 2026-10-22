import { describe, expect, it } from "vitest";
import { classifyTree } from "./classify.js";
import { readStallSentinelConfig } from "./config.js";
import type { CompanySnapshot, SnapshotIssue } from "./watch-units.js";

const T = new Date("2026-10-21T12:00:00.000Z");
const ago = (min: number) => new Date(T.getTime() - min * 60_000);
const config = readStallSentinelConfig({});

function issue(id: string, partial: Partial<SnapshotIssue> = {}): SnapshotIssue {
  return {
    id, identifier: id, title: id, status: "todo", parentId: null, lineId: null, assigneeAgentId: "eng", assigneeUserId: null,
    statusVersion: 3, originKind: "manual", hiddenAt: null, conversationAgentId: null, monitorNextCheckAt: null,
    unblockDescriptor: null, assigneeAdapterOverrides: null, createdAt: ago(60), updatedAt: ago(60), completedAt: null, cancelledAt: null,
    ...partial,
  };
}

function snapshot(issues: SnapshotIssue[]): CompanySnapshot {
  return {
    companyId: "c", now: T, issues: new Map(issues.map((i) => [i.id, i])), lineRootIds: new Set(), blocks: new Map(), blockedBy: new Map(),
    runs: [], wakes: [],
    agents: new Map([["eng", { id: "eng", name: "Engineer", role: null, status: "idle", adapterType: "claude_local", adapterConfig: {} }]]),
    progress: { latestByIssue: new Map(), issuesWithWork: new Set() },
    waitingOnBoardIssueIds: new Set(), activeRecoveryIssueIds: new Set(), labelsByIssue: new Map(), lastUserOverrideAt: new Map(),
  };
}

const ctx = { thresholds: config.thresholds, quota: new Map(), lookbackMs: config.thresholds.progressLookbackMs };
const tree = (rootId: string, ids: string[]) => ({ rootId, issueIds: new Set(ids), isRoutine: false });

describe("classifyTree", () => {
  it("plans a guarded re-queue for a lost run, due 10 minutes after the last progress", () => {
    const s = snapshot([issue("root", { status: "in_progress" }), issue("leaf", { parentId: "root" })]);
    const [f] = classifyTree(s, tree("root", ["root", "leaf"]), ctx).findings;
    expect(f).toMatchObject({ cause: "L", issueId: "leaf", path: ["root", "leaf"], heal: { kind: "requeue", agentId: "eng" } });
    expect(f!.healDueAt).toEqual(ago(50));
  });

  it("leaves heals on issues the recovery loop owns and falls back to the backstop alert", () => {
    const s = snapshot([issue("root", { status: "in_progress" }), issue("leaf", { parentId: "root" })]);
    s.activeRecoveryIssueIds.add("leaf");
    const [f] = classifyTree(s, tree("root", ["root", "leaf"]), ctx).findings;
    expect(f!.heal).toBeNull();
    expect(f!.alertDueAt).toEqual(new Date(ago(60).getTime() + config.thresholds.unknownAlertMs));
  });

  it("waits for a monitor until its check time plus 15 minutes", () => {
    const s = snapshot([issue("root", { status: "in_progress", monitorNextCheckAt: ago(10) })]);
    expect(classifyTree(s, tree("root", ["root"]), ctx).findings).toEqual([]);
    s.issues.get("root")!.monitorNextCheckAt = ago(16);
    expect(classifyTree(s, tree("root", ["root"]), ctx).findings[0]).toMatchObject({ cause: "L" });
  });

  it("finds nothing on a tree that waits on the board", () => {
    const s = snapshot([issue("root", { status: "in_progress" }), issue("leaf", { parentId: "root", assigneeUserId: "tom" })]);
    expect(classifyTree(s, tree("root", ["root", "leaf"]), ctx).findings).toEqual([]);
  });

  describe("agent in error", () => {
    const stalled = () => {
      const s = snapshot([issue("root", { status: "in_progress" }), issue("leaf", { parentId: "root" })]);
      s.agents.get("eng")!.status = "error";
      return s;
    };
    const run = (id: string, partial: Record<string, unknown>) =>
      ({ id, agentId: "eng", issueId: "leaf", createdAt: ago(1), startedAt: null, finishedAt: null, scheduledRetryAt: null, ...partial }) as never;

    it("alerts when the agent is in error and nothing is waiting to run", () => {
      expect(classifyTree(stalled(), tree("root", ["root", "leaf"]), ctx).findings[0]).toMatchObject({ cause: "A" });
    });

    it("does not alert when a due scheduled retry waits (deploy restart case)", () => {
      const s = stalled();
      s.runs.push(run("r1", { status: "scheduled_retry", scheduledRetryAt: ago(1) }));
      const causes = classifyTree(s, tree("root", ["root", "leaf"]), ctx).findings.map((f) => f.cause);
      expect(causes).not.toContain("A");
    });

    it("does not alert when the agent has a queued run or is already running", () => {
      const queued = stalled();
      queued.runs.push(run("r1", { status: "queued" }));
      expect(classifyTree(queued, tree("root", ["root", "leaf"]), ctx).findings.map((f) => f.cause)).not.toContain("A");
      const busy = stalled();
      busy.runs.push(run("r2", { status: "running", issueId: "other", startedAt: ago(1) }));
      expect(classifyTree(busy, tree("root", ["root", "leaf"]), ctx).findings.map((f) => f.cause)).not.toContain("A");
    });

    it("still alerts for a paused agent with a queued run", () => {
      const s = stalled();
      s.agents.get("eng")!.status = "paused";
      s.runs.push(run("r1", { status: "queued" }));
      expect(classifyTree(s, tree("root", ["root", "leaf"]), ctx).findings[0]).toMatchObject({ cause: "A" });
    });
  });
});
