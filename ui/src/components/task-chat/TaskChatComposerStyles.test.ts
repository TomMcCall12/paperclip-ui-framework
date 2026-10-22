import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

function cssBlock(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);

  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("\n}", bodyStart);
  expect(bodyEnd, `Missing CSS block end: ${selector}`).toBeGreaterThan(bodyStart);

  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

function customPropertyValue(name: string): string {
  const match = stylesheet.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m"));
  expect(match, `Missing CSS custom property: ${name}`).not.toBeNull();
  return match?.[1].trim() ?? "";
}

describe("task-chat composer styles", () => {
  it("wraps long placeholders within the composer instead of clipping them", () => {
    const block = cssBlock(
      '.paperclip-task-chat-composer .paperclip-mdxeditor [class*="_placeholder_"]',
    );

    expect(block).toContain("display: block");
    expect(block).toContain("width: 100%");
    expect(block).toContain("overflow-wrap: anywhere");
    expect(block).toContain("white-space: normal");
  });

  it("keeps the composer's combined shadow valid with full-color semantic tokens", () => {
    const shadow = customPropertyValue("--shadow-extract-7");

    expect(shadow).toContain("color-mix(in oklab, var(--primary) 16%, transparent)");
    expect(shadow).not.toContain("hsl(var(");
  });

  // TOM-804: the composer dock's overall height cap (editor + attachments +
  // chrome) is a viewport fraction, not a fixed pixel cap — otherwise a short
  // landscape-phone viewport (e.g. 844x390) pushes the empty composer past a
  // third of the screen before any content is even typed.
  it("defines the composer's overall-height cap as roughly a third of the viewport", () => {
    expect(customPropertyValue("--sz-34dvh")).toBe("34dvh");
  });

  // TOM-804: the editor's base font-size (1rem / 16px) only drops to 0.875rem
  // (14px) for a real desktop — a WIDE but TOUCH viewport (landscape phone,
  // e.g. 844x390) must stay at 16px so iOS doesn't zoom the page on focus.
  // `.paperclip-mdxeditor-content { font-size: inherit }` is unlayered, so it
  // always wins over any `text-*` utility placed on that same element — this
  // media query on the ancestor `.paperclip-mdxeditor-scope` is the only real
  // gate, which is why it must check pointer type, not just width.
  it("only drops the editor font-size for a real desktop (width AND a fine pointer)", () => {
    const start = stylesheet.indexOf("@media (min-width: 768px) and (pointer: fine)");
    expect(start, "Missing pointer-gated desktop font-size media query").toBeGreaterThanOrEqual(0);

    const blockEnd = stylesheet.indexOf("\n}", start);
    const block = stylesheet.slice(start, blockEnd);
    expect(block).toContain(".paperclip-mdxeditor-scope");
    expect(block).toContain("font-size: 0.875rem");

    // A bare `@media (min-width: 768px) {` (no pointer check) must not exist
    // elsewhere for this selector — that was the original width-only bug.
    expect(stylesheet).not.toContain("@media (min-width: 768px) {\n  .paperclip-mdxeditor-scope");
  });
});
