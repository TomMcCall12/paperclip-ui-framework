import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkills, issueComments, issues } from "@paperclipai/db";

/**
 * Picks the skills, among those an agent is already allowed to use, that best
 * match the task it is about to work on, so the wake prompt can name them.
 *
 * Agents can already see every installed skill's name and description, but in
 * practice they often skip loading one. Naming the few that clearly match the
 * task turns "available" into "recommended". Only the agent's own desired
 * skills are candidates, so this never grants a skill the board excluded.
 */

/** Adapters where Paperclip installs the agent's skills for the run itself. */
export const RELEVANT_SKILL_ADAPTER_TYPES: ReadonlySet<string> = new Set(["claude_local", "codex_local"]);

export const RELEVANT_SKILLS_DEFAULT_LIMIT = 3;
/** Minimum weighted score for a skill to be recommended. */
export const RELEVANT_SKILLS_MIN_SCORE = 3;
/** Minimum distinct task words a skill must share... */
const MIN_MATCHED_TERMS = 2;
/** ...unless a single shared word alone scores at least this much. */
const SINGLE_TERM_MIN_SCORE = 8;
const RECENT_COMMENT_LIMIT = 5;
const NAME_WEIGHT = 2;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "onto", "your", "you", "are", "was", "were",
  "will", "would", "should", "could", "can", "not", "but", "any", "all", "its", "our", "their", "them",
  "then", "than", "when", "what", "which", "who", "how", "why", "use", "used", "using", "uses", "via",
  "per", "each", "only", "also", "more", "most", "some", "such", "other", "about", "after", "before",
  "over", "under", "into", "out", "off", "too", "very", "just", "make", "makes", "made", "keep", "need",
  "needs", "task", "tasks", "issue", "issues", "comment", "comments", "post", "mark", "done", "please",
  "agent", "agents", "paperclip", "work", "change", "changes", "short", "at", "most", "one", "two",
  "skill", "skills", "hermes", "these", "those", "there", "here", "has", "have", "had", "been", "being",
  "does", "did", "doing", "may", "might", "must", "new", "now", "get", "got", "let", "like",
]);

/**
 * Task words that people use for the same work a skill describes in other
 * words. Applied to task text only, after stemming.
 */
const TASK_TERM_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  review: ["critique", "audit"],
  feedback: ["critique"],
  experience: ["design", "usability"],
  usability: ["design"],
  ux: ["design", "usability"],
  ui: ["design"],
  bug: ["debug"],
  broken: ["debug"],
  crash: ["debug"],
  fail: ["debug"],
  error: ["debug"],
  test: ["qa"],
  pr: ["pull", "request"],
  breakdown: ["break", "plan"],
  subtask: ["child", "plan"],
};

/** Task terms plus their synonyms; skill text is matched without expansion. */
export function expandTaskTerms(terms: Iterable<string>): Set<string> {
  const expanded = new Set<string>();
  for (const term of terms) {
    expanded.add(term);
    for (const synonym of TASK_TERM_SYNONYMS[term] ?? []) expanded.add(synonym);
  }
  return expanded;
}

/** Lower-cases, splits on non-alphanumerics, drops short and common words, and lightly stems. */
export function tokenizeForSkillMatch(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .map(stemWord)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

function stemWord(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export type SkillMatchCandidate = {
  key: string;
  name: string;
  description: string | null;
};

export type RelevantSkill = SkillMatchCandidate & {
  score: number;
  matchedTerms: string[];
};

/** The words that identify a skill: its name plus the last segment of its key. */
function nameTerms(candidate: SkillMatchCandidate): Set<string> {
  const keyTail = candidate.key.split("/").pop() ?? "";
  return new Set(tokenizeForSkillMatch(`${candidate.name} ${keyTail}`));
}

/**
 * Ranks candidates against the task text. Each task word a skill shares adds
 * its inverse document frequency across the candidates, doubled when the word
 * is in the skill's name, so words most skills share count for little.
 */
export function rankRelevantSkills(input: {
  taskText: string;
  candidates: SkillMatchCandidate[];
  limit?: number;
  minScore?: number;
}): RelevantSkill[] {
  const rawTaskText = input.taskText.toLowerCase();
  const taskTerms = expandTaskTerms(tokenizeForSkillMatch(input.taskText));
  // "From a user's point of view" asks for a design and usability critique.
  if (/point of view|user'?s? perspective|as a user/.test(rawTaskText)) {
    for (const term of ["design", "usability", "critique"]) taskTerms.add(term);
  }
  if (taskTerms.size === 0 || input.candidates.length === 0) return [];

  const indexed = input.candidates.map((candidate) => {
    const names = nameTerms(candidate);
    const all = new Set([...names, ...tokenizeForSkillMatch(candidate.description ?? "")]);
    return { candidate, names, all };
  });
  const documentFrequency = new Map<string, number>();
  for (const { all } of indexed) {
    for (const term of all) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const total = indexed.length;
  const idf = (term: string) => Math.log(1 + total / (documentFrequency.get(term) ?? total));

  const minScore = input.minScore ?? RELEVANT_SKILLS_MIN_SCORE;
  const ranked: RelevantSkill[] = [];
  for (const { candidate, names, all } of indexed) {
    const matched = [...taskTerms].filter((term) => all.has(term));
    if (matched.length === 0) continue;
    const score = matched.reduce((sum, term) => sum + idf(term) * (names.has(term) ? NAME_WEIGHT : 1), 0);
    if (matched.length < MIN_MATCHED_TERMS && score < SINGLE_TERM_MIN_SCORE) continue;
    if (score < minScore) continue;
    ranked.push({ ...candidate, score: Math.round(score * 100) / 100, matchedTerms: matched.sort() });
  }
  ranked.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return ranked.slice(0, input.limit ?? RELEVANT_SKILLS_DEFAULT_LIMIT);
}

/** The wake-prompt section naming the selected skills, or an empty string. */
export function renderRelevantSkillInstructions(skills: RelevantSkill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => {
    const description = (skill.description ?? "").replace(/\s+/g, " ").trim();
    return `- **${skill.name}**${description ? ` — ${description}` : ""}`;
  });
  return [
    "These installed skills match this task. Before you start, load each one that applies (with your Skill tool, or by reading its SKILL.md) and follow its procedure unless the task says otherwise:",
    ...lines,
  ].join("\n");
}

/**
 * Reads the task (title, description and recent comments) and the agent's own
 * desired skills, then ranks them. Company-scoped throughout.
 */
export async function resolveRelevantSkillsForRun(input: {
  db: Db;
  companyId: string;
  issueId: string | null;
  desiredSkillKeys: string[];
  limit?: number;
}): Promise<RelevantSkill[]> {
  if (!input.issueId || input.desiredSkillKeys.length === 0) return [];
  const issue = await input.db
    .select({ title: issues.title, description: issues.description })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) return [];
  const comments = await input.db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(and(
      eq(issueComments.issueId, input.issueId),
      eq(issueComments.companyId, input.companyId),
      isNull(issueComments.deletedAt),
    ))
    .orderBy(desc(issueComments.createdAt))
    .limit(RECENT_COMMENT_LIMIT);
  const candidates = await input.db
    .select({ key: companySkills.key, name: companySkills.name, description: companySkills.description })
    .from(companySkills)
    .where(and(eq(companySkills.companyId, input.companyId), inArray(companySkills.key, input.desiredSkillKeys)));
  return rankRelevantSkills({
    taskText: [issue.title, issue.description ?? "", ...comments.map((comment) => comment.body)].join("\n"),
    candidates,
    limit: input.limit,
  });
}
