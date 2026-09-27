import { describe, expect, it } from "vitest";
import type { CommandDeclarationV1 } from "@paperclipai/shared";
import type { ActionCommandOption } from "@/context/EditorAutocompleteContext";
import {
  filterActionCommandOptions,
  hostCommandToActionOption,
  matchHostCommand,
} from "./host-commands";

const echo: CommandDeclarationV1 = {
  version: 1,
  command: "echo",
  title: "Echo",
  description: "Echo text back to this conversation.",
  source: { type: "built-in" },
  aliases: ["say"],
};

const options: ActionCommandOption[] = [
  hostCommandToActionOption(echo),
  hostCommandToActionOption({ ...echo, command: "estimate", title: "Estimate", aliases: undefined }),
  hostCommandToActionOption({ ...echo, command: "weather", title: "Weather", aliases: undefined }),
];

describe("host command UI mapping", () => {
  it("maps a declaration onto an editor action option", () => {
    expect(hostCommandToActionOption(echo)).toEqual({
      id: "host-command:echo",
      kind: "action",
      command: "echo",
      name: "Echo",
      description: "Echo text back to this conversation.",
      aliases: ["echo", "say"],
    });
  });

  it("matches only listed commands, resolving aliases and MDXEditor separators", () => {
    expect(matchHostCommand("/echo hello", options)).toEqual({ command: "echo", args: "hello" });
    expect(matchHostCommand("/say hi", options)).toEqual({ command: "echo", args: "hi" });
    expect(matchHostCommand("/goal ship it", options)).toBeNull();
    expect(matchHostCommand("/echo@bot hi", options)).toBeNull();
    expect(matchHostCommand("hello /echo", options)).toBeNull();
  });

  it("filters autocomplete candidates by prefix while the command token is typed", () => {
    expect(filterActionCommandOptions("/", options).map((o) => o.command)).toEqual(["echo", "estimate", "weather"]);
    expect(filterActionCommandOptions("/e", options).map((o) => o.command)).toEqual(["echo", "estimate"]);
    expect(filterActionCommandOptions("/SA", options).map((o) => o.command)).toEqual(["echo"]);
    expect(filterActionCommandOptions("/zzz", options)).toEqual([]);
    expect(filterActionCommandOptions("/echo hi", options)).toEqual([]);
    expect(filterActionCommandOptions("hello", options)).toEqual([]);
  });
});
