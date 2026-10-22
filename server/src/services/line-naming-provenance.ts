import { createHash } from "node:crypto";

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Pulls assistant message texts out of one provider stdout record. Handles Codex
 * JSONL (`item.completed` agent_message) and Claude stream-json (`assistant`
 * message text blocks and the final `result`).
 */
export function namingProviderMessages(event: Record<string, unknown>): Array<{ text: string; source: string }> {
  const out: Array<{ text: string; source: string }> = [];
  const item = obj(event.item);
  if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string")
    out.push({ text: item.text, source: "codex_jsonl" });
  if (event.type === "assistant") {
    const content = obj(event.message).content;
    if (Array.isArray(content))
      for (const block of content) {
        const b = obj(block);
        if (b.type === "text" && typeof b.text === "string") out.push({ text: b.text, source: "claude_stream_json" });
      }
  }
  if (event.type === "result" && typeof event.result === "string") out.push({ text: event.result, source: "claude_stream_json" });
  return out;
}

export function namingProvenancePayloads(event: Record<string, unknown>) {
  const payloads: Array<{ textSha256: string; source: string }> = [];
  for (const { text, source } of namingProviderMessages(event)) {
    const name = text.trim();
    if (!name || name.length > 80) continue;
    payloads.push({ textSha256: createHash("sha256").update(name).digest("hex"), source });
  }
  return payloads;
}
