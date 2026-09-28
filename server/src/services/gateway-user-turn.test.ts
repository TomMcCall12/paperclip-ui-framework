import { describe, expect, it } from "vitest";
import { queuedMessageWaitRequiresAction } from "@paperclipai/shared";
import {
  RECONCILIATION_REQUIRED_WAIT,
  gatewayUserTurnDenial,
  isGatewayUserTurnAdapter,
} from "./gateway-user-turn.js";

const finishedAt = new Date("2026-09-20T10:00:00Z");
const terminalGatewayRun = {
  runtimeMode: "legacy",
  status: "cancelled",
  finishedAt,
  resultJson: null,
};

describe("gateway user-turn continuation gate", () => {
  it("admits only the Hermes gateway, never arbitrary process or webhook adapters", () => {
    expect(isGatewayUserTurnAdapter("hermes_gateway")).toBe(true);
    for (const adapterType of ["process", "http", "openclaw_gateway", "hermes_local", "claude_local", null, undefined]) {
      expect(isGatewayUserTurnAdapter(adapterType)).toBe(false);
    }
  });

  it("accepts a fresh user turn after a terminal legacy gateway run with matching immutable evidence", () => {
    for (const status of ["succeeded", "cancelled", "failed", "timed_out", "interrupted"]) {
      expect(gatewayUserTurnDenial({
        agentAdapterType: "hermes_gateway", historicalAdapterType: "hermes_gateway", retry: false,
        run: { ...terminalGatewayRun, status },
      })).toBeNull();
    }
  });

  it("keeps the hold when the historical adapter evidence is missing", () => {
    expect(gatewayUserTurnDenial({
      agentAdapterType: "hermes_gateway", historicalAdapterType: null, retry: false, run: terminalGatewayRun,
    })).toMatchObject({ reason: "adapter_evidence_missing" });
  });

  it("does not let a current adapter setting convert a different historical execution", () => {
    expect(gatewayUserTurnDenial({
      agentAdapterType: "hermes_gateway", historicalAdapterType: "process", retry: false, run: terminalGatewayRun,
    })).toMatchObject({ reason: "adapter_changed" });
  });

  it("never retries the previous gateway request", () => {
    expect(gatewayUserTurnDenial({
      agentAdapterType: "hermes_gateway", historicalAdapterType: "hermes_gateway", retry: true, run: terminalGatewayRun,
    })).toMatchObject({ reason: "retry_unavailable" });
  });

  it("requires a finished legacy run", () => {
    expect(gatewayUserTurnDenial({
      agentAdapterType: "hermes_gateway", historicalAdapterType: "hermes_gateway", retry: false,
      run: { ...terminalGatewayRun, status: "running", finishedAt: null },
    })).toMatchObject({ reason: "source_unavailable" });
    expect(gatewayUserTurnDenial({
      agentAdapterType: "hermes_gateway", historicalAdapterType: "hermes_gateway", retry: false,
      run: { ...terminalGatewayRun, runtimeMode: "native" },
    })).toMatchObject({ reason: "source_unavailable" });
  });

  it("keeps an unsafe workspace restore on its repair path", () => {
    expect(gatewayUserTurnDenial({
      agentAdapterType: "hermes_gateway", historicalAdapterType: "hermes_gateway", retry: false,
      run: { ...terminalGatewayRun, resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } },
    })).toMatchObject({ reason: "workspace_repair_required" });
  });

  it("describes every manual hold as an explicit action, not as automatic progress", () => {
    expect(RECONCILIATION_REQUIRED_WAIT.reason).toBe("execution_reconciliation_required");
    expect(RECONCILIATION_REQUIRED_WAIT.message).not.toMatch(/will start automatically/i);
    expect(RECONCILIATION_REQUIRED_WAIT.message).toMatch(/discard/i);
    for (const reason of ["execution_reconciliation_required", "adapter_evidence_missing", "adapter_changed", "retry_unavailable", "workspace_repair_required"]) {
      expect(queuedMessageWaitRequiresAction(reason)).toBe(true);
    }
    for (const reason of ["remote_cleanup", "process_running", "execution_active", "execution_settling"]) {
      expect(queuedMessageWaitRequiresAction(reason)).toBe(false);
    }
  });
});
