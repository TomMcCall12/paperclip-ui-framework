import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import {
  LONG_FILE_NAME,
  THRESHOLDS,
  attachMetrics,
  attachShot,
  attachmentFiles,
  gotoBoardChat,
  gotoTaskChat,
  horizontalOverflow,
  measure,
  openDesktopContext,
  openPhoneContext,
  postComment,
  seedChat,
  taskEditor,
  type ChatSeed,
} from "./helpers/mobile-chat";

// Phone chat defect 1 (TOM-654): "layout or sizing breaks when I add
// attachments". Cases that fail on the current UI are marked test.fail()
// with the defect they reproduce; each fix step flips its cases by deleting
// the marker. CHAT_MOBILE_RAW=1 ignores the markers to print raw results.
const RAW = process.env.CHAT_MOBILE_RAW === "1";

let api: APIRequestContext;
let seed: ChatSeed;

test.beforeAll(async ({}, testInfo) => {
  test.setTimeout(180_000);
  api = await playwrightRequest.newContext({ baseURL: testInfo.project.use.baseURL });
  // Attachment layout does not depend on thread length; keep seeding short.
  seed = await seedChat(api, { taskComments: 12, boardComments: 12 });
});

test.afterAll(async () => {
  await api?.dispose();
});

/** Hold attachment uploads until released so the "uploading" state can be measured. */
async function gateUploads(context: BrowserContext) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route(/\/api\/companies\/[^/]+\/issues\/[^/]+\/attachments(\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await released;
    await route.continue();
  });
  return release;
}

type Snapshot = {
  label: string;
  dockWidth: number;
  dockHeight: number;
  dockShare: number;
  editorHeight: number;
  visibleHeight: number;
  scrollWidth: number;
  clientWidth: number;
  widestOverflow: { selector: string; right: number } | null;
  chips: number;
};

async function snapshot(page: Page, label: string): Promise<Snapshot> {
  const metrics = await measure(page);
  const overflow = await horizontalOverflow(page);
  return {
    label,
    dockWidth: Math.round(metrics.dock!.width),
    dockHeight: Math.round(metrics.dock!.height),
    dockShare: +(metrics.dock!.height / metrics.visibleHeight).toFixed(3),
    editorHeight: Math.round(metrics.editor!.height),
    visibleHeight: metrics.visibleHeight,
    scrollWidth: overflow.scrollWidth,
    clientWidth: overflow.clientWidth,
    widestOverflow: overflow.widest,
    chips: await page.locator('[data-testid="task-chat-composer-attachments"] [data-slot="attachment"]').count(),
  };
}

async function pickFile(page: Page, file: ReturnType<typeof attachmentFiles>[number]) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("task-chat-composer-attach").click();
  await (await chooser).setFiles(file);
}

