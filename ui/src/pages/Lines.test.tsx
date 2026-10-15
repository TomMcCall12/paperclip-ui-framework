import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildLineTree } from "./Lines";

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
});
