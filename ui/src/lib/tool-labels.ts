/**
 * Plain-English wording for what an agent's tool call is doing, for the live
 * status line in a task thread. Raw tool names ("Bash", "Grep") mean little to
 * a non-technical reader.
 */
const TOOL_LABELS: Record<string, string> = {
  bash: "Running a command",
  shell: "Running a command",
  exec: "Running a command",
  exec_command: "Running a command",
  terminal: "Running a command",
  read: "Reading a file",
  read_file: "Reading a file",
  view: "Reading a file",
  write: "Writing a file",
  write_file: "Writing a file",
  edit: "Editing a file",
  multiedit: "Editing a file",
  apply_patch: "Editing a file",
  patch: "Editing a file",
  notebookedit: "Editing a notebook",
  grep: "Searching the code",
  glob: "Looking for files",
  search: "Searching",
  ls: "Looking through folders",
  list_files: "Looking through folders",
  webfetch: "Reading a web page",
  web_fetch: "Reading a web page",
  websearch: "Searching the web",
  web_search: "Searching the web",
  skill: "Using a skill",
  task: "Handing part of the work to a helper",
  agent: "Handing part of the work to a helper",
  todowrite: "Updating its to-do list",
  update_plan: "Updating its plan",
};

/** "Running a command", "Using GitHub", or "Using <tool>" when unknown. */
export function friendlyToolLabel(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed) return "Working";
  // MCP tools look like "mcp__github__list_commits" or "mcp.app-gallery-github-…:list-commits".
  const mcp = /^mcp(?:__|\.)(?:app-gallery-)?([a-z0-9]+)/i.exec(trimmed);
  if (mcp) {
    const app = mcp[1]!.toLowerCase();
    return `Using ${app === "github" ? "GitHub" : app.charAt(0).toUpperCase() + app.slice(1)}`;
  }
  const known = TOOL_LABELS[trimmed.toLowerCase()];
  return known ?? `Using ${trimmed}`;
}
