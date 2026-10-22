// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { TaskChatBubbleActions } from "./TaskChatBubbleActions";

function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(ui));
  return container;
}

describe("TaskChatBubbleActions", () => {
  // TOM-804: these sit in the live redesigned task thread (TaskChatBubbleActions
  // feeds its own Copy button plus the shared IssueChatFeedbackButtons for
  // Helpful/Needs work) and on 28px square buttons the global pointer-coarse
  // floor only raises min-height, leaving a 28-wide x 44-high target.
  it("gives Copy, Helpful, and Needs work touch-sized targets", () => {
    const container = render(
      <TaskChatBubbleActions
        copyText="hello"
        feedback={{
          activeVote: null,
          sharingPreference: "allowed",
          termsUrl: null,
          onVote: vi.fn().mockResolvedValue(undefined),
        }}
      />,
    );

    const copy = container.querySelector('[aria-label="Copy message"]');
    const helpful = container.querySelector('[aria-label="Helpful"]');
    const needsWork = container.querySelector('[aria-label="Needs work"]');

    expect(copy?.className).toContain("pointer-coarse:size-11");
    expect(helpful?.className).toContain("pointer-coarse:size-11");
    expect(needsWork?.className).toContain("pointer-coarse:size-11");
  });
});
