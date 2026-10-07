// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildAssigneeAdapterOverrides } from "./issue-assignee-overrides";

describe("buildAssigneeAdapterOverrides", () => {
  it("returns null for adapters that do not accept issue overrides", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "process",
        lane: "custom",
        modelOverride: "anything",
        thinkingEffortOverride: "high",
        chrome: true,
      }),
    ).toBeNull();
  });

  it("primary lane sends nothing", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "claude_local",
        lane: "primary",
        modelOverride: "",
        thinkingEffortOverride: "",
        chrome: false,
      }),
    ).toBeNull();
  });

  it("custom lane preserves explicit model + thinking effort + chrome overrides", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "claude_local",
        lane: "custom",
        modelOverride: "claude-haiku-4-5",
        thinkingEffortOverride: "high",
        chrome: true,
      }),
    ).toEqual({
      adapterConfig: {
        model: "claude-haiku-4-5",
        effort: "high",
        chrome: true,
      },
    });
  });

  it("custom lane returns null when no fields are set", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "codex_local",
        lane: "custom",
        modelOverride: "",
        thinkingEffortOverride: "",
        chrome: false,
      }),
    ).toBeNull();
  });

  it("custom lane uses adapter-specific keys for thinking effort", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "codex_local",
        lane: "custom",
        modelOverride: "",
        thinkingEffortOverride: "minimal",
        chrome: false,
      }),
    ).toEqual({
      adapterConfig: { modelReasoningEffort: "minimal" },
    });
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "opencode_local",
        lane: "custom",
        modelOverride: "",
        thinkingEffortOverride: "max",
        chrome: false,
      }),
    ).toEqual({
      adapterConfig: { variant: "max" },
    });
  });

  it("persists an exact GPT-6 Astra task override", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "codex_local",
        lane: "custom",
        modelOverride: "gpt-6-astra",
        thinkingEffortOverride: "ultra",
        chrome: false,
      }),
    ).toEqual({
      adapterConfig: {
        model: "gpt-6-astra",
        modelReasoningEffort: "ultra",
      },
    });
  });

  it("runs a Claude assignee's task on OpenAI with Codex keys when the task picks an OpenAI model", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "claude_local",
        taskAdapterType: "codex_local",
        lane: "custom",
        modelOverride: "gpt-6-sol",
        thinkingEffortOverride: "high",
        chrome: true,
      }),
    ).toEqual({
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-6-sol", modelReasoningEffort: "high" },
    });
  });

  it("runs a Codex assignee's task on Claude with Claude keys", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "codex_local",
        taskAdapterType: "claude_local",
        lane: "custom",
        modelOverride: "claude-opus-5-5",
        thinkingEffortOverride: "medium",
        chrome: true,
      }),
    ).toEqual({
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-5-5", effort: "medium", chrome: true },
    });
  });

  it("keeps a provider switch even with the other provider's default model", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "claude_local",
        taskAdapterType: "codex_local",
        lane: "custom",
        modelOverride: "",
        thinkingEffortOverride: "",
        chrome: false,
      }),
    ).toEqual({ adapterType: "codex_local" });
  });

  it("leaves adapterType out when the task stays on the assignee's own provider", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "codex_local",
        taskAdapterType: "codex_local",
        lane: "custom",
        modelOverride: "gpt-6-sol",
        thinkingEffortOverride: "",
        chrome: false,
      }),
    ).toEqual({ adapterConfig: { model: "gpt-6-sol" } });
  });

  it("ignores a provider switch for assignees that are not Claude or Codex agents", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "opencode_local",
        taskAdapterType: "codex_local",
        lane: "custom",
        modelOverride: "openai/gpt-6",
        thinkingEffortOverride: "",
        chrome: false,
      }),
    ).toEqual({ adapterConfig: { model: "openai/gpt-6" } });
  });
});
