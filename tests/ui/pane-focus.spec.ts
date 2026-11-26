import { test, expect, type Folders } from "./fixtures";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";

const view = (page: Page) => page.locator(".tab-view:visible");
const copiedText = (page: Page) => page.evaluate(() => (window as Window & { __comparecraftClipboard?: string[] }).__comparecraftClipboard ?? []);

async function captureClipboard(page: Page) {
  await page.addInitScript(() => {
    const target = window as Window & { __comparecraftClipboard?: string[] };
    target.__comparecraftClipboard = [];
    window.addEventListener("comparecraft-test-clipboard", (event) => target.__comparecraftClipboard?.push((event as CustomEvent<{ text: string }>).detail.text));
  });
}

async function openPair(page: Page, folders: Folders, kind: "text" | "table" | "picture" | "hex", name: string, left: string | Buffer, right: string | Buffer) {
  await folders.pair(name, left, right);
  const paths = [join(folders.left, name), join(folders.right, name)];
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind, paths }))}`);
}

async function openFolder(page: Page, folders: Folders) {
  await folders.pair("nested/inside.txt", "inside\n", "inside\n");
  await folders.pair("root.txt", "root\n", "root\n");
  await writeFile(join(folders.left, "left-only.txt"), "left only\n");
  await folders.open(page);
}

async function selectedFolderNames(page: Page, side: "left" | "right") {
  const child = side === "left" ? "first-child" : "last-child";
  return view(page).locator(`.frow .fside:${child}.selc:not(.missing) .fname`).evaluateAll((entries) => entries.map((entry) => Array.from(entry.childNodes)
    .filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join("").trim()));
}

test("folder Select All and Select All Files follow the focused side", async ({ page, folders }) => {
  await openFolder(page, folders);
  const scroller = view(page).locator(".fscroll");
  const root = view(page).locator(".frow").filter({ hasText: "root.txt" });

  await root.locator(".fside").last().click();
  await expect(scroller).toBeFocused();
  await expect(scroller).toHaveAttribute("data-pane-side", "right");
  await page.keyboard.press("Control+a");
  await expect.poll(() => selectedFolderNames(page, "right")).toEqual(["nested", "root.txt"]);
  await expect.poll(() => selectedFolderNames(page, "left")).toEqual([]);

  await root.locator(".fside").first().click();
  await expect(scroller).toHaveAttribute("data-pane-side", "left");
  await page.keyboard.press("Control+a");
  await expect.poll(() => selectedFolderNames(page, "left")).toEqual(["nested", "left-only.txt", "root.txt"]);
  await expect.poll(() => selectedFolderNames(page, "right")).toEqual([]);

  await root.locator(".fside").last().click();
  await page.keyboard.press("Control+Shift+a");
  await expect.poll(() => selectedFolderNames(page, "right")).toEqual(["root.txt"]);
  await expect.poll(() => selectedFolderNames(page, "left")).toEqual([]);
});

test("folder Select All uses focus after Ctrl+click selects both sides", async ({ page, folders }) => {
  await openFolder(page, folders);
  const scroller = view(page).locator(".fscroll");
  const root = view(page).locator(".frow").filter({ hasText: "root.txt" });

  await root.locator(".fside").first().click();
  await root.locator(".fside").last().click({ modifiers: ["Control"] });
  await expect(root.locator(".fside").first()).toHaveClass(/selc/);
  await expect(root.locator(".fside").last()).toHaveClass(/selc/);
  await expect(scroller).toHaveAttribute("data-pane-side", "right");

  await page.keyboard.press("Control+a");
  await expect.poll(() => selectedFolderNames(page, "right")).toEqual(["nested", "root.txt"]);
  await expect.poll(() => selectedFolderNames(page, "left")).toEqual([]);
});

test("folder twisties focus their own side", async ({ page, folders }) => {
  await openFolder(page, folders);
  const scroller = view(page).locator(".fscroll");
  const root = view(page).locator(".frow").filter({ hasText: "root.txt" });
  const directory = view(page).locator(".frow").filter({ hasText: "nested" });

  await root.locator(".fside").first().click();
  await directory.locator(".fside").last().locator(".twisty").click();
  await expect(scroller).toBeFocused();
  await expect(scroller).toHaveAttribute("data-pane-side", "right");
  await expect(view(page).locator(".frow").filter({ hasText: "inside.txt" })).toBeVisible();

  await page.keyboard.press("Control+a");
  await expect.poll(() => selectedFolderNames(page, "right")).toEqual(["nested", "inside.txt", "root.txt"]);
  await expect.poll(() => selectedFolderNames(page, "left")).toEqual([]);
});

test("text Select All follows DOM focus, and the difference map consumes Ctrl+A", async ({ page, folders }) => {
  await openPair(page, folders, "text", "focus.txt", "one\ntwo\nthree\nfour\n", "ONE\nTWO\nTHREE\nfour\n");
  await expect(view(page).locator(".trow").first()).toBeVisible({ timeout: 15000 });
  const left = view(page).locator(".tpane").nth(0);
  const right = view(page).locator(".tpane").nth(1);
  const map = view(page).locator(".overview");

  await map.focus();
  await page.keyboard.press("Control+a");
  await expect(view(page).locator(".trow.rsel")).toHaveCount(0);
  await expect(map).toBeFocused();

  await right.focus();
  await page.keyboard.press("Control+a");
  await expect(right.locator(".trow.rsel")).toHaveCount(4);
  await expect(left.locator(".trow.rsel")).toHaveCount(0);

  await left.focus();
  await page.keyboard.press("Control+a");
  await expect(left.locator(".trow.rsel")).toHaveCount(4);
  await expect(right.locator(".trow.rsel")).toHaveCount(0);
});

test("text Select All selects a whole side even when rows are filtered out", async ({ page, folders }) => {
  await captureClipboard(page);
  await openPair(page, folders, "text", "filtered.txt", "one\ntwo\nthree\n", "ONE\ntwo\nthree\n");
  await expect(view(page).locator(".trow").first()).toBeVisible({ timeout: 15000 });
  const left = view(page).locator(".tpane").nth(0);

  await view(page).getByRole("button", { name: "Diffs", exact: true }).click();
  await expect(left.locator(".trow")).toHaveCount(1);
  await left.focus();
  await page.keyboard.press("Control+a");
  await expect(left.locator(".trow.rsel")).toHaveCount(3);
  await page.keyboard.press("Control+c");
  await expect.poll(() => copiedText(page)).toEqual(["one\ntwo\nthree"]);
});

test("inline text editing keeps native Ctrl+A behavior", async ({ page, folders }) => {
  await openPair(page, folders, "text", "native.txt", "one\ntwo\n", "ONE\nTWO\n");
  const firstLine = view(page).locator(".tpane").first().locator(".trow .tx").first();
  await expect(firstLine).toBeVisible({ timeout: 15000 });
  await firstLine.dblclick();
  const editor = view(page).locator(".line-edit");
  await expect(editor).toHaveValue("one");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("X");
  await expect(editor).toHaveValue("X");
  await page.keyboard.press("Enter");
  await expect(view(page).locator(".tpane").first().locator(".trow .tx").first()).toHaveText("X");
});

test("table Select All and Copy follow the focused side", async ({ page, folders }) => {
  await captureClipboard(page);
  await openPair(page, folders, "table", "focus.csv", "id,value\n1,left\n2,two\n", "id,value\n1,right\n2,two\n");
  await expect(view(page).locator(".trow2").first()).toBeVisible({ timeout: 15000 });
  const left = view(page).locator(".tscroll").nth(0);
  const right = view(page).locator(".tscroll").nth(1);

  await right.focus();
  await page.keyboard.press("Control+a");
  await expect(right.locator(".tside.selside")).toHaveCount(3);
  await expect(left.locator(".tside.selside")).toHaveCount(0);
  await page.keyboard.press("Control+c");
  await expect.poll(() => copiedText(page)).toEqual(["1,right\n2,two\nid,value"]);

  await left.focus();
  await page.keyboard.press("Control+a");
  await expect(left.locator(".tside.selside")).toHaveCount(3);
  await expect(right.locator(".tside.selside")).toHaveCount(0);
});

test("picture transforms and context menus follow the focused source pane", async ({ page, folders }) => {
  const rotations: number[][] = [];
  await page.route("**/test-invoke", async (route) => {
    const { cmd, args } = route.request().postDataJSON();
    const rotate = cmd === "save_session" ? args?.session?.options?.pix?.rotate : undefined;
    if (rotate) rotations.push(rotate);
    await route.fallback();
  });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await openPair(page, folders, "picture", "focus.png", png, png);
  const panes = view(page).locator(".pic-pane");
  await expect(panes).toHaveCount(3);
  await expect(panes.locator("img").first()).toBeVisible({ timeout: 15000 });
  const rotate = page.getByRole("button", { name: "⟳ CW" });

  await panes.nth(1).focus();
  await expect(panes.nth(1)).toHaveClass(/focused/);
  await expect(rotate).toHaveAttribute("title", "Rotate Right picture clockwise");
  await rotate.click();
  await expect.poll(() => rotations).toContainEqual([0, 1]);

  await panes.nth(0).click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await expect(panes.nth(0)).toHaveClass(/focused/);
  await expect(rotate).toHaveAttribute("title", "Rotate Left picture clockwise");
  await page.keyboard.press("Escape");
});

test("hex logical columns keep focus on their shared scroller", async ({ page, folders }) => {
  await openPair(page, folders, "hex", "focus.bin", Buffer.from([0, 1, 2, 3]), Buffer.from([0, 9, 2, 3]));
  const scroller = view(page).locator(".hscroll");
  await expect(scroller.locator(".hrow").first()).toBeVisible({ timeout: 15000 });
  const sides = scroller.locator(".hrow").first().locator(".hside");

  await sides.nth(1).click({ position: { x: 20, y: 5 } });
  await expect(scroller).toBeFocused();
  await expect(scroller).toHaveAttribute("data-pane-side", "1");
  await view(page).locator(".path-input").first().focus();
  await scroller.focus();
  await expect(scroller).toHaveAttribute("data-pane-side", "1");

  await sides.nth(0).click({ position: { x: 20, y: 5 } });
  await expect(scroller).toHaveAttribute("data-pane-side", "0");
  await sides.nth(1).click({ button: "right", position: { x: 20, y: 5 } });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await expect(scroller).toHaveAttribute("data-pane-side", "1");
  await page.keyboard.press("Escape");

  await scroller.focus();
  await page.keyboard.press("ContextMenu");
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await expect(scroller).toHaveAttribute("data-pane-side", "1");
});
