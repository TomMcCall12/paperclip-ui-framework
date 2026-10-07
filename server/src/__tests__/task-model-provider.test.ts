import { describe, expect, it } from "vitest";
import { agentForTaskProvider, taskProviderRunNote } from "../services/task-model-provider.js";

const claudeAgent = {
  id: "a1",
  adapterType: "claude_local",
  adapterConfig: {
    model: "claude-sonnet-5",
    effort: "medium",
    cwd: "/paperclip/workspaces/software-engineer",
    env: { EXPO_TOKEN: { type: "secret_ref", secretId: "s1", version: "latest" } },
    paperclipSkillSync: { desiredSkills: ["company/c/expo-dev-and-eas-builds"] },
    useAccountConnectors: true,
  },
  runtimeConfig: { heartbeat: { enabled: false } },
};

describe("agentForTaskProvider", () => {
  it("runs a Claude agent's task on OpenAI with the responsible person's OpenAI account", () => {
    const agent = agentForTaskProvider(claudeAgent, {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-6-sol" },
    });
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe("a1");
    expect(agent!.adapterType).toBe("codex_local");
    expect(agent!.adapterConfig).toEqual({
      modelReasoningEffort: "medium",
      dangerouslyBypassApprovalsAndSandbox: true,
      cwd: "/paperclip/workspaces/software-engineer",
      env: claudeAgent.adapterConfig.env,
      paperclipSkillSync: claudeAgent.adapterConfig.paperclipSkillSync,
    });
    expect(agent!.runtimeConfig).toEqual({
      heartbeat: { enabled: false },
      aiConnection: { mode: "responsible_user", method: "subscription", provider: "openai" },
    });
    // The saved agent is untouched.
    expect(claudeAgent.adapterType).toBe("claude_local");
    expect(claudeAgent.runtimeConfig).toEqual({ heartbeat: { enabled: false } });
  });

  it("runs an OpenAI agent's task on Claude with the machine's Claude login", () => {
    const agent = agentForTaskProvider(
      {
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-6-sol", cwd: "/w" },
        runtimeConfig: { aiConnection: { mode: "responsible_user", method: "subscription", provider: "openai" } },
      },
      { adapterType: "claude_local", adapterConfig: { model: "claude-opus-5-5" } },
    );
    expect(agent?.adapterType).toBe("claude_local");
    expect(agent?.runtimeConfig).toEqual({});
  });

  it("leaves the agent alone when the task stays on its provider or can't switch", () => {
    expect(agentForTaskProvider(claudeAgent, { adapterConfig: { model: "claude-opus-5-5" } })).toBeNull();
    expect(agentForTaskProvider(claudeAgent, { adapterType: "claude_local" })).toBeNull();
    expect(agentForTaskProvider({ ...claudeAgent, adapterType: "hermes_gateway" }, { adapterType: "codex_local" })).toBeNull();
    expect(agentForTaskProvider(claudeAgent, null)).toBeNull();
  });

  it("says in the run log which provider ran the task", () => {
    expect(taskProviderRunNote("claude_local", "codex_local", "gpt-6-sol")).toBe(
      "This task runs on OpenAI (gpt-6-sol) instead of the agent's usual Claude.",
    );
  });
});
