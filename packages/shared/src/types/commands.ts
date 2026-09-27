/**
 * Shared command declaration and invocation contracts (TOM-17).
 *
 * Declarations are pure data. They never carry executable text; the host maps
 * a declared command to a handler registered in code.
 */

export const COMMAND_DECLARATION_VERSION = 1 as const;

export const COMMAND_SURFACES = ["ui_chat", "external_chat"] as const;
export type CommandSurface = (typeof COMMAND_SURFACES)[number];

export const COMMAND_CATEGORIES = ["general", "task", "session"] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export type CommandSource = { type: "built-in" } | { type: "plugin"; pluginId: string };

export interface CommandDeclarationV1 {
  version: typeof COMMAND_DECLARATION_VERSION;
  /** Command name without the leading slash, e.g. "echo". */
  command: string;
  /** Human-readable title for autocomplete. */
  title: string;
  /** Short description of what the command does. */
  description: string;
  /** Optional usage hint, e.g. "/echo <text>". */
  usage?: string;
  /** Surfaces that may invoke the command. Omitted means every surface. */
  contexts?: CommandSurface[];
  category?: CommandCategory;
  source: CommandSource;
  /** Alternative names that resolve to this command. */
  aliases?: string[];
}

export interface CommandActor {
  type: "user" | "agent" | "external";
  id: string;
  name?: string | null;
}

export interface CommandInvocationContext {
  companyId: string;
  surface: CommandSurface;
  actor: CommandActor;
  issueId?: string | null;
  conversationId?: string | null;
  channelId?: string | null;
}

export interface CommandExecutionInput {
  command: string;
  args: string;
  context: CommandInvocationContext;
}

export interface CommandExecutionResult {
  success: boolean;
  /** Text to show or send back to the invoking conversation. */
  message: string | null;
  data?: unknown;
}

/** Body accepted by `POST /api/companies/:companyId/commands/execute`. */
export interface CommandExecuteRequest {
  command: string;
  args?: string;
  issueId?: string | null;
}

export interface CommandExecuteResponse {
  command: string;
  result: CommandExecutionResult;
}
