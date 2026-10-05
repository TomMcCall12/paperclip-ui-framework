/**
 * Folds a "Technical details" section away behind a disclosure, so the board
 * reads the plain-English summary first. Agents are asked to put IDs, commands,
 * logs and hashes under a heading with that title (see the wake prompt's
 * "Writing for the board" guidance); the section runs until the next heading
 * of the same or a higher level, or the end of the text.
 */
type MdNode = {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
};

const TITLE = /^technical details:?$/i;

function plainText(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(plainText).join("");
}

export function isTechnicalDetailsHeading(node: MdNode): boolean {
  return node.type === "heading" && TITLE.test(plainText(node).trim());
}

export function remarkCollapseTechnicalDetails() {
  return (tree: MdNode) => {
    const children = tree.children;
    if (!children) return;
    for (let index = 0; index < children.length; index += 1) {
      const heading = children[index]!;
      if (!isTechnicalDetailsHeading(heading)) continue;
      const depth = heading.depth ?? 1;
      let end = index + 1;
      while (end < children.length) {
        const next = children[end]!;
        if (next.type === "heading" && (next.depth ?? 1) <= depth) break;
        end += 1;
      }
      const section: MdNode = {
        type: "technicalDetails",
        data: { hName: "details", hProperties: { className: ["paperclip-technical-details"] } },
        children: [
          {
            type: "technicalDetailsSummary",
            data: { hName: "summary" },
            children: heading.children ?? [{ type: "text", value: "Technical details" }],
          },
          ...children.slice(index + 1, end),
        ],
      };
      children.splice(index, end - index, section);
    }
  };
}
