import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";

it("round-trips a locked OpenTofu state through the real Worker, SQLite Durable Object and R2", async () => {
  const password = "s".repeat(43);
  const auth = `Basic ${Buffer.from(`tofu:${password}`).toString("base64")}`;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "tofu-state-test",
          compatibilityDate: "2026-09-14",
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("../dist/worker-bundle/worker-main.js", import.meta.url)),
              contents: readFileSync(
                new URL("../dist/worker-bundle/worker-main.js", import.meta.url),
                "utf8",
              ),
            },
          ],
          durableObjects: { STATES: { className: "TofuStateObject", useSQLite: true } },
          r2Buckets: ["SNAPSHOTS"],
          bindings: {
            STATE_ORIGIN: "https://dev-state.omh-installation.example.test",
            STATE_PREFIX: "poc-private-fullstack/",
            STATE_PASSWORD_SHA256: createHash("sha256").update(password).digest("hex"),
          },
        },
      ],
    }),
  );
  const origin =
    "https://dev-state.omh-installation.example.test/state/poc-private-fullstack/aws-build.tfstate";
  const lock = JSON.stringify({ ID: "test-lock-id", Operation: "OperationTypeApply" });
  const state = JSON.stringify({ version: 4, serial: 1, lineage: "test-lineage", outputs: {} });
  try {
    const call = (method, body, suffix = "") =>
      mf.dispatchFetch(`${origin}${suffix}`, {
        method,
        headers: { authorization: auth },
        ...(body === undefined ? {} : { body }),
      });
    expect((await call("GET")).status).toBe(404);
    expect((await call("LOCK", lock)).status).toBe(200);
    expect((await call("POST", state, "?ID=test-lock-id")).status).toBe(200);
    expect(await (await call("GET")).text()).toBe(state);
    expect((await call("UNLOCK", lock)).status).toBe(200);
    expect((await call("GET")).status).toBe(200);
  } finally {
    await mf.dispose();
  }
});
