import { describe, expect, it } from "vitest";
import { friendlyToolLabel } from "./tool-labels";

describe("friendlyToolLabel", () => {
  it("describes common tools in plain English", () => {
    expect(friendlyToolLabel("Bash")).toBe("Running a command");
    expect(friendlyToolLabel("Edit")).toBe("Editing a file");
    expect(friendlyToolLabel("Grep")).toBe("Searching the code");
    expect(friendlyToolLabel("WebSearch")).toBe("Searching the web");
    expect(friendlyToolLabel("Skill")).toBe("Using a skill");
  });

  it("names the app behind MCP tools", () => {
    expect(friendlyToolLabel("mcp__github__list_commits")).toBe("Using GitHub");
    expect(friendlyToolLabel("mcp.app-gallery-github-dc15f273:list-commits")).toBe("Using GitHub");
    expect(friendlyToolLabel("mcp__supabase__execute_sql")).toBe("Using Supabase");
  });

  it("falls back to the tool name when it is unknown", () => {
    expect(friendlyToolLabel("frobnicate")).toBe("Using frobnicate");
    expect(friendlyToolLabel("  ")).toBe("Working");
  });
});
