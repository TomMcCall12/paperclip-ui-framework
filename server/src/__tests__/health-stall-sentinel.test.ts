import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import {
  isStallSentinelFresh,
  resetStallSentinelHealthForTests,
  updateStallSentinelHealth,
} from "../services/stall-sentinel/health-state.js";

const serverInfo = {
  processStartedAt: "2026-06-26T00:00:00.000Z",
  git: {
    available: true,
    fullSha: "0123456789abcdef0123456789abcdef01234567",
    shortSha: "0123456",
    branchName: "master",
    subject: "Stall sentinel",
    committedAt: "2026-06-25T23:00:00.000Z",
    localChanges: { available: true, hasLocalChanges: false, stagedFileCount: 0, unstagedFileCount: 0, untrackedFileCount: 0 },
  },
} as const;

function db(healthy = true): Db {
  return {
    execute: healthy ? vi.fn().mockResolvedValue([{ "?column?": 1 }]) : vi.fn().mockRejectedValue(new Error("down")),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ count: 1 }]) })) })),
  } as unknown as Db;
}

function app(mode: "local_trusted" | "authenticated", database: Db | undefined = db()) {
  const server = express();
  server.use((req, _res, next) => {
    if (mode === "authenticated") (req as any).actor = { type: "none", source: "none" };
    next();
  });
  server.use(
    "/health",
    healthRoutes(database, {
      deploymentMode: mode,
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: false,
      serverInfo,
    }),
  );
  return server;
}

afterEach(() => resetStallSentinelHealthForTests());

describe("GET /health stallSentinel", () => {
  const swept = {
    mode: "on" as const,
    effectiveMode: "alert_only" as const,
    startedAt: "2026-10-22T09:00:00.000Z",
    lastSweepAt: "2026-10-22T09:12:00.000Z",
    lastSweepOk: true,
    lastSweepDurationMs: 420,
    consecutiveFailures: 0,
    openStalls: 2,
    lastAlertAt: "2026-10-22T09:10:00.000Z",
    lastDeliveryError: "telegram_not_configured",
  };

  it("rides the redacted anonymous response with no task data", async () => {
    updateStallSentinelHealth(swept);
    const res = await request(app("authenticated")).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.stallSentinel).toEqual({
      mode: "on",
      effectiveMode: "alert_only",
      startedAt: "2026-10-22T09:00:00.000Z",
      lastSweepAt: "2026-10-22T09:12:00.000Z",
      lastSweepOk: true,
    });
  });

  it("adds counts and the last delivery error for full-detail callers", async () => {
    updateStallSentinelHealth(swept);
    const res = await request(app("local_trusted")).get("/health");
    expect(res.body.stallSentinel).toEqual(swept);
  });

  it("is present on the 503 and no-database responses too", async () => {
    updateStallSentinelHealth(swept);
    const down = await request(app("authenticated", db(false))).get("/health");
    expect(down.status).toBe(503);
    expect(down.body.stallSentinel).toMatchObject({ mode: "on", lastSweepOk: true });
    const noDb = await request(app("authenticated", undefined as unknown as Db)).get("/health");
    expect(noDb.body.stallSentinel).toMatchObject({ mode: "on" });
  });

  it("feeds the host freshness rule", async () => {
    updateStallSentinelHealth({ ...swept, lastSweepAt: "2026-10-22T09:12:00.000Z" });
    const res = await request(app("authenticated")).get("/health");
    expect(isStallSentinelFresh(res.body.stallSentinel, new Date("2026-10-22T09:21:00.000Z"))).toBe(true);
    expect(isStallSentinelFresh(res.body.stallSentinel, new Date("2026-10-22T09:23:00.000Z"))).toBe(false);
    updateStallSentinelHealth({ mode: "off", effectiveMode: "off" });
    const off = await request(app("authenticated")).get("/health");
    expect(isStallSentinelFresh(off.body.stallSentinel, new Date("2026-10-23T00:00:00.000Z"))).toBe(true);
  });
});
