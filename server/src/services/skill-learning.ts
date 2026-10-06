import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { tokenizeForSkillMatch } from "./relevant-skills.js";
import { agentService } from "./agents.js";

/**
 * Skill learning, modelled on Hermes's skill system: agents capture what they
 * learn as skills. Categories mark who owns a skill. The curator only archives
 * agent-owned skills, and a company can protect the rest from agent edits with
 * its skill policy (see doc/SKILL-LEARNING.md), as Hermes protects bundled,
 * hub-installed, pinned and user-owned skills.
 */

/** Skills agents may create and maintain without a human. */
export const LEARNED_SKILL_CATEGORY = "learned";
export const AGENT_MANAGED_SKILL_CATEGORIES: readonly string[] = [LEARNED_SKILL_CATEGORY, "curated", "hermes-import"];
/** A human-pinned skill: never archived, and protected by the recommended policy. */
export const PINNED_SKILL_CATEGORY = "pinned";
/** Retired by the curator: kept for recovery, no longer assigned or recommended. */
export const ARCHIVED_SKILL_CATEGORY = "archived";

export function isAgentManagedSkill(categories: readonly string[] | null | undefined): boolean {
  const set = new Set(categories ?? []);
  if (set.has(PINNED_SKILL_CATEGORY)) return false;
  return AGENT_MANAGED_SKILL_CATEGORIES.some((category) => set.has(category));
}

export function isArchivedSkill(categories: readonly string[] | null | undefined): boolean {
  return (categories ?? []).includes(ARCHIVED_SKILL_CATEGORY);
}

/**
 * Categories for a skill an agent creates. A skill an agent writes is
 * agent-owned, so it gets "learned" unless it already names an agent-managed
 * category.
 */
export function categoriesForAgentCreatedSkill(requested: readonly string[] | null | undefined): string[] {
  const kept = [...(requested ?? [])];
  return AGENT_MANAGED_SKILL_CATEGORIES.some((category) => kept.includes(category))
    ? kept
    : [...kept, LEARNED_SKILL_CATEGORY];
}

// ---------------------------------------------------------------------------
// Run tool tracking: how many tool calls a run made, and which skills it loaded.
// ---------------------------------------------------------------------------

export type RunToolSummary = { toolCalls: number; skillsUsed: string[] };

const SKILL_TOOL_NAMES = new Set(["Skill", "skill", "skill_view"]);
const HERMES_GATEWAY_EVENT_PREFIX = "[hermes-gateway:event]";
const CODEX_TOOL_ITEM_TYPES = new Set(["command_execution", "function_call", "mcp_tool_call", "file_change", "web_search"]);

/**
 * Skills are installed for an agent under a runtime name, `<slug>--<10 hex>`
 * (see buildSkillRuntimeName). Strip the suffix to get back the skill's name.
 */
export function skillNameFromRuntimeName(value: string): string {
  return value.replace(/--[0-9a-f]{10}$/, "");
}

function skillNameFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of ["skill", "command", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/^\//, "");
  }
  return null;
}

/**
 * Watches an agent's streamed output (JSON lines) and counts tool calls and
 * skill loads. Best effort and adapter-aware: Claude stream-json `tool_use`
 * blocks (the `Skill` tool names the skill), Codex tool items, and Hermes
 * gateway `tool.started` events (`skill_view` names the skill in its preview).
 * Lines split across chunks are reassembled; malformed lines are ignored.
 */
export function createRunToolTracker() {
  let carry = "";
  let toolCalls = 0;
  const skills = new Set<string>();
  const seenToolIds = new Set<string>();

  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "tool_use" && typeof record.name === "string") {
      const id = typeof record.id === "string" ? record.id : null;
      if (!id || !seenToolIds.has(id)) {
        if (id) seenToolIds.add(id);
        toolCalls += 1;
        if (SKILL_TOOL_NAMES.has(record.name)) {
          const skill = skillNameFromInput(record.input);
            if (skill) skills.add(skillNameFromRuntimeName(skill));
        }
      }
      return;
    }
    if (record.event === "tool.started" && typeof record.tool === "string") {
      toolCalls += 1;
      if (SKILL_TOOL_NAMES.has(record.tool) && typeof record.preview === "string") {
        const skill = record.preview.trim().replace(/\.\.\.$/, "").split(/\s+/)[0];
        if (skill) skills.add(skillNameFromRuntimeName(skill));
      }
      return;
    }
    if (record.type === "item.started" && record.item && typeof record.item === "object") {
      const item = record.item as Record<string, unknown>;
      if (typeof item.type === "string" && CODEX_TOOL_ITEM_TYPES.has(item.type)) toolCalls += 1;
      return;
    }
    for (const key of ["message", "content", "item"]) {
      if (key in record) visit(record[key]);
    }
  }

  function parseLine(line: string) {
    let json = line.trim();
    // Hermes gateway events: `[hermes-gateway:event] run=… event=… data={…}`.
    // Streamed reply text has no trailing newline, so an event can start mid-line.
    const gatewayEvent = json.indexOf(HERMES_GATEWAY_EVENT_PREFIX);
    if (gatewayEvent >= 0) {
      const at = json.indexOf(" data=", gatewayEvent);
      json = at >= 0 ? json.slice(at + " data=".length) : "";
    }
    if (!json.startsWith("{")) return;
    try {
      visit(JSON.parse(json));
    } catch {
      // Not JSON (plain log output) or an incomplete line; ignore.
    }
  }

  return {
    observe(chunk: string) {
      const text = carry + chunk;
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      if (carry.length > 1_000_000) carry = ""; // Never buffer an unbounded partial line.
      for (const line of lines) parseLine(line);
    },
    result(): RunToolSummary {
      parseLine(carry);
      carry = "";
      return { toolCalls, skillsUsed: [...skills].sort() };
    },
  };
}

