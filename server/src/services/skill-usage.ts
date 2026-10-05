import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySkills } from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { ARCHIVED_SKILL_CATEGORY, isAgentManagedSkill, isArchivedSkill, PINNED_SKILL_CATEGORY } from "./skill-learning.js";
import type { CompanySkillUsageItem, CompanySkillUsageLifecycle, CompanySkillUsageReport } from "@paperclipai/shared";

/**
 * Skill usage for the skill curator, modelled on Hermes's curator: how often
 * each skill was recommended to a run, how those runs ended, how many agents
 * carry it, and a lifecycle state derived from that activity.
 *
 * The signal is the "relevantSkills" run-log event written when a run's wake
 * prompt recommends skills, so it covers every adapter. Lifecycle is advice
 * for the curator and the board; nothing here archives or edits a skill.
 */

export const SKILL_USAGE_DEFAULT_WINDOW_DAYS = 30;
export const SKILL_USAGE_MAX_WINDOW_DAYS = 365;
export const SKILL_STALE_AFTER_DAYS = 14;
export const SKILL_ARCHIVE_AFTER_DAYS = 30;
/** Category that marks a skill as written and maintained by the curator. */
export const CURATED_SKILL_CATEGORY = "curated";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Active while recommended recently; stale, then an archive candidate, after
 * a quiet spell. Quiet time is counted from the latest of the skill's
 * creation, its last recommendation and the start of tracking, so a skill
 * that has never been recommended is not judged before there was a chance
 * to recommend it: no use is an absence of evidence, not staleness.
 */
export function classifySkillLifecycle(input: {
  createdAt: Date;
  lastRecommendedAt: Date | null;
  trackingStartedAt: Date | null;
  now: Date;
  staleAfterDays?: number;
  archiveAfterDays?: number;
}): CompanySkillUsageLifecycle {
  const staleAfterMs = (input.staleAfterDays ?? SKILL_STALE_AFTER_DAYS) * DAY_MS;
  const archiveAfterMs = (input.archiveAfterDays ?? SKILL_ARCHIVE_AFTER_DAYS) * DAY_MS;
  const anchor = Math.max(
    input.createdAt.getTime(),
    input.lastRecommendedAt?.getTime() ?? 0,
    input.trackingStartedAt?.getTime() ?? input.now.getTime(),
  );
  const quietMs = input.now.getTime() - anchor;
  if (input.lastRecommendedAt === null && quietMs < staleAfterMs) return "new";
  if (quietMs >= archiveAfterMs) return "archive_candidate";
  if (quietMs >= staleAfterMs) return "stale";
  return "active";
}

export function clampSkillUsageWindowDays(value: unknown): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return SKILL_USAGE_DEFAULT_WINDOW_DAYS;
  return Math.min(Math.floor(parsed), SKILL_USAGE_MAX_WINDOW_DAYS);
}

