import { useSyncExternalStore } from "react";

export interface VisualViewportState {
  /** Visible height in px, or null when the browser has no visualViewport. */
  height: number | null;
  /** How far the keyboard (or other UI) covers the layout viewport bottom. */
  keyboardInset: number;
  keyboardOpen: boolean;
}

/** The visual viewport must lose this share of the full height to count as a keyboard. */
const KEYBOARD_OPEN_RATIO = 0.75;
const KEYBOARD_INSET_MIN_PX = 120;

const CLOSED: VisualViewportState = { height: null, keyboardInset: 0, keyboardOpen: false };

let state: VisualViewportState = CLOSED;
let baselineHeight = 0;
let baselineWidth = 0;
let attached = false;
const listeners = new Set<() => void>();

/**
 * Read the live viewport. The inset only follows `resize` events: iOS fires
 * `scroll` on the visual viewport while the reader scrolls, and re-offsetting
 * the dock then would move it mid-scroll.
 */
function read(previous: VisualViewportState, source: "resize" | "scroll"): VisualViewportState {
  const viewport = window.visualViewport;
  if (!viewport || !(viewport.height > 0)) return CLOSED;
  // Android "resizes-content" shrinks innerHeight too, so compare against the
  // tallest height seen at this width instead of innerHeight alone.
  if (window.innerWidth !== baselineWidth) {
    baselineWidth = window.innerWidth;
    baselineHeight = 0;
  }
  baselineHeight = Math.max(baselineHeight, window.innerHeight, viewport.height);
  const rawInset = Math.max(0, window.innerHeight - viewport.offsetTop - viewport.height);
  const keyboardOpen =
    viewport.height < baselineHeight * KEYBOARD_OPEN_RATIO || rawInset > KEYBOARD_INSET_MIN_PX;
  const keyboardInset = !keyboardOpen
    ? 0
    : source === "scroll" && previous.keyboardOpen
      ? previous.keyboardInset
      : Math.round(rawInset);
  const height = Math.round(viewport.height);
  if (
    previous.height === height &&
    previous.keyboardInset === keyboardInset &&
    previous.keyboardOpen === keyboardOpen
  ) {
    return previous;
  }
  return { height, keyboardInset, keyboardOpen };
}

function publish(next: VisualViewportState) {
  const root = document.documentElement;
  if (next.height === null) {
    root.style.removeProperty("--tc-visible-h");
    root.style.removeProperty("--tc-keyboard-inset");
    return;
  }
  root.style.setProperty("--tc-visible-h", `${next.height}px`);
  root.style.setProperty("--tc-keyboard-inset", `${next.keyboardInset}px`);
}

function update(source: "resize" | "scroll") {
  const next = read(state, source);
  if (next === state) return;
  state = next;
  publish(state);
  listeners.forEach((listener) => listener());
}

const onResize = () => update("resize");
const onScroll = () => update("scroll");

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!attached && typeof window !== "undefined" && window.visualViewport) {
    attached = true;
    window.visualViewport.addEventListener("resize", onResize);
    window.visualViewport.addEventListener("scroll", onScroll);
    window.addEventListener("orientationchange", onResize);
    update("resize");
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || !attached) return;
    attached = false;
    window.visualViewport?.removeEventListener("resize", onResize);
    window.visualViewport?.removeEventListener("scroll", onScroll);
    window.removeEventListener("orientationchange", onResize);
    state = CLOSED;
    baselineHeight = 0;
    baselineWidth = 0;
    publish(CLOSED);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => CLOSED;

/**
 * Publishes the visible viewport as `--tc-visible-h` and `--tc-keyboard-inset`
 * on `<html>` (CSS defaults: 100dvh and 0) and returns whether the on-screen
 * keyboard is open. Every subscriber shares one set of listeners.
 */
export function useVisualViewport(): VisualViewportState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test helper: drop shared state between cases. */
export function resetVisualViewportForTests() {
  state = CLOSED;
  baselineHeight = 0;
  baselineWidth = 0;
}
