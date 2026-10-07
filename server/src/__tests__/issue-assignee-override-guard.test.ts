import { describe, expect, it } from "vitest";
import {
  issueAssigneeOverrideRejectionReason,
  issueTaskModelToVerify,
  issueTaskModelUnsupportedReason,
  taskAdapterTypeFor,
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

  it("lets local coding agents' tasks pick only the model, effort and the keys the model picker writes", () => {
    expect(issueAssigneeOverrideRejectionReason("claude_local", { adapterConfig: { model: "claude-haiku-4-5", effort: "high", chrome: true } })).toBeNull();
    expect(issueAssigneeOverrideRejectionReason("codex_local", { adapterConfig: { model: "gpt-5.4", modelReasoningEffort: "high" } })).toBeNull();
    expect(issueAssigneeOverrideRejectionReason("opencode_local", { adapterConfig: { model: "m", variant: "high" } })).toBeNull();
    expect(issueAssigneeOverrideRejectionReason("claude_local", { adapterConfig: { workspaceStrategy: { type: "git_worktree" } } })).toBeNull();
    // Run budget is a per-task choice too.
    expect(issueAssigneeOverrideRejectionReason("claude_local", { adapterConfig: { timeoutSec: 3600, maxTurnsPerRun: 200 } })).toBeNull();
  });

  it("stops a task widening what a local coding agent may do", () => {
    for (const adapterConfig of [
      { extraArgs: ["--dangerously-skip-permissions"] },
      { dangerouslySkipPermissions: true },
      { maxTurnsPerRun: -1 },
      { cwd: "/" },
      { command: "/bin/sh" },
      { env: { ANTHROPIC_API_KEY: "k" } },
      { useAccountConnectors: true },
      { model: "" },
      { chrome: "yes" },
    ]) {
      expect(issueAssigneeOverrideRejectionReason("claude_local", { adapterConfig })).toMatch(/may only set/);
    }
    expect(issueAssigneeOverrideRejectionReason("codex_local", { adapterConfig: { dangerouslyBypassApprovalsAndSandbox: true } })).toMatch(/may only set/);
  });

  it("lets a Claude or OpenAI agent run one task on the other provider, checked against that provider", () => {
    expect(issueAssigneeOverrideRejectionReason("claude_local", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-6-sol", modelReasoningEffort: "high" },
    })).toBeNull();
    expect(issueAssigneeOverrideRejectionReason("codex_local", {
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-5-5", effort: "high", chrome: true },
    })).toBeNull();
    // Claude-only keys are not settable once the task runs on Codex.
    expect(issueAssigneeOverrideRejectionReason("claude_local", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-6-sol", chrome: true },
    })).toContain("not allowed: chrome");
    expect(taskAdapterTypeFor("claude_local", { adapterType: "codex_local" })).toBe("codex_local");
    expect(taskAdapterTypeFor("claude_local", { adapterConfig: { model: "claude-sonnet-5" } })).toBe("claude_local");
  });

  it("refuses another provider for agents that aren't Claude or OpenAI CLIs", () => {
    expect(issueAssigneeOverrideRejectionReason("hermes_gateway", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-6-sol" },
    })).toContain("Only Claude and OpenAI");
    expect(taskAdapterTypeFor("hermes_gateway", { adapterType: "codex_local" })).toBe("hermes_gateway");
  });

  it("does not restrict other adapters", () => {
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

  it("returns the trimmed model, as the adapter sends it", () => {
    expect(issueTaskModelToVerify("hermes_gateway", { adapterConfig: { model: " gpt-6.1-sol " } })).toBe("gpt-6.1-sol");
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
