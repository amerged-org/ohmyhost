import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { releaseProviderClaim } from "../support/accepted-operation.js";
import { authorizeMailGatewayKey } from "../../src/catalog/mail/auth.js";
import { createControlStore } from "../../src/store.js";
import { hash, mailFixture } from "./mail-fixture.js";
import { newUlid } from "../../src/catalog/common.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control?.dispose());

it("stops the old mail key at the mail gateway after a rotation and admits the new one with the same sender", async () => {
  const f = await mailFixture(control);
  const input = { projectId: f.scope.projectId, keySha256: hash(f.key) };
  expect(await authorizeMailGatewayKey(f.context, input)).toEqual({ ...f.scope, domain: f.domain });
  // The installing deployment still holds its claim; a rotation is an owner write, so the claim is released first.
  await releaseProviderClaim(f.fixture.project);
  const next = `${newUlid()}${newUlid()}`.slice(0, 43);
  const sealed = await f.cipher.encrypt({ ...f.scope, name: "OHMYHOST_MAIL_KEY", value: next });
  const store = createControlStore(control.bindings);
  expect(
    await store.secrets.mutateEnvironmentSecret({
      ...f.scope,
      action: "rotate",
      name: "OHMYHOST_MAIL_KEY",
      ...sealed,
      writtenAt: "2026-11-14T11:00:00.000Z",
      idempotencyKey: "rotate-mail-key-1",
      requestSha256: new Uint8Array(32).fill(0x61),
      requestedAt: "2026-11-14T11:00:00.000Z",
    }),
  ).toMatchObject({ status: "stored", secret: { name: "OHMYHOST_MAIL_KEY", revision: 2 } });
  expect(await authorizeMailGatewayKey(f.context, input)).toBeNull();
  expect(
    await authorizeMailGatewayKey(f.context, {
      projectId: f.scope.projectId,
      keySha256: hash(next),
    }),
  ).toEqual({ ...f.scope, domain: f.domain });
});
