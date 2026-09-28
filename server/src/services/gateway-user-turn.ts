const GATEWAY_ADAPTER = "hermes_gateway";
const TERMINAL_STATUSES = new Set([
  "succeeded",
  "cancelled",
  "failed",
  "timed_out",
  "interrupted",
]);

export const RECONCILIATION_REQUIRED_WAIT = {
  reason: "execution_reconciliation_required",
  message:
    "The previous run stopped and needs reconciliation before this message can start. Your message is saved. Nothing is running for this message. Discard it or reconcile the task before continuing.",
} as const;

type GatewayUserTurnInput = {
  agentAdapterType: string | null | undefined;
  historicalAdapterType: string | null | undefined;
  retry: boolean;
  run: {
    runtimeMode: string | null | undefined;
    status: string | null | undefined;
    finishedAt: Date | null | undefined;
    resultJson: unknown;
  };
};

export function isGatewayUserTurnAdapter(
  adapterType: string | null | undefined,
): boolean {
  return adapterType === GATEWAY_ADAPTER;
}

export function gatewayUserTurnDenial(input: GatewayUserTurnInput): {
  reason: string;
  message: string;
} | null {
  if (!isGatewayUserTurnAdapter(input.agentAdapterType)) {
    return {
      reason: "adapter_unsupported",
      message: RECONCILIATION_REQUIRED_WAIT.message,
    };
  }
  if (input.retry) {
    return {
      reason: "retry_unavailable",
      message:
        "Retrying the previous Hermes Gateway request is disabled. Send a new message to start a fresh turn.",
    };
  }
  if (!input.historicalAdapterType) {
    return {
      reason: "adapter_evidence_missing",
      message:
        "The previous run has no verified adapter identity. Discard this message or reconcile the task before continuing.",
    };
  }
  if (!isGatewayUserTurnAdapter(input.historicalAdapterType)) {
    return {
      reason: "adapter_changed",
      message:
        "The previous run used a different adapter. Paperclip will not convert it into a Hermes Gateway continuation.",
    };
  }
  if (
    input.run.runtimeMode !== "legacy" ||
    !TERMINAL_STATUSES.has(input.run.status ?? "") ||
    !input.run.finishedAt
  ) {
    return {
      reason: "source_unavailable",
      message:
        "The previous execution has not finished as a legacy Hermes Gateway run. Discard this message or wait for reconciliation.",
    };
  }
  const resultJson = input.run.resultJson;
  if (
    resultJson &&
    typeof resultJson === "object" &&
    !Array.isArray(resultJson) &&
    (resultJson as Record<string, unknown>).workspaceRestoreFailure ===
      "restore_unsafe_archive"
  ) {
    return {
      reason: "workspace_repair_required",
      message:
        "The previous workspace requires repair before this message can start. Discard this message or repair the workspace first.",
    };
  }
  return null;
}
