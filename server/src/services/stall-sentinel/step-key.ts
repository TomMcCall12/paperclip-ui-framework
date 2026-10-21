/**
 * Temporary local copy of the step-key rule from `@paperclipai/shared`
 * (`deriveIssueStepKey`, branch B). The integration step replaces this body
 * with a re-export so the two copies cannot drift; the test runs the same case
 * table as the shared helper.
 */
const STEP_TITLE_PATTERN = /^S(\d{1,3}[a-z]?)(?:-r(\d{1,3}))?\s*:/;

export function deriveIssueStepKey(
  parentId: string | null | undefined,
  title: string | null | undefined,
): string | null {
  if (!parentId || !title) return null;
  const match = STEP_TITLE_PATTERN.exec(title.trim());
  if (!match) return null;
  const step = match[2] ? `S${match[1]}-r${match[2]}` : `S${match[1]}`;
  return `${parentId}:${step}`;
}

/** The step id alone (`S3`, `S5e`, `S3-r2`), used in alert text. */
export function stepIdFromTitle(title: string | null | undefined): string | null {
  const key = deriveIssueStepKey("x", title);
  return key ? key.slice(2) : null;
}