async function runTaskAttachmentFlow(page: Page, context: BrowserContext, testInfo: TestInfo, count: number, prefix: string) {
  const release = await gateUploads(context);
  await gotoTaskChat(page, seed);
  await taskEditor(page).click();
  await page.keyboard.type("Here are the files.");
  const baseline = await snapshot(page, "baseline");
  const files = attachmentFiles(count);
  for (const file of files) await pickFile(page, file);
  await expect(page.getByText("Uploading…").first()).toBeVisible();
  const uploading = await snapshot(page, "uploading");
  await attachShot(page, testInfo, `${prefix}-${count}-files-uploading`);
  release();
  await expect(page.getByText("Uploading…")).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(500);
  const attached = await snapshot(page, "attached");
  await attachShot(page, testInfo, `${prefix}-${count}-files-attached`);
  // Remove every chip, then clear the inline image the PNG inserted.
  for (const file of files) {
    const remove = page.getByRole("button", { name: `Remove ${file.name}`, exact: true });
    if (await remove.count()) await remove.click();
  }
  await taskEditor(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  const removed = await snapshot(page, "removed");
  const snapshots = [baseline, uploading, attached, removed];
  await attachMetrics(testInfo, `${prefix}-${count}-files-metrics`, snapshots);
  return snapshots;
}

function assertStable(snapshots: Snapshot[], dockMaxShare: number) {
  const [baseline] = snapshots;
  for (const snap of snapshots) {
    expect(snap.scrollWidth, `${snap.label}: no horizontal overflow (${snap.widestOverflow?.selector})`).toBe(snap.clientWidth);
    expect(Math.abs(snap.dockWidth - baseline.dockWidth), `${snap.label}: composer width stable`).toBeLessThanOrEqual(1);
    expect(snap.dockShare, `${snap.label}: dock share of the visible viewport`).toBeLessThanOrEqual(dockMaxShare);
    expect(snap.editorHeight / snap.visibleHeight, `${snap.label}: editor share`).toBeLessThanOrEqual(THRESHOLDS.editorMaxShare);
  }
}

const phoneCases: Array<{ count: number; failing?: string }> = [
  {
    count: 1,
  },
  {
    count: 3,
    failing:
      "Defect 1: once a picked photo finishes uploading it is inserted inline into the editor, which jumps from 48px to its 236px cap; the dock grows from 126px to 365px (43% of the screen)",
  },
  {
    count: 8,
    failing:
      "Defect 1: the inline photo plus the chip row push the dock to 365px (43% of the screen) after upload",
  },
];

for (const scenario of phoneCases) {
  test(`phone 390x844 task chat attaching ${scenario.count} file(s) keeps the layout stable`, async ({ browser }, testInfo) => {
    if (scenario.failing && !RAW) test.fail(true, scenario.failing);
    const { context, page } = await openPhoneContext(browser, testInfo);
    try {
      const snapshots = await runTaskAttachmentFlow(page, context, testInfo, scenario.count, "390-task");
      assertStable(snapshots, THRESHOLDS.dockMaxShareKeyboardClosed);
    } finally {
      await context.close();
    }
  });
}

test("desktop 1280x800 task chat attaching 8 files keeps the layout stable", async ({ browser }, testInfo) => {
  if (!RAW)
    test.fail(true, "Defect 1 (PC): the inline photo fills the editor to its 224px cap and the dock reaches 44% of an 800px window");
  const { context, page } = await openDesktopContext(browser, testInfo);
  try {
    const snapshots = await runTaskAttachmentFlow(page, context, testInfo, 8, "1280-task");
    assertStable(snapshots, THRESHOLDS.dockMaxShareKeyboardClosed);
  } finally {
    await context.close();
  }
});

test("phone 390x844 a sent message with attachments does not overflow the thread", async ({ browser }, testInfo) => {
  const { context, page } = await openPhoneContext(browser, testInfo);
  try {
    await gotoTaskChat(page, seed);
    // Attachment receipts render as trailing link lines folded into chips.
    const links = [
      `[${LONG_FILE_NAME}](/api/attachments/00000000-0000-0000-0000-000000000001/content)`,
      "[notes-3.txt](/api/attachments/00000000-0000-0000-0000-000000000003/content)",
      "![phone-photo.png](/api/attachments/00000000-0000-0000-0000-000000000002/content)",
    ];
    const body = `Files for review\n\n${links.join("\n")}`;
    await postComment(api, seed, seed.issue.id, body, "board");
    await expect(page.getByText("Files for review")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);
    const overflow = await horizontalOverflow(page);
    await attachMetrics(testInfo, "sent-bubble-overflow", overflow);
    await attachShot(page, testInfo, "390-task-sent-attachments");
    expect(overflow.scrollWidth, `no horizontal overflow (${overflow.widest?.selector})`).toBe(overflow.clientWidth);
  } finally {
    await context.close();
  }
});

for (const viewport of ["phone", "desktop"] as const) {
  test(`${viewport} board chat composer stays in bounds with a long unbroken name`, async ({ browser }, testInfo) => {
    const { context, page } =
      viewport === "phone" ? await openPhoneContext(browser, testInfo) : await openDesktopContext(browser, testInfo);
    try {
      await gotoBoardChat(page, seed);
      const composer = page.getByTestId("chat-composer");
      const textarea = composer.locator("textarea");
      await expect(textarea).toHaveCSS("font-size", viewport === "phone" ? "16px" : "14px");
      const send = composer.getByRole("button", { name: "Send message" });
      const sendBox = await send.boundingBox();
      expect(sendBox).not.toBeNull();
      if (viewport === "phone") {
        expect(sendBox!.width).toBeGreaterThanOrEqual(44);
        expect(sendBox!.height).toBeGreaterThanOrEqual(44);
      } else {
        expect(sendBox!.width).toBe(28);
        expect(sendBox!.height).toBe(28);
      }
      // The board currently renders the shared composer without attachment handlers.
      const attachControls = await composer.getByRole("button", { name: "Attach files" }).count();
      const before = await measure(page, "board");
      // focus() rather than click(): on the phone the sticky top bar covers the
      // collapsed composer and would swallow a real tap.
      await composer.locator("textarea").focus();
      await page.keyboard.type(`${LONG_FILE_NAME} ${LONG_FILE_NAME}`);
      await page.waitForTimeout(300);
      const after = await measure(page, "board");
      const overflow = await horizontalOverflow(page);
      const messageListHeight = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="chat-composer"]')
          ?.closest(".relative.flex.min-h-0")
          ?.querySelector(".overflow-y-auto");
        return list ? Math.round(list.getBoundingClientRect().height) : null;
      });
      const record = {
        attachControls,
        messageListHeight,
        composerTop: Math.round(after.dock!.top),
        composerBottom: Math.round(after.dock!.bottom),
        composerWidthBefore: Math.round(before.dock!.width),
        composerWidthAfter: Math.round(after.dock!.width),
        composerHeightAfter: Math.round(after.dock!.height),
        visibleHeight: after.visibleHeight,
        overflow,
      };
      await attachMetrics(testInfo, `${viewport}-board-chat-metrics`, record);
      await attachShot(page, testInfo, `${viewport === "phone" ? 390 : 1280}-board-chat-long-name`);
      expect(attachControls, "board chat has no attach control").toBe(0);
      expect(overflow.scrollWidth, `no horizontal overflow (${overflow.widest?.selector})`).toBe(overflow.clientWidth);
      expect(Math.abs(after.dock!.width - before.dock!.width), "composer width stable").toBeLessThanOrEqual(1);
      expect(after.editor!.height / after.visibleHeight, "board editor share of visible viewport").toBeLessThanOrEqual(THRESHOLDS.editorMaxShare);
      expect(messageListHeight ?? 0, "message list has room to show history").toBeGreaterThan(after.visibleHeight * 0.4);
      expect(after.dock!.bottom, "composer sits in the bottom part of the screen").toBeGreaterThan(after.visibleHeight * 0.6);
    } finally {
      await context.close();
    }
  });
}

