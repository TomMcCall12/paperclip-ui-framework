import type { StallSentinelMode } from "./config.js";

/**
 * In-memory health of the stall sentinel, read by `/api/health` (design
 * section g). Holds no task data: the redacted health response carries the
 * public part to the host heartbeat check.
 */

export interface StallSentinelHealth {
  mode: StallSentinelMode;
  effectiveMode: StallSentinelMode;
  startedAt: string | null;
  lastSweepAt: string | null;
  lastSweepOk: boolean;
}

export interface StallSentinelHealthDetails extends StallSentinelHealth {
  lastSweepDurationMs: number | null;
  consecutiveFailures: number;
  openStalls: number;
  lastAlertAt: string | null;
  lastDeliveryError: string | null;
}

/**
 * Until the sentinel starts, health reports it as starting now with no sweep.
 * If it never sweeps, the host freshness check fails after 10 minutes instead
 * of passing silently.
 */
let state: StallSentinelHealthDetails = initialState();

function initialState(): StallSentinelHealthDetails {
  return {
    mode: "on",
    effectiveMode: "alert_only",
    startedAt: new Date().toISOString(),
    lastSweepAt: null,
    lastSweepOk: true,
    lastSweepDurationMs: null,
    consecutiveFailures: 0,
    openStalls: 0,
    lastAlertAt: null,
    lastDeliveryError: null,
  };
}

export function updateStallSentinelHealth(patch: Partial<StallSentinelHealthDetails>): void {
  state = { ...state, ...patch };
}

export function getStallSentinelHealth(): StallSentinelHealth {
  return {
    mode: state.mode,
    effectiveMode: state.effectiveMode,
    startedAt: state.startedAt,
    lastSweepAt: state.lastSweepAt,
    lastSweepOk: state.lastSweepOk,
  };
}

export function getStallSentinelHealthDetails(): StallSentinelHealthDetails {
  return { ...state };
}

export function resetStallSentinelHealthForTests(): void {
  state = initialState();
}

/** The host check's freshness rule (section g), shared so tests and docs agree. */
export function isStallSentinelFresh(health: StallSentinelHealth | null | undefined, now: Date, freshnessMs = 10 * 60_000): boolean {
  if (!health) return false;
  if (health.mode === "off") return true;
  if (health.lastSweepAt) {
    return health.lastSweepOk && now.getTime() - new Date(health.lastSweepAt).getTime() <= freshnessMs;
  }
  return !!health.startedAt && now.getTime() - new Date(health.startedAt).getTime() <= freshnessMs;
}
