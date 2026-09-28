import { isReservedCommandName, parseSlashCommand, type CommandActor } from "@paperclipai/shared";
import type { CommandDispatcher } from "./command-dispatcher.js";

export interface ExternalChatCommandInput {
  companyId: string;
  text: string;
  /** The endpoint's bot username; commands addressed to another bot are ignored. */
  botUsername: string | null;
  actor: CommandActor;
  conversationId?: string | null;
  issueId?: string | null;
  channelId?: string | null;
}

/**
 * Map an inbound external-chat message onto the shared command dispatcher.
 *
 * Returns the reply text for a registered command, or `null` when the text is
 * not a shared command so the caller keeps its existing behavior. Reserved
 * control commands (/task, /status, /new, /close, /start) are never
 * dispatched here: the chat channel resolves them first.
 */
export async function dispatchExternalChatCommand(
  dispatcher: CommandDispatcher,
  input: ExternalChatCommandInput,
): Promise<string | null> {
  const parsed = parseSlashCommand(input.text);
  if (!parsed.matched || isReservedCommandName(parsed.command)) return null;
  if (
    parsed.botHandle &&
    input.botUsername &&
    parsed.botHandle.toLowerCase() !== input.botUsername.toLowerCase()
  )
    return null;
  const outcome = await dispatcher.execute({
    command: parsed.command,
    args: parsed.args,
    context: {
      companyId: input.companyId,
      surface: "external_chat",
      actor: input.actor,
      conversationId: input.conversationId ?? null,
      issueId: input.issueId ?? null,
      channelId: input.channelId ?? null,
    },
  });
  if (outcome.status === "not_found") return null;
  return outcome.result.message?.trim() || (outcome.result.success ? `/${outcome.command} completed.` : `/${outcome.command} failed.`);
}

/**
 * Telegram's slash callback splits `/cmd args` into a command and its text.
 * Rebuild the full message for shared commands; reserved controls keep their
 * exact bare-command form so `/status extra` still resolves as `/status`.
 */
export function telegramSyntheticCommandText(command: string, text: string): string {
  if (command === "/task" && text) return text;
  if (!text || isReservedCommandName(command.replace(/^\//, ""))) return command;
  return `${command} ${text}`;
}
