// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetVisualViewportForTests, useVisualViewport, type VisualViewportState } from "./useVisualViewport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeVisualViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
  set(next: { height: number; offsetTop?: number }, type: "resize" | "scroll" = "resize") {
    this.height = next.height;
    this.offsetTop = next.offsetTop ?? 0;
    this.dispatchEvent(new Event(type));
  }
}

const rootStyle = (name: string) => document.documentElement.style.getPropertyValue(name);

describe("useVisualViewport", () => {
  let container: HTMLDivElement;
  let root: Root;
  let viewport: FakeVisualViewport;
  let latest: VisualViewportState;

  function Probe() {
    latest = useVisualViewport();
    return null;
  }

  async function mount() {
    await act(async () => {
      root.render(<Probe />);
    });
  }

  async function change(next: { height: number; offsetTop?: number }, type?: "resize" | "scroll") {
    await act(async () => {
      viewport.set(next, type);
    });
  }

  beforeEach(() => {
    resetVisualViewportForTests();
    viewport = new FakeVisualViewport();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  });

  it("publishes the visible height and a closed keyboard on mount", async () => {
    await mount();
    expect(latest).toEqual({ height: 844, keyboardInset: 0, keyboardOpen: false });
    expect(rootStyle("--tc-visible-h")).toBe("844px");
    expect(rootStyle("--tc-keyboard-inset")).toBe("0px");
  });

  it("reports an open keyboard and its inset when the visual viewport shrinks (iOS)", async () => {
    await mount();
    await change({ height: 480 });
    expect(latest).toEqual({ height: 480, keyboardInset: 364, keyboardOpen: true });
    expect(rootStyle("--tc-visible-h")).toBe("480px");
    expect(rootStyle("--tc-keyboard-inset")).toBe("364px");
  });

  it("detects the keyboard when innerHeight shrinks with it (Android resizes-content)", async () => {
    await mount();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 480 });
    await change({ height: 480 });
    expect(latest.keyboardOpen).toBe(true);
    expect(latest.keyboardInset).toBe(0);
    expect(rootStyle("--tc-visible-h")).toBe("480px");
  });

  it("keeps the inset still on visual viewport scroll events while the keyboard is open", async () => {
    await mount();
    await change({ height: 480 });
    await change({ height: 480, offsetTop: 200 }, "scroll");
    expect(latest.keyboardInset).toBe(364);
    expect(rootStyle("--tc-keyboard-inset")).toBe("364px");
  });

  it("closes again when the visual viewport returns to full height", async () => {
    await mount();
    await change({ height: 480 });
    await change({ height: 844 });
    expect(latest).toEqual({ height: 844, keyboardInset: 0, keyboardOpen: false });
  });

  it("ignores a small browser-chrome resize", async () => {
    await mount();
    await change({ height: 780 });
    expect(latest.keyboardOpen).toBe(false);
    expect(rootStyle("--tc-visible-h")).toBe("780px");
  });

  it("removes the custom properties on unmount so CSS falls back to 100dvh", async () => {
    await mount();
    await change({ height: 480 });
    await act(async () => root.render(null));
    expect(rootStyle("--tc-visible-h")).toBe("");
    expect(rootStyle("--tc-keyboard-inset")).toBe("");
  });

  it("does nothing without visualViewport", async () => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    await mount();
    expect(latest).toEqual({ height: null, keyboardInset: 0, keyboardOpen: false });
    expect(rootStyle("--tc-visible-h")).toBe("");
  });
});
