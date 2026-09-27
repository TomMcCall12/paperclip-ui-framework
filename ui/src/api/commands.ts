import type {
  CommandDeclarationV1,
  CommandExecuteRequest,
  CommandExecuteResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const commandsApi = {
  list: (companyId: string) =>
    api.get<CommandDeclarationV1[]>(`/companies/${companyId}/commands`),
  execute: (companyId: string, body: CommandExecuteRequest) =>
    api.post<CommandExecuteResponse>(`/companies/${companyId}/commands/execute`, body),
};
