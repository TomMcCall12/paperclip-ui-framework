import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { namingProvenancePayloads } from "../services/line-naming-provenance.js";

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
