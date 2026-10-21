import { describe, expect, it } from "vitest";
import { formatAge, formatAt, formatList, leafLabel, MAX_ALERT_LENGTH, renderAlert, templates, type RenderContext } from "./alerts.js";

const NOW = new Date("2026-10-21T12:00:00.000Z"); // 13:00 in London (BST)
const MIN = 60_000;

describe("time and age wording", () => {
  it("formats Europe/London times with day prefixes", () => {
    expect(formatAt(new Date("2026-10-21T14:00:00.000Z"), NOW)).toBe("at 15:00");
    expect(formatAt(new Date("2026-10-22T08:00:00.000Z"), NOW)).toBe("tomorrow at 09:00");
    expect(formatAt(new Date("2026-10-23T08:00:00.000Z"), NOW)).toBe("on Fri at 09:00");
  });
  it("formats ages", () => {
    expect(formatAge(42 * MIN)).toBe("42 minutes");
    expect(formatAge(1 * MIN)).toBe("1 minute");
    expect(formatAge(0)).toBe("less than a minute");
    expect(formatAge(59_000)).toBe("less than a minute");
    expect(formatAge(65 * MIN)).toBe("1 hour 5 minutes");
    expect(formatAge(180 * MIN)).toBe("3 hours");
    expect(formatAge(2 * 24 * 60 * MIN)).toBe("2 days");
    expect(formatAge(8 * 24 * 60 * MIN)).toBe("over 7 days");
  });
  it("labels a step leaf with its step id", () => {
    expect(leafLabel({ id: "x", identifier: "TOM-718", title: "S3: Build A" })).toBe("S3 (TOM-718)");
    expect(leafLabel({ id: "x", identifier: "TOM-718", title: "Build A" })).toBe("TOM-718");
  });
  it("cuts lists to 'and N more'", () => {
    expect(formatList(["A", "B", "C"], 5)).toBe("A, B and C");
    expect(formatList(["A", "B", "C", "D"], 2)).toBe("A, B and 2 more");
  });
});

describe("templates", () => {
  const plain: RenderContext = { alertOnly: null };
  it("T2 tells the board Claude is waiting for usage and nothing is needed", () => {
    const text = renderAlert(
      templates.T2({ rid: "TOM-673", age: "42 minutes", leaf: "S3 (TOM-718)", provider: "Claude", atReset: "at 18:18", atRestart: "at 18:23", byCheck: "18:35" }),
      "Make silent stalls impossible",
      plain,
    );
    expect(text).toBe(
      "Stalled: Make silent stalls impossible (TOM-673). No progress for 42 minutes. Why: S3 (TOM-718) is waiting for Claude usage, which comes back at 18:18. What I did: set it to restart at 18:23. Next: nothing needed from you. I will tell you if it has not restarted by 18:35.",
    );
    expect(text).not.toMatch(/OpenAI/);
  });
  it("alert-only wording replaces what I did and next", () => {
    const text = renderAlert(
      templates.T4({ rid: "TOM-1", age: "12 minutes", leaf: "TOM-2", atHealed: "at 14:02", atNext: "at 15:02" }),
      "Root",
      { alertOnly: { selfRepairFrom: "tomorrow at 14:00" } },
    );
    expect(text).toContain("Self-repair is off until tomorrow at 14:00; I would have restarted it.");
    expect(text).toContain("Next: I changed nothing and woke nobody.");
    expect(text).not.toContain("Jarvis has been asked");
    expect(text).not.toContain("What I did");
  });
  it("alert-only wording never says Jarvis was asked, for alerts that have no repair either", () => {
    const text = renderAlert(
      templates.T3({ rid: "TOM-1", age: "40 minutes", leaf: "TOM-2", agent: "Engineer", busyOn: "TOM-9", since: "13:00", atCheck: "at 15:00" }),
      "Root",
      { alertOnly: { selfRepairFrom: null } },
    );
    expect(text).not.toContain("Jarvis has been asked");
    expect(text).toContain("Jarvis was not woken (self-repair is off)");
  });

  // Worst case: 21-character times, 19-character ages and agent names, 5-digit ids.
  const time = "on Wed at 23:59 (BST)".slice(0, 21);
  const age = "23 hours 59 minutes";
  const agent = "Tom's Labs Engineer";
  const rid = "TOM-99999";
  const leaf = "S123-r99 (TOM-99999)";
  const longRoot = "A very long root task title that keeps on going and going well past fifty characters";
  const values = { rid, age, leaf };
  const builders = {
    T2: templates.T2({ ...values, provider: "Claude", atReset: time, atRestart: time, byCheck: time }),
    T2L: templates.T2L({ ...values, agent }),
    T3: templates.T3({ ...values, agent, busyOn: rid, since: time, atCheck: time }),
    T4: templates.T4({ ...values, atHealed: time, atNext: time }),
    T5: templates.T5({ ...values, ranFor: age, atHealed: time, atNext: time }),
    T6: templates.T6({ rid, step: "S123-r99", first: rid, second: rid }),
    T7: templates.T7({ ...values, agent, atHealed: time, atNext: time }),
    T7n: templates.T7n({ ...values, atNext: time }),
    T8: templates.T8({ ...values, blocker: rid, agent, atHealed: time, atNext: time }),
    T9: templates.T9({ ...values, step: leaf, atFinished: time, agent, atHealed: time, atNext: time }),
    T10: templates.T10({ ...values, agent, state: "in error", atNext: time }),
    T10b: templates.T10b({ ...values, atNext: time }),
    T11: templates.T11({ age, atNext: time }),
    T12: templates.T12({ ...values, atNext: time }),
    T13: templates.T13({ rid, leaf, atProgress: time, stalledFor: age }),
    T13g: templates.T13g({ rids: Array(9).fill(rid) }),
    T14: templates.T14({ count: 12, reason: `waiting for Claude usage, which comes back ${time}`, rids: Array(12).fill(rid), did: `set them to restart ${time}`, next: `nothing needed from you. I will tell you again ${time}.`, action: `set them to restart ${time}` }),
    T15: templates.T15({ count: 12, rids: Array(12).fill(rid), selfRepairStarts: time }),
    T16: templates.T16({ stalls: 999, fixes: 999 }),
    T17: templates.T17({ from: time, to: time, gap: age }),
    TF: templates.TF(),
    TCap: templates.TCap({ count: 99 }),
  };
  for (const [name, build] of Object.entries(builders)) {
    it(`${name} stays under ${MAX_ALERT_LENGTH} characters in both modes`, () => {
      for (const ctx of [plain, { alertOnly: { selfRepairFrom: time } }] as RenderContext[]) {
        const text = renderAlert(build, longRoot, ctx);
        expect(text.length).toBeLessThan(MAX_ALERT_LENGTH);
      }
    });
  }
});
