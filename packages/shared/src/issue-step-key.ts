/**
 * Step key: a server-derived identity for assembly-line steps ("S3: ...",
 * "S3-r2: ...", "S5e: ...") created under the same parent. Two open issues with
 * the same key under one parent cannot exist (partial unique index
 * `issues_open_step_key_uq`), so a retried or duplicated create resolves to the
 * issue that already exists.
 *
 * Callers never send a step key; the server derives it from parent and title.
 */
const STEP_TITLE_PATTERN = /^S(\d{1,3}[a-z]?)(?:-r(\d{1,3}))?\s*:/;

/** True when the trimmed title starts with a step prefix such as "S3:" or "S5e:". */
export function isIssueStepTitle(title: string | null | undefined): boolean {
  return !!title && STEP_TITLE_PATTERN.test(title.trim());
}

/**
 * Returns `<parentId>:S<n>` or `<parentId>:S<n>-r<k>` when the issue has a
 * parent and its trimmed title starts with a step prefix (capital S,
 * case-sensitive). Returns null otherwise; top-level issues never get a key.
 */
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
