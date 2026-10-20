import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { closeRegisteredClients, createDb, heartbeatRuns } from "../../../packages/db/src/index.ts";

// Shared harness for the phone-chat reproduction specs (TOM-654).
// Real local Board UI, comment routes and disposable DB; only the
// experimental-settings read is mocked so the task chat shell and the
// Conference Room render regardless of instance state. No provider runs:
// the task belongs to the Board user and the agent never wakes.

export const PHONE = { width: 390, height: 844 } as const;
export const DESKTOP = { width: 1280, height: 800 } as const;
/** Visible height while the software keyboard is open in both simulations. */
export const KEYBOARD_VISIBLE_HEIGHT = 480;

export const THRESHOLDS = {
  /** Editor height as a share of the visible viewport height. */
  editorMaxShare: 0.25,
  /** Whole composer dock as a share of the visible viewport height. */
  dockMaxShareKeyboardClosed: 0.4,
  dockMaxShareKeyboardOpen: 0.45,
  /** Dock top drift allowed during scroll-up when the bottom nav does not toggle. */
  dockTopDriftPx: 2,
} as const;

export type KeyboardMode = "none" | "android" | "ios";

export const PHONE_CONTEXT: BrowserContextOptions = {
  viewport: { ...PHONE },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};

export const DESKTOP_CONTEXT: BrowserContextOptions = {
  viewport: { ...DESKTOP },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
};

export async function json<T = any>(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
): Promise<T> {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

export type ChatSeed = {
  company: { id: string; issuePrefix: string };
  agent: { id: string; name: string };
  agentToken: string;
  /** Finished run per issue so agent comments carry same-issue run context. */
  agentRunIds: Record<string, string>;
  issue: { id: string; identifier: string; title: string };
  boardIssue: { id: string; identifier: string };
  issueRoute: string;
  boardChatRoute: string;
};

/** A message body whose length varies so the thread has realistic heights. */
function threadBody(index: number): string {
  const lines = [`Message ${index + 1}: progress note for the phone chat reproduction.`];
  for (let line = 0; line < index % 4; line += 1) {
    lines.push(`Detail ${line + 1} of message ${index + 1} adds a second paragraph of plain text.`);
  }
  return lines.join("\n\n");
}

/**
 * Seed a company, an agent with an API key, a Board-owned task with a long
 * thread (board and agent comments alternate) and a Conference Room thread.
 */
export async function seedChat(
  request: APIRequestContext,
  options: { taskComments?: number; boardComments?: number } = {},
): Promise<ChatSeed> {
  const taskComments = options.taskComments ?? 100;
  const boardComments = options.boardComments ?? 40;
  const company = await json(
    await request.post("/api/companies", { data: { name: `Phone chat ${randomUUID()}` } }),
  );
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Phone Chat Agent",
        role: "ceo",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"], graceSec: 1 },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  );
  const key = await json<{ token: string }>(
    await request.post(`/api/agents/${agent.id}/keys`, { data: { name: "phone-chat-e2e" } }),
  );
  const issue = await json(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Phone chat long thread", status: "todo", assigneeUserId: "local-board" },
    }),
  );
  const boardIssue = await json(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Board Operations", status: "todo", assigneeUserId: "local-board" },
    }),
  );
  const agentRunIds = await seedFinishedAgentRuns(company.id, agent.id, [issue.id, boardIssue.id]);
  const seed: ChatSeed = {
    company,
    agent,
    agentToken: key.token,
    agentRunIds,
    issue,
    boardIssue,
    issueRoute: `/${company.issuePrefix}/issues/${issue.identifier}`,
    boardChatRoute: `/${company.issuePrefix}/board-chat`,
  };
  for (let index = 0; index < taskComments; index += 1) {
    await postComment(request, seed, issue.id, threadBody(index), index % 2 === 1 ? "agent" : "board");
  }
  for (let index = 0; index < boardComments; index += 1) {
    await postComment(request, seed, boardIssue.id, threadBody(index), index % 2 === 1 ? "agent" : "board");
  }
  return seed;
}

/**
 * Agent comments must name a heartbeat run whose context is the target issue,
 * or the cross-issue guard rejects them. Insert one finished run per issue in
 * the throwaway instance database (same access path as
 * legacy-failure-continuation.spec.ts); a finished run shows no live state.
 */
async function seedFinishedAgentRuns(companyId: string, agentId: string, issueIds: string[]) {
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  const pid = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
  const url = `postgres://paperclip:paperclip@127.0.0.1:${pid.split("\n")[3]}/paperclip`;
  const db = createDb(url);
  const runIds: Record<string, string> = {};
  try {
    for (const issueId of issueIds) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 30_000),
        contextSnapshot: { issueId },
      });
      runIds[issueId] = id;
    }
  } finally {
    await closeRegisteredClients(url);
  }
  return runIds;
}

