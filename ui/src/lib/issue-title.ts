const MAX_TITLE_LENGTH = 80;

function stripLinePrefixMarkers(line: string): string {
  return line
    .replace(/^#{1,6}(\s+|$)/, "")
    .replace(/^>(\s+|$)/, "")
    .replace(/^[-*+](\s+|$)/, "")
    .replace(/^\d+[.)](\s+|$)/, "");
}

function stripInlineMarkdownAndMentions(text: string): string {
  return text
    // images: ![alt](url) -> alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // links and mentions: [label](url) -> label (mentions render as markdown links)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // emphasis / strikethrough markers
    .replace(/(\*\*\*|\*\*|\*|___|__|_|~~)/g, "")
    // inline code
    .replace(/`+/g, "");
}

function firstUsableLine(description: string): string {
  for (const rawLine of description.split(/\r?\n/)) {
    const line = stripInlineMarkdownAndMentions(stripLinePrefixMarkers(rawLine.trim())).trim();
    if (line.length > 0) return line;
  }
  return "";
}

function firstSentence(line: string): string {
  const match = line.match(/^(.*?[.!?])(\s|$)/);
  return (match ? match[1] : line).trim();
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim();
  return `${cut}…`;
}

export function fallbackIssueTitle(now: Date = new Date()): string {
  const formatted = now.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return `Task from ${formatted}`;
}

/** Deterministically derives a task title from its description, with no LLM call. */
export function deriveIssueTitle(description: string, now: Date = new Date()): string {
  const candidate = collapseWhitespace(firstSentence(firstUsableLine(description ?? "")));
  if (!candidate) return fallbackIssueTitle(now);
  return truncateAtWordBoundary(candidate, MAX_TITLE_LENGTH);
}
