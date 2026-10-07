import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneAuditTrail, resetAuditTrailPruneClock, stampClaudeMods } from "./claude-mods.js";

type ExecuteCtx = {
  config?: { env?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
};

function recordingInner() {
  const sentinel = Symbol("inner-result");
  const inner = vi.fn((_ctx: ExecuteCtx) => Promise.resolve(sentinel));
  return { inner, sentinel };
}

function forwardedEnv(inner: ReturnType<typeof recordingInner>["inner"]) {
  return (inner.mock.calls[0]?.[0] as ExecuteCtx).config?.env ?? {};
}

let modDir: string;
let auditDir: string;

beforeEach(() => {
  resetAuditTrailPruneClock();
  const root = mkdtempSync(join(tmpdir(), "claude-mods-"));
  modDir = join(root, "audit-trail");
  auditDir = join(root, "logs");
  mkdirSync(modDir);
  mkdirSync(auditDir);
});

afterEach(() => {
  resetAuditTrailPruneClock();
});

describe("stampClaudeMods", () => {
  it("adds the mod dir and audit-trail dir to config.env", async () => {
    const { inner, sentinel } = recordingInner();
    const wrapped = stampClaudeMods(inner as never, {
      PAPERCLIP_CLAUDE_MOD_DIRS: modDir,
      PAPERCLIP_CLAUDE_AUDIT_TRAIL_DIR: auditDir,
    });

    const result = await wrapped({ config: { cwd: "/work", env: { EXISTING: "keep" } } } as never);

    expect(result).toBe(sentinel);
    const env = forwardedEnv(inner);
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(modDir);
    expect(env.CLAUDE_AUDIT_TRAIL_DIR).toBe(auditDir);
    // Unrelated config + env entries are preserved.
    expect((inner.mock.calls[0]?.[0] as ExecuteCtx).config?.cwd).toBe("/work");
    expect(env.EXISTING).toBe("keep");
  });

  it("appends to a pre-existing CLAUDE_CODE_PLUGIN_DIRS without duplicating", async () => {
    const { inner } = recordingInner();
    const wrapped = stampClaudeMods(inner as never, {
      PAPERCLIP_CLAUDE_MOD_DIRS: `${modDir}:${modDir}`,
      PAPERCLIP_CLAUDE_AUDIT_TRAIL_DIR: auditDir,
    });

    await wrapped({ config: { env: { CLAUDE_CODE_PLUGIN_DIRS: "/already/here" } } } as never);

    expect(forwardedEnv(inner).CLAUDE_CODE_PLUGIN_DIRS).toBe(`/already/here:${modDir}`);
  });

  it("respects a per-agent CLAUDE_AUDIT_TRAIL_DIR override", async () => {
    const { inner } = recordingInner();
    const wrapped = stampClaudeMods(inner as never, {
      PAPERCLIP_CLAUDE_MOD_DIRS: modDir,
      PAPERCLIP_CLAUDE_AUDIT_TRAIL_DIR: auditDir,
    });

    await wrapped({ config: { env: { CLAUDE_AUDIT_TRAIL_DIR: "/agent/choice" } } } as never);

    expect(forwardedEnv(inner).CLAUDE_AUDIT_TRAIL_DIR).toBe("/agent/choice");
  });

  it("passes the ctx through untouched when no mod dir exists on disk", async () => {
    const { inner } = recordingInner();
    const wrapped = stampClaudeMods(inner as never, {
      PAPERCLIP_CLAUDE_MOD_DIRS: join(modDir, "missing"),
    });

    const ctx = { config: { env: { EXISTING: "keep" } } } as never;
    await wrapped(ctx);

    expect(inner.mock.calls[0]?.[0]).toBe(ctx);
    expect(forwardedEnv(inner).CLAUDE_CODE_PLUGIN_DIRS).toBeUndefined();
  });

  it("treats an empty PAPERCLIP_CLAUDE_MOD_DIRS as an opt-out", async () => {
    const { inner } = recordingInner();
    const wrapped = stampClaudeMods(inner as never, { PAPERCLIP_CLAUDE_MOD_DIRS: "  " });

    const ctx = { config: { env: {} } } as never;
    await wrapped(ctx);

    expect(inner.mock.calls[0]?.[0]).toBe(ctx);
  });

  it("sweeps expired logs once, not on every run", async () => {
    const stale = join(auditDir, "old.jsonl");
    writeFileSync(stale, "{}\n");
    const longAgo = Date.now() / 1000 - 20 * 24 * 60 * 60;
    utimesSync(stale, longAgo, longAgo);

    const { inner } = recordingInner();
    const wrapped = stampClaudeMods(inner as never, {
      PAPERCLIP_CLAUDE_MOD_DIRS: modDir,
      PAPERCLIP_CLAUDE_AUDIT_TRAIL_DIR: auditDir,
      PAPERCLIP_CLAUDE_AUDIT_TRAIL_RETENTION_DAYS: "14",
    });

    await wrapped({ config: { env: {} } } as never);
    expect(readdirSync(auditDir)).toEqual([]);

    // A second stale log survives: the sweep is rate-limited, not per-run.
    writeFileSync(stale, "{}\n");
    utimesSync(stale, longAgo, longAgo);
    await wrapped({ config: { env: {} } } as never);
    expect(readdirSync(auditDir)).toEqual(["old.jsonl"]);
  });
});

describe("pruneAuditTrail", () => {
  it("deletes only .jsonl files past the retention window", () => {
    const now = Date.UTC(2026, 9, 7);
    const day = 24 * 60 * 60 * 1000;
    const write = (name: string, mtimeMs: number) => {
      const path = join(auditDir, name);
      writeFileSync(path, "{}\n");
      utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
    };
    write("expired.jsonl", now - 15 * day);
    write("fresh.jsonl", now - 2 * day);
    write("notes.txt", now - 30 * day);

    expect(pruneAuditTrail(auditDir, 14, now)).toEqual({ deleted: 1 });
    expect(readdirSync(auditDir).sort()).toEqual(["fresh.jsonl", "notes.txt"]);
  });

  it("returns zero for a directory that does not exist", () => {
    expect(pruneAuditTrail(join(auditDir, "nope"), 14)).toEqual({ deleted: 0 });
  });
});
