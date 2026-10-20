import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
import {
  DESKTOP,
  THRESHOLDS,
  attachMetrics,
  attachShot,
  gotoTaskChat,
  measure,
  openDesktopContext,
  openKeyboard,
  openPhoneContext,
  postComment,
  scrollUpInSteps,
  seedChat,
  setNavVisible,
  taskEditor,
  type ChatMetrics,
  type ChatSeed,
  type KeyboardMode,
} from "./helpers/mobile-chat";

// Phone chat defect 2 (TOM-654): "the text box goes up about half the screen
// when I scroll back through chat history", plus the composer height and
// scroll-back behaviour around it.

let api: APIRequestContext;
let seed: ChatSeed;

test.beforeAll(async ({}, testInfo) => {
  test.setTimeout(180_000);
  api = await playwrightRequest.newContext({ baseURL: testInfo.project.use.baseURL });
  seed = await seedChat(api);
});

test.afterAll(async () => {
  await api?.dispose();
});

const keyboardShare = (mode: KeyboardMode) =>
  mode === "none" ? THRESHOLDS.dockMaxShareKeyboardClosed : THRESHOLDS.dockMaxShareKeyboardOpen;

function summarize(samples: ChatMetrics[]) {
  return samples.map((s) => ({
    scrollY: Math.round(s.scrollY),
    navVisible: s.navVisible,
    dockTop: s.dock ? Math.round(s.dock.top) : null,
    dockHeight: s.dock ? Math.round(s.dock.height) : null,
    visibleTop: Math.round(s.visibleTop),
    visibleHeight: Math.round(s.visibleHeight),
  }));
}

/** The dock's bottom offset animates for 200ms after each nav toggle. */
const NAV_TRANSITION_MS = 300;

/**
 * Largest dock-top move between consecutive samples where the nav did not
 * toggle, ignoring samples still inside the nav-toggle transition.
 */
function driftWithoutNavToggle(samples: ChatMetrics[]) {
  let worst = 0;
  let lastToggle = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const next = samples[i];
    if (prev.navVisible !== next.navVisible) lastToggle = next.t;
    if (!prev.dock || !next.dock || prev.navVisible !== next.navVisible) continue;
    if (prev.t - lastToggle < NAV_TRANSITION_MS) continue;
    worst = Math.max(worst, Math.abs(next.dock.top - prev.dock.top));
  }
  return worst;
}

async function typeLines(page: import("@playwright/test").Page, count: number) {
  for (let line = 1; line <= count; line += 1) {
    await page.keyboard.type(`Draft line ${line}`);
    if (line < count) await page.keyboard.press("Shift+Enter");
  }
  await page.waitForTimeout(300);
}

/** Dock top relative to the bottom of what the user can see. */
const dockLiftAboveVisibleBottom = (s: ChatMetrics) =>
  s.dock ? s.visibleTop + s.visibleHeight - s.dock.bottom : Number.NaN;

const scrollCases: Array<{ keyboard: KeyboardMode; nav: "shown" | "hidden" }> = [
  // Keyboard closed: task chat keeps the nav hidden, so nothing moves the dock.
  { keyboard: "none", nav: "shown" },
  { keyboard: "none", nav: "hidden" },
  // Android resize (interactive-widget=resizes-content): layout viewport shrinks too.
  { keyboard: "android", nav: "shown" },
  { keyboard: "android", nav: "hidden" },
  // iOS / Android Chrome default (resizes-visual): only visualViewport shrinks.
  { keyboard: "ios", nav: "shown" },
  { keyboard: "ios", nav: "hidden" },
];

