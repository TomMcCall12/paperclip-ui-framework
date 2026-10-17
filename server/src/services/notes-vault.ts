import type {
  NotesVaultAccessLevel,
  NotesVaultContainsResult,
  NotesVaultFile,
  NotesVaultListing,
  NotesVaultStatus,
  NotesVaultWrite,
  NotesVaultSyncStatus,
  NotesVaultWriteResult,
} from "@paperclipai/shared";
import { HttpError, notFound, unprocessable } from "../errors.js";

/**
 * A notes vault (for example an Obsidian vault) that chosen agents can read
 * and write through Paperclip, whatever model or adapter they run on.
 *
 * Access is operator configuration, set in the server environment, keyed by
 * agent id, and bound to one company. No agent can grant it, not even a CEO.
 * The vault itself lives behind the notes vault bridge in another container,
 * so agent processes never see it on their filesystem. See doc/NOTES-VAULT.md.
 */

export type NotesVaultConfig = {
  bridgeUrl: string;
  bridgeToken: string;
  companyId: string;
  writerAgentIds: ReadonlySet<string>;
  readerAgentIds: ReadonlySet<string>;
  /** File-name prefix required on files agents create, or null for none. */
  aiFilePrefix: string | null;
  changelogPath: string;
};

const DEFAULT_AI_FILE_PREFIX = "(C) ";
const DEFAULT_CHANGELOG_PATH = "vault-changelog.md";
const BRIDGE_TIMEOUT_MS = 15_000;

function idList(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

/** Reads the notes vault configuration, or null when the feature is off. */
export function readNotesVaultConfig(env: NodeJS.ProcessEnv = process.env): NotesVaultConfig | null {
  const bridgeUrl = env.PAPERCLIP_NOTES_VAULT_BRIDGE_URL?.trim();
  const bridgeToken = env.PAPERCLIP_NOTES_VAULT_BRIDGE_TOKEN?.trim();
  const companyId = env.PAPERCLIP_NOTES_VAULT_COMPANY_ID?.trim();
  if (!bridgeUrl || !bridgeToken || !companyId) return null;
  const writerAgentIds = idList(env.PAPERCLIP_NOTES_VAULT_WRITER_AGENT_IDS);
  const readerAgentIds = new Set([...idList(env.PAPERCLIP_NOTES_VAULT_READER_AGENT_IDS), ...writerAgentIds]);
  const prefix = env.PAPERCLIP_NOTES_VAULT_AI_FILE_PREFIX;
  return {
    bridgeUrl: bridgeUrl.replace(/\/+$/, ""),
    bridgeToken,
    companyId,
    writerAgentIds,
    readerAgentIds,
    aiFilePrefix: prefix === undefined ? DEFAULT_AI_FILE_PREFIX : prefix === "" ? null : prefix,
    changelogPath: env.PAPERCLIP_NOTES_VAULT_CHANGELOG_PATH?.trim() || DEFAULT_CHANGELOG_PATH,
  };
}

export type NotesVaultActor = { type: "board" | "agent" | "none"; agentId?: string | null };

/** Board members of the vault's company may write; agents only when listed. */
export function notesVaultAccessFor(
  config: NotesVaultConfig | null,
  companyId: string,
  actor: NotesVaultActor,
): NotesVaultAccessLevel {
  if (!config || config.companyId !== companyId) return "none";
  if (actor.type === "board") return "write";
  if (actor.type !== "agent" || !actor.agentId) return "none";
  if (config.writerAgentIds.has(actor.agentId)) return "write";
  if (config.readerAgentIds.has(actor.agentId)) return "read";
  return "none";
}

export function notesVaultStatus(config: NotesVaultConfig | null, access: NotesVaultAccessLevel): NotesVaultStatus {
  const enabled = config !== null && access !== "none";
  return {
    enabled,
    access,
    aiFilePrefix: enabled ? config.aiFilePrefix : null,
    changelogPath: enabled ? config.changelogPath : null,
  };
}

function baseName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? "";
}

/**
 * The rules Paperclip adds on top of the bridge's own path checks: Markdown
 * only; files an agent creates carry the AI prefix; a replace names the
 * version it read. The board is exempt from the prefix.
 */
