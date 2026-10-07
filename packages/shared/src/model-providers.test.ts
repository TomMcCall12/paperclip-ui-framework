import { describe, expect, it } from "vitest";
import {
  aiConnectionForProvider,
  canSwitchModelProvider,
  translateAdapterConfigForProvider,
  translateThinkingEffort,
} from "./model-providers.js";
import { issueAssigneeAdapterOverridesSchema } from "./validators/issue.js";

const claudeConfig = {
  model: "claude-sonnet-5",
  effort: "high",
  cwd: "/paperclip/workspaces/software-engineer",
  timeoutSec: 7200,
  env: { EXPO_TOKEN: { type: "secret_ref", secretId: "s1", version: "latest" } },
  paperclipSkillSync: { desiredSkills: ["company/c/expo"] },
  instructionsFilePath: "/i/AGENTS.md",
  instructionsBundleMode: "managed",
  instructionsRootPath: "/i",
  instructionsEntryFile: "AGENTS.md",
  chrome: true,
  useAccountConnectors: true,
  chatModel: "claude-haiku-4-5",
  maxTurnsPerRun: 300,
};

describe("model providers", () => {
  it("switches only between the local coding CLIs", () => {
    expect(canSwitchModelProvider("claude_local", "codex_local")).toBe(true);
    expect(canSwitchModelProvider("codex_local", "claude_local")).toBe(true);
    expect(canSwitchModelProvider("hermes_gateway", "codex_local")).toBe(false);
    expect(canSwitchModelProvider("claude_local", "opencode_local")).toBe(false);
  });

  it("keeps the agent's shared settings and drops Claude-only ones on OpenAI", () => {
    const codex = translateAdapterConfigForProvider("claude_local", "codex_local", claudeConfig, "gpt-6-sol");
    expect(codex).toEqual({
      model: "gpt-6-sol",
      modelReasoningEffort: "high",
      dangerouslyBypassApprovalsAndSandbox: true,
      cwd: claudeConfig.cwd,
      timeoutSec: 7200,
      env: claudeConfig.env,
      paperclipSkillSync: claudeConfig.paperclipSkillSync,
      instructionsFilePath: "/i/AGENTS.md",
      instructionsBundleMode: "managed",
      instructionsRootPath: "/i",
      instructionsEntryFile: "AGENTS.md",
    });
  });

  it("comes back to Claude with the closest effort", () => {
    const claude = translateAdapterConfigForProvider(
      "codex_local",
      "claude_local",
      { model: "gpt-6-sol", modelReasoningEffort: "xhigh", cwd: "/w", dangerouslyBypassApprovalsAndSandbox: true },
      "claude-opus-5-5",
    );
    expect(claude).toEqual({ model: "claude-opus-5-5", effort: "high", cwd: "/w", dangerouslySkipPermissions: true });
    expect(translateThinkingEffort("codex_local", "claude_local", "minimal")).toBe("low");
    expect(translateThinkingEffort("claude_local", "codex_local", "")).toBe("");
  });

  it("uses the responsible person's OpenAI account for OpenAI and the machine's Claude login for Claude", () => {
    expect(aiConnectionForProvider("codex_local", null)).toEqual({
      mode: "responsible_user",
      method: "subscription",
      provider: "openai",
    });
    const anthropic = { mode: "responsible_user", method: "subscription", provider: "anthropic" } as const;
    expect(aiConnectionForProvider("claude_local", anthropic)).toBe(anthropic);
    expect(aiConnectionForProvider("claude_local", aiConnectionForProvider("codex_local", null))).toBeNull();
  });

  it("accepts a task-level provider only for the local coding CLIs", () => {
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ adapterType: "codex_local", adapterConfig: { model: "gpt-6-sol" } }).success).toBe(true);
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ adapterType: "hermes_gateway" }).success).toBe(false);
  });
});
