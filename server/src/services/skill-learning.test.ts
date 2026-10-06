import { describe, expect, it } from "vitest";
import {
  categoriesForAgentCreatedSkill,
  createRunToolTracker,
  isAgentManagedSkill,
  isArchivedSkill,
  rankAgentsForSkill,
} from "./skill-learning.js";

const line = (value: unknown) => JSON.stringify(value) + "\n";
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });

describe("skill ownership", () => {
  it("treats learned, curated and Hermes-imported skills as agent-managed", () => {
    expect(isAgentManagedSkill(["learned"])).toBe(true);
    expect(isAgentManagedSkill(["curated", "plated"])).toBe(true);
    expect(isAgentManagedSkill(["hermes-import"])).toBe(true);
  });

  it("protects shipped, hand-written and pinned skills", () => {
    expect(isAgentManagedSkill([])).toBe(false);
    expect(isAgentManagedSkill(["design"])).toBe(false);
    expect(isAgentManagedSkill(["learned", "pinned"])).toBe(false);
    expect(isAgentManagedSkill(null)).toBe(false);
  });

  it("marks an agent-created skill as learned unless it is already agent-managed, and never pinned", () => {
    expect(categoriesForAgentCreatedSkill(undefined)).toEqual(["learned"]);
    expect(categoriesForAgentCreatedSkill(["plated"])).toEqual(["plated", "learned"]);
    expect(categoriesForAgentCreatedSkill(["curated"])).toEqual(["curated"]);
    expect(categoriesForAgentCreatedSkill(["pinned", "archived", "ops"])).toEqual(["ops", "learned"]);
  });

  it("recognises archived skills", () => {
    expect(isArchivedSkill(["learned", "archived"])).toBe(true);
    expect(isArchivedSkill(["learned"])).toBe(false);
  });
});

describe("createRunToolTracker", () => {
  it("counts Claude tool calls once each and records skill loads", () => {
    const tracker = createRunToolTracker();
    tracker.observe(toolUse("t1", "Bash", { command: "ls" }));
    tracker.observe(toolUse("t2", "Skill", { skill: "design-critique" }));
    tracker.observe(toolUse("t2", "Skill", { skill: "design-critique" })); // replayed block
    tracker.observe(toolUse("t3", "Skill", { command: "/plated-release-operations" }));
    expect(tracker.result()).toEqual({ toolCalls: 3, skillsUsed: ["design-critique", "plated-release-operations"] });
  });

  it("reassembles lines split across chunks and ignores non-JSON output", () => {
    const tracker = createRunToolTracker();
    const text = "plain log line\n" + toolUse("a", "Read") + toolUse("b", "Skill", { skill: "vault-maintenance" });
    tracker.observe(text.slice(0, 40));
    tracker.observe(text.slice(40, 95));
    tracker.observe(text.slice(95));
    expect(tracker.result()).toEqual({ toolCalls: 2, skillsUsed: ["vault-maintenance"] });
  });

  it("counts Codex tool items", () => {
    const tracker = createRunToolTracker();
    tracker.observe(line({ type: "item.started", item: { type: "command_execution", command: "ls" } }));
    tracker.observe(line({ type: "item.started", item: { type: "agent_message" } }));
    tracker.observe(line({ type: "item.started", item: { type: "mcp_tool_call" } }));
    expect(tracker.result().toolCalls).toBe(2);
  });

  it("counts Hermes gateway tool events and skill_view loads", () => {
    const tracker = createRunToolTracker();
    const event = (data: Record<string, unknown>) =>
      `[hermes-gateway:event] run=run_1 event=${String(data.event)} data=${JSON.stringify(data)}\n`;
    tracker.observe(event({ event: "tool.started", tool: "skill_view", preview: "paperclip-disposition-repair" }));
    tracker.observe(event({ event: "tool.completed", tool: "skill_view" }));
    tracker.observe(event({ event: "tool.started", tool: "terminal", preview: "python3 - <<'PY' import json..." }));
    tracker.observe(event({ event: "message.delta", delta: "hi" }));
    tracker.observe("hi"); // Reply text is logged without a newline.
    tracker.observe(event({ event: "tool.started", tool: "web_search", preview: "q" }));
    tracker.observe("[hermes-gateway] run created: run_1\n");
    expect(tracker.result()).toEqual({ toolCalls: 3, skillsUsed: ["paperclip-disposition-repair"] });
  });

  it("parses a final line that has no trailing newline", () => {
    const tracker = createRunToolTracker();
    tracker.observe(toolUse("z", "Skill", { skill: "notes-vault" }).trimEnd());
    expect(tracker.result().skillsUsed).toEqual(["notes-vault"]);
  });
});

describe("rankAgentsForSkill", () => {
  const agents = [
    { id: "eng", recentWorkText: "Fix Supabase edge function deploy\nDeploy categorise shopping function\nEdge function timeout" },
    { id: "designer", recentWorkText: "Review onboarding screens\nCritique the shopping list design" },
    { id: "quiet", recentWorkText: "" },
  ];

  it("picks agents whose recent work shares enough distinctive words", () => {
    const ranked = rankAgentsForSkill({
      skillText: "plated-edge-function-deploy: Deploy a Supabase edge function, then check the live version",
      agents,
    });
    expect(ranked.map((entry) => entry.agentId)).toEqual(["eng"]);
    expect(ranked[0]!.sharedTerms).toEqual(expect.arrayContaining(["deploy", "edge", "function", "supabase"]));
  });

  it("excludes agents that already have the skill", () => {
    expect(rankAgentsForSkill({
      skillText: "Deploy a Supabase edge function",
      agents,
      excludeAgentIds: new Set(["eng"]),
    })).toEqual([]);
  });
});
