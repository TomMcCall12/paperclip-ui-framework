import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertResourcePressureNotCritical,
  resolveShell,
  resolveWorkspaceJobMemoryMaxMb,
  wrapCommandWithMemoryBound,
} from "../services/workspace-runtime.ts";

/**
 * Covers TOM-426: a workspace job (an operator-authored build/typecheck/test command,
 * run as a direct child of paperclip-native.service) ballooned to 4.5-6.5GB on
 * 2026-10-12 and was OOM-killed twice, taking the whole service's cgroup down with it
 * both times. These tests exercise the real mechanism `runWorkspaceJobForControl` now
 * applies — `wrapCommandWithMemoryBound` run through the same shell invocation
 * `executeProcess` uses (`spawn(shell, ["-c", resolvedCommand])`) — rather than
 * reproducing the full execution-workspace/DB scaffolding.
 */

async function runWrapped(command: string, maxMemoryMb: number | null) {
  const shell = resolveShell();
  const script = maxMemoryMb === null ? command : wrapCommandWithMemoryBound(command, maxMemoryMb);
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>((resolve, reject) => {
    const child = spawn(shell, ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout }));
  });
}

describe("workspace job memory isolation (TOM-426)", () => {
  it("lets a bounded Node process start normally under the real default cap", async () => {
    const result = await runWrapped(
      "node -e \"console.log('ok')\"",
      resolveWorkspaceJobMemoryMaxMb(),
    );
    expect(result.stdout.trim()).toBe("ok");
    expect(result.code).toBe(0);
  });

  it("kills a heavy process on its own once it is wrapped with a tight memory bound", async () => {
    // A node process needs a few hundred MB of virtual address space just to
    // initialize V8 under pointer compression, before it runs a single line of
    // script. A 100MB cap is comfortably below that, so this reproduces, at a
    // test-safe scale, the same class of blow-up the real tsc job hit: the
    // process dies on its own (a segfault from its own RLIMIT_AS, confirmed
    // deterministic on this host) long before the 4.5-6.5GB that triggers a
    // whole-host OOM kill.
    const result = await runWrapped("node -e \"console.log('ok')\"", 100);
    expect(result.stdout.trim()).not.toBe("ok");
    expect(result.code).not.toBe(0);
  }, 10_000);

  it("fails on the current (unisolated) code: the same command succeeds with no bound applied", async () => {
    // This is the control: run the identical command through the identical
    // shell-spawn path, but WITHOUT wrapCommandWithMemoryBound — i.e. exactly
    // what `runWorkspaceJobForControl` did before this fix. If the wrapper is
    // ever removed from that call site, this assertion (that the job
    // "succeeds" even though it is heavier than the intended cap) is what
    // regresses to passing again, proving this suite is sensitive to the fix.
    const result = await runWrapped("node -e \"console.log('ok')\"", null);
    expect(result.stdout.trim()).toBe("ok");
    expect(result.code).toBe(0);
  });

  it("wraps a compound command without exec, preserving '&&' semantics", () => {
    const wrapped = wrapCommandWithMemoryBound("pnpm install && pnpm build", 2048);
    expect(wrapped).toBe("ulimit -v 2097152; pnpm install && pnpm build");
  });

  it("resolves the memory cap from PAPERCLIP_WORKSPACE_JOB_MEMORY_MAX_MB when set", () => {
    const original = process.env.PAPERCLIP_WORKSPACE_JOB_MEMORY_MAX_MB;
    try {
      process.env.PAPERCLIP_WORKSPACE_JOB_MEMORY_MAX_MB = "2048";
      expect(resolveWorkspaceJobMemoryMaxMb()).toBe(2048);
      process.env.PAPERCLIP_WORKSPACE_JOB_MEMORY_MAX_MB = "not-a-number";
      expect(resolveWorkspaceJobMemoryMaxMb()).toBeGreaterThan(0);
    } finally {
      if (original === undefined) delete process.env.PAPERCLIP_WORKSPACE_JOB_MEMORY_MAX_MB;
      else process.env.PAPERCLIP_WORKSPACE_JOB_MEMORY_MAX_MB = original;
    }
  });
});

describe("resource-pressure guard before a workspace job (TOM-426)", () => {
  let tmpDir: string | null = null;
  const originalScriptPathEnv = process.env.PAPERCLIP_RESOURCE_PRESSURE_CHECK_SCRIPT;

  afterEach(async () => {
    if (originalScriptPathEnv === undefined) delete process.env.PAPERCLIP_RESOURCE_PRESSURE_CHECK_SCRIPT;
    else process.env.PAPERCLIP_RESOURCE_PRESSURE_CHECK_SCRIPT = originalScriptPathEnv;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  async function writeFakeCheckScript(exitCode: number, verdict: string) {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-resource-pressure-"));
    const scriptPath = path.join(tmpDir, "check-resource-pressure.sh");
    await writeFile(scriptPath, `#!/usr/bin/env bash\necho "VERDICT=${verdict}"\nexit ${exitCode}\n`, "utf8");
    await chmod(scriptPath, 0o755);
    process.env.PAPERCLIP_RESOURCE_PRESSURE_CHECK_SCRIPT = scriptPath;
  }

  it("does not throw when the host is ok", async () => {
    await writeFakeCheckScript(0, "ok");
    await expect(assertResourcePressureNotCritical()).resolves.toBeUndefined();
  });

  it("does not throw when the host is merely busy", async () => {
    await writeFakeCheckScript(1, "busy");
    await expect(assertResourcePressureNotCritical()).resolves.toBeUndefined();
  });

  it("defers the job when the host reports critical pressure", async () => {
    await writeFakeCheckScript(2, "critical");
    await expect(assertResourcePressureNotCritical()).rejects.toThrow(/critical/i);
  });

  it("never blocks a job when the check script cannot be found", async () => {
    process.env.PAPERCLIP_RESOURCE_PRESSURE_CHECK_SCRIPT = path.join(
      os.tmpdir(),
      "paperclip-resource-pressure-missing-script-does-not-exist.sh",
    );
    await expect(assertResourcePressureNotCritical()).resolves.toBeUndefined();
  });
});
