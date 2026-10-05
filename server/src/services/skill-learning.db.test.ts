import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySkills,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { distributeNewSkill } from "./skill-learning.js";
import { applySkillLifecycle, findLearningCandidates } from "./skill-usage.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;
const DAY = 24 * 60 * 60 * 1000;

suite("skill learning (real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-skill-learning-");
      db = createDb(temporary.connectionString);
    }
  }, 240_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Learning fixture", issuePrefix: `L${id.slice(0, 7)}` });
    return id;
  }
  async function agent(companyId: string, name: string, desiredSkills: string[] = []) {
    const id = randomUUID();
    await db.insert(agents).values({
      id, companyId, name, adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-5", paperclipSkillSync: { desiredSkills } },
    });
    return id;
  }
  async function task(companyId: string, assigneeAgentId: string, title: string) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title, assigneeAgentId, status: "done" });
    return id;
  }
  const desired = async (agentId: string) => {
    const [row] = await db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.id, agentId));
    return readPaperclipSkillSyncPreference((row?.adapterConfig ?? {}) as Record<string, unknown>).desiredSkills;
  };

  it("hands a new skill to its creator and to agents whose recent work matches", async () => {
    const companyId = await company();
    const creator = await agent(companyId, "Jarvis");
    const engineer = await agent(companyId, "Engineer");
    const designer = await agent(companyId, "Designer");
    const already = await agent(companyId, "Already", ["company/x/edge-deploy"]);
    await task(companyId, engineer, "Deploy the Supabase edge function for shopping");
    await task(companyId, engineer, "Edge function deploy timed out; redeploy and verify");
    await task(companyId, designer, "Critique the onboarding screens");
    await task(companyId, already, "Supabase edge function deploy checks");

    const assigned = await distributeNewSkill(db, {
      companyId,
      skillKey: "company/x/edge-deploy",
      skillText: "edge-function-deploy\nDeploy a Supabase edge function, verify the live version, roll back on failure",
      creatorAgentId: creator,
    });
    expect(assigned.sort()).toEqual([creator, engineer].sort());
    expect(await desired(creator)).toContain("company/x/edge-deploy");
    expect(await desired(engineer)).toContain("company/x/edge-deploy");
    expect(await desired(designer)).not.toContain("company/x/edge-deploy");
    expect(await desired(already)).toEqual(["company/x/edge-deploy"]);
  });

  it("finds complex finished task runs that saved no skill, once per task", async () => {
    const companyId = await company();
    const jarvis = await agent(companyId, "Jarvis");
    const now = new Date();
    const mkRun = async (issueId: string, minutes: number, toolCalls: number | null) => {
      const runId = randomUUID();
      const finishedAt = new Date(now.getTime() - 60 * 60 * 1000);
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId: jarvis, status: "succeeded",
        startedAt: new Date(finishedAt.getTime() - minutes * 60 * 1000), finishedAt,
        contextSnapshot: { issueId },
      });
      if (toolCalls !== null) {
        await db.insert(heartbeatRunEvents).values({
          companyId, runId, agentId: jarvis, seq: 1, eventType: "lifecycle", stream: "system", level: "info",
          message: "Run made tool calls", payload: { toolCalls, skillsUsed: [] },
        });
      }
      return runId;
    };
    const busy = await task(companyId, jarvis, "Investigate the failing deploy");
    const long = await task(companyId, jarvis, "Reconcile the vault");
    const quick = await task(companyId, jarvis, "Say hello");
    const learned = await task(companyId, jarvis, "Fix the categoriser");
    await mkRun(busy, 3, 14);
    await mkRun(busy, 2, 12); // Same task again: reported once.
    await mkRun(long, 25, null);
    await mkRun(quick, 1, 2);
    const learnedRun = await mkRun(learned, 4, 30);
    await db.insert(activityLog).values({
      companyId, actorType: "agent", actorId: jarvis, agentId: jarvis, runId: learnedRun,
      action: "company.skill_created", entityType: "company_skill", entityId: randomUUID(), details: {},
    });

    const found = await findLearningCandidates(db, companyId, { hours: 24, now });
    expect(found.map((candidate) => candidate.title).sort()).toEqual(["Investigate the failing deploy", "Reconcile the vault"]);
  });

  it("archives only idle agent-owned skills and unassigns them", async () => {
    const companyId = await company();
    const key = (slug: string) => `company/${companyId}/${slug}`;
    const old = new Date(Date.now() - 90 * DAY);
    const insertSkill = (slug: string, categories: string[]) => db.insert(companySkills).values({
      companyId, key: key(slug), slug, name: slug, markdown: `# ${slug}`, categories, createdAt: old,
    });
    await insertSkill("idle-learned", ["learned"]);
    await insertSkill("idle-pinned", ["learned", "pinned"]);
    await insertSkill("idle-protected", []);
    const holder = await agent(companyId, "Holder", [key("idle-learned"), key("idle-pinned"), key("idle-protected")]);
    // Tracking began long enough ago for a 30-day quiet spell to count.
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: holder, status: "succeeded" });
    await db.insert(heartbeatRunEvents).values({
      companyId, runId, agentId: holder, seq: 1, eventType: "lifecycle", stream: "system", level: "info",
      message: "Recommended", payload: { delivery: "installed", relevantSkills: [] }, createdAt: new Date(Date.now() - 60 * DAY),
    });

    const dry = await applySkillLifecycle(db, companyId, { dryRun: true });
    expect(dry.map((change) => change.name)).toEqual(["idle-learned"]);

    const changes = await applySkillLifecycle(db, companyId);
    expect(changes).toEqual([expect.objectContaining({ name: "idle-learned", action: "archived", unassignedFrom: 1 })]);
    const [archived] = await db.select({ categories: companySkills.categories }).from(companySkills).where(eq(companySkills.key, key("idle-learned")));
    expect(archived?.categories).toEqual(expect.arrayContaining(["learned", "archived"]));
    expect(await desired(holder)).toEqual([key("idle-pinned"), key("idle-protected")]);
  });
});
