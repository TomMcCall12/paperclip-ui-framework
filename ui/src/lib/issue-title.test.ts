import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, deriveIssueTitle, fallbackIssueTitle } from "./issue-title";

describe("deriveIssueTitle", () => {
  it("uses the first sentence of the first line", () => {
    expect(deriveIssueTitle("Fix the login bug. It happens on mobile only.\n\nMore detail below."))
      .toBe("Fix the login bug.");
  });

  it("falls back to the whole first line when there is no sentence punctuation", () => {
    expect(deriveIssueTitle("Investigate slow dashboard queries\nSecond paragraph")).toBe(
      "Investigate slow dashboard queries",
    );
  });

  it("skips leading blank lines", () => {
    expect(deriveIssueTitle("\n\n   \nActual first line.")).toBe("Actual first line.");
  });

  it("strips heading, blockquote and list markers", () => {
    expect(deriveIssueTitle("## Heading text")).toBe("Heading text");
    expect(deriveIssueTitle("> Quoted line")).toBe("Quoted line");
    expect(deriveIssueTitle("- bullet item")).toBe("bullet item");
    expect(deriveIssueTitle("1. numbered item")).toBe("numbered item");
  });

  it("strips emphasis, inline code and link/mention markdown", () => {
    expect(deriveIssueTitle("**Bold** and _italic_ and `code`.")).toBe("Bold and italic and code.");
    expect(deriveIssueTitle("[@Jarvis](/agents/jarvis-id) please take a look.")).toBe(
      "@Jarvis please take a look.",
    );
    expect(deriveIssueTitle("See the [design doc](https://example.com/doc) for details.")).toBe(
      "See the design doc for details.",
    );
  });

  it("collapses internal whitespace", () => {
    expect(deriveIssueTitle("Too    many   spaces   here.")).toBe("Too many spaces here.");
  });

  it("cuts long titles at a word boundary near 80 characters with an ellipsis", () => {
    const longLine = "This is a very long description line that keeps going well past the eighty character budget we allow";
    const title = deriveIssueTitle(longLine);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith("…")).toBe(true);
    expect(longLine.startsWith(title.slice(0, -1).trim())).toBe(true);
  });

  it("decodes HTML entities such as &#x20; before deriving the title", () => {
    expect(deriveIssueTitle("Fix the login&#x20;bug&#x20;\nMore")).toBe("Fix the login bug");
    expect(deriveIssueTitle("Tom&#39;s Lab &amp; Macro Chef")).toBe("Tom's Lab & Macro Chef");
    expect(deriveIssueTitle("Use &lt;b&gt; tags&nbsp;please.")).toBe("Use <b> tags please.");
  });

  it("leaves unknown or invalid entities alone", () => {
    expect(decodeHtmlEntities("a &bogus; b &#0; c")).toBe("a &bogus; b &#0; c");
  });

  it("falls back to a dated title when the description has no usable text", () => {
    const now = new Date("2026-10-06T12:00:00.000Z");
    expect(deriveIssueTitle("", now)).toBe(fallbackIssueTitle(now));
    expect(deriveIssueTitle("   \n\n ", now)).toBe(fallbackIssueTitle(now));
    expect(deriveIssueTitle("### ", now)).toBe(fallbackIssueTitle(now));
  });

  it("produces a dated fallback title", () => {
    const now = new Date("2026-10-06T12:00:00.000Z");
    expect(fallbackIssueTitle(now)).toMatch(/^Task from /);
  });
});
