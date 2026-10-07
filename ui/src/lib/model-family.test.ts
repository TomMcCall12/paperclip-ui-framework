import { describe, expect, it } from "vitest";
import { classifyModelFamily } from "./utils";

describe("classifyModelFamily", () => {
  it("classifies Claude models regardless of billing provider", () => {
    expect(classifyModelFamily("claude-sonnet-5")).toBe("claude");
    expect(classifyModelFamily("claude-opus-4-7")).toBe("claude");
    expect(classifyModelFamily("global.anthropic.claude-sonnet-4-6")).toBe("claude");
    expect(classifyModelFamily("openrouter/anthropic/claude-haiku-4-5")).toBe("claude");
  });

  it("classifies GPT/OpenAI models including o-series reasoning models", () => {
    expect(classifyModelFamily("gpt-5.6-sol")).toBe("gpt");
    expect(classifyModelFamily("gpt-6-astra")).toBe("gpt");
    expect(classifyModelFamily("openai/gpt-5.4")).toBe("gpt");
    expect(classifyModelFamily("o3-mini")).toBe("gpt");
    expect(classifyModelFamily("o1")).toBe("gpt");
    expect(classifyModelFamily("chatgpt-4o-latest")).toBe("gpt");
  });

  it("classifies everything else as other", () => {
    expect(classifyModelFamily("deepseek-v4-flash-0731")).toBe("other");
    expect(classifyModelFamily("gemini-2.5-pro")).toBe("other");
    expect(classifyModelFamily("unknown")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(classifyModelFamily("CLAUDE-SONNET-5")).toBe("claude");
    expect(classifyModelFamily("GPT-6-ASTRA")).toBe("gpt");
  });
});