export async function postComment(
  request: APIRequestContext,
  seed: Pick<ChatSeed, "agentToken" | "agentRunIds">,
  issueId: string,
  body: string,
  author: "board" | "agent" = "board",
) {
  return json(
    await request.post(`/api/issues/${issueId}/comments`, {
      data: { body },
      headers:
        author === "agent"
          ? { Authorization: `Bearer ${seed.agentToken}`, "X-Paperclip-Run-Id": seed.agentRunIds[issueId] }
          : undefined,
    }),
  );
}

/**
 * Serve the chat shells this suite needs regardless of instance flags, and
 * hide the product announcement card: it floats over the composer dock on a
 * fresh instance (a returning user has already dismissed it).
 */
export async function mockChatFlags(context: BrowserContext) {
  await context.route("**/api/announcements/current", (route) =>
    route.fulfill({ contentType: "application/json", body: "null" }),
  );
  await context.route("**/api/instance/settings/experimental", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const upstream = await route.fetch();
    const base = upstream.ok() ? await upstream.json() : {};
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...base,
        enableClassicTaskInterface: false,
        enableConferenceRoomChat: true,
      }),
    });
  });
}

/**
 * iOS-style keyboard: the layout viewport keeps its height, only
 * window.visualViewport shrinks. Chromium cannot shrink the visual viewport
 * alone, so this stub replaces it. Opening the keyboard pans the visual
 * viewport to the bottom of the layout viewport (offsetTop = innerHeight -
 * 480, where iOS keeps a focused bottom-docked field visible) and each
 * window scroll re-dispatches visualViewport scroll, as Safari does.
 */
export async function installIosKeyboardStub(context: BrowserContext) {
  await context.addInitScript((keyboardHeight: number) => {
    const target = new EventTarget();
    const state = { open: false };
    const stub = {
      get width() {
        return window.innerWidth;
      },
      get height() {
        return state.open ? keyboardHeight : window.innerHeight;
      },
      get offsetTop() {
        return state.open ? Math.max(0, window.innerHeight - keyboardHeight) : 0;
      },
      offsetLeft: 0,
      get pageTop() {
        return window.scrollY + this.offsetTop;
      },
      pageLeft: 0,
      scale: 1,
      onresize: null,
      onscroll: null,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => stub });
    window.addEventListener("scroll", () => target.dispatchEvent(new Event("scroll")), { passive: true });
    (window as unknown as { __pcKeyboard: unknown }).__pcKeyboard = {
      open() {
        state.open = true;
        target.dispatchEvent(new Event("resize"));
        target.dispatchEvent(new Event("scroll"));
      },
      close() {
        state.open = false;
        target.dispatchEvent(new Event("resize"));
        target.dispatchEvent(new Event("scroll"));
      },
    };
  }, KEYBOARD_VISIBLE_HEIGHT);
}

export async function openPhoneContext(
  browser: Browser,
  testInfo: TestInfo,
  keyboard: KeyboardMode = "none",
) {
  const context = await browser.newContext({
    ...PHONE_CONTEXT,
    baseURL: testInfo.project.use.baseURL,
  });
  await mockChatFlags(context);
  if (keyboard === "ios") await installIosKeyboardStub(context);
  return { context, page: await context.newPage() };
}

export async function openDesktopContext(browser: Browser, testInfo: TestInfo) {
  const context = await browser.newContext({
    ...DESKTOP_CONTEXT,
    baseURL: testInfo.project.use.baseURL,
  });
  await mockChatFlags(context);
  return { context, page: await context.newPage() };
}

export function taskEditor(page: Page) {
  return page
    .locator(".paperclip-task-chat-composer")
    .getByRole("textbox", { name: "editable markdown", exact: true });
}

export async function gotoTaskChat(page: Page, seed: ChatSeed) {
  await page.goto(seed.issueRoute);
  await expect(page.getByTestId("task-chat-composer-dock")).toBeVisible({ timeout: 30_000 });
  await expect(taskEditor(page)).toBeVisible();
  // Phone threads scroll the document: wait for the initial bottom pin.
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.waitForFunction(
      () => document.documentElement.scrollHeight - window.scrollY - window.innerHeight <= 48 && window.scrollY > 0,
      undefined,
      { timeout: 20_000 },
    );
  }
  // Let the coordinated reveal and initial bottom pin settle.
  await page.waitForTimeout(800);
}

export async function gotoBoardChat(page: Page, seed: ChatSeed) {
  await page.goto(seed.boardChatRoute);
  await expect(page.getByTestId("chat-composer")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
}

/** Open the software keyboard after focusing `focusTarget`. */
export async function openKeyboard(page: Page, mode: KeyboardMode, focusTarget: ReturnType<Page["locator"]>) {
  await focusTarget.click();
  if (mode === "android") {
    await page.setViewportSize({ width: PHONE.width, height: KEYBOARD_VISIBLE_HEIGHT });
  } else if (mode === "ios") {
    await page.evaluate(() => (window as unknown as { __pcKeyboard: { open(): void } }).__pcKeyboard.open());
  }
  await page.waitForTimeout(300);
}

export type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };

