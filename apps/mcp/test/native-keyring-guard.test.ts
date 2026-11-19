import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import {
  CredentialStoreUnavailableError,
  NativeKeyringProfileRegistry,
  NativeNapiKeyringCredentialStore,
} from "@ohmyhost/product-cli";

// The MCP package resolves the product CLI through its package entry, which may be the built
// output rather than its source. The test guard must cover that module too (incident 2026-09-24).
// Only a service no client uses is named, so even a broken guard could read nothing real.
const SERVICE = `ohmyhost-guard-proof-${randomUUID()}`;

it("keeps the product CLI build the MCP package loads away from the real native store", async () => {
  await expect(
    new NativeNapiKeyringCredentialStore(undefined, SERVICE, "probe").read(),
  ).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
  // A saved login's token comes from the same guarded store; its list lives below the temporary
  // home the test setup gives product code, so reading it touches nothing of the operator's.
  const registry = new NativeKeyringProfileRegistry(undefined, SERVICE);
  await expect(
    registry
      .credential({
        name: "probe",
        userId: "user_probe",
        organizationId: null,
        organizationName: null,
      })
      .read(),
  ).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
  expect(await registry.list()).toEqual([]);
});