export function assertNotesVaultWriteAllowed(
  config: NotesVaultConfig,
  input: NotesVaultWrite,
  actor: NotesVaultActor,
): void {
  const name = baseName(input.path);
  if (!name.toLowerCase().endsWith(".md")) {
    throw unprocessable("Only Markdown (.md) files can be written to the notes vault.", { code: "notes_vault_markdown_only" });
  }
  if (input.path.replace(/\\/g, "/") === config.changelogPath) {
    throw unprocessable("The vault changelog is written by Paperclip; describe your change in `summary` instead.", {
      code: "notes_vault_changelog_reserved",
    });
  }
  if (input.mode === "create" && actor.type === "agent" && config.aiFilePrefix && !name.startsWith(config.aiFilePrefix)) {
    throw unprocessable(`Files that agents create must be named with the "${config.aiFilePrefix}" prefix.`, {
      code: "notes_vault_ai_prefix_required",
      aiFilePrefix: config.aiFilePrefix,
    });
  }
  if (input.mode === "replace" && !input.baseSha256) {
    throw unprocessable("Replace needs baseSha256 from your latest read of the file, so nothing is overwritten unseen.", {
      code: "notes_vault_base_required",
    });
  }
}

type BridgeErrorBody = { error?: string; code?: string };

export function notesVaultBridgeClient(config: NotesVaultConfig, fetchImpl: typeof fetch = fetch) {
  async function call<T>(route: "/list" | "/read" | "/contains" | "/write" | "/sync/status" | "/sync/run", body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${config.bridgeUrl}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(503, "The notes vault is unavailable right now.", { code: "notes_vault_unavailable" });
    }
    const payload = (await response.json().catch(() => ({}))) as T & BridgeErrorBody;
    if (response.ok) return payload;
    // The bridge token is the server's, so a bridge 401 is a configuration fault, not the caller's.
    if (response.status === 401) {
      throw new HttpError(503, "The notes vault bridge rejected Paperclip's credentials.", { code: "notes_vault_misconfigured" });
    }
    const status = [400, 403, 404, 409, 413].includes(response.status) ? response.status : 502;
    throw new HttpError(status, payload.error ?? "Notes vault request failed.", { code: payload.code ?? "notes_vault_error" });
  }

  return {
    list: (path: string) => call<NotesVaultListing>("/list", { path }),
    read: (path: string) => call<NotesVaultFile>("/read", { path }),
    contains: (path: string, needle: string) => call<NotesVaultContainsResult>("/contains", { path, needle }),
    write: (input: NotesVaultWrite, actorLabel: string) =>
      call<NotesVaultWriteResult>("/write", {
        path: input.path,
        mode: input.mode,
        content: input.content,
        baseSha256: input.baseSha256 ?? null,
        summary: input.summary,
        actor: actorLabel,
      }),
    syncStatus: async () => pickSyncStatus(await call<Record<string, unknown>>("/sync/status", {})),
    syncNow: async () => pickSyncStatus(await call<Record<string, unknown>>("/sync/run", {})),
  };
}

/** Only the fields Paperclip documents; the bridge's remote name and paths stay with the operator. */
function pickSyncStatus(raw: Record<string, unknown>): NotesVaultSyncStatus {
  if (raw.enabled !== true) return { enabled: false };
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    enabled: true,
    running: raw.running === true,
    lastSuccessAt: text(raw.lastSuccessAt),
    lastFinishedAt: text(raw.lastFinishedAt),
    lastOk: typeof raw.lastOk === "boolean" ? raw.lastOk : null,
    lastError: text(raw.lastError),
    lastConflicts: count(raw.lastConflicts),
    consecutiveFailures: count(raw.consecutiveFailures),
    nextRunAt: text(raw.nextRunAt),
  };
}

export function assertNotesVaultAccess(access: NotesVaultAccessLevel, needed: "read" | "write"): void {
  if (access === "none") throw notFound("Notes vault is not available");
  if (needed === "write" && access !== "write") {
    throw new HttpError(403, "This agent may read the notes vault but not write to it.", { code: "notes_vault_read_only" });
  }
}