for (const scenario of scrollCases) {
  test(`phone 390x844 scroll-up keeps the dock in place (keyboard=${scenario.keyboard}, nav=${scenario.nav})`, async ({ browser }, testInfo) => {
    const { context, page } = await openPhoneContext(browser, testInfo, scenario.keyboard);
    try {
      await gotoTaskChat(page, seed);
      await page.mouse.move(195, 300);
      await setNavVisible(page, scenario.nav === "shown");
      if (scenario.keyboard !== "none") await openKeyboard(page, scenario.keyboard, taskEditor(page));
      const before = await measure(page);
      const samples = [before, ...(await scrollUpInSteps(page, 1500, 150))];
      const after = samples[samples.length - 1];
      const drift = driftWithoutNavToggle(samples);
      const lift = dockLiftAboveVisibleBottom(after);
      const record = {
        scenario,
        before: summarize([before])[0],
        after: summarize([after])[0],
        driftWithoutNavToggle: Math.round(drift),
        dockLiftAboveVisibleBottomBefore: Math.round(dockLiftAboveVisibleBottom(before)),
        dockLiftAboveVisibleBottomAfter: Math.round(lift),
        scrolledBy: Math.round(before.scrollY - after.scrollY),
        samples: summarize(samples),
      };
      await attachMetrics(testInfo, "scroll-metrics", record);
      await attachShot(page, testInfo, `390-scrolled-up-keyboard-${scenario.keyboard}-nav-${scenario.nav}`);

      expect(before.scrollY - after.scrollY, "the thread scrolled back through history").toBeGreaterThan(500);
      expect(drift, "dock top drift while the nav did not toggle").toBeLessThanOrEqual(THRESHOLDS.dockTopDriftPx);
      expect(
        Math.abs(after.dock!.top - before.dock!.top),
        "dock top moved between the start and the end of the scroll-up",
      ).toBeLessThanOrEqual(THRESHOLDS.dockTopDriftPx);
      expect(after.dock!.height / after.visibleHeight, "dock share of the visible viewport").toBeLessThanOrEqual(
        keyboardShare(scenario.keyboard),
      );
      // The dock must stay docked: at most the nav's height (64px + 16px gap)
      // above the bottom of the visible area, and never below it.
      expect(lift, "dock gap above the visible bottom after scroll-up").toBeLessThanOrEqual(80 + THRESHOLDS.dockTopDriftPx);
      expect(lift, "dock bottom is not hidden below the visible area").toBeGreaterThanOrEqual(-THRESHOLDS.dockTopDriftPx);
      // When the keyboard is open the nav must not occupy the visible strip.
      if (scenario.keyboard !== "none") {
        expect(after.navVisible && after.nav!.top < after.visibleTop + after.visibleHeight, "nav hidden behind keyboard").toBe(false);
      }
    } finally {
      await context.close();
    }
  });
}

// Tom's wording: "the text box goes up about half the screen when I scroll
// back". A draft (or an inline photo) makes the dock tall; scrolling back
// re-shows the nav, which lifts it another 72px.
for (const keyboard of ["none", "ios"] as const) {
  test(`phone 390x844 scroll-up with a long draft keeps the composer in the bottom 40% (keyboard=${keyboard})`, async ({ browser }, testInfo) => {
    const { context, page } = await openPhoneContext(browser, testInfo, keyboard);
    try {
      await gotoTaskChat(page, seed);
      await page.mouse.move(195, 300);
      await setNavVisible(page, false);
      await openKeyboard(page, keyboard, taskEditor(page));
      await typeLines(page, 15);
      const before = await measure(page);
      const samples = [before, ...(await scrollUpInSteps(page, 1500, 150))];
      const after = samples[samples.length - 1];
      // Share of the visible height between the dock top and the visible bottom.
      const occupied = (s: ChatMetrics) => (s.visibleTop + s.visibleHeight - s.dock!.top) / s.visibleHeight;
      await attachMetrics(testInfo, "draft-scroll-metrics", {
        keyboard,
        before: summarize([before])[0],
        after: summarize([after])[0],
        occupiedBefore: +occupied(before).toFixed(3),
        occupiedAfter: +occupied(after).toFixed(3),
      });
      await attachShot(page, testInfo, `390-scrolled-up-with-draft-keyboard-${keyboard}`);
      expect(occupied(after), "composer and nav share of the visible height after scroll-up").toBeLessThanOrEqual(
        keyboardShare(keyboard),
      );
    } finally {
      await context.close();
    }
  });
}

const editorCases: Array<{ keyboard: KeyboardMode }> = [
  { keyboard: "none" },
  { keyboard: "android" },
  { keyboard: "ios" },
];

for (const scenario of editorCases) {
  test(`phone 390x844 15-line draft keeps the composer bounded (keyboard=${scenario.keyboard})`, async ({ browser }, testInfo) => {
    const { context, page } = await openPhoneContext(browser, testInfo, scenario.keyboard);
    try {
      await gotoTaskChat(page, seed);
      await openKeyboard(page, scenario.keyboard, taskEditor(page));
      await typeLines(page, 15);
      const metrics = await measure(page);
      await attachMetrics(testInfo, "editor-metrics", {
        scenario,
        editorHeight: Math.round(metrics.editor!.height),
        dockHeight: Math.round(metrics.dock!.height),
        visibleHeight: Math.round(metrics.visibleHeight),
        editorShare: +(metrics.editor!.height / metrics.visibleHeight).toFixed(3),
        dockShare: +(metrics.dock!.height / metrics.visibleHeight).toFixed(3),
        navVisible: metrics.navVisible,
      });
      await attachShot(page, testInfo, `390-15-line-draft-keyboard-${scenario.keyboard}`);
      expect(metrics.editor!.height / metrics.visibleHeight, "editor share").toBeLessThanOrEqual(THRESHOLDS.editorMaxShare);
      expect(metrics.dock!.height / metrics.visibleHeight, "dock share").toBeLessThanOrEqual(keyboardShare(scenario.keyboard));
    } finally {
      await context.close();
    }
  });
}

