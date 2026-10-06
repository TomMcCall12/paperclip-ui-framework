import { describe, expect, it } from "vitest";
import { telegramTargetFromThreadId } from "./chat-telegram-target.js";

describe("telegramTargetFromThreadId", () => {
  it("reads the chat and optional topic from a Chat SDK thread ID", () => {
    expect(telegramTargetFromThreadId("telegram:5002548752")).toEqual({ chatId: "5002548752" });
    expect(telegramTargetFromThreadId("telegram:-1001234:42")).toEqual({ chatId: "-1001234", messageThreadId: 42 });
  });

  it("rejects anything that isn't a Telegram thread", () => {
    for (const value of [null, "", "5002548752", "slack:C1", "telegram:", "telegram:1:2:3"]) {
      expect(telegramTargetFromThreadId(value)).toBeNull();
    }
  });
});
