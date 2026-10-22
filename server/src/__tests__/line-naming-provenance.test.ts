import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  namingProvenancePayloads,
  createAcpxNamingTextBuffer,
  accumulateAcpxTextDelta,
  isAcpxNamingFlushTrigger,
  flushAcpxNamingBuffer,
} from "../services/line-naming-provenance.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("namingProvenancePayloads", () => {
  it("records codex agent messages", () => {
    expect(namingProvenancePayloads({ type: "item.completed", item: { type: "agent_message", text: " Blue Fox " } }))
      .toEqual([{ textSha256: sha("Blue Fox"), source: "codex_jsonl" }]);
  });
  it("records claude stream-json assistant text and result", () => {
    expect(namingProvenancePayloads({ type: "assistant", message: { content: [{ type: "tool_use" }, { type: "text", text: "Blue Fox\n" }] } }))
      .toEqual([{ textSha256: sha("Blue Fox"), source: "claude_stream_json" }]);
    expect(namingProvenancePayloads({ type: "result", result: "Blue Fox" })).toHaveLength(1);
  });
  it("ignores long, empty and unrelated records", () => {
    expect(namingProvenancePayloads({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(81) }] } })).toEqual([]);
    expect(namingProvenancePayloads({ type: "system", subtype: "init" })).toEqual([]);
  });
});

describe("ACPX text_delta provenance buffer", () => {
  it("accumulates output-channel deltas and flushes on a tool_call trigger", () => {
    const buffer = createAcpxNamingTextBuffer();
    for (const chunk of ["Blue", " ", "Fox"])
      accumulateAcpxTextDelta(buffer, { type: "acpx.text_delta", text: chunk, channel: "output" });
    expect(isAcpxNamingFlushTrigger({ type: "acpx.tool_call" })).toBe(true);
    expect(flushAcpxNamingBuffer(buffer)).toEqual([{ textSha256: sha("Blue Fox"), source: "acpx_text_delta" }]);
    // Buffer is reset after flush.
    expect(flushAcpxNamingBuffer(buffer)).toEqual([]);
  });

  it("flushes on acpx.result and acpx.error too, but not on other record types", () => {
    expect(isAcpxNamingFlushTrigger({ type: "acpx.result" })).toBe(true);
    expect(isAcpxNamingFlushTrigger({ type: "acpx.error" })).toBe(true);
    expect(isAcpxNamingFlushTrigger({ type: "acpx.status" })).toBe(false);
    expect(isAcpxNamingFlushTrigger({ type: "acpx.text_delta" })).toBe(false);
  });

  it("ignores the thought channel", () => {
    const buffer = createAcpxNamingTextBuffer();
    accumulateAcpxTextDelta(buffer, { type: "acpx.text_delta", text: "scratch reasoning", channel: "thought" });
    expect(flushAcpxNamingBuffer(buffer)).toEqual([]);
  });

  it("skips empty and over-80-char flushed text", () => {
    const empty = createAcpxNamingTextBuffer();
    accumulateAcpxTextDelta(empty, { type: "acpx.text_delta", text: "   ", channel: "output" });
    expect(flushAcpxNamingBuffer(empty)).toEqual([]);

    const long = createAcpxNamingTextBuffer();
    accumulateAcpxTextDelta(long, { type: "acpx.text_delta", text: "x".repeat(81), channel: "output" });
    expect(flushAcpxNamingBuffer(long)).toEqual([]);
  });

  it("also hashes each non-empty line, so a bare name on its own line after narration still matches", () => {
    const buffer = createAcpxNamingTextBuffer();
    accumulateAcpxTextDelta(buffer, {
      type: "acpx.text_delta",
      text: "Proposed Line name:\nBlue Fox",
      channel: "output",
    });
    const payloads = flushAcpxNamingBuffer(buffer);
    const hashes = payloads.map((p) => p.textSha256);
    expect(hashes).toContain(sha("Blue Fox"));
    expect(payloads.every((p) => p.source === "acpx_text_delta")).toBe(true);
  });
});
