#!/usr/bin/env node
/* global process, setTimeout */
import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureEdit, fixtureOriginal } from "./browser.mjs";

const cases = [
  ["react-vite", 4171],
  ["vanilla-vite", 4172],
  ["astro-edge", 4173],
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = await realpath(process.argv[2] ?? "");
  const allowed = await Promise.all([realpath(tmpdir()), realpath("/tmp")]);
  if (!allowed.some((dir) => root.startsWith(`${dir}${sep}`)))
    throw new Error("temporary_root_required");
  const modulePath = process.env.PREVIEW_SPIKE_PLAYWRIGHT_MODULE;
  const executablePath = process.env.PREVIEW_SPIKE_CHROME_BINARY;
  if (!modulePath?.startsWith("/") || !executablePath?.startsWith("/"))
    throw new Error("browser_driver_required");
  const { chromium } = await import(pathToFileURL(await realpath(modulePath)).href);
  const browser = await chromium.launch({ headless: true, executablePath });
  const results = [];
  try {
    for (const [fixture, port] of cases) {
      const original = await fixtureOriginal(fixture, { originalApp: true });
      const path = join(root, fixture, original.path);
      const actual = await realpath(path);
      if (
        !actual.startsWith(`${root}${sep}`) ||
        !(await lstat(path)).isFile() ||
        (await readFile(path, "utf8")) !== original.content
      )
        throw new Error("temporary_fixture_not_original");
      const page = await browser.newPage();
      let frames = 0,
        navigations = 0;
      page.on("websocket", (socket) =>
        socket.on("framereceived", () => {
          frames += 1;
        }),
      );
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });
      try {
        const response = await page.goto(`http://127.0.0.1:${port}/`, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.locator("#note-id").waitFor({ state: "visible", timeout: 30000 });
        const deadline = Date.now() + 10000;
        while (!frames && Date.now() < deadline) await sleep(100);
        if (!frames) throw new Error("websocket_unobserved");
        const marker = `preview-probe-${randomBytes(16).toString("hex")}`;
        if (await page.getByText(marker).count()) throw new Error("marker_not_unique");
        await page.evaluate(() => {
          globalThis.__localFixtureProbe = true;
        });
        const beforeNavigation = navigations,
          beforeFrames = frames;
        const edit = await fixtureEdit(fixture, marker, { originalApp: true });
        await writeFile(path, edit.content);
        await page
          .locator("h1")
          .filter({ hasText: marker })
          .waitFor({ state: "visible", timeout: 15000 });
        const sameDocument = await page.evaluate(() => globalThis.__localFixtureProbe === true);
        results.push({
          fixture,
          outcome: sameDocument ? "same_document" : "reload",
          status: response.status(),
          navigations: navigations - beforeNavigation,
          frames: frames - beforeFrames,
        });
      } catch {
        results.push({ fixture, outcome: "unobserved_or_timeout" });
      } finally {
        await writeFile(path, original.content);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(`${JSON.stringify({ scope: "local_framework_only", results })}\n`);
  if (results.some((result) => result.outcome === "unobserved_or_timeout")) process.exitCode = 1;
}

try {
  await main();
} catch {
  process.stderr.write("Local framework check stopped.\n");
  process.exitCode = 1;
}
