import fs from "node:fs/promises";
import path from "node:path";
import { codexHomeHasUsableAuth } from "@paperclipai/adapter-codex-local/server";
import { and, eq } from "drizzle-orm";
import { type Db, aiProviderDefaults } from "@paperclipai/db";
import {
  aiConnectionMetadataSchema,
  aiSubscriptionNeedsIsolatedLogin,
} from "@paperclipai/shared";
import type { QuotaVaultCredentialResolver } from "@paperclipai/adapter-utils";
import { aiConnectionService } from "./ai-connections.js";

/**
 * Builds the lookup a quota probe uses to read a company's AI-connection
 * credential without the provider adapter package depending on the
 * database. Resolution reuses `aiConnectionService`'s own rows/credential
 * helpers — the same tables and decryption path a real agent run goes
 * through — rather than a second, parallel way of reading the vault.
 *
 * Preference order: a grant that is some user's saved default for this
 * provider, then any other active, connected subscription grant. Only ever
 * reads the stored secret; never rotates or writes anything back.
 */
export function createQuotaVaultCredentialResolver(db: Db): QuotaVaultCredentialResolver {
  const connections = aiConnectionService(db);
  return {
    async resolveOpenAiSubscription(companyId: string) {
      const candidates = (await connections.rows(companyId)).filter(({ connection, grant }) => {
        const metadata = aiConnectionMetadataSchema.safeParse(connection.config.ai);
        if (!metadata.success) return false;
        if (metadata.data.provider !== "openai" || metadata.data.method !== "subscription") return false;
        if (aiSubscriptionNeedsIsolatedLogin(connection.config)) return false;
        return (
          grant.status === "active" &&
          connection.enabled &&
          connection.status === "active" &&
          connection.healthStatus === "ok"
        );
      });
      if (candidates.length === 0) return null;

      const defaults = await db
        .select()
        .from(aiProviderDefaults)
        .where(
          and(
            eq(aiProviderDefaults.companyId, companyId),
            eq(aiProviderDefaults.provider, "openai"),
          ),
        );
      const defaultGrantIds = new Set(defaults.map((d) => d.grantId));
      const preferred =
        candidates.find(({ grant }) => defaultGrantIds.has(grant.id)) ?? candidates[0]!;

      try {
        const credential = await connections.credential(preferred);
        return { credential };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Materializes the company's vault OpenAI subscription credential into the
 * managed Codex home's `auth.json` so the `codex` CLI (which needs a real file)
 * and the readiness gate that predicts it can both find it. Fires only when
 * neither the managed home nor the shared host home already holds usable auth,
 * so a promoted device login or host login always wins. The stored token pair
 * is copied as-is: never refreshed or written back, Codex rotates it from here.
 * Returns true when a file was written.
 */
export async function seedManagedCodexHomeFromVault(
  resolver: QuotaVaultCredentialResolver,
  input: { companyId: string; managedHome: string; sharedHome: string },
): Promise<boolean> {
  if (
    (await codexHomeHasUsableAuth(input.managedHome)) ||
    (await codexHomeHasUsableAuth(input.sharedHome))
  ) {
    return false;
  }
  const vault = await resolver.resolveOpenAiSubscription(input.companyId);
  if (!vault) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(vault.credential);
  } catch {
    return false;
  }
  const tokens = (parsed as { tokens?: Record<string, unknown> } | null)?.tokens;
  if (!tokens || typeof tokens.access_token !== "string" || typeof tokens.account_id !== "string") {
    return false;
  }
  await fs.mkdir(input.managedHome, { recursive: true });
  const authPath = path.join(input.managedHome, "auth.json");
  const tmpPath = `${authPath}.${process.pid}.tmp`;
  await fs.rm(authPath, { force: true }); // clear a dangling symlink
  await fs.writeFile(tmpPath, vault.credential, { mode: 0o600 });
  await fs.rename(tmpPath, authPath);
  return true;
}
