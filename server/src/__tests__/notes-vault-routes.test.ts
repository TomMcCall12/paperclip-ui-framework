import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

const { notesVaultRoutes } = await import("../routes/notes-vault.js");
const { errorHandler } = await import("../middleware/index.js");
const { readNotesVaultConfig, notesVaultAccessFor } = await import("../services/notes-vault.js");
// The bridge is a standalone, dependency-free script shipped beside its Dockerfile.
const bridgeModule = await import("../../../docker/notes-vault-bridge/server.mjs");

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const WRITER = "33333333-3333-4333-8333-333333333333";
const READER = "44444444-4444-4444-8444-444444444444";
const STRANGER = "55555555-5555-4555-8555-555555555555";
const TOKEN = "test-bridge-token-0123456789abcdef";

const fakeDb = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([{ name: "Jarvis" }]) }) }),
} as any;

let root: string;
let bridgeServer: ReturnType<typeof bridgeModule.createVaultBridgeServer>;
let bridgeUrl: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "notes-vault-"));
  bridgeServer = bridgeModule.createVaultBridgeServer({ root, token: TOKEN, now: () => new Date("2026-10-04T12:00:00Z") });
  await new Promise<void>((resolve) => bridgeServer.listen(0, "127.0.0.1", () => resolve()));
  bridgeUrl = `http://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => bridgeServer.close(resolve));
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  mockLogActivity.mockReset();
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "03 Projects"), { recursive: true });
  await mkdir(path.join(root, ".obsidian"), { recursive: true });
  await writeFile(path.join(root, "03 Projects", "Plan.md"), "# Plan\n", "utf8");
  await writeFile(path.join(root, "vault-changelog.md"), "| Date | Files | Change | By |\n|---|---|---|---|\n", "utf8");
});

function config() {
  return readNotesVaultConfig({
    PAPERCLIP_NOTES_VAULT_BRIDGE_URL: bridgeUrl,
    PAPERCLIP_NOTES_VAULT_BRIDGE_TOKEN: TOKEN,
    PAPERCLIP_NOTES_VAULT_COMPANY_ID: COMPANY,
    PAPERCLIP_NOTES_VAULT_WRITER_AGENT_IDS: WRITER,
    PAPERCLIP_NOTES_VAULT_READER_AGENT_IDS: READER,
  });
}

function app(actor: Record<string, unknown>) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  instance.use("/api", notesVaultRoutes(fakeDb, { config: config() }));
  instance.use(errorHandler);
  return instance;
}

const agent = (agentId: string, companyId = COMPANY) => ({ type: "agent", agentId, companyId, source: "agent_jwt", runId: null });
const board = { type: "board", userId: "board-user", companyIds: [COMPANY], source: "session", isInstanceAdmin: false };

describe("notes vault configuration", () => {
  it("is off unless the bridge, token and company are all set", () => {
    expect(readNotesVaultConfig({})).toBeNull();
    expect(readNotesVaultConfig({ PAPERCLIP_NOTES_VAULT_BRIDGE_URL: "http://x", PAPERCLIP_NOTES_VAULT_BRIDGE_TOKEN: TOKEN })).toBeNull();
  });

  it("defaults the AI prefix, lets an empty value disable it, and treats writers as readers", () => {
    const base = { PAPERCLIP_NOTES_VAULT_BRIDGE_URL: "http://x/", PAPERCLIP_NOTES_VAULT_BRIDGE_TOKEN: TOKEN, PAPERCLIP_NOTES_VAULT_COMPANY_ID: COMPANY };
    expect(readNotesVaultConfig(base)).toMatchObject({ aiFilePrefix: "(C) ", bridgeUrl: "http://x", changelogPath: "vault-changelog.md" });
    expect(readNotesVaultConfig({ ...base, PAPERCLIP_NOTES_VAULT_AI_FILE_PREFIX: "" })?.aiFilePrefix).toBeNull();
    const configured = readNotesVaultConfig({ ...base, PAPERCLIP_NOTES_VAULT_WRITER_AGENT_IDS: ` ${WRITER} ,` });
    expect(notesVaultAccessFor(configured, COMPANY, { type: "agent", agentId: WRITER })).toBe("write");
    expect(notesVaultAccessFor(configured, COMPANY, { type: "agent", agentId: STRANGER })).toBe("none");
    expect(notesVaultAccessFor(configured, OTHER_COMPANY, { type: "board" })).toBe("none");
  });
});

describe("notes vault routes with a real bridge", () => {
  it("reports each actor's access", async () => {
    expect((await request(app(agent(WRITER))).get(`/api/companies/${COMPANY}/notes-vault`)).body)
      .toEqual({ enabled: true, access: "write", aiFilePrefix: "(C) ", changelogPath: "vault-changelog.md" });
    expect((await request(app(agent(READER))).get(`/api/companies/${COMPANY}/notes-vault`)).body.access).toBe("read");
    expect((await request(app(agent(STRANGER))).get(`/api/companies/${COMPANY}/notes-vault`)).body)
      .toEqual({ enabled: false, access: "none", aiFilePrefix: null, changelogPath: null });
  });

  it("hides the vault from agents without access and from other companies", async () => {
    expect((await request(app(agent(STRANGER))).get(`/api/companies/${COMPANY}/notes-vault/file`).query({ path: "03 Projects/Plan.md" })).status).toBe(404);
    expect((await request(app(agent(WRITER, OTHER_COMPANY))).get(`/api/companies/${COMPANY}/notes-vault/list`)).status).toBe(403);
  });

  it("lists folders without hidden entries and reads files with a hash", async () => {
    const listing = await request(app(agent(READER))).get(`/api/companies/${COMPANY}/notes-vault/list`);
    expect(listing.status).toBe(200);
    expect(listing.body.entries.map((entry: { name: string }) => entry.name)).toEqual(["03 Projects", "vault-changelog.md"]);
    const file = await request(app(agent(READER))).get(`/api/companies/${COMPANY}/notes-vault/file`).query({ path: "03 Projects/Plan.md" });
    expect(file.body).toMatchObject({ content: "# Plan\n", sha256: bridgeModule.sha256("# Plan\n") });
  });

  it("lets readers read but not write", async () => {
    const res = await request(app(agent(READER))).post(`/api/companies/${COMPANY}/notes-vault/file`)
      .send({ path: "03 Projects/(C) Note.md", mode: "create", content: "x", summary: "test" });
    expect(res.status).toBe(403);
    expect(res.body.details?.code ?? res.body.code).toBe("notes_vault_read_only");
  });

  it("creates an AI file, logs activity and appends one changelog row", async () => {
    const res = await request(app(agent(WRITER))).post(`/api/companies/${COMPANY}/notes-vault/file`)
      .send({ path: "03 Projects/(C) Weekly review.md", mode: "create", content: "# Review\n", summary: "Weekly review | draft" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "create", previousSha256: null, sha256: bridgeModule.sha256("# Review\n") });
    expect(await readFile(path.join(root, "03 Projects", "(C) Weekly review.md"), "utf8")).toBe("# Review\n");
    const changelog = await readFile(path.join(root, "vault-changelog.md"), "utf8");
    expect(changelog.trimEnd().split("\n").pop())
      .toBe("| 2026-10-04 | 03 Projects/(C) Weekly review.md | Weekly review \\| draft | Jarvis (Paperclip) |");
    expect(mockLogActivity).toHaveBeenCalledWith(fakeDb, expect.objectContaining({
      companyId: COMPANY, action: "notes_vault.file_written", entityType: "notes_vault_file", agentId: WRITER,
      details: expect.objectContaining({ mode: "create", path: "03 Projects/(C) Weekly review.md" }),
    }));
    expect(JSON.stringify(mockLogActivity.mock.calls[0])).not.toContain("# Review");
  });

  it("requires the AI prefix on agent-created files, but not for the board", async () => {
    const agentRes = await request(app(agent(WRITER))).post(`/api/companies/${COMPANY}/notes-vault/file`)
      .send({ path: "03 Projects/Note.md", mode: "create", content: "x", summary: "test" });
    expect(agentRes.status).toBe(422);
    const boardRes = await request(app(board)).post(`/api/companies/${COMPANY}/notes-vault/file`)
      .send({ path: "03 Projects/Note.md", mode: "create", content: "x", summary: "board note" });
    expect(boardRes.status).toBe(200);
    expect(await readFile(path.join(root, "vault-changelog.md"), "utf8")).toContain("| Board (Paperclip) |");
  });

  it("never creates over an existing file", async () => {
    const res = await request(app(board)).post(`/api/companies/${COMPANY}/notes-vault/file`)
      .send({ path: "03 Projects/Plan.md", mode: "create", content: "gone", summary: "overwrite" });
    expect(res.status).toBe(409);
    expect(await readFile(path.join(root, "03 Projects", "Plan.md"), "utf8")).toBe("# Plan\n");
  });

  it("appends to existing files", async () => {
    const res = await request(app(agent(WRITER))).post(`/api/companies/${COMPANY}/notes-vault/file`)
      .send({ path: "03 Projects/Plan.md", mode: "append", content: "- step\n", summary: "Added a step" });
    expect(res.status).toBe(200);
    expect(res.body.previousSha256).toBe(bridgeModule.sha256("# Plan\n"));
    expect(await readFile(path.join(root, "03 Projects", "Plan.md"), "utf8")).toBe("# Plan\n- step\n");
  });

  it("replaces only the version the caller read", async () => {
    const send = (body: Record<string, unknown>) => request(app(agent(WRITER))).post(`/api/companies/${COMPANY}/notes-vault/file`)
      .send({ path: "03 Projects/Plan.md", mode: "replace", content: "# New plan\n", summary: "Rewrote plan", ...body });
    expect((await send({})).status).toBe(422);
    expect((await send({ baseSha256: "0".repeat(64) })).status).toBe(409);
    expect(await readFile(path.join(root, "03 Projects", "Plan.md"), "utf8")).toBe("# Plan\n");
    const ok = await send({ baseSha256: bridgeModule.sha256("# Plan\n") });
    expect(ok.status).toBe(200);
    expect(await readFile(path.join(root, "03 Projects", "Plan.md"), "utf8")).toBe("# New plan\n");
  });

  it("refuses non-Markdown files, the changelog, hidden folders and escapes", async () => {
    const write = (body: Record<string, unknown>) => request(app(board)).post(`/api/companies/${COMPANY}/notes-vault/file`)
      .send({ mode: "create", content: "x", summary: "test", ...body });
    expect((await write({ path: "03 Projects/script.sh" })).status).toBe(422);
    expect((await write({ path: "vault-changelog.md", mode: "append" })).status).toBe(422);
    expect((await write({ path: ".obsidian/(C) x.md" })).status).toBe(403);
    expect((await write({ path: "../(C) outside.md" })).status).toBe(400);
    expect((await request(app(board)).get(`/api/companies/${COMPANY}/notes-vault/file`).query({ path: "/etc/passwd" })).status).toBe(400);
  });

  it("refuses symlinks that point outside the vault", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "notes-vault-outside-"));
    try {
      await symlink(outside, path.join(root, "Linked"));
      const res = await request(app(board)).post(`/api/companies/${COMPANY}/notes-vault/file`)
        .send({ path: "Linked/(C) escape.md", mode: "create", content: "x", summary: "escape" });
      expect(res.status).toBe(403);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects bridge calls without the token", async () => {
    const res = await fetch(`${bridgeUrl}/read`, { method: "POST", body: JSON.stringify({ path: "03 Projects/Plan.md" }) });
    expect(res.status).toBe(401);
  });
});
