import { describe, expect, it } from "vitest";
import {
  CommandRegistrationError,
  SharedCommandRegistry,
  parseSlashCommand,
} from "./commands.js";
import type { CommandDeclarationV1 } from "./types/commands.js";
import { commandDeclarationV1Schema, commandExecuteRequestSchema } from "./validators/commands.js";

function declaration(overrides: Partial<CommandDeclarationV1> = {}): CommandDeclarationV1 {
  return {
    version: 1,
    command: "echo",
    title: "Echo",
    description: "Echo text back",
    source: { type: "built-in" },
    ...overrides,
  };
}

describe("parseSlashCommand", () => {
  it("parses command, bot handle, and args", () => {
    expect(parseSlashCommand("/echo hello world")).toEqual({
      matched: true, command: "echo", botHandle: null, args: "hello world",
    });
    expect(parseSlashCommand("  /Echo@Paper_Bot   hi  ")).toEqual({
      matched: true, command: "echo", botHandle: "Paper_Bot", args: "hi",
    });
    expect(parseSlashCommand("/echo")).toEqual({ matched: true, command: "echo", botHandle: null, args: "" });
    expect(parseSlashCommand("/echo line one\nline two")).toMatchObject({ args: "line one\nline two" });
  });

  it("normalizes the MDXEditor non-breaking separator and autolink shapes", () => {
    expect(parseSlashCommand("/echo hello")).toMatchObject({ command: "echo", args: "hello" });
    expect(parseSlashCommand("[/echo](</echo hello there>)")).toMatchObject({ command: "echo", args: "hello there" });
    expect(parseSlashCommand("[/ec](/echo%20hi%C2%A0there)")).toMatchObject({ command: "echo", args: "hi there" });
  });

  it("does not match ordinary text or malformed commands", () => {
    for (const text of ["", "echo hi", "hello /echo", "/", "/9lives", "/echo-it", "[/docs](/docs)"]) {
      expect(parseSlashCommand(text)).toEqual({ matched: false });
    }
  });
});

describe("command validators", () => {
  it("accepts a versioned declaration and rejects executable or unknown fields", () => {
    expect(commandDeclarationV1Schema.safeParse(declaration()).success).toBe(true);
    expect(commandDeclarationV1Schema.safeParse({ ...declaration(), shell: "rm -rf /" }).success).toBe(false);
    expect(commandDeclarationV1Schema.safeParse({ ...declaration(), version: 2 }).success).toBe(false);
    expect(commandDeclarationV1Schema.safeParse(declaration({ command: "Echo" })).success).toBe(false);
    expect(commandDeclarationV1Schema.safeParse(declaration({ command: "e-cho" })).success).toBe(false);
    expect(commandDeclarationV1Schema.safeParse(declaration({ aliases: ["echo"] })).success).toBe(false);
    expect(
      commandDeclarationV1Schema.safeParse(declaration({ source: { type: "plugin", pluginId: "" } })).success,
    ).toBe(false);
  });

  it("validates execute requests", () => {
    expect(commandExecuteRequestSchema.parse({ command: "echo" })).toEqual({ command: "echo", args: "" });
    expect(commandExecuteRequestSchema.safeParse({ command: "echo", issueId: "nope" }).success).toBe(false);
    expect(commandExecuteRequestSchema.safeParse({ command: "echo", args: "x".repeat(4_001) }).success).toBe(false);
    expect(commandExecuteRequestSchema.safeParse({ command: "echo", companyId: "other" }).success).toBe(false);
  });
});

describe("SharedCommandRegistry", () => {
  it("resolves aliases and lists unique declarations sorted and filtered by surface", () => {
    const registry = new SharedCommandRegistry();
    registry.register(declaration({ aliases: ["say"] }));
    registry.register(declaration({ command: "ping", title: "Ping", contexts: ["external_chat"] }));
    expect(registry.get("SAY")?.command).toBe("echo");
    expect(registry.list().map((item) => item.command)).toEqual(["echo", "ping"]);
    expect(registry.list({ surface: "ui_chat" }).map((item) => item.command)).toEqual(["echo"]);
    expect(registry.list({ surface: "external_chat" }).map((item) => item.command)).toEqual(["echo", "ping"]);
  });

  it("rejects reserved control names and cross-source shadowing", () => {
    const registry = new SharedCommandRegistry();
    registry.register(declaration());
    expect(() => registry.register(declaration({ command: "status" }))).toThrow(CommandRegistrationError);
    expect(() => registry.register(declaration({ command: "ping", aliases: ["new"] }))).toThrow(/reserved/);
    expect(() =>
      registry.register(declaration({ source: { type: "plugin", pluginId: "acme" } })),
    ).toThrow(/another source/);
    expect(() => registry.register(declaration({ command: "ping", aliases: ["echo"] }))).toThrow(/already registered/);
    expect(registry.get("echo")?.source).toEqual({ type: "built-in" });
  });

  it("replaces a same-source declaration and removes its stale aliases on unregister", () => {
    const registry = new SharedCommandRegistry();
    registry.register(declaration({ aliases: ["say"] }));
    registry.register(declaration({ aliases: ["repeat"] }));
    expect(registry.get("say")).toBeNull();
    expect(registry.get("repeat")?.command).toBe("echo");
    expect(registry.unregister("repeat")).toBe(true);
    expect(registry.get("echo")).toBeNull();
    expect(registry.list()).toEqual([]);
  });
});
