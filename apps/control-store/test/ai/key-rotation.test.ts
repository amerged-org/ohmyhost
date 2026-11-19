import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { AI_KEY_NAME } from "@ohmyhost/platform/shared";

import { authorizeAiKey } from "../../src/catalog/ai/index.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { digestOf, readyProject } from "./support.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

it("rotates an installed AI key: the old key stops authorizing and the new key keeps the environment's scope", async () => {
  const p = await readyProject(control, { jurisdiction: "eu" });
  const store = createControlStore({ CONTROL_CORE: control.core });
  const next = `omh_ai_${p.project.projectId}_${"b".repeat(43)}`;
  const digest = Uint8Array.from(createHash("sha256").update(next).digest());
  const generation = async () =>
    (
      await control.core
        .prepare(
          "SELECT desired_generation AS g FROM runtime_secret_delivery_states WHERE environment_id = ?",
        )
        .bind(p.project.devEnvironmentId)
        .first<{ g: number }>()
    )?.g;
  const before = await generation();
  const stored = await store.secrets.mutateEnvironmentSecret({
    organizationId: p.project.organizationId,
    projectId: p.project.projectId,
    environmentId: p.project.devEnvironmentId,
    action: "rotate",
    name: AI_KEY_NAME,
    ciphertext: new Uint8Array(32).fill(21),
    nonce: new Uint8Array(12).fill(22),
    valueSha256: digest,
    keyVersion: 1,
    writtenAt: "2026-11-14T11:00:00.000Z",
    idempotencyKey: "rotate-ai-key-1",
    requestSha256: new Uint8Array(32).fill(23),
    requestedAt: "2026-11-14T11:00:00.000Z",
  });
  expect(stored).toMatchObject({ status: "stored", secret: { name: AI_KEY_NAME, revision: 2 } });
  // The running environment is told of the new value by the delivery generation, which advances with the rotation.
  expect(await generation()).toBe((before ?? 0) + 1);
  expect(
    await authorizeAiKey(p.context, { projectId: p.project.projectId, keySha256: digestOf(p.key) }),
  ).toBeNull();
  expect(
    await authorizeAiKey(p.context, { projectId: p.project.projectId, keySha256: digestOf(next) }),
  ).toEqual(p.scope);
});
