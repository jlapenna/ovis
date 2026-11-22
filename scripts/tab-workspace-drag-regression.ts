import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import { sessionSnapshot, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const evidence = process.env.UI_EVIDENCE_DIR;

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function center(locator: Locator, label: string): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} is drawn`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `tab-workspace-drag-${name}.png`) });
}

const row = (page: Page, workspaceId: string) => page.locator(`.workspace-group[data-workspace=${JSON.stringify(workspaceId)}]`);
const header = (page: Page, workspaceId: string) => row(page, workspaceId).locator("> .workspace-header");
const marked = (page: Page) => page.locator(".workspace-group.is-tab-drop").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset["workspace"]));
const tabsIn = async (workspaceId: string, label: string) => (await sessionSnapshot()).tabs.filter((tab) => tab.workspace_id === workspaceId && tab.label.endsWith(` ${label}`));

/** A tab dragged out of its strip and let go on another workspace's sidebar row moves to that workspace. */
export async function checkTabWorkspaceDrag(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-tab-workspace-drag-")));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })); });
  try {
    const source = await workspaceCreate({ cwd: root, label: "ovis-test-tab-drag-from" });
    workspaces.push(source.workspace.workspace_id);
    const target = await workspaceCreate({ cwd: root, label: "ovis-test-tab-drag-to" });
    workspaces.push(target.workspace.workspace_id);
    const from = source.workspace.workspace_id;
    const to = target.workspace.workspace_id;
    await tabCreate({ workspaceId: from, label: "drag-me" });

    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const moves: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/tab/move-to-workspace")) moves.push(request.postData() ?? ""); });
    await page.goto(`${origin}/?pane=${encodeURIComponent(source.root_pane.pane_id)}`);
    await page.locator(".conn-live").waitFor();
    const tab = page.locator(".tab-strip").getByRole("tab", { name: /drag-me$/ });
    await tab.waitFor();
    await header(page, to).waitFor();

    // held over its own workspace's row, the tab marks nothing and goes nowhere
    const start = await center(tab, "the dragged tab");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const own = await center(header(page, from), "the tab's own workspace row");
    await page.mouse.move(own.x, own.y, { steps: 10 });
    assert.deepEqual(await marked(page), [], "the tab's own workspace is no drop target");
    // Escape lets go of the drag: nothing moves
    const away = await center(header(page, to), "the other workspace row");
    await page.mouse.move(away.x, away.y, { steps: 6 });
    await until(async () => JSON.stringify(await marked(page)) === JSON.stringify([to]), "the other workspace's row is marked");
    await page.keyboard.press("Escape");
    await until(async () => (await marked(page)).length === 0, "Escape clears the mark");
    await page.mouse.up();
    assert.equal(moves.length, 0, "a cancelled drag moves nothing");
    assert.equal((await tabsIn(from, "drag-me")).length, 1, "the tab stays where it was");

    // dragged again and let go on the other workspace's row, the tab moves there
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(away.x, away.y, { steps: 10 });
    await until(async () => JSON.stringify(await marked(page)) === JSON.stringify([to]), "the drop target is marked");
    await screenshot(page, "over-row");
    await page.mouse.up();
    await until(async () => (await tabsIn(to, "drag-me")).length === 1, "herdr moves the tab to the other workspace");
    assert.equal((await tabsIn(from, "drag-me")).length, 0, "the tab left its workspace");
    assert.equal(moves.length, 1, "one move was asked for");
    assert.deepEqual(await marked(page), [], "nothing stays marked after the drop");
    await screenshot(page, "moved");
    assert.deepEqual(errors, []);
    console.log("PASS a tab dragged onto another workspace's sidebar row moves there; its own row and a cancelled drag move nothing");
  } finally {
    await context.close();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-tab-workspace-drag-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try { await checkTabWorkspaceDrag(browser, `http://127.0.0.1:${server.port}`); }
  finally { await browser.close(); server.stop(); rmSync(state, { recursive: true, force: true }); }
}
