import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  applyHmrOverlay,
  HMR_OVERLAY_FIXTURES,
  hmrOverlay,
  hmrOverlaySha256,
  hmrProbeSource,
} from "../container/hmr-probe.mjs";

test("probe overlay is deterministic, bounded to disposable copies, and refuses collisions", async () => {
  const source = fileURLToPath(
    new URL("../../../../fixtures/cloudflare-preview/", import.meta.url),
  );
  const root = await mkdtemp(join(tmpdir(), "preview-hmr-overlay-"));
  try {
    for (const fixture of HMR_OVERLAY_FIXTURES) {
      const directory = join(root, fixture);
      await cp(join(source, fixture), directory, { recursive: true });
      const overlay = hmrOverlay(fixture);
      const before = await readFile(join(directory, overlay.target), "utf8");
      const lock = fixture === "astro-edge" ? "package-lock.json" : "pnpm-lock.yaml";
      const lockBefore = await readFile(join(directory, lock));
      await applyHmrOverlay(directory, fixture);
      assert.equal(
        await readFile(join(directory, overlay.target), "utf8"),
        before.replace(overlay.anchor, `${overlay.injection}${overlay.anchor}`),
      );
      assert.equal(
        await readFile(join(directory, overlay.probePath), "utf8"),
        overlay.initialContent,
      );
      assert.deepEqual(await readFile(join(directory, lock)), lockBefore);
      assert.equal(await readFile(join(source, fixture, overlay.target), "utf8"), before);
      assert.equal(
        hmrOverlaySha256(fixture),
        createHash("sha256").update(JSON.stringify(overlay)).digest("hex"),
      );
      await assert.rejects(applyHmrOverlay(directory, fixture));
      await rm(join(directory, overlay.probePath));
      await writeFile(join(directory, overlay.target), "missing body anchor");
      await assert.rejects(applyHmrOverlay(directory, fixture), /hmr_overlay_fixture_invalid/);
      await assert.rejects(readFile(join(directory, overlay.probePath)), { code: "ENOENT" });
    }
    assert.equal(hmrOverlay("next-edge"), null);
    assert.equal(hmrOverlaySha256("next-edge"), null);
    assert.throws(() => hmrProbeSource("bad-marker"), /edit_invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
