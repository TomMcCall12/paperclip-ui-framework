import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  parseSlashCommand,
  type CommandDeclarationV1,
  type CommandExecutionResult,
} from "@paperclipai/shared";
import { commandsApi } from "@/api/commands";
import type { ActionCommandOption } from "@/context/EditorAutocompleteContext";
import { queryKeys } from "@/lib/queryKeys";

/** Map a host command declaration onto the editor's slash-action option. */
export function hostCommandToActionOption(declaration: CommandDeclarationV1): ActionCommandOption {
  return {
    id: `host-command:${declaration.command}`,
    kind: "action",
    command: declaration.command,
    name: declaration.title,
    description: declaration.description,
    aliases: [declaration.command, ...(declaration.aliases ?? [])],
  };
}

/**
 * Resolve composer text to a listed host command. Only commands the server
 * advertised for this company are intercepted; anything else is sent as an
 * ordinary message.
 */
export function matchHostCommand(
  body: string,
  options: readonly ActionCommandOption[],
): { command: string; args: string } | null {
  const parsed = parseSlashCommand(body);
  if (!parsed.matched || parsed.botHandle) return null;
  const option = options.find((item) => item.aliases.includes(parsed.command));
  return option ? { command: option.command, args: parsed.args } : null;
}

export function useHostCommands(companyId: string | null | undefined, issueId: string | null) {
  const { data = [] } = useQuery({
    queryKey: companyId ? queryKeys.commands.list(companyId) : ["commands", "__none__"],
    queryFn: () => commandsApi.list(companyId!),
    enabled: Boolean(companyId),
    staleTime: 60_000,
  });
  const options = useMemo(() => data.map(hostCommandToActionOption), [data]);
  const execute = useCallback(
    async (command: string, args: string): Promise<CommandExecutionResult> => {
      if (!companyId) throw new Error("Select a company before running commands.");
      const response = await commandsApi.execute(companyId, { command, args, issueId });
      return response.result;
    },
    [companyId, issueId],
  );
  return { options, execute: companyId ? execute : undefined };
}

/**
 * Autocomplete candidates while the user is still typing the command token
 * (`/`, `/ec`). Returns an empty list once arguments begin or the text is not
 * a slash token. Matches command names and aliases by prefix.
 */
export function filterActionCommandOptions(
  value: string,
  options: readonly ActionCommandOption[],
): ActionCommandOption[] {
  const token = /^\/([a-z0-9_]*)$/i.exec(value.trimStart())?.[1];
  if (token === undefined) return [];
  const query = token.toLowerCase();
  return options.filter((option) =>
    [option.command, ...option.aliases].some((name) => name.toLowerCase().startsWith(query)),
  );
}
