import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ServerAdapterModule } from "./types.js";

type ClaudeExecute = ServerAdapterModule["execute"];

/**
 * Claude Code mods (function-hooks plugins) this instance loads for every
 * claude_local agent run. Each entry is a plugin directory; a missing one is
 * skipped, so a Paperclip install without the directory behaves as before.
 *
 * Override with `PAPERCLIP_CLAUDE_MOD_DIRS` (path-list separated by `:`).
 */
const DEFAULT_MOD_DIRS = ["/paperclip/mods/audit-trail"];

/** Where the audit-trail mod writes its JSONL logs. */
const DEFAULT_AUDIT_TRAIL_DIR = "/paperclip/storage/audit-trail";

/** Days an audit-trail log is kept before the sweep deletes it. */
const DEFAULT_AUDIT_TRAIL_RETENTION_DAYS = 14;

/** Sweep at most this often, so a busy instance does not re-scan per run. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let lastPruneAt = 0;

function readPathList(value: string | undefined, fallback: string[]): string[] {
  if (typeof value !== "string") return fallback;
  const entries = value.split(":").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  // An explicitly empty value is an opt-out, not a reason to fall back.
  return value.trim().length === 0 ? [] : entries;
}

function readRetentionDays(value: string | undefined): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUDIT_TRAIL_RETENTION_DAYS;
}

/**
 * Delete audit-trail logs older than the retention window. Best effort: the
 * sweep never throws, because losing a log is preferable to failing a run.
 */
export function pruneAuditTrail(
  dir: string,
  retentionDays: number,
  now = Date.now(),
): { deleted: number } {
  let deleted = 0;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { deleted };
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(dir, entry);
    try {
      if (statSync(path).mtimeMs >= cutoff) continue;
      unlinkSync(path);
      deleted += 1;
    } catch {
      // Already gone, or not ours to delete — skip it.
    }
  }
  return { deleted };
}

/**
 * Wraps the claude_local execute so every Paperclip Claude agent run loads this
 * instance's Claude Code mods and writes its audit trail to a persistent folder.
 *
 * Like `stampClaudeAgentIdHeader`, the values are merged into `config.env` — the
 * env the adapter actually forwards into the spawned process — not into
 * `agent.adapterConfig.env`, which is resolved upstream before execute runs.
 *
 * `CLAUDE_CODE_PLUGIN_DIRS` is the only switch-on route available here: the
 * agents run through the ACP engine, which takes no `--plugin-dir` flag, and an
 * agent API key cannot write `adapterConfig.env` on a local adapter.
 */
export function stampClaudeMods(
  inner: ClaudeExecute,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeExecute {
  return (ctx) => {
    const modDirs = readPathList(env.PAPERCLIP_CLAUDE_MOD_DIRS, DEFAULT_MOD_DIRS).filter((dir) =>
      existsSync(dir),
    );
    if (modDirs.length === 0) return inner(ctx);

    const config = ((ctx as { config?: unknown }).config ?? {}) as Record<string, unknown>;
    const configEnv: Record<string, unknown> = {
      ...((config.env as Record<string, unknown> | undefined) ?? {}),
    };

    const existing =
      typeof configEnv.CLAUDE_CODE_PLUGIN_DIRS === "string"
        ? configEnv.CLAUDE_CODE_PLUGIN_DIRS
        : "";
    // De-duplicate: listing a plugin dir twice loads the mod twice.
    const dirs = new Set([
      ...existing.split(":").filter((entry) => entry.length > 0),
      ...modDirs,
    ]);
    configEnv.CLAUDE_CODE_PLUGIN_DIRS = [...dirs].join(":");

    const auditTrailDir = env.PAPERCLIP_CLAUDE_AUDIT_TRAIL_DIR ?? DEFAULT_AUDIT_TRAIL_DIR;
    // A per-agent override wins: the operator asked for a different folder.
    if (typeof configEnv.CLAUDE_AUDIT_TRAIL_DIR !== "string") {
      configEnv.CLAUDE_AUDIT_TRAIL_DIR = auditTrailDir;
    }

    const now = Date.now();
    if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      pruneAuditTrail(
        String(configEnv.CLAUDE_AUDIT_TRAIL_DIR),
        readRetentionDays(env.PAPERCLIP_CLAUDE_AUDIT_TRAIL_RETENTION_DAYS),
        now,
      );
    }

    return inner({ ...ctx, config: { ...config, env: configEnv } } as Parameters<ClaudeExecute>[0]);
  };
}

/** Test seam: forget when the sweep last ran. */
export function resetAuditTrailPruneClock(): void {
  lastPruneAt = 0;
}