export type ChatMetrics = {
  /** performance.now() when measured, to skip the dock's 200ms nav transition. */
  t: number;
  scrollY: number;
  /** Desktop thread scroller position (the window does not scroll there). */
  scrollerTop: number | null;
  innerHeight: number;
  /** Height the user can actually see (visualViewport when present). */
  visibleHeight: number;
  visibleTop: number;
  scrollWidth: number;
  clientWidth: number;
  dock: Rect | null;
  editor: Rect | null;
  nav: Rect | null;
  navVisible: boolean;
  composerBottomVar: string | null;
};

export type Surface = "task" | "board";

/** Measure the composer dock, editor, nav and document overflow in one frame. */
export async function measure(page: Page, surface: Surface = "task"): Promise<ChatMetrics> {
  return page.evaluate((which) => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const dock =
      which === "task"
        ? document.querySelector('[data-testid="task-chat-composer-dock"]')
        : document.querySelector('[data-testid="chat-composer"]');
    const editor =
      which === "task"
        ? document.querySelector('[data-testid="task-chat-composer-input"] [contenteditable="true"]') ??
          document.querySelector('[data-testid="task-chat-composer-input"]')
        : document.querySelector('[data-testid="chat-composer"] textarea');
    const nav = document.querySelector('nav[aria-label="Mobile navigation"]');
    const navRect = rect(nav);
    const vv = window.visualViewport;
    const main = document.getElementById("main-content");
    const doc = document.documentElement;
    const scroller = document.querySelector('[data-testid="task-chat-scroller"]');
    return {
      t: performance.now(),
      scrollY: window.scrollY,
      scrollerTop: scroller ? scroller.scrollTop : null,
      innerHeight: window.innerHeight,
      visibleHeight: vv ? vv.height : window.innerHeight,
      visibleTop: vv ? vv.offsetTop : 0,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      dock: rect(dock),
      editor: rect(editor),
      nav: navRect,
      navVisible: !!navRect && navRect.top < window.innerHeight - 1,
      composerBottomVar: main ? getComputedStyle(main).getPropertyValue("--tc-composer-bottom").trim() || null : null,
    };
  }, surface);
}

/** Document-level horizontal overflow plus the widest offending element. */
export async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    let widest: { selector: string; right: number } | null = null;
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= doc.clientWidth + 0.5) continue;
      // Ignore content inside a horizontal scroller that clips it.
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === "auto" || ox === "hidden" || ox === "scroll" || ox === "clip") && p.getBoundingClientRect().right <= doc.clientWidth + 0.5) {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      if (!widest || r.right > widest.right) {
        const testId = el.getAttribute("data-testid");
        const slot = el.getAttribute("data-slot");
        widest = {
          selector: `${el.tagName.toLowerCase()}${testId ? `[data-testid=${testId}]` : ""}${slot ? `[data-slot=${slot}]` : ""}.${String(el.className).slice(0, 80)}`,
          right: Math.round(r.right),
        };
      }
    }
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, widest };
  });
}

/** Scroll the document (task chat) or the board-chat scroller up in touch-sized steps. */
export async function scrollUpInSteps(page: Page, totalPx = 1500, stepPx = 150, surface: Surface = "task") {
  const samples: ChatMetrics[] = [];
  for (let moved = 0; moved < totalPx; moved += stepPx) {
    await page.mouse.wheel(0, -stepPx);
    await page.waitForTimeout(60);
    samples.push(await measure(page, surface));
  }
  await page.waitForTimeout(300);
  samples.push(await measure(page, surface));
  return samples;
}

export async function setNavVisible(page: Page, visible: boolean) {
  // The nav hides on a downward scroll of more than 8px and shows on an
  // upward one; a nudge sets the desired state without leaving the bottom.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await measure(page);
    if (state.navVisible === visible) return;
    if (visible) {
      await page.mouse.wheel(0, -40);
      await page.waitForTimeout(80);
      await page.mouse.wheel(0, 40);
    } else {
      await page.mouse.wheel(0, -60);
      await page.waitForTimeout(80);
      await page.mouse.wheel(0, 60);
    }
    await page.waitForTimeout(350);
  }
}

export async function attachShot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

export async function attachMetrics(testInfo: TestInfo, name: string, data: unknown) {
  await testInfo.attach(name, { body: JSON.stringify(data, null, 2), contentType: "application/json" });
}

export const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfFoAAAAASUVORK5CYII=",
  "base64",
);

/** Encode a solid-colour RGB PNG, e.g. a portrait phone-photo-sized image. */
export function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([60, 130, 200], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const LONG_FILE_NAME = `${"phone-attachment-with-a-very-long-unbroken-file-name-".repeat(3)}`.slice(0, 116) + ".txt";

/** Attachment fixtures: a 120-character file name, a portrait PNG photo and plain files. */
export function attachmentFiles(count: number) {
  const files = [
    { name: LONG_FILE_NAME, mimeType: "text/plain", buffer: Buffer.from("long name\n") },
    { name: "phone-photo.png", mimeType: "image/png", buffer: makePng(900, 1200) },
  ];
  for (let index = files.length; index < count; index += 1) {
    files.push({ name: `notes-${index + 1}.txt`, mimeType: "text/plain", buffer: Buffer.from(`file ${index + 1}\n`) });
  }
  return files.slice(0, count);
}
