import { z } from "zod";

export const NOTES_VAULT_WRITE_SUMMARY_MAX_LENGTH = 200;
export const NOTES_VAULT_WRITE_CONTENT_MAX_LENGTH = 256_000;

export const notesVaultWriteSchema = z.object({
  path: z.string().trim().min(1).max(512),
  mode: z.enum(["create", "append", "replace"]),
  content: z.string().max(NOTES_VAULT_WRITE_CONTENT_MAX_LENGTH),
  /** Required for replace: the sha256 returned when the file was read. */
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional().nullable(),
  /** One line for the vault changelog. */
  summary: z.string().trim().min(1).max(NOTES_VAULT_WRITE_SUMMARY_MAX_LENGTH),
}).strict();

export type NotesVaultWrite = z.infer<typeof notesVaultWriteSchema>;