// ---------------------------------------------------------------------------
// Automatic hand-out of new skills.
// ---------------------------------------------------------------------------

export const SKILL_DISTRIBUTION_MAX_AGENTS = 3;
const SKILL_DISTRIBUTION_RECENT_ISSUES = 25;
const SKILL_DISTRIBUTION_MIN_SHARED_TERMS = 3;

/**
 * Which other agents would use a skill: those whose recent tasks share the
 * most distinctive words with the skill's name and description. Agents that
 * already have the skill, terminated agents and the creator are excluded.
 */
export function rankAgentsForSkill(input: {
  skillText: string;
  agents: Array<{ id: string; recentWorkText: string }>;
  excludeAgentIds?: ReadonlySet<string>;
  limit?: number;
}): Array<{ agentId: string; sharedTerms: string[] }> {
  const skillTerms = new Set(tokenizeForSkillMatch(input.skillText));
  if (skillTerms.size === 0) return [];
  const scored = input.agents
    .filter((agent) => !input.excludeAgentIds?.has(agent.id))
    .map((agent) => {
      const workTerms = new Set(tokenizeForSkillMatch(agent.recentWorkText));
      const shared = [...skillTerms].filter((term) => workTerms.has(term)).sort();
      return { agentId: agent.id, sharedTerms: shared };
    })
    .filter((entry) => entry.sharedTerms.length >= SKILL_DISTRIBUTION_MIN_SHARED_TERMS);
  scored.sort((a, b) => b.sharedTerms.length - a.sharedTerms.length || a.agentId.localeCompare(b.agentId));
  return scored.slice(0, input.limit ?? SKILL_DISTRIBUTION_MAX_AGENTS);
}

/**
 * Gives a newly created skill to the agent that wrote it and to the agents
 * whose recent work it matches, so it is recommended to them from their next
 * run. Returns the agents it was added to.
 */
export async function distributeNewSkill(db: Db, input: {
  companyId: string;
  skillKey: string;
  skillText: string;
  creatorAgentId: string | null;
}): Promise<string[]> {
  const companyAgents = await db
    .select({ id: agents.id, status: agents.status, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), ne(agents.status, "terminated")));
  const hasSkill = new Set(
    companyAgents
      .filter((agent) => readPaperclipSkillSyncPreference((agent.adapterConfig ?? {}) as Record<string, unknown>).desiredSkills.includes(input.skillKey))
      .map((agent) => agent.id),
  );

  const targets: string[] = [];
  if (input.creatorAgentId && companyAgents.some((agent) => agent.id === input.creatorAgentId) && !hasSkill.has(input.creatorAgentId)) {
    targets.push(input.creatorAgentId);
  }

  const candidateIds = companyAgents.map((agent) => agent.id);
  const recent = candidateIds.length
    ? await db
      .select({ assigneeAgentId: issues.assigneeAgentId, title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), inArray(issues.assigneeAgentId, candidateIds)))
      .orderBy(desc(issues.updatedAt))
      .limit(SKILL_DISTRIBUTION_RECENT_ISSUES * Math.max(1, candidateIds.length))
    : [];
  const workByAgent = new Map<string, string[]>();
  for (const row of recent) {
    if (!row.assigneeAgentId) continue;
    const list = workByAgent.get(row.assigneeAgentId) ?? [];
    if (list.length < SKILL_DISTRIBUTION_RECENT_ISSUES) list.push(row.title);
    workByAgent.set(row.assigneeAgentId, list);
  }
  const ranked = rankAgentsForSkill({
    skillText: input.skillText,
    agents: candidateIds.map((id) => ({ id, recentWorkText: (workByAgent.get(id) ?? []).join("\n") })),
    excludeAgentIds: new Set([...hasSkill, ...targets]),
  });
  targets.push(...ranked.map((entry) => entry.agentId));

  const svc = agentService(db);
  const assigned: string[] = [];
  for (const agentId of targets) {
    const agent = companyAgents.find((candidate) => candidate.id === agentId);
    if (!agent) continue;
    const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const current = readPaperclipSkillSyncPreference(config).desiredSkillEntries;
    if (current.some((entry) => entry.key === input.skillKey)) continue;
    const next = writePaperclipSkillSyncPreference(config, [...current, { key: input.skillKey, versionId: null }]);
    const updated = await svc.update(agentId, { adapterConfig: next }, {
      recordRevision: { createdByAgentId: input.creatorAgentId, createdByUserId: null, source: "skill-distribution" },
    });
    if (updated) assigned.push(agentId);
  }
  return assigned;
}
