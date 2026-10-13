import type { ProviderQuotaResult, ProviderQuotaSummary } from "@paperclipai/shared";
import type { QuotaVaultCredentialResolver } from "@paperclipai/adapter-utils";
import { listServerAdapters } from "../adapters/registry.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 */
export async function fetchAllQuotaWindows(
  companyId?: string,
  vault?: QuotaVaultCredentialResolver,
): Promise<ProviderQuotaResult[]> {
  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const settled = await Promise.allSettled(
    adapters.map((adapter) =>
      withQuotaTimeout(adapter.type, adapter.getQuotaWindows!(companyId, vault)),
    ),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const adapterType = adapters[i]!.type;
    return {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
  });
}

/**
 * Reduces the full quota-windows results to the compact, agent-readable shape:
 * provider, ok/error, and each window's percent used/left and reset time.
 * Deliberately drops `source`, `errorFamily`, `valueLabel`, and `detail` —
 * those can carry provider-account identifiers or free-form text, and the
 * agent-facing summary only needs enough to pick a provider by headroom.
 */
export function summarizeQuotaWindows(results: ProviderQuotaResult[]): ProviderQuotaSummary[] {
  return results.map((result) => ({
    provider: result.provider,
    ok: result.ok,
    ...(result.error != null ? { error: result.error } : {}),
    windows: result.windows.map((w) => ({
      label: w.label,
      usedPercent: w.usedPercent,
      percentLeft: w.usedPercent == null ? null : Math.max(0, 100 - w.usedPercent),
      resetsAt: w.resetsAt,
    })),
  }));
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
