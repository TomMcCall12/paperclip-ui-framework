/**
 * Categories that record who owns a skill and where it is in its lifecycle
 * (see doc/SKILL-LEARNING.md). They live only in Paperclip, never in SKILL.md.
 */

/** Written by an agent during a task. */
export const LEARNED_SKILL_CATEGORY = "learned";
/** Skills agents may create and maintain without a human. */
export const AGENT_MANAGED_SKILL_CATEGORIES: readonly string[] = [LEARNED_SKILL_CATEGORY, "curated", "hermes-import"];
/** The board wants it kept as is: never archived, protected by the recommended policy. */
export const PINNED_SKILL_CATEGORY = "pinned";
/** Retired by the curator: kept for recovery, no longer assigned or recommended. */
export const ARCHIVED_SKILL_CATEGORY = "archived";

export const SKILL_OWNERSHIP_CATEGORIES: readonly string[] = [
  ...AGENT_MANAGED_SKILL_CATEGORIES,
  PINNED_SKILL_CATEGORY,
  ARCHIVED_SKILL_CATEGORY,
];
