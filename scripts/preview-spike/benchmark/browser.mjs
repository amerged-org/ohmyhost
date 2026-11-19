/* global URL, requestAnimationFrame */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { exerciseUsable } from "./capability-journeys.mjs";
import {
  HMR_PROBE_ID,
  HMR_PROBE_PATH,
  hmrOverlay,
  hmrProbeSource,
} from "../worker/container/hmr-probe.mjs";

// Only disposable workspace copies are edited. The repository fixtures remain byte-identical.
const targets = {
  "react-vite": ["src/main.tsx", "Preview notes"],
  "vanilla-vite": ["src/main.ts", null],
  "tanstack-start": ["src/routes/index.tsx", "Preview notes"],
  "next-edge": ["src/app/notes.tsx", "Preview notes"],
  "astro-edge": ["src/pages/index.astro", "Preview notes"],
  "next-native-auth": ["src/app/notes.tsx", "Native Auth preview notes"],
  "next-app-mail": ["src/app/notes.tsx", "Mail preview notes"],
};
const fixtureRoot = fileURLToPath(
  new URL("../../../fixtures/cloudflare-preview/", import.meta.url),
);

export async function fixtureOriginal(fixture, { originalApp = false } = {}) {
  const target = targets[fixture];
  if (!target) throw new Error("fixture_invalid");
  const overlay = hmrOverlay(fixture);
  if (overlay && !originalApp) return { path: HMR_PROBE_PATH, content: overlay.initialContent };
  return {
    path: target[0],
    content: await readFile(`${fixtureRoot}/${fixture}/${target[0]}`, "utf8"),
  };
}

export async function fixtureEdit(fixture, marker, { originalApp = false } = {}) {
  const target = targets[fixture];
  if (!target || !/^preview-probe-[a-f0-9]{32}$/u.test(marker)) throw new Error("edit_invalid");
  if (hmrOverlay(fixture) && !originalApp)
    return { path: HMR_PROBE_PATH, content: hmrProbeSource(marker) };
  const { path, content: source } = await fixtureOriginal(fixture, { originalApp });
  const text = target[1];
  let content;
  if (fixture.startsWith("next-")) {
    const original = "        Id\n";
    if (!source.startsWith('"use client";') || source.split(original).length !== 2)
      throw new Error("fixture_marker_invalid");
    content = source.replace(original, `        ${marker}\n`);
  } else if (text === null) {
    // Editing HTML forces a Vite reload. Edit its module and record honestly if it reloads too.
    content = `${source}\nconst spikeHeading = document.querySelector("h1");\nif (spikeHeading) spikeHeading.textContent = "${marker}";\n`;
  } else {
    const original = `<h1>${text}</h1>`;
    if (source.split(original).length !== 2) throw new Error("fixture_marker_invalid");
    content = source.replace(original, `<h1>${marker}</h1>`);
  }
  return { path, content };
}

function nextVersion(value) {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]*)$/u.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

/** Reviewed Next 16.4.1 Client Component delta, restricted to this fixture module. */
function turbopackEditObserved(message, current) {
  if (message?.type !== "turbopack-message" || !nextVersion(message.hmrVersion)) return false;
  const updates = Array.isArray(message.data) ? message.data : [message.data];
  const module = `[project]/${current.edit.path} [app-client] (ecmascript)`;
  return updates.some(
    (update) =>
      update?.type === "partial" &&
      update.instruction?.type === "ChunkListUpdate" &&
      Array.isArray(update.instruction.merged) &&
      update.instruction.merged.some((merged) => {
        if (
          merged?.type !== "EcmascriptMergedUpdate" ||
          !merged.entries ||
          typeof merged.entries !== "object" ||
          Array.isArray(merged.entries) ||
          !Object.hasOwn(merged.entries, module)
        )
          return false;
        const entry = merged.entries[module];
        return typeof entry?.code === "string" && entry.code.includes(current.marker);
      }),
  );
}

