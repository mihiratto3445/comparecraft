import { test, expect } from "./fixtures";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

const leftPane = (page: Page) => page.locator(".tab-view:visible .tpane").nth(0);
const editor = (page: Page) => page.locator(".tab-view:visible .line-edit");
const texts = (pane: Locator) => pane.locator(".trow .tx").allTextContents();

async function open(page: Page, folders: { left: string; right: string; pair: (n: string, l: string, r: string) => Promise<void> }, extra: Record<string, unknown> = {}) {
  await folders.pair("edit.txt", "one\ntwo\nthree\nfour\n", "ONE\nTWO\nTHREE\nfour\n");
  const path = (dir: string) => join(dir, "edit.txt");
  const spec = { kind: "text", paths: [path(folders.left), path(folders.right)], ...extra };
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify(spec))}`);
  await expect(page.locator(".tab-view:visible .trow").first()).toBeVisible({ timeout: 15000 });
}

/** Clicks inside the text of a row at a horizontal pixel offset from its first character. */
async function clickText(page: Page, pane: Locator, row: number, x: number) {
  const tx = pane.locator(".trow").nth(row).locator(".tx");
  const box = await tx.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + x, box!.y + box!.height / 2);
}

test("clicking a line and typing edits it at the click point", async ({ page, folders }) => {
  await open(page, folders);
  await clickText(page, leftPane(page), 0, 1);
  await expect(editor(page)).toHaveCount(0);
  await page.keyboard.type("X");
  await expect(editor(page)).toHaveValue("Xone");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveCount(0);
  await expect.poll(() => texts(leftPane(page))).toEqual(["Xone", "two", "three", "four"]);
});

test("clicking the selected line again opens the editor without a double-click", async ({ page, folders }) => {
  await open(page, folders);
  await clickText(page, leftPane(page), 0, 5);
  await expect(editor(page)).toHaveCount(0);
  await clickText(page, leftPane(page), 0, 25);
  await expect(editor(page)).toHaveValue("one");
  await page.keyboard.press("Escape");
  await expect(editor(page)).toHaveCount(0);
  await expect.poll(() => texts(leftPane(page))).toEqual(["one", "two", "three", "four"]);
});

test("typing after keyboard navigation appends at the end of the caret line", async ({ page, folders }) => {
  await open(page, folders);
  await clickText(page, leftPane(page), 0, 5);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Z");
  await expect(editor(page)).toHaveValue("twoZ");
  await page.keyboard.press("Enter");
  await expect.poll(() => texts(leftPane(page))).toEqual(["one", "twoZ", "three", "four"]);
});

test("dragging text on the selected line selects instead of editing", async ({ page, folders }) => {
  await open(page, folders);
  await clickText(page, leftPane(page), 0, 5);
  const box = await leftPane(page).locator(".trow").nth(0).locator(".tx").boundingBox();
  await page.mouse.move(box!.x + 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 20, box!.y + box!.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(editor(page)).toHaveCount(0);
  await expect(leftPane(page).locator(".trow.rsel")).toHaveCount(1);
});

test("double-click still edits and typing without a selection does nothing", async ({ page, folders }) => {
  await open(page, folders);
  await page.keyboard.type("x");
  await expect(editor(page)).toHaveCount(0);
  await leftPane(page).locator(".trow").nth(1).locator(".tx").dblclick();
  await expect(editor(page)).toHaveValue("two");
  await page.keyboard.press("Escape");
  await expect.poll(() => texts(leftPane(page))).toEqual(["one", "two", "three", "four"]);
});

test("typing on a focused toolbar control keeps its native keyboard behavior", async ({ page, folders }) => {
  await open(page, folders);
  await clickText(page, leftPane(page), 0, 5);
  const wrap = page.getByRole("button", { name: "↩ Wrap" });
  await wrap.focus();
  await page.keyboard.press("Space");
  await expect(editor(page)).toHaveCount(0);
  await expect(wrap).toHaveClass(/active/);
});

test("a read-only side neither edits on typing nor on a second click", async ({ page, folders }) => {
  await open(page, folders, { readOnly: [true, false] });
  await clickText(page, leftPane(page), 0, 5);
  await page.keyboard.type("X");
  await clickText(page, leftPane(page), 0, 25);
  await expect(editor(page)).toHaveCount(0);
  await expect.poll(() => texts(leftPane(page))).toEqual(["one", "two", "three", "four"]);
});
test("the unwrapped pane width tracks line length after edits and undo", async ({ page, folders }) => {
  await folders.pair("width.txt", "short\na much longer line\nshort\n", "x\nshort\nx\n");
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "text", paths: [join(folders.left, "width.txt"), join(folders.right, "width.txt")] }))}`);
  await expect(page.locator(".tab-view:visible .trow").first()).toBeVisible({ timeout: 15000 });
  const inner = leftPane(page).locator(".tpane-inner");
  const width = () => inner.evaluate((el) => Number.parseFloat(el.style.width.match(/[\d.]+/)?.[0] ?? "0"));
  const initial = await width();

  // Shorten the longest line: the pane must shrink.
  await leftPane(page).locator(".trow").nth(1).locator(".tx").dblclick();
  await editor(page).fill("tiny");
  await editor(page).press("Enter");
  await expect.poll(width).toBeLessThan(initial);

  // Lengthen a short line past the old maximum: the pane must grow again.
  await leftPane(page).locator(".trow").nth(0).locator(".tx").dblclick();
  await editor(page).fill("an even longer line than before");
  await editor(page).press("Enter");
  await expect.poll(width).toBeGreaterThan(initial);

  // Undo restores the pre-edit text and its width.
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect.poll(width).toBeLessThan(initial);
});
