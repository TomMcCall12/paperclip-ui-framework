// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Stateful harness so the controlled textarea reflects typed input. */
function Harness(props: Partial<ChatComposerProps> & { initial?: string }) {
  const { initial = "", onChange, ...rest } = props;
  const [value, setValue] = useState(initial);
  return (
    <ChatComposer
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      onSubmit={rest.onSubmit ?? (() => {})}
      {...rest}
    />
  );
}

function typeInput(textarea: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, text);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ChatComposer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function input() {
    return container.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer-input"]')!;
  }
  function sendButton() {
    return container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
  }
  function attachButton() {
    return container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]');
  }

  it("renders a bare textarea + send and no attach button without a handler", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness placeholder="Ask anything…" />);
    });
    expect(input()).toBeTruthy();
    expect(input().placeholder).toBe("Ask anything…");
    expect(attachButton()).toBeNull();
    // No formatting toolbar — there is exactly one button (send) when bare.
    expect(container.querySelectorAll("button").length).toBe(1);
    act(() => root.unmount());
  });

  it("shows the attach affordance when onAttachFiles is provided", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness onAttachFiles={() => {}} />);
    });
    expect(attachButton()).toBeTruthy();
    act(() => root.unmount());
  });

  it("keeps eight attachment chips in one scrolling row and truncates long names", () => {
    const longName = `${"a".repeat(116)}.txt`;
    const attachments = Array.from({ length: 8 }, (_, index) => ({
      id: `file-${index}`,
      name: index === 0 ? longName : `file-${index}.txt`,
      status: index === 0 ? "uploading" as const : "attached" as const,
    }));
    const root = createRoot(container);
    act(() => root.render(<Harness attachments={attachments} />));
    const row = container.querySelector<HTMLElement>('[data-testid="chat-composer-attachments"]')!;
    const chips = row.querySelectorAll<HTMLElement>("[data-attachment-chip]");
    expect(row.className).toContain("overflow-x-auto");
    expect(chips).toHaveLength(8);
    expect(chips[0]!.className).toContain("w-(--sz-12rem)");
    const name = chips[0]!.querySelector<HTMLElement>("[title]")!;
    expect(name.className).toContain("truncate");
    expect(name.title).toBe(longName);
    expect(chips[0]!.textContent).toContain("Uploading…");
    act(() => root.unmount());
  });

  it("reports the selected chip for removal", () => {
    const onRemoveAttachment = vi.fn();
    const root = createRoot(container);
    act(() => root.render(
      <Harness
        attachments={[{ id: "one", name: "notes.txt", status: "attached" }]}
        onRemoveAttachment={onRemoveAttachment}
      />,
    ));
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Remove notes.txt"]')!.click());
    expect(onRemoveAttachment).toHaveBeenCalledExactlyOnceWith("one");
    act(() => root.unmount());
  });

  it("disables send while empty and enables it once there is text", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });
    expect(sendButton().disabled).toBe(true);
    act(() => {
      typeInput(input(), "hello");
    });
    expect(sendButton().disabled).toBe(false);
    act(() => root.unmount());
  });

  it("submits on click", () => {
    const onSubmit = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<Harness onSubmit={onSubmit} initial="hi" />);
    });
    act(() => {
      sendButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('submitKey="enter": plain Enter submits, Shift+Enter does not', () => {
    const onSubmit = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<Harness onSubmit={onSubmit} initial="hi" submitKey="enter" />);
    });
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, shiftKey: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('submitKey="mod-enter": plain Enter does not submit, Cmd/Ctrl+Enter does', () => {
    const onSubmit = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<Harness onSubmit={onSubmit} initial="hi" submitKey="mod-enter" />);
    });
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, metaKey: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("singleLine strips newlines from input", () => {
    const onChange = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<Harness singleLine onChange={onChange} />);
    });
    act(() => {
      typeInput(input(), "one\ntwo");
    });
    expect(onChange).toHaveBeenLastCalledWith("one two");
    act(() => root.unmount());
  });

  it("default (multiline) mode soft-wraps and auto-grows instead of clipping (PAP-116)", () => {
    // The conference room composer adopts this default mode. Text must wrap and
    // the box grow up to a cap — never clip horizontally or show an idle scrollbar.
    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });
    const el = input();
    expect(el.getAttribute("wrap")).toBe("soft");
    expect(el.className).toContain("overflow-y-auto");
    expect(el.className).toContain("max-h-(--sz-200px)");
    expect(el.className).not.toContain("whitespace-nowrap");
    expect(el.className).not.toContain("overflow-x-auto");
    act(() => root.unmount());
  });

  it("singleLine mode clips to one row (opt-in only)", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness singleLine />);
    });
    const el = input();
    expect(el.getAttribute("wrap")).toBe("off");
    expect(el.className).toContain("whitespace-nowrap");
    expect(el.className).toContain("max-h-(--sz-22px)");
    act(() => root.unmount());
  });

  it('tone="planning" is reflected on the container', () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness tone="planning" />);
    });
    const box = container.querySelector('[data-testid="chat-composer"]');
    expect(box?.getAttribute("data-tone")).toBe("planning");
    act(() => root.unmount());
  });

  it('tone="ask" is reflected on the container', () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness tone="ask" />);
    });
    const box = container.querySelector('[data-testid="chat-composer"]');
    expect(box?.getAttribute("data-tone")).toBe("ask");
    expect(box?.className).toContain("sky");
    act(() => root.unmount());
  });

  it('defaults to the opaque "card" surface', () => {
    // PAP-131: surface is opt-in — existing adopters keep the bg-card box.
    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });
    const box = container.querySelector('[data-testid="chat-composer"]')!;
    expect(box.getAttribute("data-surface")).toBe("card");
    expect(box.className).toContain("bg-card");
    expect(box.className).not.toContain("backdrop-blur");
    // Rounded corners are shared chrome on both surfaces.
    expect(box.className).toContain("rounded-xl");
    act(() => root.unmount());
  });

  it('surface="translucent" applies the opaque task surface and keeps shared chrome (PAP-131)', () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness surface="translucent" />);
    });
    const box = container.querySelector('[data-testid="chat-composer"]')!;
    expect(box.getAttribute("data-surface")).toBe("translucent");
    // Opaque surface (TOM-665): no translucency, no blur.
    expect(box.className).toContain("bg-background");
    expect(box.className).not.toContain("bg-background/");
    expect(box.className).not.toContain("backdrop-blur");
    expect(box.className).toContain("shadow-(--shadow-extract-4)");
    expect(box.className).toContain("dark:shadow-(--shadow-extract-5)");
    expect(box.className).not.toContain("bg-card");
    // Shared chrome survives: rounded-xl corners + neutral focus darkening.
    expect(box.className).toContain("rounded-xl");
    expect(box.className).toContain("focus-within:border-muted-foreground/40");
    act(() => root.unmount());
  });

  it("translucent surface keeps the drag-over attach layering", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness surface="translucent" onAttachFiles={() => {}} />);
    });
    const box = container.querySelector<HTMLDivElement>('[data-testid="chat-composer"]')!;
    act(() => {
      const dataTransfer = { types: ["Files"], dropEffect: "none" };
      const evt = new Event("dragenter", { bubbles: true }) as DragEvent & {
        dataTransfer: typeof dataTransfer;
      };
      Object.defineProperty(evt, "dataTransfer", { value: dataTransfer });
      box.dispatchEvent(evt);
    });
    expect(container.querySelector('[data-testid="chat-composer-drop-overlay"]')).toBeTruthy();
    act(() => root.unmount());
  });

  describe("shared action commands", () => {
    const commands = [
      { id: "host-command:echo", kind: "action" as const, command: "echo", name: "Echo", description: "Echo text back", aliases: ["echo"] },
      { id: "host-command:estimate", kind: "action" as const, command: "estimate", name: "Estimate", description: "Estimate work", aliases: ["estimate"] },
    ];
    const menu = () => container.querySelector('[data-testid="chat-composer-command-menu"]');
    const menuOptions = () => Array.from(container.querySelectorAll<HTMLLIElement>('[role="option"]'));
    const feedback = () => container.querySelector<HTMLElement>('[data-testid="chat-composer-command-feedback"]');
    const key = (k: string) =>
      act(() => {
        input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      });
    async function flush() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    it("shows and filters listed commands on /, and selects with the keyboard", () => {
      const onSubmit = vi.fn();
      const root = createRoot(container);
      act(() => {
        root.render(<Harness onSubmit={onSubmit} submitKey="enter" actionCommands={commands} onActionCommand={vi.fn()} />);
      });
      expect(menu()).toBeNull();
      act(() => typeInput(input(), "/"));
      expect(menuOptions().map((o) => o.textContent)).toEqual(["/echoEcho text back", "/estimateEstimate work"]);
      expect(input().getAttribute("aria-expanded")).toBe("true");
      act(() => typeInput(input(), "/es"));
      expect(menuOptions().map((o) => o.textContent)).toEqual(["/estimateEstimate work"]);
      act(() => typeInput(input(), "/e"));
      key("ArrowDown");
      expect(menuOptions()[1]!.getAttribute("aria-selected")).toBe("true");
      expect(input().getAttribute("aria-activedescendant")).toBe(menuOptions()[1]!.id);
      key("Enter");
      expect(input().value).toBe("/estimate ");
      expect(menu()).toBeNull();
      expect(onSubmit).not.toHaveBeenCalled();
      act(() => root.unmount());
    });

    it("selects with the mouse and dismisses with Escape", () => {
      const root = createRoot(container);
      act(() => {
        root.render(<Harness actionCommands={commands} onActionCommand={vi.fn()} />);
      });
      act(() => typeInput(input(), "/"));
      key("Escape");
      expect(menu()).toBeNull();
      act(() => typeInput(input(), "/ec"));
      act(() => {
        menuOptions()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(input().value).toBe("/echo ");
      act(() => root.unmount());
    });

    it("runs a listed command instead of posting, then clears and shows the reply", async () => {
      const onSubmit = vi.fn();
      const onActionCommand = vi.fn().mockResolvedValue({ success: true, message: "Echo: hello" });
      const onChange = vi.fn();
      const root = createRoot(container);
      act(() => {
        root.render(
          <Harness initial="/echo hello" submitKey="enter" onSubmit={onSubmit} onChange={onChange} actionCommands={commands} onActionCommand={onActionCommand} />,
        );
      });
      key("Enter");
      await flush();
      expect(onActionCommand).toHaveBeenCalledWith("echo", "hello");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(input().value).toBe("");
      expect(feedback()?.getAttribute("role")).toBe("status");
      expect(feedback()?.textContent).toBe("Echo: hello");
      act(() => typeInput(input(), "n"));
      expect(feedback()).toBeNull();
      act(() => root.unmount());
    });

    it("shows command failures as alerts and keeps the draft on transport errors", async () => {
      const onActionCommand = vi
        .fn()
        .mockResolvedValueOnce({ success: false, message: "Usage: /echo <text>" })
        .mockRejectedValueOnce(new Error("Network down"));
      const root = createRoot(container);
      act(() => {
        root.render(<Harness initial="/echo" actionCommands={commands} onActionCommand={onActionCommand} />);
      });
      act(() => {
        sendButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();
      expect(feedback()?.getAttribute("role")).toBe("alert");
      expect(feedback()?.textContent).toBe("Usage: /echo <text>");
      act(() => typeInput(input(), "/echo retry"));
      act(() => {
        sendButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();
      expect(feedback()?.textContent).toBe("Network down");
      expect(input().value).toBe("/echo retry");
      act(() => root.unmount());
    });

    it("posts unlisted slash text and ordinary messages normally, and stays bare without a handler", () => {
      const onSubmit = vi.fn();
      const onActionCommand = vi.fn();
      const root = createRoot(container);
      act(() => {
        root.render(<Harness initial="/unknown thing" submitKey="enter" onSubmit={onSubmit} actionCommands={commands} onActionCommand={onActionCommand} />);
      });
      key("Enter");
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onActionCommand).not.toHaveBeenCalled();
      act(() => root.unmount());

      const bare = createRoot(container);
      act(() => {
        bare.render(<Harness actionCommands={commands} />);
      });
      act(() => typeInput(input(), "/"));
      expect(menu()).toBeNull();
      expect(input().getAttribute("role")).toBeNull();
      act(() => bare.unmount());
    });
  });
});
