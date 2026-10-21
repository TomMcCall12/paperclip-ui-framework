import { describe, expect, it } from "vitest";
import { issueProgressAt, treeAgeMs, treeProgress } from "./progress.js";
import type { CompanySnapshot, SnapshotRun } from "./watch-units.js";

const T = new Date("2026-10-21T12:00:00.000Z");
const ago = (min: number) => new Date(T.getTime() - min * 60_000);

function snap(runs: Partial<SnapshotRun>[], latest: Record<string, Date> = {}): CompanySnapshot {
  return {
    companyId: "c", now: T,
    issues: new Map([["i", { id: "i", createdAt: ago(600) } as never], ["j", { id: "j", createdAt: ago(600) } as never]]),
    lineRootIds: new Set(), blocks: new Map(), blockedBy: new Map(),
    runs: runs.map((r, n) => ({ id: `r${n}`, agentId: "a", issueId: "i", status: "succeeded", errorCode: null, createdAt: ago(60), startedAt: ago(60), finishedAt: ago(59), scheduledRetryAt: null, silenceAgeMs: null, ...r })),
    wakes: [], agents: new Map(),
    progress: { latestByIssue: new Map(Object.entries(latest)), issuesWithWork: new Set() },
    waitingOnBoardIssueIds: new Set(), activeRecoveryIssueIds: new Set(), labelsByIssue: new Map(), lastUserOverrideAt: new Map(),
  };
}

describe("progress", () => {
  it("counts succeeded and running runs, never failed, cancelled or queued ones", () => {
    expect(issueProgressAt(snap([{ status: "succeeded", finishedAt: ago(30) }]), "i")).toEqual(ago(30));
    expect(issueProgressAt(snap([{ status: "running", startedAt: ago(20), finishedAt: null }]), "i")).toEqual(ago(20));
    for (const status of ["failed", "timed_out", "cancelled", "queued", "scheduled_retry"]) {
      expect(issueProgressAt(snap([{ status, finishedAt: ago(1), createdAt: ago(1) }]), "i")).toEqual(ago(600));
    }
  });
  it("takes the newest event across the tree", () => {
    const s = snap([], { i: ago(50), j: ago(5) });
    const progress = treeProgress(s, { rootId: "i", issueIds: new Set(["i", "j"]), isRoutine: false });
    expect(progress).toEqual({ at: ago(5), issueId: "j" });
    expect(treeAgeMs(progress, T, 7 * 86_400_000)).toBe(5 * 60_000);
    expect(treeAgeMs({ at: null, issueId: null }, T, 1000)).toBe(1001);
  });
});
