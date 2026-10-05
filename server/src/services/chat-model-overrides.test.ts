import { describe, expect, it } from "vitest";
import { chatModelConfigOverrides } from "./chat-model-overrides.js";

describe("chatModelConfigOverrides", () => {
  it("maps the agent's chat model and effort onto the run config", () => {
    expect(chatModelConfigOverrides({ model: "claude-opus-5-5", chatModel: "claude-sonnet-5", chatEffort: "low" }))
      .toEqual({ model: "claude-sonnet-5", effort: "low" });
  });

  it("changes nothing when no chat settings are set", () => {
    expect(chatModelConfigOverrides({ model: "claude-opus-5-5" })).toEqual({});
    expect(chatModelConfigOverrides({ chatModel: "  " })).toEqual({});
  });
});
