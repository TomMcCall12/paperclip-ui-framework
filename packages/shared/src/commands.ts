import type { CommandDeclarationV1, CommandSource, CommandSurface } from "./types/commands.js";
import { commandDeclarationV1Schema } from "./validators/commands.js";

/**
 * Control commands owned by existing Paperclip surfaces (task chat `/goal`,
 * `/new`; chat channels `/task`, `/start`, `/status`, `/new`, `/close`). They
 * are resolved before the shared registry and can never be shadowed by a
 * registered command or alias.
 */
export const RESERVED_COMMAND_NAMES: readonly string[] = ["close", "goal", "new", "start", "status", "task"];

export function isReservedCommandName(name: string): boolean {
  return RESERVED_COMMAND_NAMES.includes(name.toLowerCase());
}

export type ParsedSlashCommand =
  | { matched: false }
  | { matched: true; command: string; botHandle: string | null; args: string };

// MDXEditor's link extension can reinterpret an inserted action command plus
// its typed argument as one relative autolink. Accept only the exact
// whole-document shapes it generates (see TaskChatComposer's /goal parser).
const RELATIVE_AUTOLINK = /^\[\/[a-z0-9_]*[ \t ]*\]\(<(\/[a-z0-9_]+(?:[ \t ].*)?)>\)$/is;
const ENCODED_AUTOLINK = /^\[\/[a-z0-9_]*[ \t ]*\]\((\/[a-z0-9_]+(?:%20|%C2%A0).*)\)$/is;
const SLASH_COMMAND = /^\/([a-z][a-z0-9_]{0,31})(?:@([a-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/i;

function normalizeCommandText(text: string): string {
  const trimmed = text.trim();
  const relative = RELATIVE_AUTOLINK.exec(trimmed);
  if (relative) return relative[1]!.replaceAll(" ", " ");
  const encoded = ENCODED_AUTOLINK.exec(trimmed);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]!).replaceAll(" ", " ");
    } catch {
      return trimmed;
    }
  }
  return trimmed.replaceAll(" ", " ");
}

/**
 * Parse `/command[@bot] args…` into its parts. The command is lowercased;
 * args keep their original text with surrounding whitespace trimmed.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand {
  const match = SLASH_COMMAND.exec(normalizeCommandText(text));
  if (!match) return { matched: false };
  return {
    matched: true,
    command: match[1]!.toLowerCase(),
    botHandle: match[2] ?? null,
    args: match[3]?.trim() ?? "",
  };
}

export class CommandRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRegistrationError";
  }
}

export function commandAvailableOn(declaration: CommandDeclarationV1, surface: CommandSurface): boolean {
  return !declaration.contexts || declaration.contexts.includes(surface);
}

function sameSource(left: CommandSource, right: CommandSource): boolean {
  if (left.type !== right.type) return false;
  return left.type === "built-in" || left.pluginId === (right as { pluginId: string }).pluginId;
}

/**
 * In-memory registry keyed by command name and alias. Registration validates
 * each declaration, rejects reserved names, and refuses to let one
 * declaration's name or alias shadow another's.
 */
export class SharedCommandRegistry {
  private readonly byName = new Map<string, CommandDeclarationV1>();

  register(input: CommandDeclarationV1): CommandDeclarationV1 {
    const parsed = commandDeclarationV1Schema.safeParse(input);
    if (!parsed.success) {
      throw new CommandRegistrationError(`Invalid command declaration: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    const declaration = parsed.data as CommandDeclarationV1;
    const names = [declaration.command, ...(declaration.aliases ?? [])];
    for (const name of names) {
      if (isReservedCommandName(name)) {
        throw new CommandRegistrationError(`/${name} is a reserved control command`);
      }
      const existing = this.byName.get(name);
      if (existing && existing.command !== declaration.command) {
        throw new CommandRegistrationError(`/${name} is already registered by /${existing.command}`);
      }
      if (existing && !sameSource(existing.source, declaration.source)) {
        throw new CommandRegistrationError(`/${name} is already registered by another source`);
      }
    }
    // Replacing a declaration from the same source drops its stale aliases.
    this.unregister(declaration.command);
    for (const name of names) this.byName.set(name, declaration);
    return declaration;
  }

  unregister(command: string): boolean {
    const existing = this.byName.get(command.toLowerCase());
    if (!existing) return false;
    for (const name of [existing.command, ...(existing.aliases ?? [])]) {
      if (this.byName.get(name) === existing) this.byName.delete(name);
    }
    return true;
  }

  get(commandOrAlias: string): CommandDeclarationV1 | null {
    return this.byName.get(commandOrAlias.toLowerCase()) ?? null;
  }

  /** Unique declarations, sorted by command name for deterministic output. */
  list(filter?: { surface?: CommandSurface }): CommandDeclarationV1[] {
    const unique = new Set(this.byName.values());
    return [...unique]
      .filter((declaration) => !filter?.surface || commandAvailableOn(declaration, filter.surface))
      .sort((left, right) => left.command.localeCompare(right.command));
  }
}
