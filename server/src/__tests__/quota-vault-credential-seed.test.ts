import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateCodexCredentialReadiness } from "@paperclipai/adapter-codex-local/server";
import { seedManagedCodexHomeFromVault } from "../services/quota-vault-credential.js";

const credential = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: "a", refresh_token: "r", id_token: "i", account_id: "acct" },
});

describe("seedManagedCodexHomeFromVault", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-seed-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("makes a vault-only company ready and writes auth.json as-is", async () => {
    const env = { PAPERCLIP_HOME: root, PAPERCLIP_INSTANCE_ID: "t", CODEX_HOME: path.join(root, "host") } as NodeJS.ProcessEnv;
    const before = await evaluateCodexCredentialReadiness({ env, companyId: "c1", configuredCodexHome: null, configuredApiKey: null });
    expect(before.ready).toBe(false);
    const wrote = await seedManagedCodexHomeFromVault(
      { resolveOpenAiSubscription: async () => ({ credential }) },
      { companyId: "c1", managedHome: before.effectiveHome, sharedHome: before.sharedSourceHome },
    );
    expect(wrote).toBe(true);
    expect(await fs.readFile(path.join(before.effectiveHome, "auth.json"), "utf8")).toBe(credential);
    const after = await evaluateCodexCredentialReadiness({ env, companyId: "c1", configuredCodexHome: null, configuredApiKey: null });
    expect(after.ready).toBe(true);
  });

  it("does not overwrite existing on-disk auth or fire without a vault credential", async () => {
    const managed = path.join(root, "m");
    const shared = path.join(root, "s");
    await fs.mkdir(managed, { recursive: true });
    await fs.writeFile(path.join(managed, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "k" }));
    const resolver = { resolveOpenAiSubscription: async () => ({ credential }) };
    expect(await seedManagedCodexHomeFromVault(resolver, { companyId: "c", managedHome: managed, sharedHome: shared })).toBe(false);
    const empty = path.join(root, "e");
    expect(
      await seedManagedCodexHomeFromVault({ resolveOpenAiSubscription: async () => null }, { companyId: "c", managedHome: empty, sharedHome: shared }),
    ).toBe(false);
    await expect(fs.access(path.join(empty, "auth.json"))).rejects.toThrow();
  });
});
