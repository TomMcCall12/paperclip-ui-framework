import { describe, expect, it } from "vitest";
import { buildWatchedTrees, findFrontier, isWaitingOnBoard, runIssueId, type CompanySnapshot, type SnapshotIssue } from "./watch-units.js";

const T = new Date("2026-10-21T12:00:00.000Z");

function issue(id: string, partial: Partial<SnapshotIssue> = {}): SnapshotIssue {
  return {
    id, identifier: id, title: id, status: "todo", parentId: null, lineId: null, assigneeAgentId: "a", assigneeUserId: null,
    statusVersion: 1, originKind: "manual", hiddenAt: null, conversationAgentId: null, monitorNextCheckAt: null,
    unblockDescriptor: null, assigneeAdapterOverrides: null, createdAt: T, updatedAt: T, completedAt: null, cancelledAt: null,
    ...partial,
  };
}

function snapshot(issues: SnapshotIssue[], relations: Array<[string, string]> = [], lineRoots: string[] = []): CompanySnapshot {
  const blocks = new Map<string, string[]>();
  const blockedBy = new Map<string, string[]>();
  for (const [a, b] of relations) {
    blocks.set(a, [...(blocks.get(a) ?? []), b]);
    blockedBy.set(b, [...(blockedBy.get(b) ?? []), a]);
  }
  return {
    companyId: "c", now: T, issues: new Map(issues.map((i) => [i.id, i])), lineRootIds: new Set(lineRoots), blocks, blockedBy,
    runs: [], wakes: [], agents: new Map(), progress: { latestByIssue: new Map(), issuesWithWork: new Set() },
    waitingOnBoardIssueIds: new Set(), activeRecoveryIssueIds: new Set(), labelsByIssue: new Map(), lastUserOverrideAt: new Map(),
  };
}

describe("watched trees", () => {
  it("watches open Line roots and open top-level tasks outside a Line, once each", () => {
    const s = snapshot(
      [
        issue("line-root", { status: "in_progress", lineId: "L" }),
        issue("line-child", { parentId: "line-root", lineId: "L" }),
        issue("top", { status: "in_progress" }),
        issue("done-top", { status: "done" }),
        issue("backlog-top", { status: "backlog" }),
        issue("hidden-top", { hiddenAt: T }),
        issue("chat", { conversationAgentId: "a" }),
        issue("watchdog", { originKind: "task_watchdog" }),
        issue("toms", { assigneeAgentId: null, assigneeUserId: "tom" }),
      ],
      [],
      ["line-root"],
    );
    const trees = buildWatchedTrees(s);
    expect(trees.map((t) => t.rootId).sort()).toEqual(["line-root", "top"]);
    expect([...trees.find((t) => t.rootId === "line-root")!.issueIds].sort()).toEqual(["line-child", "line-root"]);
  });

  it("follows blocked issues to their open blockers, across trees", () => {
    const s = snapshot(
      [
        issue("root", { status: "blocked" }),
        issue("other-tree", { status: "blocked" }),
        issue("leaf", { status: "todo", parentId: "x" }),
        issue("x", { status: "in_progress" }),
        issue("done-blocker", { status: "done" }),
      ],
      [["other-tree", "root"], ["leaf", "other-tree"], ["done-blocker", "root"]],
    );
    expect(findFrontier(s, "root")).toEqual([{ issueId: "leaf", path: ["root", "other-tree", "leaf"] }]);
  });

  it("descends from a parent into its open children, and survives a blocker cycle", () => {
    const s = snapshot(
      [issue("p", { status: "in_progress" }), issue("c1", { parentId: "p" }), issue("c2", { parentId: "p", status: "blocked" }), issue("c3", { parentId: "p", status: "blocked" })],
      [["c3", "c2"], ["c2", "c3"]],
    );
    expect(findFrontier(s, "p").map((f) => f.issueId).sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("treats cards, approvals, user assignees and user unblock owners as waiting on the board", () => {
    const s = snapshot([
      issue("card"),
      issue("user", { assigneeUserId: "tom" }),
      issue("owner", { unblockDescriptor: { owner: { userId: "tom" }, action: "sign in" } }),
      issue("board", { unblockDescriptor: { owner: "board", action: "approve" } }),
      issue("agent-owner", { unblockDescriptor: { owner: { agentId: "a" }, action: "x" } }),
    ]);
    s.waitingOnBoardIssueIds.add("card");
    expect(["card", "user", "owner", "board", "agent-owner"].map((id) => isWaitingOnBoard(s, id))).toEqual([true, true, true, true, false]);
  });

  it("reads the issue id from a run context", () => {
    expect(runIssueId({ issueId: "i" })).toBe("i");
    expect(runIssueId({ taskId: "t" })).toBe("t");
    expect(runIssueId(null)).toBeNull();
  });
});
