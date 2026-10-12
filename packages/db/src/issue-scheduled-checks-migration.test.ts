import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0285_fearless_moondragon.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("issue_scheduled_checks migration (TOM-413)", () => {
  it("creates the table and moves an existing single monitor into a primary row", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-scheduled-checks-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueWithMonitorId = randomUUID();
    const issueWithoutMonitorId = randomUUID();
    const monitorNextCheckAt = new Date("2026-05-01T09:00:00.000Z");
    const monitorLastTriggeredAt = new Date("2026-04-20T09:00:00.000Z");

    try {
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
      await sql`DROP TABLE IF EXISTS "issue_scheduled_checks" CASCADE`;
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Scheduled checks company', 'SCC')
      `;
      await sql`
        INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
        VALUES (${agentId}, ${companyId}, 'Scheduled checks agent', 'engineer', 'process', '{}'::jsonb)
      `;
      await sql`
        INSERT INTO "issues" (
          "id", "company_id", "title", "identifier", "assignee_agent_id",
          "monitor_next_check_at", "monitor_notes", "monitor_scheduled_by",
          "monitor_attempt_count", "monitor_last_triggered_at"
        ) VALUES (
          ${issueWithMonitorId}, ${companyId}, 'Issue with a legacy monitor', 'SCC-1', ${agentId},
          ${monitorNextCheckAt}, 'Check the deploy', 'assignee',
          2, ${monitorLastTriggeredAt}
        )
      `;
      await sql`
        INSERT INTO "issues" ("id", "company_id", "title", "identifier")
        VALUES (${issueWithoutMonitorId}, ${companyId}, 'Issue with no monitor', 'SCC-2')
      `;
    } finally {
      await sql.end();
    }

    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
    await applyPendingMigrations(database.connectionString);

    const verify = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const rows = await verify<
        {
          issue_id: string;
          company_id: string;
          next_check_at: Date;
          notes: string | null;
          created_by_agent_id: string | null;
          status: string;
          attempt_count: number;
          last_triggered_at: Date | null;
          is_primary: boolean;
        }[]
      >`SELECT * FROM "issue_scheduled_checks" WHERE "issue_id" = ${issueWithMonitorId}`;

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        company_id: companyId,
        notes: "Check the deploy",
        created_by_agent_id: agentId,
        status: "scheduled",
        attempt_count: 2,
        is_primary: true,
      });
      expect(rows[0]!.next_check_at.toISOString()).toBe(monitorNextCheckAt.toISOString());
      expect(rows[0]!.last_triggered_at?.toISOString()).toBe(monitorLastTriggeredAt.toISOString());

      const noMonitorRows = await verify`
        SELECT * FROM "issue_scheduled_checks" WHERE "issue_id" = ${issueWithoutMonitorId}
      `;
      expect(noMonitorRows).toHaveLength(0);

      // The multi-row model: a second, independent check-in on the same issue.
      const extraCheckId = randomUUID();
      await verify`
        INSERT INTO "issue_scheduled_checks" (
          "id", "company_id", "issue_id", "next_check_at", "notes", "is_primary"
        ) VALUES (
          ${extraCheckId}, ${companyId}, ${issueWithMonitorId}, now(), 'A second, independent check-in', false
        )
      `;
      const allChecks = await verify`
        SELECT "id" FROM "issue_scheduled_checks" WHERE "issue_id" = ${issueWithMonitorId}
      `;
      expect(allChecks).toHaveLength(2);
    } finally {
      await verify.end();
    }
  }, 30_000);
});
