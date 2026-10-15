import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, lines } from "@paperclipai/db";
import type { Line, ListLinesQuery, PaginatedLines } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

export interface LineActor {
  type: "agent" | "user" | "system";
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
}

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** All membership writers take this company-scoped lock before reading the tree. */
export async function lockLineTree(tx: Transaction, companyId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'line-tree:' + companyId}, 0))`);
}

export async function lineDescendantIds(tx: Transaction, companyId: string, rootId: string): Promise<string[]> {
  const rows = await tx.execute(sql`
    with recursive tree as (
      select id from issues where company_id = ${companyId} and id = ${rootId}
      union
      select child.id from issues child join tree on child.parent_id = tree.id
      where child.company_id = ${companyId}
    ) select id from tree`);
  return rows.map((row) => String(row.id));
}

function actorLog(actor: LineActor) {
  return {
    actorType: actor.type,
    actorId: actor.agentId ?? actor.userId ?? "line_service",
    agentId: actor.agentId ?? null,
    runId: actor.runId ?? null,
  } as const;
}

function lineView(row: typeof lines.$inferSelect, root: typeof issues.$inferSelect, members: Array<typeof issues.$inferSelect>): Line {
  const visible = members.filter((member) => member.hiddenAt === null);
  const terminal = visible.filter((member) => member.status === "done" || member.status === "cancelled").length;
  const completionStatus = root.status === "cancelled" ? "cancelled"
    : root.status === "done" && terminal === visible.length ? "completed" : "active";
  return {
    ...row,
    rootIdentifier: root.identifier ?? root.id,
    rootTitle: root.title,
    displayName: row.name ?? `Line ${root.identifier ?? root.id}`,
    completionStatus,
    visibleIssueCount: visible.length,
    terminalIssueCount: terminal,
    nextNamingAttemptAt: row.nextNamingAttemptAt?.toISOString() ?? null,
    namedAt: row.namedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function lineService(db: Db) {
  async function get(companyId: string, lineId: string): Promise<Line | null> {
    const [row] = await db.select().from(lines).where(and(eq(lines.companyId, companyId), eq(lines.id, lineId)));
    if (!row) return null;
    const [root] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, row.rootIssueId)));
    if (!root) return null;
    const members = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.lineId, lineId)));
    return lineView(row, root, members);
  }

  return {
    get,
    async inspect(companyId: string, rootIssueId: string) {
      return db.transaction(async (tx) => {
        const [root] = await tx.select({ id: issues.id, hiddenAt: issues.hiddenAt }).from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.id, rootIssueId)));
        if (!root) return { memberIssueIds: [] as string[], conflict: "root_not_found" as string | null, existingLineId: null as string | null };
        const memberIssueIds = (await lineDescendantIds(tx, companyId, rootIssueId)).sort();
        const members = await tx.select({ lineId: issues.lineId }).from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, memberIssueIds)));
        const [existing] = await tx.select({ id: lines.id }).from(lines)
          .where(and(eq(lines.companyId, companyId), eq(lines.rootIssueId, rootIssueId)));
        const conflictCode = root.hiddenAt ? "hidden_root" :
          members.some((row) => row.lineId && row.lineId !== existing?.id) ? "conflicting_membership" : null;
        return { memberIssueIds, conflict: conflictCode, existingLineId: existing?.id ?? null };
      });
    },
    async ensure(companyId: string, rootIssueId: string, actor: LineActor) {
      const result = await db.transaction(async (tx) => {
        await lockLineTree(tx, companyId);
        const [root] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, rootIssueId))).for("update");
        if (!root) throw notFound("Issue not found");
        const [existing] = await tx.select().from(lines).where(and(eq(lines.companyId, companyId), eq(lines.rootIssueId, rootIssueId)));
        if (existing) {
          const ids = await lineDescendantIds(tx, companyId, rootIssueId);
          const subtree = await tx.select({ id: issues.id, lineId: issues.lineId }).from(issues)
            .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
          if (subtree.some((member) => member.lineId && member.lineId !== existing.id)) throw conflict("Subtree contains another Line");
          const missing = subtree.filter((member) => !member.lineId).map((member) => member.id);
          if (missing.length) {
            await tx.update(issues).set({ lineId: existing.id }).where(and(eq(issues.companyId, companyId), inArray(issues.id, missing)));
            await logActivity(tx as unknown as Db, { companyId, ...actorLog(actor), action: "line.members_reconciled", entityType: "line", entityId: existing.id, details: { memberCount: missing.length } });
          }
          return { id: existing.id, created: false };
        }
        if (root.hiddenAt || root.lineId) throw conflict("Root already belongs to a Line or is hidden");
        if (root.parentId) {
          const [parent] = await tx.select({ lineId: issues.lineId }).from(issues)
            .where(and(eq(issues.companyId, companyId), eq(issues.id, root.parentId)));
          if (parent?.lineId) throw conflict("A Line cannot be nested inside another Line");
        }
        const ids = await lineDescendantIds(tx, companyId, rootIssueId);
        const subtree = await tx.select({ id: issues.id, lineId: issues.lineId }).from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
        if (subtree.some((member) => member.lineId)) throw conflict("Subtree already contains Line members");
        const [row] = await tx.insert(lines).values({
          companyId, rootIssueId, createdByType: actor.type,
          createdByAgentId: actor.agentId ?? null, createdByUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
        }).returning();
        await tx.update(issues).set({ lineId: row.id }).where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
        await logActivity(tx as unknown as Db, {
          companyId, ...actorLog(actor), action: "line.created", entityType: "line", entityId: row.id,
          details: { rootIssueId, memberCount: ids.length },
        });
        return { id: row.id, created: true };
      });
      const line = await get(companyId, result.id);
      if (!line) throw new Error("New Line missing after commit");
      return { line, created: result.created };
    },
    async list(companyId: string, query: ListLinesQuery): Promise<PaginatedLines> {
      const normalizedQ = query.q?.trim().toLowerCase() ?? "";
      let after: { updatedAt: string; id: string; status: string; q: string } | null = null;
      if (query.cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
          if (typeof parsed.updatedAt !== "string" || !Number.isFinite(Date.parse(parsed.updatedAt)) ||
              typeof parsed.id !== "string" || parsed.status !== query.status || parsed.q !== normalizedQ)
            throw new Error("cursor mismatch");
          after = parsed;
        } catch { throw unprocessable("Invalid Line cursor"); }
      }
      const completed = sql`(${issues.status} = 'done' and not exists (
        select 1 from issues member where member.company_id = ${companyId}
        and member.line_id = ${lines.id} and member.hidden_at is null
        and member.status not in ('done', 'cancelled')
      ))`;
      const rows = await db.select({ line: lines, root: issues }).from(lines)
        .innerJoin(issues, and(eq(issues.companyId, lines.companyId), eq(issues.id, lines.rootIssueId)))
        .where(and(eq(lines.companyId, companyId),
          normalizedQ ? or(ilike(lines.name, `%${normalizedQ}%`), ilike(issues.title, `%${normalizedQ}%`), ilike(issues.identifier, `%${normalizedQ}%`)) : undefined,
          query.status === "archived" ? sql`${lines.archivedAt} is not null` : query.status === "all" ? undefined : isNull(lines.archivedAt),
          query.status === "completed" ? completed : query.status === "active" ? sql`not ${completed}` : undefined,
          after ? sql`(${lines.updatedAt} < ${new Date(after.updatedAt)} or (${lines.updatedAt} = ${new Date(after.updatedAt)} and ${lines.id} < ${after.id}))` : undefined,
        )).orderBy(desc(lines.updatedAt), desc(lines.id)).limit(query.limit + 1);
      const pageRows = rows.slice(0, query.limit);
      const ids = pageRows.map(({ line }) => line.id);
      const members = ids.length ? await db.select().from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.lineId, ids))) : [];
      const byLine = new Map<string, Array<typeof issues.$inferSelect>>();
      for (const member of members) {
        if (!member.lineId) continue;
        const group = byLine.get(member.lineId) ?? [];
        group.push(member);
        byLine.set(member.lineId, group);
      }
      const items = pageRows.map(({ line, root }) => lineView(line, root, byLine.get(line.id) ?? []));
      const last = pageRows.at(-1)?.line;
      return { items, nextCursor: rows.length > query.limit && last
        ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt.toISOString(), id: last.id, status: query.status, q: normalizedQ })).toString("base64url")
        : null };
    },
    async archive(companyId: string, lineId: string, archived: boolean, actor: LineActor) {
      await db.transaction(async (tx) => {
        await lockLineTree(tx, companyId);
        const [row] = await tx.select().from(lines).where(and(eq(lines.companyId, companyId), eq(lines.id, lineId))).for("update");
        if (!row) throw notFound("Line not found");
        if (Boolean(row.archivedAt) === archived) return;
        if (archived) {
          const [open] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.lineId, lineId), isNull(issues.hiddenAt), sql`${issues.status} not in ('done', 'cancelled')`)).limit(1);
          const [running] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
            .innerJoin(issues, sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issues.id}::text`)
            .where(and(eq(heartbeatRuns.companyId, companyId), eq(issues.companyId, companyId), eq(issues.lineId, lineId), isNull(heartbeatRuns.finishedAt))).limit(1);
          if (open || running) throw conflict("Line has open work or an active run");
        }
        await tx.update(lines).set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
          .where(and(eq(lines.companyId, companyId), eq(lines.id, lineId)));
        await logActivity(tx as unknown as Db, { companyId, ...actorLog(actor), action: archived ? "line.archived" : "line.unarchived", entityType: "line", entityId: lineId });
      });
      const line = await get(companyId, lineId);
      if (!line) throw notFound("Line not found");
      return line;
    },
  };
}
