import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  startEmbeddedPostgresTestDatabase,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import {
  GIT_CREDENTIAL_TOKEN_ENV_KEY,
  GITHUB_API_KEY_CONFIG_PATH,
  createGitRemoteAuthProvider,
} from "../services/git-credentials.ts";

// A GitHub connection made with a personal access token, owned by a board user
// and installed for the company, must also serve git (workspace clone and push),
// using the run's responsible user even when the caller's context omits it.

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;
const githubUrl = "https://github.com/acme/private-repo.git";

suite("git credentials from a personal-access-token GitHub connection (real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-git-pat-");
      db = createDb(temporary.connectionString);
    }
  }, 240_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture(options: { runNamesResponsibleUser: boolean }) {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const agentId = randomUUID();
    const runId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const definitionId = randomUUID();
    const secretId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "PAT fixture", issuePrefix: `G${companyId.slice(0, 7)}` });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner",
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "claude_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: options.runNamesResponsibleUser ? userId : null });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "GitHub", type: "mcp" });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, name: "GitHub", uid: `github-${connectionId.slice(0, 8)}`,
      transport: "mcp_remote", authKind: "api_key", status: "active", enabled: true, credentialPolicy: "per_user",
      config: { url: "https://api.githubcopilot.com/mcp/", sourceTemplateKey: "github", connectionMethodKey: "mcp-key" },
    });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId, targetType: "company", targetId: companyId });
    await db.insert(userSecretDefinitions).values({ id: definitionId, companyId, key: `github-${definitionId.slice(0, 8)}`, name: "GitHub token" });
    await db.insert(companySecrets).values({
      id: secretId, companyId, key: `github-token-${secretId.slice(0, 8)}`, name: "GitHub token",
      scope: "user", ownerUserId: userId, userSecretDefinitionId: definitionId,
    });
    await db.insert(connectionGrants).values({
      companyId, connectionId, kind: "user", subjectUserId: userId, status: "active",
      credentialSecretRefs: [{ label: "GitHub token", required: true, secretId, configPath: GITHUB_API_KEY_CONFIG_PATH, versionSelector: "latest" }],
    });
    const secrets = {
      getByName: vi.fn(async () => null),
      resolveSecretValue: vi.fn(async () => ""),
      resolveUserSecretValue: vi.fn(async (_companyId: string, input: { definitionId: string; responsibleUserId: string }) =>
        input.definitionId === definitionId && input.responsibleUserId === userId ? { value: "Bearer github_pat_example" } : null),
    };
    return { companyId, userId, agentId, runId, secrets };
  }

  it("resolves the token for git, using the run's responsible user when the context lacks it", async () => {
    const f = await fixture({ runNamesResponsibleUser: true });
    const provider = createGitRemoteAuthProvider(db, f.companyId, { heartbeatRunId: f.runId, agentId: f.agentId }, {
      secrets: f.secrets as never,
      env: {},
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.source).toBe("managed_connection");
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("github_pat_example");
    expect(JSON.stringify(invocation?.configArgs)).not.toContain("github_pat_example");
  });

  it("finds no identity when neither the context nor the run names a responsible user", async () => {
    const f = await fixture({ runNamesResponsibleUser: false });
    const provider = createGitRemoteAuthProvider(db, f.companyId, { heartbeatRunId: f.runId, agentId: f.agentId }, {
      secrets: f.secrets as never,
      env: {},
    });
    await expect(provider(githubUrl)).rejects.toThrow(/No managed GitHub identity/);
  });
});
