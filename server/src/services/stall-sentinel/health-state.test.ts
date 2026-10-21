import { afterEach, describe, expect, it } from "vitest";
import {
  getStallSentinelHealth,
  getStallSentinelHealthDetails,
  isStallSentinelFresh,
  resetStallSentinelHealthForTests,
  updateStallSentinelHealth,
} from "./health-state.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

afterEach(() => resetStallSentinelHealthForTests());

describe("stall sentinel health", () => {
  it("public health holds only mode and freshness, never counts or errors", () => {
    updateStallSentinelHealth({ openStalls: 3, lastDeliveryError: "telegram_not_configured" });
    expect(Object.keys(getStallSentinelHealth()).sort()).toEqual(["effectiveMode", "lastSweepAt", "lastSweepOk", "mode", "startedAt"]);
    expect(getStallSentinelHealthDetails()).toMatchObject({ openStalls: 3, lastDeliveryError: "telegram_not_configured" });
  });

  it.each([
    ["off passes", { mode: "off", effectiveMode: "off", startedAt: null, lastSweepAt: null, lastSweepOk: false }, true],
    ["fresh sweep passes", { mode: "on", effectiveMode: "on", startedAt: ago(60), lastSweepAt: ago(9), lastSweepOk: true }, true],
    ["stale sweep fails", { mode: "on", effectiveMode: "on", startedAt: ago(60), lastSweepAt: ago(11), lastSweepOk: true }, false],
    ["failed sweep fails", { mode: "on", effectiveMode: "on", startedAt: ago(60), lastSweepAt: ago(1), lastSweepOk: false }, false],
    ["just started passes", { mode: "on", effectiveMode: "alert_only", startedAt: ago(5), lastSweepAt: null, lastSweepOk: true }, true],
    ["never swept fails", { mode: "on", effectiveMode: "alert_only", startedAt: ago(11), lastSweepAt: null, lastSweepOk: true }, false],
  ] as const)("freshness rule: %s", (_name, health, expected) => {
    expect(isStallSentinelFresh(health, NOW)).toBe(expected);
  });

  it("a missing field fails (older build)", () => {
    expect(isStallSentinelFresh(undefined, NOW)).toBe(false);
  });
});