type RecommendationRow = {
  key: string;
  runs: number;
  succeeded: number;
  failed: number;
  last: Date | null;
};

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function skillUsageService(db: Db) {
  return {
    async report(companyId: string, options: { windowDays?: number; now?: Date } = {}): Promise<CompanySkillUsageReport> {
      const now = options.now ?? new Date();
      const windowDays = clampSkillUsageWindowDays(options.windowDays);
      const since = new Date(now.getTime() - windowDays * DAY_MS);

      const skills = await db
        .select({
          id: companySkills.id,
          key: companySkills.key,
          slug: companySkills.slug,
          name: companySkills.name,
          sourceType: companySkills.sourceType,
          categories: companySkills.categories,
          createdAt: companySkills.createdAt,
          updatedAt: companySkills.updatedAt,
        })
        .from(companySkills)
        .where(eq(companySkills.companyId, companyId));

      const trackingRows = await db.execute(sql`
        select min(created_at) as started
        from heartbeat_run_events
        where company_id = ${companyId}
          and event_type = 'lifecycle'
          and payload ? 'relevantSkills'
      `);
      const trackingStartedAt = toDate((trackingRows as unknown as Array<{ started: unknown }>)[0]?.started);

      // Window counts per skill, plus the last recommendation ever, so a skill
      // quiet for longer than the window still gets an accurate lifecycle.
      const recommendationResult = await db.execute(sql`
        select picked.value->>'key' as key,
          count(distinct e.run_id) filter (where e.created_at >= ${since.toISOString()}) as runs,
          count(distinct e.run_id) filter (where e.created_at >= ${since.toISOString()} and r.status = 'succeeded') as succeeded,
          count(distinct e.run_id) filter (where e.created_at >= ${since.toISOString()} and r.status in ('failed', 'timed_out', 'cancelled')) as failed,
          max(e.created_at) as last
        from heartbeat_run_events e
        join heartbeat_runs r on r.id = e.run_id
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(e.payload->'relevantSkills') = 'array' then e.payload->'relevantSkills' else '[]'::jsonb end
        ) as picked(value)
        where e.company_id = ${companyId}
          and e.event_type = 'lifecycle'
          and e.payload ? 'relevantSkills'
        group by 1
      `);
      const recommendationRows = recommendationResult as unknown as Array<Record<string, unknown>>;
      const recommendations = new Map<string, RecommendationRow>();
      for (const row of recommendationRows) {
        if (typeof row.key !== "string") continue;
        recommendations.set(row.key, {
          key: row.key,
          runs: Number(row.runs ?? 0),
          succeeded: Number(row.succeeded ?? 0),
          failed: Number(row.failed ?? 0),
          last: toDate(row.last),
        });
      }

      // Actual loads (the agent opened the skill), recorded per run as
      // issue.skills_used activity with the skill's name as the agent saw it.
      const usedResult = await db.execute(sql`
        select lower(used.value->>'name') as name,
          count(distinct l.run_id) filter (where l.created_at >= ${since.toISOString()}) as runs,
          max(l.created_at) as last
        from activity_log l
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(l.details->'skills') = 'array' then l.details->'skills' else '[]'::jsonb end
        ) as used(value)
        where l.company_id = ${companyId}
          and l.action = 'issue.skills_used'
        group by 1
      `);
      const usedByName = new Map<string, { runs: number; last: Date | null }>();
      for (const row of usedResult as unknown as Array<Record<string, unknown>>) {
        if (typeof row.name !== "string") continue;
        usedByName.set(row.name, { runs: Number(row.runs ?? 0), last: toDate(row.last) });
      }
      const usedFor = (skill: { key: string; slug: string; name: string }) => {
        const names = new Set([skill.name, skill.slug, skill.key.split("/").pop() ?? ""].map((value) => value.toLowerCase()).filter(Boolean));
        let runs = 0;
        let last: Date | null = null;
        for (const name of names) {
          const hit = usedByName.get(name);
          if (!hit) continue;
          runs = Math.max(runs, hit.runs);
          if (hit.last && (!last || hit.last > last)) last = hit.last;
        }
        return { runs, last };
      };

      const agentRows = await db
        .select({ adapterConfig: agents.adapterConfig, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const agentCounts = new Map<string, number>();
      for (const agent of agentRows) {
        if (agent.status === "terminated") continue;
        const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
        for (const key of new Set(readPaperclipSkillSyncPreference(config).desiredSkills)) {
          agentCounts.set(key, (agentCounts.get(key) ?? 0) + 1);
        }
      }

      const items: CompanySkillUsageItem[] = skills.map((skill) => {
        const usage = recommendations.get(skill.key);
        const lastRecommendedAt = usage?.last ?? null;
        const used = usedFor(skill);
        const lastActiveAt = [lastRecommendedAt, used.last].filter((value): value is Date => value !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        return {
          skillId: skill.id,
          key: skill.key,
          name: skill.name,
          sourceType: skill.sourceType,
          curated: skill.categories.includes(CURATED_SKILL_CATEGORY),
          agentCount: agentCounts.get(skill.key) ?? 0,
          recommendedRuns: usage?.runs ?? 0,
          recommendedRunsSucceeded: usage?.succeeded ?? 0,
          recommendedRunsFailed: usage?.failed ?? 0,
          lastRecommendedAt: lastRecommendedAt?.toISOString() ?? null,
          usedRuns: used.runs,
          lastUsedAt: used.last?.toISOString() ?? null,
          agentManaged: isAgentManagedSkill(skill.categories),
          pinned: skill.categories.includes(PINNED_SKILL_CATEGORY),
          archived: isArchivedSkill(skill.categories),
          createdAt: skill.createdAt.toISOString(),
          updatedAt: skill.updatedAt.toISOString(),
          lifecycle: classifySkillLifecycle({ createdAt: skill.createdAt, lastRecommendedAt: lastActiveAt, trackingStartedAt, now }),
        };
      });
      items.sort((a, b) => b.recommendedRuns - a.recommendedRuns || a.key.localeCompare(b.key));

      return {
        companyId,
        generatedAt: now.toISOString(),
        windowDays,
        trackingStartedAt: trackingStartedAt?.toISOString() ?? null,
        staleAfterDays: SKILL_STALE_AFTER_DAYS,
        archiveAfterDays: SKILL_ARCHIVE_AFTER_DAYS,
        skills: items,
      };
    },
  };
}

/** A run counts as complex, worth a learning review, past these (Hermes reviews after 10 tool iterations). */
export const LEARNING_MIN_TOOL_CALLS = 10;
export const LEARNING_MIN_DURATION_MINUTES = 10;

export type LearningCandidate = {
  issueId: string;
  identifier: string | null;
  title: string;
  agentId: string;
  agentName: string;
  runId: string;
  toolCalls: number | null;
  durationMinutes: number;
  finishedAt: string;
};

/**
 * Complex, successful task runs in the window that captured no skill, the
 * safety net for agents that skipped the end-of-run learning step. Mirrors
 * Hermes's trigger: enough tool work in a turn, and no skill write during it.
 */
export async function findLearningCandidates(db: Db, companyId: string, options: { hours?: number; now?: Date } = {}): Promise<LearningCandidate[]> {
  const now = options.now ?? new Date();
  const hours = Math.min(Math.max(Math.floor(options.hours ?? 24), 1), 24 * 14);
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const rows = await db.execute(sql`
    select r.id as run_id, r.agent_id, a.name as agent_name, i.id as issue_id, i.identifier, i.title,
      r.finished_at,
      extract(epoch from (r.finished_at - r.started_at)) / 60.0 as minutes,
      (select (e.payload->>'toolCalls')::int from heartbeat_run_events e
        where e.run_id = r.id and e.event_type = 'lifecycle' and e.payload ? 'toolCalls'
        order by e.id desc limit 1) as tool_calls
    from heartbeat_runs r
    join agents a on a.id = r.agent_id
    join issues i on i.id::text = r.context_snapshot->>'issueId' and i.company_id = r.company_id
    where r.company_id = ${companyId}
      and r.status = 'succeeded'
      and r.finished_at >= ${since.toISOString()}
      and r.started_at is not null
      and i.conversation_agent_id is null
      and not exists (
        select 1 from activity_log l
        where l.company_id = r.company_id and l.run_id = r.id
          and l.action in ('company.skill_created', 'company.skill_updated', 'company.skill_file_updated')
      )
    order by r.finished_at desc
  `);
  const candidates: LearningCandidate[] = [];
  const seenIssues = new Set<string>();
  for (const row of rows as unknown as Array<Record<string, unknown>>) {
    const toolCalls = row.tool_calls === null || row.tool_calls === undefined ? null : Number(row.tool_calls);
    const minutes = Number(row.minutes ?? 0);
    if ((toolCalls ?? 0) < LEARNING_MIN_TOOL_CALLS && minutes < LEARNING_MIN_DURATION_MINUTES) continue;
    const issueId = String(row.issue_id);
    if (seenIssues.has(issueId)) continue; // One review per task.
    seenIssues.add(issueId);
    candidates.push({
      issueId,
      identifier: (row.identifier as string | null) ?? null,
      title: String(row.title ?? ""),
      agentId: String(row.agent_id),
      agentName: String(row.agent_name ?? ""),
      runId: String(row.run_id),
      toolCalls,
      durationMinutes: Math.round(minutes * 10) / 10,
      finishedAt: (toDate(row.finished_at) ?? now).toISOString(),
    });
  }
  return candidates;
}

export type LifecycleChange = { skillId: string; key: string; name: string; action: "archived"; unassignedFrom: number };

/**
 * Hermes's deterministic prune: agent-owned skills idle past the archive
 * threshold are archived (kept, recoverable, no longer assigned or
 * recommended). Pinned and protected skills are never touched, and nothing is
 * judged before tracking could have seen it used.
 */
export async function applySkillLifecycle(db: Db, companyId: string, options: { now?: Date; dryRun?: boolean } = {}): Promise<LifecycleChange[]> {
  const report = await skillUsageService(db).report(companyId, { now: options.now });
  const due = report.skills.filter((skill) => skill.lifecycle === "archive_candidate" && skill.agentManaged && !skill.pinned && !skill.archived);
  if (options.dryRun || due.length === 0) {
    return due.map((skill) => ({ skillId: skill.skillId, key: skill.key, name: skill.name, action: "archived", unassignedFrom: 0 }));
  }
  const { companySkillService } = await import("./company-skills.js");
  const { agentService } = await import("./agents.js");
  const { writePaperclipSkillSyncPreference } = await import("@paperclipai/adapter-utils/server-utils");
  const skillsSvc = companySkillService(db);
  const agentsSvc = agentService(db);
  const agentRows = await db
    .select({ id: agents.id, adapterConfig: agents.adapterConfig, status: agents.status })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const changes: LifecycleChange[] = [];
  for (const skill of due) {
    const current = await skillsSvc.getById(companyId, skill.skillId);
    if (!current) continue;
    await skillsSvc.updateSkill(companyId, skill.skillId, { categories: [...new Set([...current.categories, ARCHIVED_SKILL_CATEGORY])] });
    let unassignedFrom = 0;
    for (const agent of agentRows) {
      const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      const entries = readPaperclipSkillSyncPreference(config).desiredSkillEntries;
      if (!entries.some((entry) => entry.key === skill.key)) continue;
      await agentsSvc.update(agent.id, { adapterConfig: writePaperclipSkillSyncPreference(config, entries.filter((entry) => entry.key !== skill.key)) }, {
        recordRevision: { createdByAgentId: null, createdByUserId: null, source: "skill-lifecycle" },
      });
      unassignedFrom += 1;
    }
    changes.push({ skillId: skill.skillId, key: skill.key, name: skill.name, action: "archived", unassignedFrom });
  }
  return changes;
}
