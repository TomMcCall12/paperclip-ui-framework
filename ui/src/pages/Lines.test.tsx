import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildLineTree, filterLineTree } from "./Lines";

const task = (id: string, parentId: string | null = null) => ({ id, parentId }) as Issue;

describe("buildLineTree", () => {
  it("keeps descendants beside their own root even when tasks arrive out of order", () => {
    expect(buildLineTree([task("child-a", "root-a"), task("root-b"), task("root-a"), task("child-b", "root-b")])
      .map(({ issue, depth }) => [issue.id, depth]))
      .toEqual([["root-b", 0], ["child-b", 1], ["root-a", 0], ["child-a", 1]]);
  });

  it("returns orphaned and cyclic tasks once", () => {
    expect(buildLineTree([task("orphan", "missing"), task("a", "b"), task("b", "a")])
      .map(({ issue }) => issue.id))
      .toEqual(["orphan", "a", "b"]);
  });

  it("keeps parent context for a blocked grandchild and names its path", () => {
    const root = { ...task("root"), identifier: "LIN-1", status: "todo" } as Issue;
    const child = { ...task("child", "root"), identifier: "LIN-2", status: "todo" } as Issue;
    const blocked = { ...task("blocked", "child"), identifier: "LIN-3", status: "blocked" } as Issue;
    expect(filterLineTree(buildLineTree([blocked, child, root]), "blocked", "all")
      .map(({ issue, matched, parentPath }) => [issue.id, matched, parentPath]))
      .toEqual([["root", false, ""], ["child", false, "LIN-1"], ["blocked", true, "LIN-1 › LIN-2"]]);
  });
});
