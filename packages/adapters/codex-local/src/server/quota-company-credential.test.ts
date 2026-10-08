import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof cp.spawn>) => mockSpawn(...args) as ReturnType<typeof cp.spawn>,
  };
});

import { getQuotaWindows, readCodexToken, resolveQuotaCodexHome } from "./quota.js";

function createChildThatErrorsOnMicrotask(err: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stream = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  Object.assign(child, {
    stdout: stream,
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stdin: { write: vi.fn(), end: vi.fn() },
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    child.emit("error", err);
  });
  return child;
}

// Real Codex agent runs authenticate from a company-scoped managed Codex
// home (packages/adapters/codex-local/src/server/codex-home.ts:
// resolveManagedCodexHomeDir), falling back to the shared host-login home
// only when the company has no credential of its own. The quota probe used
// to check only the shared host-login home, so it reported "no local codex
// auth token" even while Codex agent runs for that company authenticated
// fine. These tests cover the fix: the probe must check the same homes, in
// the same order, as a real run.
describe("Codex quota probe reads the credential real agent runs use", () => {
  let previousPaperclipHome: string | undefined;
  let previousCodexHome: string | undefined;
  let paperclipHome: string;
  let sharedCodexHome: string;
  const companyId = "company-under-test";

  beforeEach(() => {
    mockSpawn.mockReset();
    previousPaperclipHome = process.env.PAPERCLIP_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    paperclipHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-home-test-"));
    sharedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-shared-codex-home-test-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.CODEX_HOME = sharedCodexHome;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(paperclipHome, { recursive: true, force: true });
    fs.rmSync(sharedCodexHome, { recursive: true, force: true });
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  function managedHomeFor(company: string): string {
    return path.join(paperclipHome, "instances", "default", "companies", company, "codex-home");
  }

  it("falls back to the shared host-login home when the company has no managed credential", async () => {
    fs.writeFileSync(
      path.join(sharedCodexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "shared-token", account_id: "shared-acc" } }),
      "utf8",
    );

    const home = await resolveQuotaCodexHome(companyId);
    expect(home).toBe(sharedCodexHome);

    const token = await readCodexToken(companyId);
    expect(token).toEqual({ token: "shared-token", accountId: "shared-acc" });
  });

  it("prefers the company's own managed credential over the shared host-login home", async () => {
    const managedHome = managedHomeFor(companyId);
    fs.mkdirSync(managedHome, { recursive: true });
    fs.writeFileSync(
      path.join(managedHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "company-token", account_id: "company-acc" } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(sharedCodexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "shared-token", account_id: "shared-acc" } }),
      "utf8",
    );

    const home = await resolveQuotaCodexHome(companyId);
    expect(home).toBe(managedHome);

    const token = await readCodexToken(companyId);
    expect(token).toEqual({ token: "company-token", accountId: "company-acc" });
  });

  it("points the app-server RPC spawn at the resolved company credential, not the server process's own CODEX_HOME", async () => {
    const managedHome = managedHomeFor(companyId);
    fs.mkdirSync(managedHome, { recursive: true });
    fs.writeFileSync(
      path.join(managedHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "company-token", account_id: "company-acc" } }),
      "utf8",
    );
    mockSpawn.mockImplementation(() =>
      createChildThatErrorsOnMicrotask(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })),
    );

    await getQuotaWindows(companyId);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, , spawnOptions] = mockSpawn.mock.calls[0]!;
    expect((spawnOptions as { env: NodeJS.ProcessEnv }).env.CODEX_HOME).toBe(managedHome);
  });

  it("does not log or return the credential token", async () => {
    const managedHome = managedHomeFor(companyId);
    fs.mkdirSync(managedHome, { recursive: true });
    fs.writeFileSync(
      path.join(managedHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "super-secret-token", account_id: "company-acc" } }),
      "utf8",
    );
    mockSpawn.mockImplementation(() =>
      createChildThatErrorsOnMicrotask(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })),
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));

    const result = await getQuotaWindows(companyId);

    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });
});
