import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { findLegacyApprovalPolicyFlags, legacyApprovalPolicyGuard } from "../middleware/legacy-approval-policy-guard.js";

describe("findLegacyApprovalPolicyFlags", () => {
  it("finds retired approval flags set to true anywhere in a body", () => {
    expect(findLegacyApprovalPolicyFlags({
      executionWorkspacePolicy: {
        enabled: true,
        authorizationPolicy: {
          protectedAgent: { requiresApproval: true, approvalReason: "x" },
          assignmentPolicy: { mode: "protected", protectedAgentRequiresApproval: true },
        },
      },
    })).toEqual([
      "executionWorkspacePolicy.authorizationPolicy.protectedAgent.requiresApproval",
      "executionWorkspacePolicy.authorizationPolicy.assignmentPolicy.protectedAgentRequiresApproval",
    ]);
  });

  it("ignores false flags, the supported block, and unrelated keys", () => {
    expect(findLegacyApprovalPolicyFlags({
      permissions: {
        authorizationPolicy: {
          protectedAgent: { requiresApproval: false, blockAssignment: true, blockReason: "Prod" },
          assignmentPolicy: { protectedAgentRequiresApproval: false },
        },
      },
      requiresApproval: true,
      description: "protectedAgent requiresApproval true",
    })).toEqual([]);
  });
});

describe("legacyApprovalPolicyGuard", () => {
  const app = express();
  app.use(express.json());
  app.use(legacyApprovalPolicyGuard());
  app.use((_req, res) => res.json({ ok: true }));

  it("rejects writes that add a retired flag", async () => {
    const res = await request(app).patch("/projects/p1")
      .send({ executionWorkspacePolicy: { enabled: true, authorizationPolicy: { protectedAgent: { requiresApproval: true } } } });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({
      code: "legacy_approval_policy_retired",
      fields: ["executionWorkspacePolicy.authorizationPolicy.protectedAgent.requiresApproval"],
    });
    expect(res.body.error).toContain("blockAssignment");
  });

  it("lets other writes and all reads through", async () => {
    expect((await request(app).patch("/projects/p1").send({ executionWorkspacePolicy: { enabled: true } })).status).toBe(200);
    expect((await request(app).get("/projects/p1")).status).toBe(200);
  });
});
