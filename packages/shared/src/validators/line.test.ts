import { describe, expect, it } from "vitest";
import { createLineSchema, issueLineFilterSchema, lineNameSchema, lineNamingResultSchema, listLinesQuerySchema, updateLineSchema } from "./line.js";

const uuid = "c8e96d44-a038-4b95-a766-29bdff49d5a8";

describe("Line contract", () => {
  it("accepts normalized, bounded model names", () => {
    expect(lineNameSchema.safeParse("Customer Intake Flow").success).toBe(true);
    for (const name of ["One", "One  Two", " One Two", "One Two ", "<b> Two", "One\nTwo", "a b c d e f g", "x".repeat(79) + " y"]) {
      expect(lineNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("keeps authority fields off client writes", () => {
    expect(createLineSchema.safeParse({ rootIssueId: uuid }).success).toBe(true);
    expect(createLineSchema.safeParse({ rootIssueId: uuid, name: "Manual Name" }).success).toBe(false);
    expect(updateLineSchema.safeParse({ archived: true }).success).toBe(true);
    expect(updateLineSchema.safeParse({ archived: true, name: "Manual Name" }).success).toBe(false);
    expect(lineNamingResultSchema.safeParse({ namingVersion: 1, namingIssueId: uuid, runId: uuid, name: "Valid Name", model: "gpt-6" }).success).toBe(false);
  });

  it("parses pagination and explicit ungrouped filtering", () => {
    expect(listLinesQuerySchema.parse({})).toMatchObject({ status: "active", limit: 25 });
    expect(listLinesQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(issueLineFilterSchema.safeParse("ungrouped").success).toBe(true);
    expect(issueLineFilterSchema.safeParse(uuid).success).toBe(true);
    expect(issueLineFilterSchema.safeParse("none").success).toBe(false);
  });
});
