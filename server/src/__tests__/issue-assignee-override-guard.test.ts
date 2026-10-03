import { describe, expect, it } from "vitest";
import { issueAssigneeOverrideRejectionReason } from "../services/issue-assignee-override-guard.js";

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
