/**
 * Stall sentinel settings. The sentinel watches every open tree of work, fixes
 * simple stalls itself and tells the board on Telegram when it cannot. It never
 * calls a model or an agent adapter. See doc/stall-sentinel.md.
 */
export const STALL_SENTINEL_MODES = ["off", "alert_only", "on"] as const;
export type StallSentinelMode = (typeof STALL_SENTINEL_MODES)[number];

export const STALL_SENTINEL_ACTOR_ID = "stall-sentinel";
/** Origin kinds of system review issues; their source trees are watched instead. */
export const STALL_SENTINEL_EXCLUDED_ROOT_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  "stale_active_run_evaluation",
  "harness_liveness_escalation",
  "issue_productivity_review",
  "stranded_issue_recovery",
  "task_watchdog",
  "task_watchdog_product_bug",
  "chat_channel",
]);
export const ROUTINE_ORIGIN_KIND = "routine_execution";
export const PROVIDER_LOCKED_LABEL = "provider-locked";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Times (ms) from section (b) of the design. All are multiplied by the threshold scale. */
export interface StallSentinelThresholds {
  holdAlertMs: number;
  providerRestartDelayMs: number;
  providerRestartAlertGraceMs: number;
  stuckSilenceMs: number;
  stuckTimeoutGraceMs: number;
  busyQueuedAlertMs: number;
  idleQueuedHealMs: number;
  lostRunHealMs: number;
  afterRequeueAlertMs: number;
  agentUnavailableAlertMs: number;
  cancelledBlockerHealMs: number;
  blockedWithoutBlockerHealMs: number;
  checkpointHealMs: number;
  afterWakeAlertMs: number;
  monitorGraceMs: number;
  unknownAlertMs: number;
  routineUnknownAlertMs: number;
  alertRepeatMs: number;
  perRootMessageGapMs: number;
  healCooldownMs: number;
  oldStallMs: number;
  progressLookbackMs: number;
}

const DEFAULT_THRESHOLDS: StallSentinelThresholds = {
  holdAlertMs: 60 * MINUTE,
  providerRestartDelayMs: 5 * MINUTE,
  providerRestartAlertGraceMs: 15 * MINUTE,
  /** Matches the active-run watchdog's suspicion threshold, so a long silent tool call is not killed. */
  stuckSilenceMs: 60 * MINUTE,
  stuckTimeoutGraceMs: 15 * MINUTE,
  busyQueuedAlertMs: 30 * MINUTE,
  idleQueuedHealMs: 10 * MINUTE,
  lostRunHealMs: 10 * MINUTE,
  afterRequeueAlertMs: 15 * MINUTE,
  agentUnavailableAlertMs: 15 * MINUTE,
  cancelledBlockerHealMs: 15 * MINUTE,
  blockedWithoutBlockerHealMs: 30 * MINUTE,
  checkpointHealMs: 15 * MINUTE,
  afterWakeAlertMs: 30 * MINUTE,
  monitorGraceMs: 15 * MINUTE,
  unknownAlertMs: 3 * HOUR,
  routineUnknownAlertMs: 4 * HOUR,
  alertRepeatMs: 60 * MINUTE,
  perRootMessageGapMs: 15 * MINUTE,
  healCooldownMs: 24 * HOUR,
  oldStallMs: 24 * HOUR,
  progressLookbackMs: 7 * 24 * HOUR,
};

export interface StallSentinelConfig {
  /** Operator setting. `on` still runs alert-only during the rollout window. */
  mode: StallSentinelMode;
  rolloutMs: number;
  thresholdScale: number;
  thresholds: StallSentinelThresholds;
  sweepIntervalMs: number;
  sweepTimeoutMs: number;
  /** Health freshness window and the gap that triggers the "I was not running" message. */
  freshnessMs: number;
  companyTelegramCapPerHour: number;
  groupListLimit: number;
  failureAlertAfter: number;
  /** Agent that is mentioned and woken to reroute alert-only stalls. Null: resolved by name. */
  coordinatorAgentId: string | null;
  coordinatorAgentName: string;
}

function parseMode(raw: string | undefined): StallSentinelMode {
  const value = raw?.trim().toLowerCase();
  return (STALL_SENTINEL_MODES as readonly string[]).includes(value ?? "")
    ? (value as StallSentinelMode)
    : "on";
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readStallSentinelConfig(
  env: Record<string, string | undefined> = process.env,
): StallSentinelConfig {
  // The scale exists so a dev or test instance can prove the timings quickly.
  const scale = env.NODE_ENV === "production"
    ? 1
    : parsePositiveNumber(env.PAPERCLIP_STALL_SENTINEL_THRESHOLD_SCALE, 1);
  const thresholds = Object.fromEntries(
    Object.entries(DEFAULT_THRESHOLDS).map(([key, value]) => [key, Math.max(1, Math.round(value * scale))]),
  ) as unknown as StallSentinelThresholds;
  return {
    mode: parseMode(env.PAPERCLIP_STALL_SENTINEL_MODE),
    rolloutMs: parsePositiveNumber(env.PAPERCLIP_STALL_SENTINEL_ROLLOUT_HOURS, 24) * HOUR,
    thresholdScale: scale,
    thresholds,
    sweepIntervalMs: Math.max(1_000, Math.round(2 * MINUTE * scale)),
    sweepTimeoutMs: 60_000,
    freshnessMs: 10 * MINUTE,
    companyTelegramCapPerHour: 6,
    groupListLimit: 5,
    failureAlertAfter: 3,
    coordinatorAgentId: env.PAPERCLIP_STALL_SENTINEL_COORDINATOR_AGENT_ID?.trim() || null,
    coordinatorAgentName: env.PAPERCLIP_STALL_SENTINEL_COORDINATOR_AGENT_NAME?.trim() || "Jarvis",
  };
}

/** `on` is alert-only until the rollout window has passed since the first sweep. */
export function resolveEffectiveMode(
  mode: StallSentinelMode,
  rolloutStartedAt: Date | null,
  rolloutMs: number,
  now: Date,
): StallSentinelMode {
  if (mode !== "on") return mode;
  if (!rolloutStartedAt) return "alert_only";
  return now.getTime() - rolloutStartedAt.getTime() >= rolloutMs ? "on" : "alert_only";
}
