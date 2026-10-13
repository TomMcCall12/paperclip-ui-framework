import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { QuotaVaultCredentialResolver } from "@paperclipai/adapter-utils";

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

import { CODEX_QUOTA_EXPIRED_SIGN_IN_MESSAGE, getQuotaWindows } from "./quota.js";

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

function makeJwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

function authJsonWithToken(accessToken: string, accountId = "vault-acc"): string {
  return JSON.stringify({ tokens: { access_token: accessToken, account_id: accountId } });
}

// The quota probe used to only read on-disk auth.json files. Since the
// native cutover, a ChatGPT sign-in can instead live only in the Paperclip
// vault (saved through the Lab's own sign-in flow), with no auth.json ever
// written to either Codex home. These tests cover the fix: the probe falls
// back to a vault-supplied credential, prefers on-disk auth when present,
// detects an expired token without trying to refresh it, and never leaks
// the token value.
describe("Codex quota probe reads a vault-saved ChatGPT connection", () => {
  let previousCodexHome: string | undefined;
  let emptyCodexHome: string;
  const companyId = "company-under-test";

  beforeEach(() => {
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() =>
      createChildThatErrorsOnMicrotask(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })),
    );
    previousCodexHome = process.env.CODEX_HOME;
    emptyCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-codex-vault-test-"));
    process.env.CODEX_HOME = emptyCodexHome;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(emptyCodexHome, { recursive: true, force: true });
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  it("returns windows from the vault credential when no on-disk auth exists", async () => {
    const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const vault: QuotaVaultCredentialResolver = {
      resolveOpenAiSubscription: vi.fn(async () => ({ credential: authJsonWithToken(accessToken) })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            rate_limit: { primary_window: { used_percent: 10, reset_at: 1000 } },
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await getQuotaWindows(companyId, vault);

    expect(result.ok).toBe(true);
    expect(result.windows.length).toBeGreaterThan(0);
    expect(vault.resolveOpenAiSubscription).toHaveBeenCalledTimes(1);
  });

  it("prefers an on-disk auth.json over the vault credential", async () => {
    fs.writeFileSync(
      path.join(emptyCodexHome, "auth.json"),
      authJsonWithToken("disk-token", "disk-acc"),
      "utf8",
    );
    const vault: QuotaVaultCredentialResolver = {
      resolveOpenAiSubscription: vi.fn(async () => {
        throw new Error("vault should not be consulted when disk auth is usable");
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer disk-token");
        return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 });
      }),
    );

    const result = await getQuotaWindows(companyId, vault);

    expect(result.ok).toBe(true);
    expect(vault.resolveOpenAiSubscription).not.toHaveBeenCalled();
  });

  it("returns a clean error, without fetching or refreshing, when the vault token is expired", async () => {
    const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const vault: QuotaVaultCredentialResolver = {
      resolveOpenAiSubscription: vi.fn(async () => ({ credential: authJsonWithToken(accessToken) })),
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getQuotaWindows(companyId, vault);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(CODEX_QUOTA_EXPIRED_SIGN_IN_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never includes the vault token value in the result, even on failure", async () => {
    const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const secretMarker = `super-secret-${accessToken}`;
    const vault: QuotaVaultCredentialResolver = {
      resolveOpenAiSubscription: vi.fn(async () => ({
        credential: authJsonWithToken(secretMarker),
      })),
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));

    const result = await getQuotaWindows(companyId, vault);

    expect(JSON.stringify(result)).not.toContain(secretMarker);
  });

  it("only reads the vault credential; it never resolves to anything beyond the lookup call", async () => {
    // The resolver interface exposes no write/rotate method at all, so the
    // probe has no way to mutate the credential row — this asserts the probe
    // calls the read lookup exactly once per request and nothing else.
    const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const resolveOpenAiSubscription = vi.fn(async () => ({ credential: authJsonWithToken(accessToken) }));
    const vault: QuotaVaultCredentialResolver = { resolveOpenAiSubscription };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ rate_limit: {} }), { status: 200 })),
    );

    await getQuotaWindows(companyId, vault);

    expect(resolveOpenAiSubscription).toHaveBeenCalledTimes(1);
    expect(Object.keys(vault)).toEqual(["resolveOpenAiSubscription"]);
  });
});
