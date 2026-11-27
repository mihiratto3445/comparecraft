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

async function settingsHost(page: Page, initial: Record<string, unknown> = {}) {
  let settings = initial;
  await page.route("**/test-invoke", (route) => {
    const { cmd, args } = route.request().postDataJSON();
    if (cmd === "load_settings") return route.fulfill({ json: settings });
    if (cmd === "save_settings") {
      settings = args.value ?? args.settings;
      return route.fulfill({ json: null });
    }
    return route.continue();
  });
  return () => settings;
}

const open = (page: Page, kind: string, paths: string[]) => page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind, paths }))}`);

const sentence = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `word${i}`).join(" ") + tag;

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

test("text merge and text edit wrap long lines", async ({ page, folders }) => {
  await settingsHost(page);
  await folders.pair("m.txt", ["a", sentence(150), "c"].join("\n"), ["a", sentence(150), "C"].join("\n"));
  await folders.pair("base.txt", ["a", sentence(150), "c"].join("\n"), "");
  await page.setViewportSize({ width: 1200, height: 800 });
  await open(page, "merge", [join(folders.left, "m.txt"), join(folders.right, "m.txt"), join(folders.left, "base.txt")]);
  const top = page.locator(".tab-view:visible .mtop");
  await expect(top.locator(".mrow").first()).toBeVisible({ timeout: 15000 });
  await expect(top).toHaveClass(/wrapped/);
  await expect(top.locator(".seg").first()).toBeVisible();
  const boxes = await top.locator(".mrow").evaluateAll((rows) => rows.map((row) => [(row as HTMLElement).offsetTop, (row as HTMLElement).offsetHeight]));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i][0]).toBe(boxes[i - 1][0] + boxes[i - 1][1]);
  expect(await top.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.locator(".tab-view:visible .mbottom .seg").first()).toBeVisible();

  await open(page, "edit", [join(folders.left, "m.txt")]);
  const area = page.locator(".tab-view:visible textarea.text-edit");
  await expect(area).toHaveValue(/word149/);
  await expect(area).toHaveAttribute("wrap", "soft");
  expect(await area.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole("button", { name: /Wrap/ }).click();
  await expect(area).toHaveAttribute("wrap", "off");
  expect(await area.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});
