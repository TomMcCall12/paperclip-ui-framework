import { describe, expect, it, vi } from "vitest";
import { createCommandDispatcher } from "./command-dispatcher.js";
import { dispatchExternalChatCommand, telegramSyntheticCommandText } from "./chat-command-dispatch.js";

const baseInput = {
  companyId: "company-1",
  botUsername: "paperclip_bot",
  actor: { type: "external" as const, id: "principal-1", name: "Telegram User" },
  conversationId: "conversation-1",
  issueId: "issue-1",
  channelId: "telegram:417200359",
};

describe("external chat command mapping", () => {
  it("dispatches a registered command through the shared dispatcher with external_chat context", async () => {
    const dispatcher = createCommandDispatcher();
    const execute = vi.spyOn(dispatcher, "execute");
    await expect(
      dispatchExternalChatCommand(dispatcher, { ...baseInput, text: "/echo@Paperclip_Bot hello from telegram" }),
    ).resolves.toBe("Echo: hello from telegram");
    expect(execute).toHaveBeenCalledWith({
      command: "echo",
      args: "hello from telegram",
      context: {
        companyId: "company-1",
        surface: "external_chat",
        actor: baseInput.actor,
        conversationId: "conversation-1",
        issueId: "issue-1",
        channelId: "telegram:417200359",
      },
    });
  });

  it("falls back (null) for unknown, reserved, other-bot, and non-command text", async () => {
    const dispatcher = createCommandDispatcher();
    const execute = vi.spyOn(dispatcher, "execute");
    for (const text of ["/danger", "/status", "/new", "/close", "/task do it", "/start", "hello", "/echo@other_bot hi"]) {
      await expect(dispatchExternalChatCommand(dispatcher, { ...baseInput, text })).resolves.toBeNull();
    }
    expect(execute).toHaveBeenCalledTimes(1); // only the unknown "/danger" reached the registry
  });

  it("replies with the usage failure for a registered command with bad input", async () => {
    await expect(
      dispatchExternalChatCommand(createCommandDispatcher(), { ...baseInput, text: "/echo" }),
    ).resolves.toBe("Usage: /echo <text>");
  });

  it("rebuilds Telegram slash text for shared commands but keeps reserved controls bare", () => {
    expect(telegramSyntheticCommandText("/echo", "hello there")).toBe("/echo hello there");
    expect(telegramSyntheticCommandText("/echo", "")).toBe("/echo");
    expect(telegramSyntheticCommandText("/task", "fix the build")).toBe("fix the build");
    expect(telegramSyntheticCommandText("/task", "")).toBe("/task");
    expect(telegramSyntheticCommandText("/status", "extra")).toBe("/status");
    expect(telegramSyntheticCommandText("/start", "payload")).toBe("/start");
    expect(telegramSyntheticCommandText("/danger", "x")).toBe("/danger x");
  });
});
