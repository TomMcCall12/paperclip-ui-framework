/** Notes vault (for example an Obsidian vault) shared with agents. Not the secrets vault. */
/** What the current actor may do with the company's notes vault. */
export type NotesVaultAccessLevel = "none" | "read" | "write";

export interface NotesVaultStatus {
  enabled: boolean;
  access: NotesVaultAccessLevel;
  /** File-name prefix required on files that agents create, or null when none is required. */
  aiFilePrefix: string | null;
  changelogPath: string | null;
}

export interface NotesVaultEntry {
  name: string;
  /** Vault-relative path, always with forward slashes. */
  path: string;
  kind: "folder" | "file";
}

export interface NotesVaultListing {
  path: string;
  entries: NotesVaultEntry[];
  truncated: boolean;
}

export interface NotesVaultFile {
  path: string;
  content: string;
  sha256: string;
  bytes: number;
}

/** Whether a file contains a string, without reading it whole — checks an idempotency marker cheaply. */
export interface NotesVaultContainsResult {
  path: string;
  found: boolean;
}

export type NotesVaultWriteMode = "create" | "append" | "replace";

export interface NotesVaultWriteResult {
  path: string;
  mode: NotesVaultWriteMode;
  sha256: string;
  previousSha256: string | null;
  bytes: number;
}

/** Two-way sync between the vault and its cloud copy (for example the Google Drive folder Obsidian opens). */
export interface NotesVaultSyncStatus {
  /** False when the vault has no cloud copy set up. */
  enabled: boolean;
  running?: boolean;
  lastSuccessAt?: string | null;
  lastFinishedAt?: string | null;
  lastOk?: boolean | null;
  /** The last failure, in rclone's words, when the last sync failed. */
  lastError?: string | null;
  /** Files kept as "name.sync-conflict1.md" because both sides changed them. */
  lastConflicts?: number;
  consecutiveFailures?: number;
  nextRunAt?: string | null;
}
