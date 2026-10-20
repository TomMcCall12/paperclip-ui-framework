import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The bridge is a standalone, dependency-free script shipped beside its Dockerfile.
const bridgeModule = await import("../../../docker/notes-vault-bridge/server.mjs");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "notes-vault-large-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("notes vault bridge: append onto a file larger than the read/replace limit", () => {
  it("appends onto a file already over maxFileBytes, where a full read is refused", async () => {
    // A tiny read/replace limit stands in for the real ~512 KiB default, so the
    // test doesn't have to write hundreds of KB to cross it.
    const bridge = bridgeModule.createVaultBridge({ root, maxFileBytes: 100, maxAppendFileBytes: 10_000 });
    const big = "x".repeat(500) + "\n";
    await writeFile(path.join(root, "log.md"), big, "utf8");

    await expect(bridge.read("log.md")).rejects.toMatchObject({ status: 413, code: "vault_file_too_large" });

    const result = await bridge.write({ path: "log.md", mode: "append", content: "new entry", baseSha256: null, summary: "append", actor: "test" });
    expect(result.mode).toBe("append");
    expect(result.previousSha256).toBe(bridgeModule.sha256(big));
    expect(result.sha256).toBe(bridgeModule.sha256(big + "new entry"));
    expect(result.bytes).toBe(Buffer.byteLength(big + "new entry", "utf8"));

    // Still refused by the read-side limit; append does not change that.
    await expect(bridge.read("log.md")).rejects.toMatchObject({ status: 413, code: "vault_file_too_large" });
  });

  it("adds a separating newline only when the file doesn't already end with one", async () => {
    const bridge = bridgeModule.createVaultBridge({ root, maxFileBytes: 100, maxAppendFileBytes: 10_000 });
    await writeFile(path.join(root, "a.md"), "no newline at end", "utf8");
    await writeFile(path.join(root, "b.md"), "ends with one\n", "utf8");

    await bridge.write({ path: "a.md", mode: "append", content: "next", baseSha256: null, summary: "s", actor: "t" });
    await bridge.write({ path: "b.md", mode: "append", content: "next", baseSha256: null, summary: "s", actor: "t" });

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("no newline at end\nnext");
    expect(await readFile(path.join(root, "b.md"), "utf8")).toBe("ends with one\nnext");
  });

  it("still refuses to append onto a missing or non-file path", async () => {
    const bridge = bridgeModule.createVaultBridge({ root, maxFileBytes: 100, maxAppendFileBytes: 10_000 });
    await expect(bridge.write({ path: "missing.md", mode: "append", content: "x", baseSha256: null, summary: "s", actor: "t" }))
      .rejects.toMatchObject({ status: 404, code: "vault_not_found" });
  });

  it("refuses an append that would push the file past the append ceiling", async () => {
    const bridge = bridgeModule.createVaultBridge({ root, maxFileBytes: 100, maxAppendFileBytes: 20 });
    await writeFile(path.join(root, "log.md"), "0123456789", "utf8");
    await expect(bridge.write({ path: "log.md", mode: "append", content: "0123456789 more than fits", baseSha256: null, summary: "s", actor: "t" }))
      .rejects.toMatchObject({ status: 413, code: "vault_file_too_large" });
  });
});

describe("notes vault bridge: contains, a cheap check that never reads a whole large file", () => {
  it("finds a marker anywhere in a file larger than the read limit, including across a chunk boundary", async () => {
    const bridge = bridgeModule.createVaultBridge({ root, maxFileBytes: 10 });
    const marker = "plated-vault-sync: commit:24169283be42da84bb7a29ab598d2cd3f4893c62";
    // Pad past a couple of the bridge's internal 64 KiB read chunks, with the
    // marker straddling a chunk boundary, to prove the carry-over logic works.
    const padBefore = "a".repeat(64 * 1024 - 10);
    const padAfter = "b".repeat(64 * 1024);
    await writeFile(path.join(root, "log.md"), padBefore + marker + padAfter, "utf8");

    expect(await bridge.contains("log.md", marker)).toEqual({ path: "log.md", found: true });
    expect(await bridge.contains("log.md", "not present anywhere")).toEqual({ path: "log.md", found: false });
  });

  it("404s for a missing file and 400s for an empty needle", async () => {
    const bridge = bridgeModule.createVaultBridge({ root });
    await expect(bridge.contains("missing.md", "x")).rejects.toMatchObject({ status: 404, code: "vault_not_found" });
    await writeFile(path.join(root, "a.md"), "hi", "utf8");
    await expect(bridge.contains("a.md", "")).rejects.toMatchObject({ status: 400, code: "vault_needle_invalid" });
  });
});
