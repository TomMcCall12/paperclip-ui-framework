import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The bridge is a standalone, dependency-free script shipped beside its Dockerfile.
const bridgeModule = await import("../../../docker/notes-vault-bridge/server.mjs");

type RunResult = { code: number | null; output: string };

let vaultRoot: string;
let stateDir: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), "vault-sync-root-"));
  stateDir = await mkdtemp(path.join(tmpdir(), "vault-sync-state-"));
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

function fakeRclone(results: RunResult[]) {
  const calls: string[][] = [];
  const run = vi.fn(async (_command: string, args: string[]) => {
    calls.push(args);
    return results.shift() ?? { code: 0, output: "" };
  });
  return { run, calls };
}

describe("notes vault bridge sync", () => {
  it("builds a two-way bisync that keeps both sides of a conflict", () => {
    const args: string[] = bridgeModule.bisyncArgs({
      root: "/vault",
      remote: "gdrive:Tom's Vault",
      config: "/sync/rclone.conf",
      stateDir: "/sync",
    });
    expect(args.slice(0, 3)).toEqual(["bisync", "/vault", "gdrive:Tom's Vault"]);
    expect(args).toEqual(expect.arrayContaining(["--conflict-resolve", "newer", "--conflict-loser", "num", "--suffix-keep-extension"]));
    expect(args).toEqual(expect.arrayContaining(["--config", "/sync/rclone.conf", "--workdir", "/sync/bisync"]));
    expect(args).not.toContain("--resync");
    expect(bridgeModule.bisyncArgs({ root: "/vault", remote: "r:v", stateDir: "/sync", resync: true })).toEqual(
      expect.arrayContaining(["--resync", "--resync-mode", "newer"]),
    );
  });

  it("merges both sides on the first run, then syncs normally", async () => {
    const { run, calls } = fakeRclone([{ code: 0, output: "" }, { code: 0, output: "" }]);
    const sync = bridgeModule.createVaultSync({ root: vaultRoot, remote: "r:v", stateDir, run });

    const first = await sync.runOnce();
    expect(calls[0]).toContain("--resync");
    expect(first).toMatchObject({ enabled: true, lastOk: true, lastError: null, consecutiveFailures: 0 });

    // rclone leaves its listings in the work folder after a successful run.
    await writeFile(path.join(stateDir, "bisync", "vault..r_v.path1.lst"), "");
    await sync.runOnce();
    expect(calls[1]).not.toContain("--resync");
    sync.stop();
  });

  it("recovers with a merge when bisync asks for a resync", async () => {
    await mkdir(path.join(stateDir, "bisync"), { recursive: true });
    await writeFile(path.join(stateDir, "bisync", "vault..r_v.path1.lst"), "");
    const { run, calls } = fakeRclone([
      { code: 2, output: "ERROR : Bisync critical error: cannot find prior listings. Must run --resync to recover." },
      { code: 0, output: "" },
    ]);
    const sync = bridgeModule.createVaultSync({ root: vaultRoot, remote: "r:v", stateDir, run });

    const status = await sync.runOnce();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--resync");
    expect(status.lastOk).toBe(true);
    sync.stop();
  });

  it("reports a failed run without retrying a safety abort", async () => {
    await mkdir(path.join(stateDir, "bisync"), { recursive: true });
    await writeFile(path.join(stateDir, "bisync", "vault..r_v.path1.lst"), "");
    const { run, calls } = fakeRclone([
      { code: 7, output: "NOTICE: something\nERROR : Safety abort: too many deletes (>50%, 120 of 240) on Path1. Run with --force if desired." },
    ]);
    const sync = bridgeModule.createVaultSync({ root: vaultRoot, remote: "r:v", stateDir, run });

    const status = await sync.runOnce();
    expect(calls).toHaveLength(1);
    expect(status.lastOk).toBe(false);
    expect(status.lastError).toContain("Safety abort");
    expect(status.consecutiveFailures).toBe(1);
    sync.stop();
  });

  it("serves sync status and asks for a sync after each write", async () => {
    const requestSoon = vi.fn();
    const status = vi.fn(() => ({ enabled: true, lastOk: true }));
    const server = bridgeModule.createVaultBridgeServer({
      root: vaultRoot,
      token: "t".repeat(32),
      sync: { requestSoon, status },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (route: string, body: unknown) =>
      fetch(`${base}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${"t".repeat(32)}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      expect(await (await post("/sync/status", {})).json()).toEqual({ enabled: true, lastOk: true });

      const written = await post("/write", { path: "note.md", mode: "create", content: "hi", summary: "test", actor: "test" });
      expect(written.status).toBe(200);
      expect(requestSoon).toHaveBeenCalledTimes(1);

      const queued = await post("/sync/run", {});
      expect(queued.status).toBe(202);
      expect(requestSoon).toHaveBeenLastCalledWith(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("says sync is off when no remote is set up", async () => {
    const server = bridgeModule.createVaultBridgeServer({ root: vaultRoot, token: "t".repeat(32) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { authorization: `Bearer ${"t".repeat(32)}`, "content-type": "application/json" };
    try {
      const res = await fetch(`${base}/sync/status`, { method: "POST", headers, body: "{}" });
      expect(await res.json()).toEqual({ enabled: false });
      const run = await fetch(`${base}/sync/run`, { method: "POST", headers, body: "{}" });
      expect(run.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