test("desktop 1280x800 15-line draft keeps the composer bounded", async ({ browser }, testInfo) => {
  const { context, page } = await openDesktopContext(browser, testInfo);
  try {
    await gotoTaskChat(page, seed);
    await taskEditor(page).click();
    await typeLines(page, 15);
    const metrics = await measure(page);
    await attachMetrics(testInfo, "editor-metrics", {
      editorHeight: Math.round(metrics.editor!.height),
      dockHeight: Math.round(metrics.dock!.height),
      visibleHeight: metrics.visibleHeight,
    });
    await attachShot(page, testInfo, "1280-15-line-draft");
    expect(metrics.editor!.height / DESKTOP.height).toBeLessThanOrEqual(THRESHOLDS.editorMaxShare);
    expect(metrics.dock!.height / DESKTOP.height).toBeLessThanOrEqual(THRESHOLDS.dockMaxShareKeyboardClosed);
  } finally {
    await context.close();
  }
});

for (const keyboard of ["none", "ios"] as const) {
  test(`phone 390x844 a new message while scrolled up does not snap to the bottom (keyboard=${keyboard})`, async ({ browser }, testInfo) => {
    const { context, page } = await openPhoneContext(browser, testInfo, keyboard);
    try {
      await gotoTaskChat(page, seed);
      await page.mouse.move(195, 300);
      if (keyboard !== "none") await openKeyboard(page, keyboard, taskEditor(page));
      await scrollUpInSteps(page, 1500, 150);
      const before = await measure(page);
      const body = `Arrived while scrolled up ${Date.now()}`;
      await postComment(api, seed, seed.issue.id, body, "agent");
      // The thread polls/streams; wait until the new message is in the DOM.
      await expect(page.getByText(body)).toBeAttached({ timeout: 20_000 });
      await page.waitForTimeout(500);
      const after = await measure(page);
      const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      await attachMetrics(testInfo, "follow-metrics", {
        keyboard,
        scrollYBefore: Math.round(before.scrollY),
        scrollYAfter: Math.round(after.scrollY),
        maxScroll: Math.round(maxScroll),
      });
      await attachShot(page, testInfo, `390-new-message-while-scrolled-up-keyboard-${keyboard}`);
      expect(Math.abs(after.scrollY - before.scrollY), "scroll position held").toBeLessThanOrEqual(48);
      expect(maxScroll - after.scrollY, "did not snap to the bottom").toBeGreaterThan(200);
    } finally {
      await context.close();
    }
  });
}

test("desktop 1280x800 scroll-up keeps the dock in place", async ({ browser }, testInfo) => {
  const { context, page } = await openDesktopContext(browser, testInfo);
  try {
    await gotoTaskChat(page, seed);
    await page.mouse.move(640, 300);
    // The thread keeps following to the bottom while late content settles;
    // wait until the scroller holds still so "before" is a stable baseline.
    let settled = await measure(page);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await page.waitForTimeout(400);
      const next = await measure(page);
      const stable = next.scrollerTop === settled.scrollerTop;
      settled = next;
      if (stable) break;
    }
    const before = await measure(page);
    const samples = [before, ...(await scrollUpInSteps(page, 1500, 150))];
    const after = samples[samples.length - 1];
    await attachMetrics(testInfo, "scroll-metrics", {
      before: summarize([before])[0],
      after: summarize([after])[0],
      scrollerTopBefore: before.scrollerTop,
      scrollerTopAfter: after.scrollerTop,
    });
    await attachShot(page, testInfo, "1280-scrolled-up");
    expect((before.scrollerTop ?? 0) - (after.scrollerTop ?? 0), "the thread scroller moved back").toBeGreaterThan(500);
    expect(driftWithoutNavToggle(samples)).toBeLessThanOrEqual(THRESHOLDS.dockTopDriftPx);
    expect(after.dock!.height / DESKTOP.height).toBeLessThanOrEqual(THRESHOLDS.dockMaxShareKeyboardClosed);
  } finally {
    await context.close();
  }
});
