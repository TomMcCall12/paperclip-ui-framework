import { deriveIssueStepKey } from "@paperclipai/shared";

/**
 * The step-key rule lives in `@paperclipai/shared`; the sentinel re-exports it so
 * the alarm and the issue service can never disagree about what a duplicate is.
 */
export { deriveIssueStepKey };

/** The step id alone (`S3`, `S5e`, `S3-r2`), used in alert text. */
export function stepIdFromTitle(title: string | null | undefined): string | null {
  const key = deriveIssueStepKey("x", title);
  return key ? key.slice(2) : null;
}
