import { describe, expect, it } from "vitest";
import {
  alertIsDue,
  emptyMemory,
  nextLondonNine,
  rebuildMemory,
  rolloutFromRows,
  rootGapOk,
  SENTINEL_ACTIONS,
  stallFingerprint,
  telegramAllowed,
} from "./dedupe.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const MIN = 60_000;
const at = (min: number) => new Date(NOW.getTime() + min * MIN);

describe("stall fingerprints and repeats", () => {
  it("changes when the cause or the frontier changes", () => {
    const a = stallFingerprint("c", "r", "L", "f");
    expect(a).toBe(stallFingerprint("c", "r", "L", "f"));
    expect(a).not.toBe(stallFingerprint("c", "r", "U", "f"));
    expect(a).not.toBe(stallFingerprint("c", "r", "L", "g"));
  });
  it("repeats at most every 60 minutes, and once a day at 09:00 for old stalls", () => {
    const mem = emptyMemory();
    mem.alerts.set("fp", { firstAt: NOW, lastSentAt: NOW, rootId: "r", cause: "U", repeat: "hourly" });
    expect(alertIsDue(mem, "fp", at(59), 3 * 60 * MIN, 60 * MIN, 24 * 60 * MIN)).toBe(false);
    expect(alertIsDue(mem, "fp", at(60), 3 * 60 * MIN, 60 * MIN, 24 * 60 * MIN)).toBe(true);
    const old = 30 * 60 * MIN;
    expect(alertIsDue(mem, "fp", at(120), old, 60 * MIN, 24 * 60 * MIN)).toBe(false);
    expect(alertIsDue(mem, "fp", new Date("2026-10-22T08:00:00.000Z"), old, 60 * MIN, 24 * 60 * MIN)).toBe(true);
  });
  it("never repeats a once-only alert", () => {
    const mem = emptyMemory();
    mem.alerts.set("fp", { firstAt: NOW, lastSentAt: NOW, rootId: "r", cause: "P", repeat: "once" });
    expect(alertIsDue(mem, "fp", at(600), 60 * MIN, 60 * MIN, 24 * 60 * MIN)).toBe(false);
  });
  it("finds the next 09:00 in London across the clock change", () => {
    expect(nextLondonNine(NOW).toISOString()).toBe("2026-10-22T08:00:00.000Z");
    // 25 Oct 2026: BST ends, so 09:00 on 26 Oct is 09:00 UTC.
    expect(nextLondonNine(new Date("2026-10-25T10:00:00.000Z")).toISOString()).toBe("2026-10-26T09:00:00.000Z");
  });
});

describe("rate limits", () => {
  it("allows one message per root per 15 minutes", () => {
    const mem = emptyMemory();
    mem.rootLastMessageAt.set("r", NOW);
    expect(rootGapOk(mem, "r", at(14), 15 * MIN)).toBe(false);
    expect(rootGapOk(mem, "r", at(15), 15 * MIN)).toBe(true);
  });
  it("caps Telegram at 6 messages per company per hour", () => {
    const mem = emptyMemory();
    for (let i = 0; i < 6; i += 1) mem.telegramSends.push(at(i));
    expect(telegramAllowed(mem, at(10), 6)).toBe(false);
    expect(telegramAllowed(mem, at(60.5), 6)).toBe(true);
  });
});

describe("memory rebuild from activity rows", () => {
  it("restores heals, alerts and cleared roots so a restart never repeats early", () => {
    const mem = rebuildMemory([
      { action: SENTINEL_ACTIONS.healed, entityId: "r", createdAt: at(-30), details: { cause: "L", healKey: "i:requeue", issueId: "i", action: "requeue" } },
      { action: SENTINEL_ACTIONS.wouldHeal, entityId: "r", createdAt: at(-20), details: { cause: "R", issueId: "j", action: "cancel_stuck_run" } },
      { action: SENTINEL_ACTIONS.alerted, entityId: "r", createdAt: at(-10), details: { fingerprint: "fp", cause: "L", rootIssueId: "r", sent: true } },
      { action: SENTINEL_ACTIONS.alerted, entityId: "s", createdAt: at(-9), details: { fingerprint: "fp2", cause: "U", rootIssueId: "s", sent: true } },
      { action: SENTINEL_ACTIONS.cleared, entityId: "s", createdAt: at(-5), details: { rootIssueId: "s" } },
      { action: SENTINEL_ACTIONS.healed, entityId: "r", createdAt: at(-4), details: { cause: "P", issueId: "k", action: "restart_after_reset", wakeAt: at(30).toISOString() } },
    ]);
    expect(mem.heals.get("i:requeue")).toMatchObject({ applied: true, kind: "requeue" });
    expect(mem.heals.get("j:R")).toMatchObject({ applied: false });
    expect(mem.heals.get("k:P")?.wakeAt?.toISOString()).toBe(at(30).toISOString());
    expect(mem.alerts.has("fp")).toBe(true);
    expect(mem.alerts.has("fp2")).toBe(false);
    expect(mem.openRoots.has("r")).toBe(true);
    expect(mem.openRoots.has("s")).toBe(false);
    expect(mem.telegramSends).toHaveLength(2);
    expect(mem.alertOnlyFixes).toBe(1);
  });
  it("reads the rollout start and the self-repair switch", () => {
    const state = rolloutFromRows([
      { details: { phase: "self_repair_on" }, createdAt: at(0) },
      { details: { phase: "started", startedAt: at(-1440).toISOString() }, createdAt: at(-1440) },
    ]);
    expect(state.startedAt?.toISOString()).toBe(at(-1440).toISOString());
    expect(state.selfRepairOnAt?.toISOString()).toBe(NOW.toISOString());
  });
});
