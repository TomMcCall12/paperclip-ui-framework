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
