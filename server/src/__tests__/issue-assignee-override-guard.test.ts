import { describe, expect, it } from "vitest";
import {
  issueAssigneeOverrideRejectionReason,
  issueTaskModelToVerify,
  issueTaskModelUnsupportedReason,
} from "../services/issue-assignee-override-guard.js";

describe("issueAssigneeOverrideRejectionReason", () => {
  it("allows only a non-empty string model for Hermes gateway", () => {
    expect(issueAssigneeOverrideRejectionReason("hermes_gateway", { adapterConfig: { model: "m" } })).toBeNull();
    expect(issueAssigneeOverrideRejectionReason("hermes_gateway", { useProjectWorkspace: true })).toBeNull();
    expect(issueAssigneeOverrideRejectionReason("hermes_gateway", null)).toBeNull();
    for (const adapterConfig of [
      { apiBaseUrl: "https://attacker.example" },
      { url: "https://attacker.example" },
      { apiKey: "k" },
      { token: "k" },
      { dangerouslyAllowInsecureRemoteHttp: true },
      { model: "" },
      { model: { type: "secret_ref", secretId: "s" } },
      "not-an-object",
    ]) {
      expect(issueAssigneeOverrideRejectionReason("hermes_gateway", { adapterConfig })).toMatch(/may only set model|must be an object/);
    }
  });

  it("names offending keys but never values", () => {
    const reason = issueAssigneeOverrideRejectionReason("hermes_gateway", {
      adapterConfig: { token: "attacker-secret", apiBaseUrl: "https://attacker.example" },
    });
    expect(reason).toContain("apiBaseUrl, token");
    expect(reason).not.toContain("attacker-secret");
    expect(reason).not.toContain("attacker.example");
  });

  it("does not restrict other adapters", () => {
    expect(issueAssigneeOverrideRejectionReason("claude_local", { adapterConfig: { chrome: true, effort: "high" } })).toBeNull();
    expect(issueAssigneeOverrideRejectionReason("hermes_local", { adapterConfig: { model: "m", provider: "p" } })).toBeNull();
    expect(issueAssigneeOverrideRejectionReason(null, { adapterConfig: { apiBaseUrl: "x" } })).toBeNull();
  });
});

describe("issueTaskModelToVerify", () => {
  it("returns the Hermes task model only", () => {
    expect(issueTaskModelToVerify("hermes_gateway", { adapterConfig: { model: "m" } })).toBe("m");
    expect(issueTaskModelToVerify("hermes_gateway", { useProjectWorkspace: true })).toBeNull();
    expect(issueTaskModelToVerify("hermes_gateway", { adapterConfig: {} })).toBeNull();
    expect(issueTaskModelToVerify("hermes_gateway", null)).toBeNull();
    expect(issueTaskModelToVerify("claude_local", { adapterConfig: { model: "m" } })).toBeNull();
    expect(issueTaskModelToVerify("hermes_local", { adapterConfig: { model: "m" } })).toBeNull();
    expect(issueTaskModelToVerify(null, { adapterConfig: { model: "m" } })).toBeNull();
  });
});

describe("issueTaskModelUnsupportedReason", () => {
  const models = [{ id: "listed" }];

  it("accepts only an exact id from an available list", () => {
    expect(issueTaskModelUnsupportedReason({ status: "available", models }, "listed")).toBeNull();
    expect(issueTaskModelUnsupportedReason({ status: "available", models }, "LISTED")).toMatch(/is not offered/);
    expect(issueTaskModelUnsupportedReason({ status: "available", models }, " listed")).toMatch(/is not offered/);
  });

  it("rejects a listed id when the list is not available, including unverified", () => {
    for (const status of ["unverified", "auth_failed", "unreachable", "unsupported", "misconfigured", "invalid_response"]) {
      expect(issueTaskModelUnsupportedReason({ status, models }, "listed")).toContain(`could not be verified (${status})`);
    }
    expect(issueTaskModelUnsupportedReason(null, "listed")).toMatch(/could not be verified\./);
  });
});
