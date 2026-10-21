import { describe, expect, it } from "vitest";
import { deriveIssueStepKey, stepIdFromTitle } from "./step-key.js";

const PARENT = "fe0189cc-4c8d-4973-988b-44a430720ae4";

describe("stall sentinel deriveIssueStepKey (local copy)", () => {
  it.each([
    ["S3: Build the alarm", `${PARENT}:S3`],
    ["S3:Build the alarm", `${PARENT}:S3`],
    ["S3 : spaced colon", `${PARENT}:S3`],
    ["  S3: leading whitespace", `${PARENT}:S3`],
    ["S12: two digits", `${PARENT}:S12`],
    ["S123: three digits", `${PARENT}:S123`],
    ["S5e: letter suffix", `${PARENT}:S5e`],
    ["S3-r2: second retry", `${PARENT}:S3-r2`],
    ["S5e-r10: suffix and retry", `${PARENT}:S5e-r10`],
  ])("derives a key from %j", (title, expected) => {
    expect(deriveIssueStepKey(PARENT, title)).toBe(expected);
  });

  it.each([
    "s3: lower-case s",
    "S: no number",
    "S3 build without colon",
    "S1234: four digits",
    "S3ee: two letters",
    "S3E: upper-case suffix",
    "S3-r: retry without number",
    "S3-r2x: junk after retry",
    "Step S3: not at the start",
    "TOM-3: other prefix",
    "",
  ])("returns null for %j", (title) => {
    expect(deriveIssueStepKey(PARENT, title)).toBeNull();
  });

  it("returns null without a parent", () => {
    expect(deriveIssueStepKey(null, "S3: top level")).toBeNull();
    expect(deriveIssueStepKey(undefined, "S3: top level")).toBeNull();
  });

  it("returns null without a title", () => {
    expect(deriveIssueStepKey(PARENT, null)).toBeNull();
    expect(deriveIssueStepKey(PARENT, undefined)).toBeNull();
  });
});

describe("stepIdFromTitle", () => {
  it("returns the bare step id", () => {
    expect(stepIdFromTitle("S5e: Close the gap")).toBe("S5e");
    expect(stepIdFromTitle("S3-r2: retry")).toBe("S3-r2");
    expect(stepIdFromTitle("Plain title")).toBeNull();
  });
});
