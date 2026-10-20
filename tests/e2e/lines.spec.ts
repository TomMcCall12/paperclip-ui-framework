import { expect, test, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  const body = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as Record<string, unknown>;
}

test("Lines list and filtered task tree remain usable on desktop and mobile", async ({ request, page }) => {
  const company = await json(await request.post("/api/companies", { data: { name: `Lines browser ${Date.now()}` } }));
  const companyId = company.id as string;
  const prefix = company.issuePrefix as string;
  const root = await json(await request.post(`/api/companies/${companyId}/issues`, {
    data: { title: "Prepare customer launch", description: "Coordinate the launch work.", status: "backlog" },
  }));
  const other = await json(await request.post(`/api/companies/${companyId}/issues`, {
    data: { title: "Prepare partner launch", status: "backlog" },
  }));
  const child = await json(await request.post(`/api/companies/${companyId}/issues`, {
    data: { title: "Review landing page", parentId: root.id, status: "todo" },
  }));
  const line = await json(await request.post(`/api/companies/${companyId}/lines`, { data: { rootIssueId: root.id } }));
  await json(await request.post(`/api/companies/${companyId}/lines`, { data: { rootIssueId: other.id } }));

  await page.goto(`/${prefix}/lines`);
  await expect(page.locator("#main-content").getByRole("heading", { name: "Lines" })).toBeVisible();
  await expect(page.getByText("Prepare customer launch")).toBeVisible();
  await expect(page.getByText("Prepare partner launch")).toBeVisible();
  await page.screenshot({ path: "tests/e2e/test-results/lines-desktop.png" });
  await page.getByRole("searchbox", { name: "Search Lines" }).fill("no matching work");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No Lines match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText("Prepare customer launch")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${prefix}/lines`);
  await expect(page.getByRole("searchbox", { name: "Search Lines" })).toBeVisible();
  await expect(page.getByText("Prepare customer launch")).toBeVisible();
  await expect(page.getByText("Prepare partner launch")).toBeVisible();
  await page.screenshot({ path: "tests/e2e/test-results/lines-mobile-list.png" });
  await page.goto(`/${prefix}/lines/${line.id}?status=todo`);
  await expect(page.getByRole("heading", { name: "Task tree" })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`${child.identifier}: Review landing page`) })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`${root.identifier}: Prepare customer launch`) })).toBeVisible();
  await expect(page.getByText("Context", { exact: true })).toBeVisible();
  await expect(page.getByText("Coordinate the launch work.")).toBeVisible();
  await expect(page.getByText("No blueprint yet")).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search Lines" })).not.toBeVisible();
  await page.screenshot({ path: "tests/e2e/test-results/lines-mobile-detail.png" });

  await page.goto(`/${prefix}/issues`);
  await expect(page.locator(`a[href*="/lines/${line.id}"]`).first()).toBeVisible();
  await page.goto(`/lines/${line.id}`);
  await expect(page).toHaveURL(new RegExp(`/${prefix}/lines/${line.id}$`));
  await expect(page.getByRole("heading", { name: "Task tree" })).toBeVisible();
});
