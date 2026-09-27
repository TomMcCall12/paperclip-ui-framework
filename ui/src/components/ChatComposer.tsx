import {
  forwardRef,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { AlertTriangle, Check, Loader2, Paperclip, Send } from "lucide-react";
import type { CommandExecutionResult } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import type { ActionCommandOption } from "../context/EditorAutocompleteContext";
import {
  filterActionCommandOptions,
  matchHostCommand,
} from "./task-chat/host-commands";

/**
 * Shared chat composer (PAP-95a / PAP-96).
 *
 * One reusable input shell used by BOTH the conference room (BoardChat) and
 * task comments (IssueChatThread). It is intentionally a *plain textarea* —
 * **no formatting toolbar** — with attach + send. The focus state is a neutral
 * border darkening (no blue focus ring) so the box reads as calm chrome in both
 * surfaces.
 *
 * Task-only chrome — the yellow planning chip and the assignee footer — is NOT
 * baked in here. It layers on through the `tone`, `leadingTools`, and
 * `trailingTools` props (wired by PAP-95b). The @project/@task picker layers on
 * through PAP-95f. The conference room adopts this bare: textarea + send (+ attach
 * when a handler is supplied), no mode chip, since the room has no task lifecycle.
 * Shared host commands (TOM-17) layer on through `actionCommands` +
 * `onActionCommand`: a `/` listbox over the textarea and command dispatch.
 */

export interface ChatComposerAttachment {
  id: string;
  name: string;
  size?: number;
  status: "uploading" | "attached" | "error";
  error?: string;
  /** True when the file was inserted inline (e.g. an image) rather than only attached. */
  inline?: boolean;
}

export interface ChatComposerHandle {
  focus: () => void;
}

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** Shows the send button in a busy state and blocks resubmission. */
  submitting?: boolean;
  /**
   * Send-key behavior.
   * - `"enter"`: Enter submits, Shift+Enter inserts a newline (conference room default today).
   * - `"mod-enter"`: Cmd/Ctrl+Enter submits, Enter inserts a newline (recommended unified default).
   */
  submitKey?: "enter" | "mod-enter";
  /** Collapse to a single visual line — strips newlines and disables wrapping (conference room). */
  singleLine?: boolean;
  /** Visual tone. Task issue modes tint the box for planning and ask flows. */
  tone?: "standard" | "ask" | "planning";
  /**
   * Surface treatment (PAP-128 A / PAP-131).
   * - `"card"`: opaque `bg-card` box (default).
   * - `"translucent"`: the task-comments glass recipe — translucent background,
   *   backdrop blur, and a soft upward shadow — so chat text reads through the
   *   box as it scrolls behind (mirrors `IssueChatThread.tsx` composer shell).
   */
  surface?: "card" | "translucent";
  autoFocus?: boolean;
  /** Accessible label for the send button. */
  sendLabel?: string;
  /**
   * When provided, an attach button, drag-and-drop, and the attachment chip list
   * render. The parent owns the actual upload and reflects progress back through
   * the `attachments` prop. Omit entirely to render bare (no attach affordance).
   */
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  attachments?: ChatComposerAttachment[];
  attaching?: boolean;
  /** Restrict the file picker (e.g. "image/*"). */
  acceptFileTypes?: string;
  /** Slot rendered just right of the attach button (e.g. the planning mode chip). */
  leadingTools?: ReactNode;
  /** Slot rendered just left of the send button (e.g. the assignee picker). */
  trailingTools?: ReactNode;
  /** Optional hint chip rendered under the textarea. */
  hint?: ReactNode;
  className?: string;
  textareaClassName?: string;
  /** test id for the textarea (defaults to "chat-composer-input"). */
  inputTestId?: string;
  /**
   * Shared host commands (TOM-17). Typing `/` offers them in a listbox, and
   * submitting a listed command calls `onActionCommand` instead of `onSubmit`.
   * Both must be provided to enable commands.
   */
  actionCommands?: ActionCommandOption[];
  onActionCommand?: (command: string, args: string) => Promise<CommandExecutionResult>;
}

const MAX_TEXTAREA_HEIGHT_PX = 200;

function formatAttachmentSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dragHasFiles(evt: ReactDragEvent<HTMLDivElement>): boolean {
  const types = evt.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  {
    value,
    onChange,
    onSubmit,
    placeholder = "Message…",
    disabled = false,
    submitting = false,
    submitKey = "mod-enter",
    singleLine = false,
    tone = "standard",
    surface = "card",
    autoFocus = false,
    sendLabel = "Send message",
    onAttachFiles,
    attachments = [],
    attaching = false,
    acceptFileTypes,
    leadingTools,
    trailingTools,
    hint,
    className,
    textareaClassName,
    inputTestId = "chat-composer-input",
    actionCommands,
    onActionCommand,
  },
  forwardedRef,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const listboxId = useId();
  const [menuDismissedFor, setMenuDismissedFor] = useState<string | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [commandRunning, setCommandRunning] = useState(false);
  const [commandFeedback, setCommandFeedback] = useState<
    { kind: "reply" | "error"; text: string } | null
  >(null);

  const commands = onActionCommand ? (actionCommands ?? []) : [];
  const menuOptions =
    menuDismissedFor === value ? [] : filterActionCommandOptions(value, commands);
  const menuOpen = !disabled && menuOptions.length > 0;
  const activeIndex = Math.min(highlightIndex, menuOptions.length - 1);

  const canAttach = typeof onAttachFiles === "function";
  const isAsk = tone === "ask";
  const isPlanning = tone === "planning";
  const canSend = !disabled && !submitting && !commandRunning && value.trim().length > 0;

  useImperativeHandle(forwardedRef, () => ({
    focus: () => textareaRef.current?.focus(),
  }), []);

  // Auto-grow the textarea up to a cap (multiline only). Single-line stays at
  // one row and scrolls horizontally, matching the conference room today.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || singleLine) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [value, singleLine]);

  function handleChange(evt: ChangeEvent<HTMLTextAreaElement>) {
    const next = singleLine ? evt.target.value.replace(/\r?\n/g, " ") : evt.target.value;
    setHighlightIndex(0);
    if (next) setCommandFeedback(null);
    onChange(next);
  }

  function selectCommand(option: ActionCommandOption) {
    if (option.disabled) return;
    setHighlightIndex(0);
    onChange(`/${option.command} `);
    textareaRef.current?.focus();
  }

  async function runCommand(command: string, args: string) {
    setCommandRunning(true);
    setCommandFeedback(null);
    try {
      const result = await onActionCommand!(command, args);
      onChange("");
      setCommandFeedback(
        result.success
          ? result.message
            ? { kind: "reply", text: result.message }
            : null
          : { kind: "error", text: result.message ?? `/${command} failed.` },
      );
    } catch (error) {
      // Keep the draft so the user can retry after a transport failure.
      setCommandFeedback({
        kind: "error",
        text: error instanceof Error ? error.message : `/${command} could not be run.`,
      });
    } finally {
      setCommandRunning(false);
    }
  }

  function submit() {
    if (!canSend) return;
    const hostCommand = onActionCommand ? matchHostCommand(value, commands) : null;
    if (hostCommand) {
      void runCommand(hostCommand.command, hostCommand.args);
      return;
    }
    setCommandFeedback(null);
    onSubmit();
  }

  function handleKeyDown(evt: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
        evt.preventDefault();
        const step = evt.key === "ArrowDown" ? 1 : -1;
        setHighlightIndex((activeIndex + step + menuOptions.length) % menuOptions.length);
        return;
      }
      if (evt.key === "Escape") {
        evt.preventDefault();
        setMenuDismissedFor(value);
        return;
      }
      if ((evt.key === "Enter" && !evt.shiftKey) || evt.key === "Tab") {
        evt.preventDefault();
        selectCommand(menuOptions[activeIndex]!);
        return;
      }
    }
    if (evt.key !== "Enter") return;
    const wantsSubmit =
      submitKey === "mod-enter"
        ? evt.metaKey || evt.ctrlKey
        : !evt.shiftKey && !evt.metaKey && !evt.ctrlKey;
    if (!wantsSubmit) return;
    evt.preventDefault();
    submit();
  }

  function triggerFilePicker() {
    fileInputRef.current?.click();
  }

  async function emitFiles(files: File[]) {
    if (!onAttachFiles || files.length === 0) return;
    await onAttachFiles(files);
  }

  async function handleFileInputChange(evt: ChangeEvent<HTMLInputElement>) {
    const files = evt.target.files ? Array.from(evt.target.files) : [];
    await emitFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function resetDrag() {
    dragDepthRef.current = 0;
    setIsDragOver(false);
  }

  function handleDragEnter(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAttach || !dragHasFiles(evt)) return;
    evt.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleDragOver(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAttach || !dragHasFiles(evt)) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAttach || !dragHasFiles(evt)) return;
    evt.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }

  function handleDrop(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAttach || !dragHasFiles(evt)) return;
    evt.preventDefault();
    resetDrag();
    const files = evt.dataTransfer?.files ? Array.from(evt.dataTransfer.files) : [];
    void emitFiles(files);
  }

  return (
    <div
      data-testid="chat-composer"
      data-tone={tone}
      data-surface={surface}
      className={cn(
        "relative rounded-xl border px-3 pt-2.5 pb-2 transition-colors duration-150 focus-within:border-muted-foreground/40",
        // Surface: opaque card vs the task glass recipe (IssueChatThread.tsx shell).
        surface === "translucent"
          ? "border-border/70 bg-background/95 shadow-(--shadow-extract-4) backdrop-blur supports-[backdrop-filter]:bg-background/85 dark:shadow-(--shadow-extract-5)"
          : "border-border bg-card",
        // No blue focus ring — neutral border darkening only.
        isAsk &&
          "border-sky-500/55 bg-sky-50/50 focus-within:border-sky-500/70 dark:border-sky-500/50 dark:bg-sky-500/[0.07]",
        isPlanning &&
          "border-amber-500/55 bg-amber-50/50 focus-within:border-amber-500/70 dark:border-amber-500/50 dark:bg-amber-500/[0.07]",
        isDragOver && canAttach && "border-muted-foreground/50 bg-accent/20",
        disabled && "opacity-60",
        className,
      )}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && canAttach ? (
        <div
          data-testid="chat-composer-drop-overlay"
          className="pointer-events-none absolute inset-1.5 z-20 flex items-center justify-center rounded-lg border border-dashed border-muted-foreground/50 bg-background/80 text-xs text-muted-foreground backdrop-blur-(--blur-1px)"
        >
          <span className="inline-flex items-center gap-2">
            <Paperclip className="h-3.5 w-3.5" />
            Drop to attach
          </span>
        </div>
      ) : null}

      {menuOpen ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Commands"
          data-testid="chat-composer-command-menu"
          className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {menuOptions.map((option, index) => (
            <li
              key={option.id}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={option.disabled || undefined}
              title={option.disabled ? (option.disabledReason ?? undefined) : undefined}
              // Keep focus in the textarea so typing continues after selection.
              onMouseDown={(evt) => evt.preventDefault()}
              onMouseEnter={() => setHighlightIndex(index)}
              onClick={() => selectCommand(option)}
              className={cn(
                "flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-sm",
                index === activeIndex && "bg-accent",
                option.disabled && "cursor-not-allowed opacity-50",
              )}
            >
              <span className="font-medium text-foreground">/{option.command}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{option.description}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <textarea
        ref={textareaRef}
        data-testid={inputTestId}
        role={commands.length > 0 ? "combobox" : undefined}
        aria-autocomplete={commands.length > 0 ? "list" : undefined}
        aria-expanded={commands.length > 0 ? menuOpen : undefined}
        aria-controls={menuOpen ? listboxId : undefined}
        aria-activedescendant={menuOpen ? `${listboxId}-${activeIndex}` : undefined}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        rows={1}
        wrap={singleLine ? "off" : "soft"}
        className={cn(
          "block min-h-(--sz-22px) w-full resize-none border-0 bg-transparent p-0 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground focus:outline-none focus:ring-0",
          singleLine
            ? "max-h-(--sz-22px) overflow-x-auto whitespace-nowrap"
            : "max-h-(--sz-200px) overflow-y-auto",
          textareaClassName,
        )}
      />

      {attachments.length > 0 ? (
        <div
          data-testid="chat-composer-attachments"
          className="mt-2 space-y-1 rounded-md border border-dashed border-border/80 bg-muted/20 p-1.5"
        >
          {attachments.map((attachment) => {
            const sizeLabel = formatAttachmentSize(attachment.size);
            const statusLabel =
              attachment.status === "uploading"
                ? "Uploading…"
                : attachment.status === "error"
                  ? attachment.error ?? "Upload failed"
                  : attachment.inline
                    ? "Inserted inline"
                    : "Attached";
            return (
              <div
                key={attachment.id}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-xs",
                  attachment.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-background/70 text-muted-foreground",
                )}
              >
                {attachment.status === "uploading" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : attachment.status === "attached" ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {attachment.name}
                </span>
                {sizeLabel ? <span className="shrink-0">{sizeLabel}</span> : null}
                <span className="shrink-0">{statusLabel}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {commandFeedback ? (
        <p
          role={commandFeedback.kind === "error" ? "alert" : "status"}
          data-testid="chat-composer-command-feedback"
          className={cn(
            "mt-2 text-xs",
            commandFeedback.kind === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {commandFeedback.text}
        </p>
      ) : null}

      {hint ? (
        <div className="mt-2 inline-flex items-center rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-(length:--text-micro) text-muted-foreground">
          {hint}
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-2">
        {canAttach ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept={acceptFileTypes}
              className="hidden"
              onChange={handleFileInputChange}
            />
            <button
              type="button"
              onClick={triggerFilePicker}
              disabled={disabled || attaching}
              aria-label="Attach files"
              title="Attach files"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {attaching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
            </button>
          </>
        ) : null}

        {leadingTools}

        <span className="flex-1" />

        {trailingTools}

        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label={sendLabel}
          title={sendLabel}
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors duration-150 disabled:cursor-not-allowed",
            canSend
              ? "bg-foreground text-background hover:opacity-90"
              : "bg-accent text-muted-foreground",
          )}
        >
          {submitting || commandRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
});
