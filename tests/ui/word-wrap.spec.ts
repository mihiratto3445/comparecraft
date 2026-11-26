import { test, expect } from "./fixtures";
import { join } from "node:path";
import type { Page } from "@playwright/test";

const leftPane = (page: Page) => page.locator(".tab-view:visible .tpane").nth(0);
const rightPane = (page: Page) => page.locator(".tab-view:visible .tpane").nth(1);
const wrapBtn = (page: Page) => page.locator(".tab-view:visible .toolbar").getByRole("button", { name: "↩ Wrap" });
const longLine = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");

async function openText(page: Page, folders: { left: string; right: string }, name: string) {
  const path = (dir: string) => join(dir, name);
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "text", paths: [path(folders.left), path(folders.right)] }))}`);
  await expect(page.locator(".tab-view:visible .trow").first()).toBeVisible({ timeout: 15000 });
}

test("word wrap splits long lines into segments and keeps both panes aligned", async ({ page, folders }) => {
  await folders.pair("wrap.txt", `${longLine}\nshort\n`, "tiny\nshort\n");
  await openText(page, folders, "wrap.txt");
  // Unwrapped, the long line scrolls horizontally.
  expect(await leftPane(page).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await wrapBtn(page).click();
  await expect(page.locator(".tab-view:visible .tcompare.wrapped")).toBeVisible();
  const segs = await leftPane(page).locator(".trow").nth(0).locator(".txseg").allTextContents();
  expect(segs.length).toBeGreaterThan(1);
  expect(segs.join("")).toBe(longLine);
  // Short words break at spaces, never mid-word.
  expect(segs.slice(0, -1).every((s) => s.endsWith(" "))).toBe(true);
  // The short right line pads to the same height as the wrapped left line.
  const leftBox = await leftPane(page).locator(".trow").nth(0).boundingBox();
  const rightBox = await rightPane(page).locator(".trow").nth(0).boundingBox();
  const shortBox = await leftPane(page).locator(".trow").nth(1).boundingBox();
  expect(leftBox!.height).toBe(rightBox!.height);
  expect(leftBox!.height).toBeGreaterThan(shortBox!.height);
  for (const pane of [leftPane(page), rightPane(page)]) {
    expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  // Toggling off restores the single-line horizontal-scroll layout.
  await wrapBtn(page).click();
  await expect(page.locator(".tab-view:visible .tcompare.wrapped")).toHaveCount(0);
  await expect(leftPane(page).locator(".txseg")).toHaveCount(0);
  expect(await leftPane(page).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test("next difference scrolls to the right position with wrapped rows", async ({ page, folders }) => {
  const filler = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
  await folders.pair("far.txt", `${filler}\n${longLine} left\n`, `${filler}\n${longLine} right\n`);
  await openText(page, folders, "far.txt");
  await wrapBtn(page).click();
  await expect(page.locator(".tab-view:visible .tcompare.wrapped")).toBeVisible();
  await page.locator(".tab-view:visible .toolbar").getByRole("button", { name: "▼ Next" }).click();
  const sel = page.locator(".tab-view:visible .trow.sel").first();
  await expect(sel).toBeVisible();
  const paneBox = (await leftPane(page).boundingBox())!;
  const selBox = (await sel.boundingBox())!;
  expect(selBox.y).toBeGreaterThanOrEqual(paneBox.y);
  expect(selBox.y + selBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height);
  // The selected row is the wrapped difference, not a uniform-height offset away.
  await expect(sel.locator(".txseg").first()).toContainText("word0");
  expect(selBox.height).toBeGreaterThan((await page.locator(".tab-view:visible .trow").nth(0).boundingBox())!.height);
});

test("wrapped lines expand tabs and keep their diff highlights", async ({ page, folders }) => {
  const tabbed = `\t${longLine} alpha\t${longLine} omega`;
  const other = `\t${longLine} beta\t${longLine} omega`;
  await folders.pair("tabs.txt", `${tabbed}\n`, `${other}\n`);
  await openText(page, folders, "tabs.txt");
  await wrapBtn(page).click();
  await expect(page.locator(".tab-view:visible .tcompare.wrapped")).toBeVisible();
  const segs = await leftPane(page).locator(".trow").nth(0).locator(".txseg").allTextContents();
  expect(segs.length).toBeGreaterThan(1);
  // Tabs render as spaces up to the next 4-column stop.
  const expanded = tabbed.replace(/\t/g, (_m, i: number, s: string) => " ".repeat(4 - (s.slice(0, i).replace(/\t/g, "    ").length % 4)));
  expect(segs.join("")).toBe(expanded);
  // The changed word stays highlighted inside its segment.
  await expect(leftPane(page).locator(".trow").nth(0).locator(".txseg .hl")).not.toHaveCount(0);
  await expect(leftPane(page).locator(".trow").nth(0).locator(".txseg .hl").first()).toHaveText("alpha");
});

test("text edit wraps the textarea to fit the display", async ({ page, folders }) => {
  await folders.pair("edit.txt", `${longLine}\nshort\n`, "unused\n");
  const path = join(folders.left, "edit.txt");
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "edit", paths: [path] }))}`);
  const area = page.locator(".tab-view:visible textarea.text-edit");
  await expect(area).toBeVisible({ timeout: 15000 });
  await expect(area).toHaveValue(`${longLine}\nshort`);
  expect(await area.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await wrapBtn(page).click();
  await expect(area).toHaveAttribute("wrap", "soft");
  expect(await area.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await wrapBtn(page).click();
  await expect(area).toHaveAttribute("wrap", "off");
});