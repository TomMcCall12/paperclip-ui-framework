import { describe, expect, it } from "vitest";
import { lineNamingPrompt } from "./line-naming-prompt.js";

describe("isolated Line naming input", () => {
  it("bounds and redacts root fields without carrying unrelated context", () => {
    const prompt = lineNamingPrompt("line-id", 2, {
      title: `${"A".repeat(300)}TITLE_TAIL_SECRET`,
      description: `${"B".repeat(500)}OBJECTIVE_TAIL_SECRET`,
    }, "task-id");
    expect(prompt).toContain("A".repeat(300));
    expect(prompt).toContain("B".repeat(500));
    expect(prompt).not.toContain("TITLE_TAIL_SECRET");
    expect(prompt).not.toContain("OBJECTIVE_TAIL_SECRET");
    expect(prompt).not.toMatch(/ANCESTOR_SECRET|COMMENT_SECRET|PLAN_SECRET|ATTACHMENT_SECRET/);
  });
});
