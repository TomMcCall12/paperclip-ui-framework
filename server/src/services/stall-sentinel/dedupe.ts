import { createHash } from "node:crypto";
import { and, desc, eq, gte, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { STALL_SENTINEL_ACTOR_ID } from "./config.js";

/**
 * De-duplication and rate limits (design section e). The memory lives in
 * process and is rebuilt from the sentinel's own activity rows on start, so a
 * restart never sends a repeat early and no new table is needed.
 */

export const SENTINEL_ACTIONS = {
  alerted: "stall_sentinel.alerted",
  healed: "stall_sentinel.healed",
  wouldHeal: "stall_sentinel.would_heal",
  cleared: "stall_sentinel.cleared",
  rollout: "stall_sentinel.rollout",
} as const;

const HOUR = 60 * 60_000;

export function stallFingerprint(companyId: string, rootIssueId: string, cause: string, frontierIssueId: string): string {
  return createHash("sha256").update(`${companyId}|${rootIssueId}|${cause}|${frontierIssueId}`).digest("hex");
}

export interface HealRecord {
  at: Date;
  kind: string;
  /** False for `would_heal` (alert-only mode). */
  applied: boolean;
  /** Provider restart: when the one wake is due (reset + 5 minutes). */
  wakeAt?: Date;
}

export interface AlertRecord {
  firstAt: Date;
  lastSentAt: Date;
  rootId: string;
  cause: string;
  repeat: "hourly" | "once";
}

export interface OpenRootAlert {
  firstAlertAt: Date;
  stalledSince: Date | null;
  telegramSent: boolean;
}

export interface CompanyMemory {
  heals: Map<string, HealRecord>;
  alerts: Map<string, AlertRecord>;
  rootLastMessageAt: Map<string, Date>;
  openRoots: Map<string, OpenRootAlert>;
  telegramSends: Date[];
  capOverflow: number;
  /** Counts for the T16 message: stalls alerted and fixes that alert-only mode skipped. */
  alertOnlyStalls: Set<string>;
  alertOnlyFixes: number;
}

export function emptyMemory(): CompanyMemory {
  return {
    heals: new Map(),
    alerts: new Map(),
    rootLastMessageAt: new Map(),
    openRoots: new Map(),
    telegramSends: [],
    capOverflow: 0,
    alertOnlyStalls: new Set(),
    alertOnlyFixes: 0,
  };
}

export function healKey(issueId: string, cause: string, subject?: string | null): string {
  return subject ? `${issueId}:${cause}:${subject}` : `${issueId}:${cause}`;
}

/** The last heal of this issue and cause inside the cooldown, if any. */
export function recentHeal(mem: CompanyMemory, key: string, now: Date, cooldownMs: number): HealRecord | null {
  const record = mem.heals.get(key);
  if (!record) return null;
  return now.getTime() - record.at.getTime() < cooldownMs ? record : null;
}

const londonHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" });

/** The first 09:00 Europe/London strictly after `after`. */
export function nextLondonNine(after: Date): Date {
  // Walk forward by whole hours from the next hour boundary; at most 25 steps.
  let candidate = new Date(Math.floor(after.getTime() / HOUR) * HOUR + HOUR);
  for (let i = 0; i < 26; i += 1) {
    if (Number(londonHour.format(candidate)) === 9) return candidate;
    candidate = new Date(candidate.getTime() + HOUR);
  }
  return new Date(after.getTime() + 24 * HOUR);
}

/** When this alert may be sent again. Old stalls repeat once a day at 09:00. */
export function nextRepeatAt(record: AlertRecord, stallAgeMs: number, repeatMs: number, oldStallMs: number): Date | null {
  if (record.repeat === "once") return null;
  if (stallAgeMs > oldStallMs) return nextLondonNine(record.lastSentAt);
  return new Date(record.lastSentAt.getTime() + repeatMs);
}

export function alertIsDue(
  mem: CompanyMemory,
  fingerprint: string,
  now: Date,
  stallAgeMs: number,
  repeatMs: number,
  oldStallMs: number,
): boolean {
  const record = mem.alerts.get(fingerprint);
  if (!record) return true;
  const next = nextRepeatAt(record, stallAgeMs, repeatMs, oldStallMs);
  return next !== null && now >= next;
}

export function rootGapOk(mem: CompanyMemory, rootId: string, now: Date, gapMs: number): boolean {
  const last = mem.rootLastMessageAt.get(rootId);
  return !last || now.getTime() - last.getTime() >= gapMs;
}

export function telegramAllowed(mem: CompanyMemory, now: Date, capPerHour: number): boolean {
  mem.telegramSends = mem.telegramSends.filter((at) => now.getTime() - at.getTime() < HOUR);
  return mem.telegramSends.length < capPerHour;
}

export interface ActivityStateRow {
  action: string;
  entityId: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Rebuilds the memory from the last 24 hours of the sentinel's own activity rows (oldest first). */
export function rebuildMemory(rows: ActivityStateRow[]): CompanyMemory {
  const mem = emptyMemory();
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const row of sorted) {
    const d = row.details ?? {};
    if (row.action === SENTINEL_ACTIONS.healed || row.action === SENTINEL_ACTIONS.wouldHeal) {
      const issueId = str(d.issueId);
      const cause = str(d.cause);
      if (!issueId || !cause) continue;
      if (d.action === "restart_wake") continue;
      const wakeAt = str(d.wakeAt);
      mem.heals.set(str(d.healKey) ?? healKey(issueId, cause, str(d.subject)), {
        at: row.createdAt,
        kind: str(d.action) ?? "unknown",
        applied: row.action === SENTINEL_ACTIONS.healed,
        ...(wakeAt ? { wakeAt: new Date(wakeAt) } : {}),
      });
      if (row.action === SENTINEL_ACTIONS.wouldHeal) mem.alertOnlyFixes += 1;
    } else if (row.action === SENTINEL_ACTIONS.alerted) {
      const fingerprint = str(d.fingerprint);
      const rootId = str(d.rootIssueId) ?? row.entityId;
      const cause = str(d.cause) ?? "U";
      if (fingerprint) {
        const prev = mem.alerts.get(fingerprint);
        mem.alerts.set(fingerprint, {
          firstAt: prev?.firstAt ?? row.createdAt,
          lastSentAt: row.createdAt,
          rootId,
          cause,
          repeat: d.repeat === "once" ? "once" : "hourly",
        });
        mem.alertOnlyStalls.add(fingerprint);
      }
      mem.rootLastMessageAt.set(rootId, row.createdAt);
      const stalledSince = str(d.stalledSince);
      if (!mem.openRoots.has(rootId)) {
        mem.openRoots.set(rootId, {
          firstAlertAt: row.createdAt,
          stalledSince: stalledSince ? new Date(stalledSince) : null,
          telegramSent: d.sent === true,
        });
      } else if (d.sent === true) {
        mem.openRoots.get(rootId)!.telegramSent = true;
      }
      if (d.sent === true) mem.telegramSends.push(row.createdAt);
    } else if (row.action === SENTINEL_ACTIONS.cleared) {
      const rootId = str(d.rootIssueId) ?? row.entityId;
      mem.openRoots.delete(rootId);
      for (const [fingerprint, record] of mem.alerts) {
        if (record.rootId === rootId) mem.alerts.delete(fingerprint);
      }
    }
  }
  return mem;
}

export async function loadMemoryRows(db: Db, companyId: string, since: Date): Promise<ActivityStateRow[]> {
  const rows = await db
    .select({
      action: activityLog.action,
      entityId: activityLog.entityId,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.actorType, "system"),
        eq(activityLog.actorId, STALL_SENTINEL_ACTOR_ID),
        like(activityLog.action, "stall_sentinel.%"),
        gte(activityLog.createdAt, since),
      ),
    );
  return rows.map((row) => ({ ...row, details: (row.details ?? null) as Record<string, unknown> | null }));
}

export interface RolloutState {
  startedAt: Date | null;
  selfRepairOnAt: Date | null;
}

export async function loadRolloutState(db: Db, companyId: string): Promise<RolloutState> {
  const rows = await db
    .select({ details: activityLog.details, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.actorType, "system"),
        eq(activityLog.actorId, STALL_SENTINEL_ACTOR_ID),
        eq(activityLog.action, SENTINEL_ACTIONS.rollout),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(20);
  return rolloutFromRows(rows.map((row) => ({ details: (row.details ?? {}) as Record<string, unknown>, createdAt: row.createdAt })));
}

export function rolloutFromRows(rows: Array<{ details: Record<string, unknown>; createdAt: Date }>): RolloutState {
  let startedAt: Date | null = null;
  let selfRepairOnAt: Date | null = null;
  for (const row of rows) {
    if (row.details.phase === "started") {
      const at = str(row.details.startedAt);
      const date = at ? new Date(at) : row.createdAt;
      if (!startedAt || date < startedAt) startedAt = date;
    } else if (row.details.phase === "self_repair_on") {
      if (!selfRepairOnAt || row.createdAt < selfRepairOnAt) selfRepairOnAt = row.createdAt;
    }
  }
  return { startedAt, selfRepairOnAt };
}
