import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const HMR_PROBE_PATH = "src/__preview_spike_hmr__.js";
export const HMR_PROBE_ID = "__preview_spike_hmr__";
export const HMR_OVERLAY_FIXTURES = Object.freeze(["react-vite", "vanilla-vite", "astro-edge"]);
const INITIAL = "preview-probe-initial";

/** A self-accepting client module, loaded before a measured write. */
export function hmrProbeSource(marker) {
  if (marker !== INITIAL && !/^preview-probe-[a-f0-9]{32}$/u.test(marker))
    throw new Error("edit_invalid");
  return `const marker = ${JSON.stringify(marker)};\nlet output = document.getElementById("${HMR_PROBE_ID}");\nif (!output) { output = document.createElement("output"); output.id = "${HMR_PROBE_ID}"; document.body.append(output); }\noutput.textContent = marker;\nif (import.meta.hot) import.meta.hot.accept();\n`;
}

/** The full deterministic overlay descriptor is the input to the reported hash. */
export function hmrOverlay(fixture) {
  if (!HMR_OVERLAY_FIXTURES.includes(fixture)) return null;
  const astro = fixture === "astro-edge";
  return {
    version: 1,
    target: astro ? "src/pages/index.astro" : "index.html",
    anchor: "</body>",
    injection: `<script ${astro ? "is:inline " : ""}type="module" src="/${HMR_PROBE_PATH}"></script>`,
    probePath: HMR_PROBE_PATH,
    initialContent: hmrProbeSource(INITIAL),
  };
}

export function hmrOverlaySha256(fixture) {
  const overlay = hmrOverlay(fixture);
  return overlay ? createHash("sha256").update(JSON.stringify(overlay)).digest("hex") : null;
}

export function hmrWorkload(fixture) {
  if (hmrOverlay(fixture)) return "instrumented-self-accepting-module";
  if (fixture.startsWith("next-")) return "fixture-client-component";
  return "fixture-route-component";
}

/** Apply only to a disposable prepared workspace, never to the fixture archive. */
export async function applyHmrOverlay(directory, fixture) {
  const overlay = hmrOverlay(fixture);
  if (!overlay) return;
  const target = join(directory, overlay.target);
  const original = await readFile(target, "utf8");
  if (original.split(overlay.anchor).length !== 2 || original.includes(HMR_PROBE_ID))
    throw new Error("hmr_overlay_fixture_invalid");
  await writeFile(join(directory, overlay.probePath), overlay.initialContent, { flag: "wx" });
  await writeFile(
    target,
    original.replace(overlay.anchor, `${overlay.injection}${overlay.anchor}`),
  );
}
