/**
 * Telegram conversations are stored by their Chat SDK thread ID,
 * `telegram:<chatId>` or `telegram:<chatId>:<topicId>`. The Bot API needs the
 * bare chat ID (and the topic, if any). Returns null for anything else.
 */
export function telegramTargetFromThreadId(
  threadId: string | null | undefined,
): { chatId: string; messageThreadId?: number } | null {
  if (!threadId) return null;
  const parts = threadId.split(":");
  if (parts[0] !== "telegram" || parts.length < 2 || parts.length > 3 || !parts[1]) return null;
  const topic = parts[2] ? Number(parts[2]) : undefined;
  return topic !== undefined && Number.isInteger(topic) ? { chatId: parts[1], messageThreadId: topic } : { chatId: parts[1] };
}
