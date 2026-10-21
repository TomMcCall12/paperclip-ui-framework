import { describe, expect, it } from "vitest";
import { readStallSentinelConfig, resolveEffectiveMode } from "./config.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;

describe("stall sentinel config", () => {
  it("defaults to on, accepts off and alert_only, and ignores junk", () => {
    expect(readStallSentinelConfig({}).mode).toBe("on");
    expect(readStallSentinelConfig({ PAPERCLIP_STALL_SENTINEL_MODE: "OFF" }).mode).toBe("off");
    expect(readStallSentinelConfig({ PAPERCLIP_STALL_SENTINEL_MODE: "alert_only" }).mode).toBe("alert_only");
    expect(readStallSentinelConfig({ PAPERCLIP_STALL_SENTINEL_MODE: "maybe" }).mode).toBe("on");
  });
  it("scales thresholds in dev and test only", () => {
    expect(readStallSentinelConfig({ PAPERCLIP_STALL_SENTINEL_THRESHOLD_SCALE: "0.01" }).thresholds.lostRunHealMs).toBe(6_000);
    expect(
      readStallSentinelConfig({ PAPERCLIP_STALL_SENTINEL_THRESHOLD_SCALE: "0.01", NODE_ENV: "production" }).thresholds.lostRunHealMs,
    ).toBe(600_000);
  });
  it("on is alert-only until the rollout window has passed", () => {
    expect(resolveEffectiveMode("on", null, 24 * HOUR, NOW)).toBe("alert_only");
    expect(resolveEffectiveMode("on", new Date(NOW.getTime() - 23 * HOUR), 24 * HOUR, NOW)).toBe("alert_only");
    expect(resolveEffectiveMode("on", new Date(NOW.getTime() - 24 * HOUR), 24 * HOUR, NOW)).toBe("on");
    expect(resolveEffectiveMode("alert_only", new Date(0), 24 * HOUR, NOW)).toBe("alert_only");
    expect(resolveEffectiveMode("off", new Date(0), 24 * HOUR, NOW)).toBe("off");
  });
  it("cancels a stuck run only after 60 minutes of silence, like the watchdog's suspicion threshold", () => {
    expect(readStallSentinelConfig({}).thresholds.stuckSilenceMs).toBe(60 * 60_000);
  });
  it("reads the rollout length", () => {
    expect(readStallSentinelConfig({ PAPERCLIP_STALL_SENTINEL_ROLLOUT_HOURS: "2" }).rolloutMs).toBe(2 * HOUR);
  });
});