for (const viewport of ["phone", "desktop"] as const) {
  const windowWidth = viewport === "phone" ? 390 : 1280;

  test(`${viewport} shared composer styles fit eight chips and give controls proper targets`, async ({ browser }, testInfo) => {
    const { context, page } =
      viewport === "phone" ? await openPhoneContext(browser, testInfo) : await openDesktopContext(browser, testInfo);
    try {
      await gotoBoardChat(page, seed);
      const stylesheets = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
        links.map((link) => (link as HTMLLinkElement).href),
      );
      // BoardChat does not supply attachment handlers yet. Match the shared
      // component's chip and control classes to exercise its compiled CSS at
      // this viewport, with one chip carrying an unbroken long file name.
      const chipsMarkup = Array.from({ length: 8 }, (_, index) => {
        const name = index === 0 ? LONG_FILE_NAME : `file-${index}.txt`;
        return `<div data-attachment-chip class="flex w-(--sz-12rem) max-w-full shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 text-xs bg-background/70 text-muted-foreground"><span class="h-3.5 w-3.5 shrink-0"></span><span class="min-w-0 flex-1 truncate font-medium text-foreground" title="${name}">${name}</span><span class="max-w-(--sz-6rem) shrink-0 truncate">Attached</span><button type="button" aria-label="Remove ${name}" class="chat-composer-touch-control grid h-5 w-5 shrink-0 place-items-center rounded-sm">×</button></div>`;
      }).join("");
      const markup = `<div data-testid="chat-composer" class="relative min-w-0 rounded-xl border px-3 pt-2.5 pb-2"><textarea class="block min-h-(--sz-22px) w-full resize-none border-0 bg-transparent p-0 text-sm leading-6"></textarea><div data-testid="chat-composer-attachments" class="mt-2 flex min-w-0 max-w-full gap-1.5 overflow-x-auto rounded-md border p-1.5">${chipsMarkup}</div><div class="mt-2 flex items-center gap-2"><button type="button" aria-label="Attach files" class="chat-composer-touch-control grid h-7 w-7 shrink-0 place-items-center rounded-md">+</button><span class="flex-1"></span><button type="button" aria-label="Send message" class="chat-composer-touch-control grid h-7 w-7 shrink-0 place-items-center rounded-md">➤</button></div></div>`;
      await page.setContent(`<html><head>${stylesheets.map((href) => `<link rel="stylesheet" href="${href}">`).join("")}</head><body><main style="width:calc(100% - 3rem);margin:2rem auto">${markup}</main></body></html>`);
      const composer = page.getByTestId("chat-composer");
      await expect(composer.locator("textarea")).toHaveCSS("font-size", viewport === "phone" ? "16px" : "14px");
      const controls = [
        composer.getByRole("button", { name: "Attach files" }),
        composer.getByRole("button", { name: `Remove ${LONG_FILE_NAME}` }),
        composer.getByRole("button", { name: "Send message" }),
      ];
      for (const control of controls) {
        expect(await control.boundingBox()).not.toBeNull();
      }
      const attachBox = (await controls[0]!.boundingBox())!;
      const removeBox = (await controls[1]!.boundingBox())!;
      const sendBox = (await controls[2]!.boundingBox())!;
      if (viewport === "phone") {
        expect(attachBox.width).toBeGreaterThanOrEqual(44);
        expect(attachBox.height).toBeGreaterThanOrEqual(44);
        expect(sendBox.width).toBeGreaterThanOrEqual(44);
        expect(sendBox.height).toBeGreaterThanOrEqual(44);
      } else {
        expect(attachBox.width).toBe(28);
        expect(attachBox.height).toBe(28);
        expect(sendBox.width).toBe(28);
        expect(sendBox.height).toBe(28);
      }
      expect(attachBox.x + attachBox.width).toBeLessThanOrEqual(sendBox.x);
      const chips = composer.locator("[data-attachment-chip]");
      await expect(chips).toHaveCount(8);
      const firstChip = (await chips.first().boundingBox())!;
      const secondChip = (await chips.nth(1).boundingBox())!;
      expect(removeBox.x).toBeGreaterThanOrEqual(firstChip.x);
      expect(removeBox.x + removeBox.width).toBeLessThanOrEqual(firstChip.x + firstChip.width);
      expect(firstChip.x + firstChip.width).toBeLessThanOrEqual(secondChip.x);
      // The long name must truncate to the chip's fixed width, not stretch it.
      expect(firstChip.width).toBeLessThanOrEqual(secondChip.width + 1);
      const layout = await composer.evaluate((element) => {
        const row = element.querySelector('[data-testid="chat-composer-attachments"]')!;
        const rect = element.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        return {
          composerLeft: rect.left,
          composerRight: rect.right,
          rowLeft: rowRect.left,
          rowRight: rowRect.right,
          rowScrollWidth: row.scrollWidth,
          rowClientWidth: row.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
        };
      });
      expect(layout.composerLeft).toBeGreaterThanOrEqual(0);
      expect(layout.composerRight).toBeLessThanOrEqual(windowWidth);
      expect(layout.rowLeft).toBeGreaterThanOrEqual(layout.composerLeft);
      expect(layout.rowRight).toBeLessThanOrEqual(layout.composerRight);
      expect(layout.rowScrollWidth).toBeGreaterThan(layout.rowClientWidth);
      expect(layout.documentWidth).toBeLessThanOrEqual(windowWidth);
      await attachShot(page, testInfo, `${windowWidth}-shared-composer-eight-chips`);
    } finally {
      await context.close();
    }
  });
}
