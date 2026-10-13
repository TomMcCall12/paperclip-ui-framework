import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { shouldConfiguredCwdDisplaceAgentHome } from "../server-utils.js";

describe("shouldConfiguredCwdDisplaceAgentHome", () => {
  let tmpRoot = "";
  let workspaceCwd = "";

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "configured-cwd-"));
    workspaceCwd = path.join(tmpRoot, "agent-home");
    await fs.mkdir(workspaceCwd, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("keeps the resolved workspace when the configured cwd cannot be created", async () => {
    // A file where a directory component must be: mkdir -p fails with ENOTDIR,
    // the portable stand-in for the read-only host root that produced this bug.
    const blocker = path.join(tmpRoot, "blocker");
    await fs.writeFile(blocker, "not a directory");
    const warnings: string[] = [];

    const result = await shouldConfiguredCwdDisplaceAgentHome({
      workspaceSource: "agent_home",
      workspaceCwd,
      configuredCwd: path.join(blocker, "app"),
      onWarn: (message) => {
        warnings.push(message);
      },
    });

    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("is unusable on this host");
    expect(warnings[0]).toContain(workspaceCwd);
  });

  it("honours a configured cwd that already exists", async () => {
    const configuredCwd = path.join(tmpRoot, "configured");
    await fs.mkdir(configuredCwd, { recursive: true });

    await expect(shouldConfiguredCwdDisplaceAgentHome({
      workspaceSource: "agent_home",
      workspaceCwd,
      configuredCwd,
    })).resolves.toBe(true);
  });

  it("honours a configured cwd that does not exist yet but can be created", async () => {
    const configuredCwd = path.join(tmpRoot, "created", "on", "demand");

    await expect(shouldConfiguredCwdDisplaceAgentHome({
      workspaceSource: "agent_home",
      workspaceCwd,
      configuredCwd,
    })).resolves.toBe(true);
    await expect(fs.stat(configuredCwd).then((stats) => stats.isDirectory())).resolves.toBe(true);
  });

  it("does not probe when there is no resolved workspace to fall back to", async () => {
    let probes = 0;

    await expect(shouldConfiguredCwdDisplaceAgentHome({
      workspaceSource: "agent_home",
      workspaceCwd: "",
      configuredCwd: "/app",
      ensureDirectory: async () => {
        probes += 1;
      },
    })).resolves.toBe(true);
    expect(probes).toBe(0);
  });

  it("ignores the configured cwd when the workspace did not come from agent home", async () => {
    let probes = 0;

    await expect(shouldConfiguredCwdDisplaceAgentHome({
      workspaceSource: "project_primary",
      workspaceCwd,
      configuredCwd: "/app",
      ensureDirectory: async () => {
        probes += 1;
      },
    })).resolves.toBe(false);
    expect(probes).toBe(0);
  });

  it("ignores an empty configured cwd", async () => {
    await expect(shouldConfiguredCwdDisplaceAgentHome({
      workspaceSource: "agent_home",
      workspaceCwd,
      configuredCwd: "",
    })).resolves.toBe(false);
  });
});
