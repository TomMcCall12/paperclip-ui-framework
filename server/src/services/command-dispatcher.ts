import {
  COMMAND_MESSAGE_MAX_LENGTH,
  SharedCommandRegistry,
  commandAvailableOn,
  commandExecutionResultSchema,
  type CommandDeclarationV1,
  type CommandExecutionInput,
  type CommandExecutionResult,
  type CommandInvocationContext,
  type CommandSurface,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export type CommandHandler = (input: {
  args: string;
  context: CommandInvocationContext;
}) => Promise<CommandExecutionResult> | CommandExecutionResult;

/**
 * Extension seam for plugin commands. The handler is host code (for a plugin,
 * a bridge to its worker); declarations stay pure data and are never run.
 */
export interface ExtensionCommandRegistration {
  declaration: CommandDeclarationV1 & { source: { type: "plugin"; pluginId: string } };
  handler: CommandHandler;
  /** Company gate; the command is hidden and refused where this returns false. */
  isEnabledForCompany: (companyId: string) => boolean | Promise<boolean>;
}

interface RegisteredCommand {
  declaration: CommandDeclarationV1;
  handler: CommandHandler;
  isEnabledForCompany: (companyId: string) => boolean | Promise<boolean>;
}

export const ECHO_COMMAND: CommandDeclarationV1 = {
  version: 1,
  command: "echo",
  title: "Echo",
  description: "Echo text back to this conversation.",
  usage: "/echo <text>",
  category: "general",
  source: { type: "built-in" },
};

const echoHandler: CommandHandler = ({ args }) =>
  args
    ? { success: true, message: `Echo: ${args}`, data: { echoed: args } }
    : { success: false, message: `Usage: ${ECHO_COMMAND.usage}` };

const DEFAULT_HANDLER_TIMEOUT_MS = 10_000;

export type CommandDispatchOutcome =
  | { status: "executed"; command: string; result: CommandExecutionResult }
  | { status: "not_found" };

export function createCommandDispatcher(options: { handlerTimeoutMs?: number } = {}) {
  const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const registry = new SharedCommandRegistry();
  const handlers = new Map<string, RegisteredCommand>();

  function registerInternal(entry: RegisteredCommand) {
    const declaration = registry.register(entry.declaration);
    handlers.set(declaration.command, { ...entry, declaration });
    return declaration;
  }

  // Built-ins register first; the registry refuses any later declaration or
  // alias that would shadow them.
  registerInternal({ declaration: ECHO_COMMAND, handler: echoHandler, isEnabledForCompany: () => true });

  function registerExtension(registration: ExtensionCommandRegistration): () => void {
    if (registration.declaration.source?.type !== "plugin") {
      throw new Error("Extension commands must declare a plugin source");
    }
    const declaration = registerInternal(registration);
    return () => {
      if (handlers.get(declaration.command)?.handler !== registration.handler) return;
      handlers.delete(declaration.command);
      registry.unregister(declaration.command);
    };
  }

  async function resolve(companyId: string, surface: CommandSurface, command: string) {
    const declaration = registry.get(command);
    const entry = declaration ? handlers.get(declaration.command) : undefined;
    if (!entry || !commandAvailableOn(entry.declaration, surface)) return null;
    return (await entry.isEnabledForCompany(companyId)) ? entry : null;
  }

  async function listCommands(companyId: string, surface: CommandSurface): Promise<CommandDeclarationV1[]> {
    const visible: CommandDeclarationV1[] = [];
    for (const declaration of registry.list({ surface })) {
      const entry = handlers.get(declaration.command);
      if (entry && (await entry.isEnabledForCompany(companyId))) visible.push(declaration);
    }
    return visible;
  }

  async function runHandler(entry: RegisteredCommand, input: CommandExecutionInput): Promise<CommandExecutionResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => entry.handler({ args: input.args, context: input.context })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Command handler timed out")), handlerTimeoutMs);
        }),
      ]);
      // Extension results are untrusted: bound and reshape before returning.
      const parsed = commandExecutionResultSchema.safeParse({
        ...raw,
        message: typeof raw?.message === "string" ? raw.message.slice(0, COMMAND_MESSAGE_MAX_LENGTH) : raw?.message ?? null,
      });
      if (!parsed.success) throw new Error("Command handler returned an invalid result");
      return parsed.data as CommandExecutionResult;
    } catch (error) {
      logger.warn(
        { command: entry.declaration.command, companyId: input.context.companyId, err: error },
        "Command handler failed",
      );
      return { success: false, message: `/${entry.declaration.command} failed. Try again later.` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Execute a command for an already-authorized caller. Callers own actor and
   * company authorization; the dispatcher enforces surface availability and
   * the per-company extension gate so a hidden command is never runnable.
   */
  async function execute(input: CommandExecutionInput): Promise<CommandDispatchOutcome> {
    if (!input.context.companyId) throw new Error("Command execution requires a company scope");
    const entry = await resolve(input.context.companyId, input.context.surface, input.command);
    if (!entry) return { status: "not_found" };
    return { status: "executed", command: entry.declaration.command, result: await runHandler(entry, input) };
  }

  return {
    registerExtension,
    listCommands,
    execute,
    has: async (companyId: string, surface: CommandSurface, command: string) =>
      (await resolve(companyId, surface, command)) !== null,
  };
}

export type CommandDispatcher = ReturnType<typeof createCommandDispatcher>;
