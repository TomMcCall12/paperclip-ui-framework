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

export type NotesVaultWriteMode = "create" | "append" | "replace";

export interface NotesVaultWriteResult {
  path: string;
  mode: NotesVaultWriteMode;
  sha256: string;
  previousSha256: string | null;
  bytes: number;
}
