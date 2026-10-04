import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companySkills,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRunEvents,
  heartbeatRuns,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  CURATED_SKILL_CATEGORY,
  SKILL_USAGE_DEFAULT_WINDOW_DAYS,
  SKILL_USAGE_MAX_WINDOW_DAYS,
  clampSkillUsageWindowDays,
  classifySkillLifecycle,
  skillUsageService,
} from "./skill-usage.js";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-04T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

describe("classifySkillLifecycle", () => {
  it("treats a never-recommended skill as new until tracking has run long enough", () => {
    expect(classifySkillLifecycle({ createdAt: daysAgo(90), lastRecommendedAt: null, trackingStartedAt: daysAgo(3), now }))
      .toBe("new");
    expect(classifySkillLifecycle({ createdAt: daysAgo(90), lastRecommendedAt: null, trackingStartedAt: null, now }))
      .toBe("new");
  });

  it("treats a young never-recommended skill as new even when tracking is old", () => {
    expect(classifySkillLifecycle({ createdAt: daysAgo(2), lastRecommendedAt: null, trackingStartedAt: daysAgo(60), now }))
      .toBe("new");
  });

  it("is active while recommended within the stale window", () => {
    expect(classifySkillLifecycle({ createdAt: daysAgo(90), lastRecommendedAt: daysAgo(5), trackingStartedAt: daysAgo(60), now }))
      .toBe("active");
  });

  it("goes stale, then becomes an archive candidate, after quiet spells", () => {
    expect(classifySkillLifecycle({ createdAt: daysAgo(90), lastRecommendedAt: daysAgo(20), trackingStartedAt: daysAgo(60), now }))
      .toBe("stale");
    expect(classifySkillLifecycle({ createdAt: daysAgo(90), lastRecommendedAt: daysAgo(40), trackingStartedAt: daysAgo(60), now }))
      .toBe("archive_candidate");
    expect(classifySkillLifecycle({ createdAt: daysAgo(90), lastRecommendedAt: null, trackingStartedAt: daysAgo(20), now }))
      .toBe("stale");
    expect(classifySkillLifecycle({ createdAt: daysAgo(90), lastRecommendedAt: null, trackingStartedAt: daysAgo(45), now }))
      .toBe("archive_candidate");
  });

  it("honours custom thresholds", () => {
    expect(classifySkillLifecycle({
      createdAt: daysAgo(90), lastRecommendedAt: daysAgo(5), trackingStartedAt: daysAgo(60), now,
      staleAfterDays: 3, archiveAfterDays: 4,
    })).toBe("archive_candidate");
  });
});

describe("clampSkillUsageWindowDays", () => {
  it("defaults bad input and caps large windows", () => {
    expect(clampSkillUsageWindowDays(undefined)).toBe(SKILL_USAGE_DEFAULT_WINDOW_DAYS);
    expect(clampSkillUsageWindowDays("abc")).toBe(SKILL_USAGE_DEFAULT_WINDOW_DAYS);
    expect(clampSkillUsageWindowDays("0")).toBe(SKILL_USAGE_DEFAULT_WINDOW_DAYS);
    expect(clampSkillUsageWindowDays("7")).toBe(7);
    expect(clampSkillUsageWindowDays(10_000)).toBe(SKILL_USAGE_MAX_WINDOW_DAYS);
  });
});

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

suite("skillUsageService.report (real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-skill-usage-");
      db = createDb(temporary.connectionString);
    }
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function company() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Usage fixture", issuePrefix: `U${companyId.slice(0, 7)}` });
    return companyId;
  }

  async function skill(companyId: string, slug: string, categories: string[] = []) {
    const key = `company/${companyId}/${slug}`;
    await db.insert(companySkills).values({
      companyId, key, slug, name: slug, markdown: `# ${slug}`, categories, createdAt: daysAgo(90),
    });
    return key;
  }

  async function recommend(companyId: string, agentId: string, keys: string[], at: Date, status: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status });
    await db.insert(heartbeatRunEvents).values({
      companyId, runId, agentId, seq: 1, eventType: "lifecycle", stream: "system", level: "info",
      message: `Recommended ${keys.length} skill(s) matching this task`,
      payload: { delivery: "inline", relevantSkills: keys.map((key) => ({ key, score: 5, matchedTerms: ["x"] })) },
      createdAt: at,
    });
  }

  it("counts recommendations, outcomes, agents and lifecycle per skill, within one company", async () => {
    const companyId = await company();
    const otherCompanyId = await company();
    const busy = await skill(companyId, "busy");
    const quiet = await skill(companyId, "quiet", [CURATED_SKILL_CATEGORY]);
    const unused = await skill(companyId, "unused");
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "Curator fixture", adapterType: "hermes_gateway",
      adapterConfig: { paperclipSkillSync: { desiredSkills: [busy, quiet] } },
    });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: otherCompanyId, name: "Other", adapterType: "claude_local" });

    await recommend(companyId, agentId, [busy, quiet], daysAgo(50), "succeeded");
    await recommend(companyId, agentId, [busy], daysAgo(2), "succeeded");
    await recommend(companyId, agentId, [busy], daysAgo(1), "failed");
    // Another company's recommendation of a same-named key must not count.
    await recommend(otherCompanyId, otherAgentId, [busy], daysAgo(1), "succeeded");

    const report = await skillUsageService(db).report(companyId, { windowDays: 30, now });
    expect(report.trackingStartedAt).toBe(daysAgo(50).toISOString());
    const byKey = new Map(report.skills.map((item) => [item.key, item]));

    expect(byKey.get(busy)).toMatchObject({
      recommendedRuns: 2, recommendedRunsSucceeded: 1, recommendedRunsFailed: 1,
      agentCount: 1, curated: false, lifecycle: "active", lastRecommendedAt: daysAgo(1).toISOString(),
    });
    expect(byKey.get(quiet)).toMatchObject({
      recommendedRuns: 0, agentCount: 1, curated: true, lifecycle: "archive_candidate",
      lastRecommendedAt: daysAgo(50).toISOString(),
    });
    expect(byKey.get(unused)).toMatchObject({ recommendedRuns: 0, agentCount: 0, lifecycle: "archive_candidate" });
    expect(report.skills[0]?.key).toBe(busy);
  });

  it("reports every skill as new before any recommendation is tracked", async () => {
    const companyId = await company();
    await skill(companyId, "fresh");
    const report = await skillUsageService(db).report(companyId, { now });
    expect(report.trackingStartedAt).toBeNull();
    expect(report.skills.map((item) => item.lifecycle)).toEqual(["new"]);
  });
});