/** Playwright-compatible browser probe. The caller must own and close its browser. */
export async function createBrowserProbe({
  browser,
  url,
  fixture,
  now = () => performance.now(),
  deadlineMs = 30000,
}) {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash ||
    !targets[fixture] ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 86_400_000
  )
    throw new Error("browser_target_invalid");
  const page = await browser.newPage();
  const sockets = [];
  let pending, observing;
  const viteProtocol = !fixture.startsWith("next-");
  page.on("websocket", (socket) => {
    try {
      const observed = new URL(socket.url());
      if (observed.protocol !== "wss:" || observed.host !== target.host) return;
      if (!viteProtocol && observed.pathname !== "/_next/hmr") return;
      const connection = { socket, connected: false };
      sockets.push(connection);
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string" || payload.length > 65536) return;
        let message;
        try {
          message = JSON.parse(payload);
        } catch {
          return;
        }
        if (
          viteProtocol
            ? message?.type === "connected"
            : message?.type === "turbopack-connected" &&
              Number.isSafeInteger(message.data?.sessionId) &&
              message.data.sessionId >= 0 &&
              nextVersion(message.data.hmrVersion)
        )
          connection.connected = true;
        if (!connection.connected || !observing) return;
        if (!viteProtocol) {
          if (message?.type === "reloadPage") observing.reloadObserved = true;
          if (turbopackEditObserved(message, observing)) observing.hmrUpdateObserved = true;
          return;
        }
        if (message?.type === "full-reload") observing.reloadObserved = true;
        if (
          message?.type === "update" &&
          Array.isArray(message.updates) &&
          message.updates.some(
            (update) =>
              update?.type === "js-update" &&
              update.acceptedPath === `/${observing.edit.path}` &&
              typeof update.path === "string" &&
              update.path.startsWith("/") &&
              Number.isFinite(update.timestamp) &&
              update.timestamp >= 0,
          )
        )
          observing.hmrUpdateObserved = true;
      });
    } catch {
      // An unrelated or malformed socket is never treated as HMR evidence.
    }
  });
  const sameOrigin = () => new URL(page.url()).origin === target.origin;
  const sameUrl = () => page.url() === target.href;
  async function visibleHeading() {
    const heading = targets[fixture][1] ?? "Preview notes";
    await page
      .locator("h1")
      .filter({ hasText: new RegExp(`^${heading}$`, "u") })
      .waitFor({ state: "visible" });
    await page.locator("#note-id").waitFor({ state: "visible" });
    if (!sameOrigin()) throw new Error("browser_origin_changed");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  async function waitUsable({ signal } = {}) {
    await visibleHeading();
    await exerciseUsable(page, fixture, { signal });
    if (!sameOrigin()) throw new Error("browser_origin_changed");
  }
  return {
    page,
    async navigate(options = {}) {
      await page.goto(target.href, { waitUntil: "domcontentloaded" });
      await waitUsable(options);
      return { usable: true, sameUrl: sameUrl() };
    },
    waitUsable,
    socketOpen() {
      return sockets.some(({ socket, connected }) => connected && !socket.isClosed());
    },
    async prepareEdit() {
      // A Vite handshake can precede this particular module's load. Require the
      // already-rendered initial or previous marker before dispatching any write.
      pending = undefined;
      if (hmrOverlay(fixture)) {
        const output = page.locator(`#${HMR_PROBE_ID}`);
        await output.waitFor({ state: "visible", timeout: deadlineMs });
        const previous = await output.textContent({ timeout: deadlineMs });
        if (
          previous !== "preview-probe-initial" &&
          !/^preview-probe-[a-f0-9]{32}$/u.test(previous ?? "")
        )
          throw new Error("hmr_probe_not_ready");
      }
      const marker = `preview-probe-${randomBytes(16).toString("hex")}`;
      const sentinel = `__preview_probe_${randomBytes(16).toString("hex")}`;
      const edit = await fixtureEdit(fixture, marker);
      await page.evaluate((name) => {
        globalThis[name] = true;
      }, sentinel);
      // Install the observer before the write; consume both success and failure promises.
      const markerLocator = hmrOverlay(fixture)
        ? page.locator(`#${HMR_PROBE_ID}`).filter({ hasText: marker })
        : viteProtocol
          ? page.locator("h1").filter({ hasText: marker })
          : page.getByText(marker, { exact: true });
      const visible = markerLocator.waitFor({ state: "visible" }).then(
        () => true,
        () => false,
      );
      pending = {
        marker,
        sentinel,
        edit,
        visible,
        hmrUpdateObserved: false,
        reloadObserved: false,
      };
      return { ready: true };
    },
    async editAndObserve(sendEdit) {
      const current = pending;
      pending = undefined;
      if (!current) throw new Error("edit_not_prepared");
      let dispatchAt = null,
        dispatchCalls = 0;
      const onDispatch = () => {
        dispatchCalls += 1;
        if (dispatchCalls === 1) {
          dispatchAt = now();
          observing = current;
        }
      };
      // Observe paint concurrently with the guarded control request. Both
      // timestamps use this Node process's monotonic clock, never browser time.
      const painted = current.visible.then(async (visible) => {
        if (!visible) throw new Error("edit_not_visible");
        const markerAfterDispatch = dispatchCalls === 1 && Number.isFinite(dispatchAt);
        if (!sameOrigin()) throw new Error("browser_origin_changed");
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        return { markerAfterDispatch, paintAt: now() };
      });
      try {
        const [confirmed, paint] = await Promise.all([
          Promise.resolve().then(() => sendEdit(current.edit, onDispatch)),
          painted,
        ]);
        if (!sameOrigin()) throw new Error("browser_origin_changed");
        const sameDocument = await page.evaluate(
          (name) => globalThis[name] === true,
          current.sentinel,
        );
        const dispatchObserved =
          dispatchCalls === 1 && Number.isFinite(dispatchAt) && dispatchAt >= 0;
        const paintObserved =
          dispatchObserved &&
          paint.markerAfterDispatch &&
          Number.isFinite(paint.paintAt) &&
          paint.paintAt >= dispatchAt &&
          paint.paintAt - dispatchAt <= 86_400_000;
        const controlConfirmed = confirmed?.controlConfirmed === true;
        return {
          visible: true,
          sameDocument,
          hmrUpdateObserved: current.hmrUpdateObserved && !current.reloadObserved,
          dispatchObserved,
          paintObserved,
          controlConfirmed,
          editToPaintMs: paintObserved && controlConfirmed ? paint.paintAt - dispatchAt : null,
        };
      } finally {
        observing = undefined;
      }
    },
    async close() {
      await page.close();
    },
  };
}
