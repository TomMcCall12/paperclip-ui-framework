import { z } from "zod";
import { COMMAND_CATEGORIES, COMMAND_SURFACES } from "../types/commands.js";

/**
 * Command names are portable across surfaces: Telegram accepts only
 * `[a-z0-9_]{1,32}`, so hyphens are excluded.
 */
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const COMMAND_ARGS_MAX_LENGTH = 4_000;
export const COMMAND_MESSAGE_MAX_LENGTH = 4_000;

export const commandNameSchema = z.string().regex(COMMAND_NAME_PATTERN);

// `.strict()` rejects unknown keys so a declaration cannot smuggle in
// executable fields (e.g. `shell`, `exec`, `script`).
export const commandDeclarationV1Schema = z
  .object({
    version: z.literal(1),
    command: commandNameSchema,
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    usage: z.string().max(200).optional(),
    contexts: z.array(z.enum(COMMAND_SURFACES)).min(1).optional(),
    category: z.enum(COMMAND_CATEGORIES).optional(),
    source: z.discriminatedUnion("type", [
      z.object({ type: z.literal("built-in") }).strict(),
      z.object({ type: z.literal("plugin"), pluginId: z.string().trim().min(1).max(200) }).strict(),
    ]),
    aliases: z.array(commandNameSchema).max(10).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const names = [value.command, ...(value.aliases ?? [])];
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", path: ["aliases"], message: "Aliases must be unique and differ from the command" });
    }
  });

export const commandExecuteRequestSchema = z
  .object({
    command: commandNameSchema,
    args: z.string().max(COMMAND_ARGS_MAX_LENGTH).default(""),
    issueId: z.string().guid().nullable().optional(),
  })
  .strict();

export const commandExecutionResultSchema = z.object({
  success: z.boolean(),
  message: z.string().max(COMMAND_MESSAGE_MAX_LENGTH).nullable(),
  data: z.unknown().optional(),
});

export type CommandExecuteRequestInput = z.input<typeof commandExecuteRequestSchema>;
