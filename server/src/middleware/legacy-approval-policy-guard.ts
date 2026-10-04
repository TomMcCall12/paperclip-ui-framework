import type { RequestHandler } from "express";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH"]);
const MAX_DEPTH = 12;

export const LEGACY_APPROVAL_POLICY_MESSAGE =
  "`requiresApproval` and `protectedAgentRequiresApproval` are retired: no approval step exists behind them, " +
  "so they silently block every agent assignment. Remove them. To block assignment on purpose, set " +
  "`protectedAgent.blockAssignment: true` with a `blockReason`.";

/**
 * Paths in a JSON body that set a retired approval flag to true: an
 * authorization policy's `protectedAgent.requiresApproval` or
 * `assignmentPolicy.protectedAgentRequiresApproval`. Stored policies keep
 * their old hard-block meaning; this only stops new writes of them.
 */
export function findLegacyApprovalPolicyFlags(body: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (child !== null && typeof child === "object" && !Array.isArray(child)) {
        const record = child as Record<string, unknown>;
        if (key === "protectedAgent" && record.requiresApproval === true) found.push(`${childPath}.requiresApproval`);
        if (key === "assignmentPolicy" && record.protectedAgentRequiresApproval === true) {
          found.push(`${childPath}.protectedAgentRequiresApproval`);
        }
      }
      visit(child, childPath, depth + 1);
    }
  };
  visit(body, "", 0);
  return found;
}

/** Rejects writes that would add a retired approval flag to any authorization policy. */
export function legacyApprovalPolicyGuard(): RequestHandler {
  return (req, res, next) => {
    if (!MUTATING_METHODS.has(req.method) || req.body === null || typeof req.body !== "object") return next();
    const fields = findLegacyApprovalPolicyFlags(req.body);
    if (fields.length === 0) return next();
    res.status(422).json({
      error: LEGACY_APPROVAL_POLICY_MESSAGE,
      details: { code: "legacy_approval_policy_retired", fields },
    });
  };
}
