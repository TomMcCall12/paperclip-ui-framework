import { describe, expect, it } from "vitest";
import { sanitizeTaskTitle, shouldNameTask, taskNamingPrompt, TASK_NAMING_HOURLY_LIMIT } from "./task-naming-prompt.js";

describe("sanitizeTaskTitle", () => {
  it("accepts a good sentence-case title and collapses whitespace", () => {
    expect(sanitizeTaskTitle("Fix the Macro Chef login bug")).toBe("Fix the Macro Chef login bug");
    expect(sanitizeTaskTitle("  Fix   the   login   bug  ")).toBe("Fix the login bug");
  });

  it("strips one pair of surrounding quotes", () => {
    expect(sanitizeTaskTitle("\"Fix the login bug\"")).toBe("Fix the login bug");
    expect(sanitizeTaskTitle("“Fix the login bug”")).toBe("Fix the login bug");
    expect(sanitizeTaskTitle("'Fix the login bug'")).toBe("Fix the login bug");
  });

  it("rejects URLs, www and e-mail addresses", () => {
    expect(sanitizeTaskTitle("Read https://example.com docs")).toBeNull();
    expect(sanitizeTaskTitle("Check www.example.com today")).toBeNull();
    expect(sanitizeTaskTitle("Email tom@example.com about it")).toBeNull();
  });

  it("rejects text the redactor would change (secrets)", () => {
    expect(sanitizeTaskTitle("Rotate key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")).toBeNull();
    expect(sanitizeTaskTitle("Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB")).toBeNull();
  });

  it("rejects assembly-line step prefixes", () => {
    expect(sanitizeTaskTitle("S3: Build the thing")).toBeNull();
    expect(sanitizeTaskTitle("S5e: Review the change")).toBeNull();
    expect(sanitizeTaskTitle("S2-r1: Retry the step")).toBeNull();
  });

  it("rejects too short, too many words and too long text", () => {
    expect(sanitizeTaskTitle("Fix")).toBeNull();
    expect(sanitizeTaskTitle("one two three four five six seven eight nine ten eleven")).toBeNull();
    expect(sanitizeTaskTitle(`Fix ${"a".repeat(80)}`)).toBeNull();
    expect(sanitizeTaskTitle("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight nine ten");
  });

  it("rejects non-strings, control characters and angle brackets", () => {
    expect(sanitizeTaskTitle(42)).toBeNull();
    expect(sanitizeTaskTitle(null)).toBeNull();
    expect(sanitizeTaskTitle("Fix the\u0000 bug")).toBeNull();
    expect(sanitizeTaskTitle("Fix the <b>bug</b>")).toBeNull();
  });
});

describe("taskNamingPrompt", () => {
  it("bounds the title to 300 and the description to 1500 characters", () => {
    const prompt = taskNamingPrompt("issue-id", 2, {
      title: `${"A".repeat(300)}TITLE_TAIL_MARKER`,
      description: `${"B".repeat(1500)}DESCRIPTION_TAIL_MARKER`,
    }, "task-id");
    expect(prompt).toContain("A".repeat(300));
    expect(prompt).toContain("B".repeat(1500));
    expect(prompt).not.toContain("TITLE_TAIL_MARKER");
    expect(prompt).not.toContain("DESCRIPTION_TAIL_MARKER");
    expect(prompt).toContain("/api/issues/issue-id/title-naming/result");
    expect(prompt).toContain("\"namingVersion\":2");
    expect(prompt).toContain("British English");
  });

  it("redacts secrets in the untrusted input", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const prompt = taskNamingPrompt("issue-id", 1, { title: `Rotate ${secret}`, description: `The key is ${secret} please rotate` }, "task-id");
    expect(prompt).not.toContain(secret);
  });

  it("treats a missing description as empty", () => {
    expect(taskNamingPrompt("issue-id", 1, { title: "Do the thing", description: null }, "task-id")).toContain("\"description\":\"\"");
  });
});

describe("shouldNameTask", () => {
  const base = { titleSource: "derived", originKind: "manual", hiddenAt: null, description: "Please fix the login bug on mobile" };

  it("names an eligible derived task", () => {
    expect(shouldNameTask(base, 0)).toEqual({ name: true });
    expect(shouldNameTask(base, TASK_NAMING_HOURLY_LIMIT - 1)).toEqual({ name: true });
  });

  it("skips explicit and AI titles", () => {
    expect(shouldNameTask({ ...base, titleSource: "explicit" }, 0)).toEqual({ name: false, reason: "not_derived" });
    expect(shouldNameTask({ ...base, titleSource: "ai" }, 0)).toEqual({ name: false, reason: "not_derived" });
  });

  it("never names a naming task", () => {
    expect(shouldNameTask({ ...base, originKind: "task_naming" }, 0)).toEqual({ name: false, reason: "naming_task" });
    expect(shouldNameTask({ ...base, originKind: "line_naming" }, 0)).toEqual({ name: false, reason: "naming_task" });
  });

  it("skips hidden tasks", () => {
    expect(shouldNameTask({ ...base, hiddenAt: new Date() }, 0)).toEqual({ name: false, reason: "hidden" });
  });

  it("skips descriptions under four words", () => {
    expect(shouldNameTask({ ...base, description: "Fix login bug" }, 0)).toEqual({ name: false, reason: "too_short" });
    expect(shouldNameTask({ ...base, description: null }, 0)).toEqual({ name: false, reason: "too_short" });
  });

  it("skips once the company started 20 namings in the last hour", () => {
    expect(shouldNameTask(base, TASK_NAMING_HOURLY_LIMIT)).toEqual({ name: false, reason: "rate_limited" });
  });
});
