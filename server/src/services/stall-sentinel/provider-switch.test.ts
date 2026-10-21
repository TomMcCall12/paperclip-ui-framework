import { describe, expect, it, vi } from "vitest";
import type { ProviderQuotaSummary } from "@paperclipai/shared";
import {
  createQuotaCache,
  evaluateProviderOut,
  isOpenAiModel,
  mapOpenAiModelToClaude,
  planClaudeRewrite,
  providerLockReason,
} from "./provider-switch.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const MIN = 60_000;

function claude(sessionLeft: number | null, resetInMin: number, weeklyLeft: number | null = 80): ProviderQuotaSummary {
  return {
    provider: "anthropic",
    ok: true,
    windows: [
      { label: "Current session", usedPercent: null, percentLeft: sessionLeft, resetsAt: new Date(NOW.getTime() + resetInMin * MIN).toISOString() },
      { label: "Current week (all models)", usedPercent: null, percentLeft: weeklyLeft, resetsAt: new Date(NOW.getTime() + 3 * 24 * 60 * MIN).toISOString() },
      { label: "Extra usage credits", usedPercent: null, percentLeft: 0, resetsAt: null },
    ],
  };
}

describe("Claude-out rule (strict edges)", () => {
  it("19% left with a reset 61 minutes away is out", () => {
    expect(evaluateProviderOut(claude(19, 61), NOW)).toMatchObject({ out: true, reason: "session" });
  });
  it("21% left with a reset 61 minutes away is not out", () => {
    expect(evaluateProviderOut(claude(21, 61), NOW).out).toBe(false);
  });
  it("20% left exactly is not out", () => {
    expect(evaluateProviderOut(claude(20, 120), NOW).out).toBe(false);
  });
  it("19% left with a reset 59 minutes away is not out", () => {
    expect(evaluateProviderOut(claude(19, 59), NOW).out).toBe(false);
  });
  it("19% left with a reset exactly 60 minutes away is not out", () => {
    expect(evaluateProviderOut(claude(19, 60), NOW).out).toBe(false);
  });
  it("weekly 14% left is out whatever the session says", () => {
    const state = evaluateProviderOut(claude(90, 10, 14), NOW);
    expect(state).toMatchObject({ out: true, reason: "weekly" });
    expect(state.resetsAt?.getTime()).toBe(NOW.getTime() + 3 * 24 * 60 * MIN);
  });
  it("weekly 16% left is not out", () => {
    expect(evaluateProviderOut(claude(90, 10, 16), NOW).out).toBe(false);
  });
  it("unknown data never counts as out", () => {
    expect(evaluateProviderOut({ provider: "anthropic", ok: false, windows: [] }, NOW).out).toBe(false);
    expect(evaluateProviderOut(claude(null, 120, null), NOW).out).toBe(false);
    expect(evaluateProviderOut(undefined, NOW).out).toBe(false);
  });
});

describe("OpenAI-to-Claude model map", () => {
  it.each([
    ["gpt-6-sol", "xhigh", "claude-opus-5-5", "high"],
    ["gpt-6-sol", "high", "claude-sonnet-5-5", "high"],
    ["gpt-6-sol", "medium", "claude-sonnet-5-5", "medium"],
    ["gpt-6-sol", "low", "claude-sonnet-5-5", "medium"],
    ["gpt-5.4-mini", "medium", "claude-haiku-4-5", null],
  ])("%s / %s -> %s / %s", (model, effort, toModel, toEffort) => {
    expect(mapOpenAiModelToClaude(model, effort)).toEqual({ model: toModel, effort: toEffort });
  });
  it("has no Claude-to-OpenAI direction", () => {
    expect(mapOpenAiModelToClaude("claude-opus-5-5", "high")).toBeNull();
  });
  it("recognises OpenAI model names", () => {
    expect(isOpenAiModel("gpt-6-sol")).toBe(true);
    expect(isOpenAiModel("claude-sonnet-5-5")).toBe(false);
  });
});

describe("planClaudeRewrite", () => {
  it("moves a codex override on a Claude agent back to claude_local with the mapped model", () => {
    const plan = planClaudeRewrite("claude_local", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-6-sol", modelReasoningEffort: "xhigh", timeoutSec: 900 },
      useProjectWorkspace: true,
    });
    expect(plan?.overrides).toEqual({
      useProjectWorkspace: true,
      adapterConfig: { timeoutSec: 900, model: "claude-opus-5-5", effort: "high" },
    });
    expect(plan?.overrides).not.toHaveProperty("adapterType");
  });
  it("drops an unmapped OpenAI model so the agent's own Claude model is used", () => {
    expect(planClaudeRewrite("claude_local", { adapterType: "codex_local", adapterConfig: { model: "gpt-9" } })?.overrides).toBeNull();
  });
  it("rewrites an OpenAI model set without adapterType", () => {
    expect(planClaudeRewrite("claude_local", { adapterConfig: { model: "gpt-5.4-mini" } })?.overrides).toEqual({
      adapterConfig: { model: "claude-haiku-4-5" },
    });
  });
  it("leaves Claude overrides and Codex agents alone", () => {
    expect(planClaudeRewrite("claude_local", { adapterConfig: { model: "claude-opus-5-5", effort: "high" } })).toBeNull();
    expect(planClaudeRewrite("codex_local", { adapterConfig: { model: "gpt-6-sol" } })).toBeNull();
    expect(planClaudeRewrite("claude_local", null)).toBeNull();
  });
});

describe("providerLockReason", () => {
  const base = { labelNames: [] as string[], lastUserOverrideAt: null, now: NOW };
  it("locks a Codex agent without a Claude override", () => {
    expect(providerLockReason({ ...base, agentAdapterType: "codex_local", overrides: null })).toBe("codex_agent");
  });
  it("does not lock a Codex agent whose task runs on Claude", () => {
    expect(providerLockReason({ ...base, agentAdapterType: "codex_local", overrides: { adapterType: "claude_local" } })).toBeNull();
  });
  it("honours the provider-locked label and a recent choice by a person", () => {
    expect(providerLockReason({ ...base, agentAdapterType: "claude_local", overrides: null, labelNames: ["Provider-Locked"] })).toBe("label");
    expect(
      providerLockReason({ ...base, agentAdapterType: "claude_local", overrides: null, lastUserOverrideAt: new Date(NOW.getTime() - 119 * MIN) }),
    ).toBe("recent_user_choice");
    expect(
      providerLockReason({ ...base, agentAdapterType: "claude_local", overrides: null, lastUserOverrideAt: new Date(NOW.getTime() - 121 * MIN) }),
    ).toBeNull();
  });
});

describe("quota cache", () => {
  it("asks the providers at most once per 5 minutes per company", async () => {
    const fetcher = vi.fn(async () => [claude(50, 30)]);
    const get = createQuotaCache(fetcher);
    await get("c1", NOW);
    await get("c1", new Date(NOW.getTime() + 4 * MIN));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await get("c1", new Date(NOW.getTime() + 5 * MIN));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("treats a failed fetch as no data", async () => {
    const get = createQuotaCache(async () => {
      throw new Error("down");
    });
    expect((await get("c1", NOW)).size).toBe(0);
  });
});
