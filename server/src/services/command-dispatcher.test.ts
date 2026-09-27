import { describe, expect, it, vi } from "vitest";
import type { CommandDeclarationV1, CommandInvocationContext } from "@paperclipai/shared";
import { createCommandDispatcher, type ExtensionCommandRegistration } from "./command-dispatcher.js";

const context = (overrides: Partial<CommandInvocationContext> = {}): CommandInvocationContext => ({
  companyId: "company-1",
  surface: "ui_chat",
  actor: { type: "user", id: "user-1" },
  ...overrides,
});

function pluginCommand(
  overrides: Partial<CommandDeclarationV1> = {},
  registration: Partial<ExtensionCommandRegistration> = {},
): ExtensionCommandRegistration {
  return {
    declaration: {
      version: 1,
      command: "weather",
      title: "Weather",
      description: "Report the weather",
      source: { type: "plugin", pluginId: "acme.weather" },
      ...overrides,
    } as ExtensionCommandRegistration["declaration"],
    handler: vi.fn(() => ({ success: true, message: "Sunny" })),
    isEnabledForCompany: (companyId) => companyId === "company-1",
    ...registration,
  };
}

describe("command dispatcher", () => {
  it("executes the deterministic built-in /echo on every surface", async () => {
    const dispatcher = createCommandDispatcher();
    await expect(dispatcher.execute({ command: "echo", args: "hello", context: context() })).resolves.toEqual({
      status: "executed",
      command: "echo",
      result: { success: true, message: "Echo: hello", data: { echoed: "hello" } },
    });
    await expect(
      dispatcher.execute({ command: "ECHO", args: "hi", context: context({ surface: "external_chat" }) }),
    ).resolves.toMatchObject({ result: { message: "Echo: hi" } });
    await expect(dispatcher.execute({ command: "echo", args: "", context: context() })).resolves.toMatchObject({
      result: { success: false, message: "Usage: /echo <text>" },
    });
  });

  it("returns not_found for unknown commands and refuses an empty company scope", async () => {
    const dispatcher = createCommandDispatcher();
    await expect(dispatcher.execute({ command: "nope", args: "", context: context() })).resolves.toEqual({
      status: "not_found",
    });
    await expect(
      dispatcher.execute({ command: "echo", args: "x", context: context({ companyId: "" }) }),
    ).rejects.toThrow(/company scope/);
  });

  it("lists and runs extension commands only for enabled companies and declared surfaces", async () => {
    const dispatcher = createCommandDispatcher();
    const registration = pluginCommand({ contexts: ["external_chat"] });
    dispatcher.registerExtension(registration);

    expect((await dispatcher.listCommands("company-1", "ui_chat")).map((c) => c.command)).toEqual(["echo"]);
    expect((await dispatcher.listCommands("company-1", "external_chat")).map((c) => c.command)).toEqual([
      "echo",
      "weather",
    ]);
    expect((await dispatcher.listCommands("company-2", "external_chat")).map((c) => c.command)).toEqual(["echo"]);

    await expect(
      dispatcher.execute({ command: "weather", args: "", context: context({ companyId: "company-2", surface: "external_chat" }) }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(dispatcher.execute({ command: "weather", args: "", context: context() })).resolves.toEqual({
      status: "not_found",
    });
    expect(registration.handler).not.toHaveBeenCalled();

    const ctx = context({ surface: "external_chat" });
    await expect(dispatcher.execute({ command: "weather", args: "Leeds", context: ctx })).resolves.toMatchObject({
      result: { success: true, message: "Sunny" },
    });
    expect(registration.handler).toHaveBeenCalledWith({ args: "Leeds", context: ctx });
  });

  it("gives built-in and reserved control commands precedence over extensions", () => {
    const dispatcher = createCommandDispatcher();
    expect(() => dispatcher.registerExtension(pluginCommand({ command: "echo" }))).toThrow(/another source/);
    expect(() => dispatcher.registerExtension(pluginCommand({ aliases: ["echo"] }))).toThrow(/already registered/);
    for (const reserved of ["status", "new", "close", "goal", "task", "start"]) {
      expect(() => dispatcher.registerExtension(pluginCommand({ command: reserved }))).toThrow(/reserved/);
    }
    expect(() =>
      dispatcher.registerExtension(
        pluginCommand({ source: { type: "built-in" } } as unknown as Partial<CommandDeclarationV1>),
      ),
    ).toThrow(/plugin source/);
  });

  it("unregisters an extension and isolates failing, hanging, or malformed handlers", async () => {
    const dispatcher = createCommandDispatcher({ handlerTimeoutMs: 20 });
    const unregister = dispatcher.registerExtension(
      pluginCommand({}, { handler: () => { throw new Error("secret stack detail"); } }),
    );
    await expect(dispatcher.execute({ command: "weather", args: "", context: context() })).resolves.toMatchObject({
      result: { success: false, message: "/weather failed. Try again later." },
    });
    unregister();
    await expect(dispatcher.execute({ command: "weather", args: "", context: context() })).resolves.toEqual({
      status: "not_found",
    });

    dispatcher.registerExtension(pluginCommand({ command: "slow" }, { handler: () => new Promise(() => {}) }));
    await expect(dispatcher.execute({ command: "slow", args: "", context: context() })).resolves.toMatchObject({
      result: { success: false },
    });

    dispatcher.registerExtension(
      pluginCommand({ command: "bad" }, { handler: () => ({ success: "yes" }) as never }),
    );
    await expect(dispatcher.execute({ command: "bad", args: "", context: context() })).resolves.toMatchObject({
      result: { success: false, message: "/bad failed. Try again later." },
    });

    dispatcher.registerExtension(
      pluginCommand({ command: "long" }, { handler: () => ({ success: true, message: "x".repeat(10_000) }) }),
    );
    const long = await dispatcher.execute({ command: "long", args: "", context: context() });
    expect(long.status === "executed" && long.result.message?.length).toBe(4_000);
  });
});
