import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migration = await readFile(new URL("./migrations/0286_happy_johnny_blaze.sql", import.meta.url), "utf8");
const hash = createHash("sha256").update(migration).digest("hex");
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describePostgres("Lines additive migration", () => {
  it("starts empty and rejects cross-company roots and members", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-lines-fresh-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const a = randomUUID(), b = randomUUID(), root = randomUUID(), foreignRoot = randomUUID(), member = randomUUID(), line = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${a}, 'Line A', 'LNA'), (${b}, 'Line B', 'LNB')`;
      await sql`INSERT INTO issues (id, company_id, title) VALUES (${root}, ${a}, 'Root'), (${foreignRoot}, ${b}, 'Foreign root'), (${member}, ${b}, 'Foreign member')`;
      expect(await sql`SELECT id FROM lines`).toHaveLength(0);
      await expect(sql`INSERT INTO lines (company_id, root_issue_id, created_by_type) VALUES (${a}, ${foreignRoot}, 'system')`).rejects.toMatchObject({ code: "23503", constraint_name: "lines_root_company_fk" });
      await sql`INSERT INTO lines (id, company_id, root_issue_id, created_by_type) VALUES (${line}, ${a}, ${root}, 'system')`;
      await sql`INSERT INTO lines (company_id, root_issue_id, created_by_type) VALUES (${a}, ${root}, 'system') ON CONFLICT (company_id, root_issue_id) DO NOTHING`;
      expect(await sql`SELECT id FROM lines WHERE company_id = ${a}`).toHaveLength(1);
      await expect(sql`UPDATE issues SET line_id = ${line} WHERE id = ${member}`).rejects.toMatchObject({ code: "23503", constraint_name: "issues_line_company_fk" });
    } finally { await sql.end(); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("preserves existing rows as ungrouped when applied over pre-Line data", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-lines-existing-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql`ALTER TABLE issues DROP CONSTRAINT issues_line_company_fk`;
      await sql`DROP TABLE lines`;
      await sql`ALTER TABLE issues DROP COLUMN line_id`;
      await sql`ALTER TABLE heartbeat_runs DROP CONSTRAINT heartbeat_runs_company_id_uq`;
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      const company = randomUUID(), oldIssue = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'Existing line fixture', 'ELF')`;
      await sql`INSERT INTO issues (id, company_id, title) VALUES (${oldIssue}, ${company}, 'Existing task')`;
      await applyPendingMigrations(database.connectionString);
      expect(await sql`SELECT line_id FROM issues WHERE id = ${oldIssue}`).toEqual([{ line_id: null }]);
      expect(await sql`SELECT id FROM lines`).toHaveLength(0);
    } finally { await sql.end(); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
