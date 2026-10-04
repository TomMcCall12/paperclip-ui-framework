import { describe, expect, it } from "vitest";
import {
  RELEVANT_SKILL_ADAPTER_TYPES,
  expandTaskTerms,
  rankRelevantSkills,
  renderRelevantSkillInstructions,
  tokenizeForSkillMatch,
} from "./relevant-skills.js";

const LIBRARY = [
  {
    key: "paperclipai/optional/product/design-critique",
    name: "design-critique",
    description: "Give a structured product design critique — user job clarity, hierarchy, affordance, error states, accessibility.",
  },
  {
    key: "company/c1/hermes-software-development-systematic-debugging",
    name: "systematic-debugging",
    description: "4-phase root cause debugging: understand bugs before fixing.",
  },
  {
    key: "company/c1/hermes-software-development-expo-react-native-typescript-diagnostics",
    name: "expo-react-native-typescript-diagnostics",
    description: "Use when investigating or fixing TypeScript failures in an Expo/React Native project.",
  },
  {
    key: "paperclipai/bundled/quality/qa-acceptance",
    name: "qa-acceptance",
    description: "Produce QA acceptance criteria and a manual validation plan for a feature change.",
  },
  {
    key: "paperclipai/bundled/paperclip-operations/task-planning",
    name: "task-planning",
    description: "Turn a Paperclip issue or request into a structured implementation plan with child task graph, blockers, owners.",
  },
  {
    key: "company/c1/hermes-plated-plated-model-experimentation",
    name: "plated-model-experimentation",
    description: "Run safe, evidence-based model, provider, reasoning-effort experiments for Plated.",
  },
];

const top = (taskText: string) => rankRelevantSkills({ taskText, candidates: LIBRARY }).map((skill) => skill.name);

describe("tokenizeForSkillMatch", () => {
  it("lower-cases, drops common words and lightly stems", () => {
    expect(tokenizeForSkillMatch("The Builds are FAILING for these TypeScript errors")).toEqual(
      ["build", "fail", "typescript", "error"],
    );
  });

  it("expands task synonyms without changing the originals", () => {
    expect([...expandTaskTerms(["review", "bug"])]).toEqual(["review", "critique", "audit", "bug", "debug"]);
  });
});

describe("rankRelevantSkills", () => {
  it("recommends design critique for a user's-point-of-view review", () => {
    expect(top("Review the pause and resume experience from a board user's point of view.")[0]).toBe("design-critique");
  });

  it("recommends the specific diagnostics skill for a broken Expo TypeScript build", () => {
    expect(top("TypeScript build fails in the Expo app after upgrading React Native; investigate.")[0])
      .toBe("expo-react-native-typescript-diagnostics");
  });

  it("recommends debugging for a root-cause bug fix", () => {
    expect(top("Calories are wrong; find the root cause of this bug and fix it.")).toContain("systematic-debugging");
  });

  it("recommends QA acceptance and planning for a test plan", () => {
    expect(top("Write acceptance criteria and a manual QA plan for the export.")).toEqual(
      expect.arrayContaining(["qa-acceptance"]),
    );
  });

  it("recommends nothing for a trivial task", () => {
    expect(top("Post a comment saying hello and mark this done.")).toEqual([]);
  });

  it("does not recommend a skill on one weak shared word", () => {
    // "model" alone appears in plated-model-experimentation's name.
    expect(top("Pick a default model.")).not.toContain("plated-model-experimentation");
  });

  it("caps the number of recommendations and orders by score", () => {
    const ranked = rankRelevantSkills({
      taskText: "Plan the QA acceptance criteria, child tasks and owners, then debug the root cause of the TypeScript Expo failure.",
      candidates: LIBRARY,
      limit: 2,
    });
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score);
  });

  it("only ever returns given candidates", () => {
    const ranked = rankRelevantSkills({ taskText: "Review this design from a user's point of view.", candidates: [LIBRARY[1]!] });
    expect(ranked.every((skill) => skill.key === LIBRARY[1]!.key)).toBe(true);
  });
});

describe("renderRelevantSkillInstructions", () => {
  it("names each recommended skill with its description and tells the agent to load them", () => {
    const text = renderRelevantSkillInstructions(
      rankRelevantSkills({ taskText: "Review this from a user's point of view.", candidates: LIBRARY }),
    );
    expect(text).toContain("load each one that applies");
    expect(text).toContain("- **design-critique** — Give a structured product design critique");
  });

  it("renders nothing when no skill matches", () => {
    expect(renderRelevantSkillInstructions([])).toBe("");
  });
});

describe("RELEVANT_SKILL_ADAPTER_TYPES", () => {
  it("covers only adapters where Paperclip installs the skills", () => {
    expect([...RELEVANT_SKILL_ADAPTER_TYPES].sort()).toEqual(["claude_local", "codex_local"]);
  });
});
