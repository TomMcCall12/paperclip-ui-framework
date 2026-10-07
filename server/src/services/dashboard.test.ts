import { describe, expect, it } from "vitest";
import { inferDeployState, parseQueueDescription } from "./dashboard.js";

const TOM_177_DESCRIPTION = `Tom wants **one rebuild** for every pending Tom's Lab change instead of many small ones. This task is the queue. The previous queue was [TOM-148](/TOM/issues/TOM-148).

## In the next build

Commit \`5d4e540867cd\` on \`feat/terra-simple-autonomy\` (builds on the live commit \`3b07738\`).

| Change | Task |
|---|---|
| Every Claude agent run writes an audit-trail log of its tool calls and file changes, kept 14 days | [TOM-167](/TOM/issues/TOM-167) |

## Rebuilding (Software Engineer)
`;

const TOM_148_DESCRIPTION = `Tom wants **one rebuild** for every pending Tom's Lab change instead of many small ones, after Tom's Lab moves to the new SSD. This task is the queue.

## In the next build

Commit \`3b07738462bd\` on \`feat/terra-simple-autonomy\` (builds on the live commit \`216c87d\`).

| Change | Task |
|---|---|
| Use Claude or OpenAI models on any agent and task, in one list with a heading per provider | Lab session, 7 Oct |
| Claude vs GPT usage card on the Dashboard | [TOM-142](/TOM/issues/TOM-142) |

## Rebuilding (Software Engineer)
`;

describe("parseQueueDescription", () => {
  it("returns an empty result for a null description", () => {
    expect(parseQueueDescription(null)).toEqual({ commit: null, branch: null, items: [] });
  });

  it("parses the commit, branch, and one linked task row", () => {
    expect(parseQueueDescription(TOM_177_DESCRIPTION)).toEqual({
      commit: "5d4e540867cd",
      branch: "feat/terra-simple-autonomy",
      items: [
        {
          title:
            "Every Claude agent run writes an audit-trail log of its tool calls and file changes, kept 14 days",
          taskIdentifier: "TOM-167",
          href: "/issues/TOM-167",
          source: null,
        },
      ],
    });
  });

  it("falls back to the raw task cell when a row has no linked task", () => {
    const result = parseQueueDescription(TOM_148_DESCRIPTION);
    expect(result.commit).toBe("3b07738462bd");
    expect(result.branch).toBe("feat/terra-simple-autonomy");
    expect(result.items).toEqual([
      {
        title: "Use Claude or OpenAI models on any agent and task, in one list with a heading per provider",
        taskIdentifier: null,
        href: null,
        source: "Lab session, 7 Oct",
      },
      {
        title: "Claude vs GPT usage card on the Dashboard",
        taskIdentifier: "TOM-142",
        href: "/issues/TOM-142",
        source: null,
      },
    ]);
  });
});

describe("inferDeployState", () => {
  it("returns null when there is no confirmation yet", () => {
    expect(inferDeployState(null, null)).toBeNull();
  });

  it("maps a pending confirmation to awaiting_approval", () => {
    expect(inferDeployState("pending", null)).toBe("awaiting_approval");
  });

  it("maps rejected/cancelled to declined", () => {
    expect(inferDeployState("rejected", null)).toBe("declined");
    expect(inferDeployState("cancelled", null)).toBe("declined");
  });

  it("maps expired/failed confirmation status to expired", () => {
    expect(inferDeployState("expired", null)).toBe("expired");
    expect(inferDeployState("failed", null)).toBe("expired");
  });

  it("reads the host updater's progress note once accepted", () => {
    expect(inferDeployState("accepted", null)).toBe("queued");
    expect(
      inferDeployState("accepted", "**Tom's Lab updater:** building `3b07738462bd` as tom60."),
    ).toBe("building");
    expect(
      inferDeployState("accepted", "**Tom's Lab updater:** `3b07738462bd` is live as tom60 and healthy."),
    ).toBe("live");
    expect(
      inferDeployState(
        "accepted",
        "**Tom's Lab updater:** the build of `3b07738462bd` failed, so nothing changed.",
      ),
    ).toBe("failed");
  });
});
