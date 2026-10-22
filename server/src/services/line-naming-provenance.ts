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

/**
 * ACPX (the persistent-mode engine used by claude_local, among others) streams
 * assistant text as many `acpx.text_delta` records rather than one whole
 * message, so provenance needs an accumulating buffer instead of a
 * per-record extractor. Only the "output" channel is accumulated; "thought"
 * is reasoning, never a candidate name.
 */
export interface AcpxNamingTextBuffer {
  text: string;
}

export function createAcpxNamingTextBuffer(): AcpxNamingTextBuffer {
  return { text: "" };
}

export function accumulateAcpxTextDelta(buffer: AcpxNamingTextBuffer, event: Record<string, unknown>): void {
  if (event.type !== "acpx.text_delta" || event.channel !== "output" || typeof event.text !== "string") return;
  buffer.text += event.text;
}

const ACPX_NAMING_FLUSH_TYPES = new Set(["acpx.tool_call", "acpx.result", "acpx.error"]);

export function isAcpxNamingFlushTrigger(event: Record<string, unknown>): boolean {
  return typeof event.type === "string" && ACPX_NAMING_FLUSH_TYPES.has(event.type);
}

/**
 * Flushes the accumulated output text into provenance payloads and resets the
 * buffer. Hashes the whole trimmed text and each non-empty trimmed line
 * separately, since the model may send narration on one line and the bare
 * name on another within the same buffered span.
 */
export function flushAcpxNamingBuffer(buffer: AcpxNamingTextBuffer): Array<{ textSha256: string; source: string }> {
  const text = buffer.text;
  buffer.text = "";
  const candidates = new Set<string>();
  const whole = text.trim();
  if (whole) candidates.add(whole);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) candidates.add(trimmed);
  }
  const payloads: Array<{ textSha256: string; source: string }> = [];
  for (const candidate of candidates) {
    if (candidate.length > 80) continue;
    payloads.push({ textSha256: createHash("sha256").update(candidate).digest("hex"), source: "acpx_text_delta" });
  }
  return payloads;
}
