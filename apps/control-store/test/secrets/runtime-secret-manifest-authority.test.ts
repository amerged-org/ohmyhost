import { expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { createTestControl } from "../support/control-d1.js";
import { STORED_NOW, bytes } from "../support/platform-fixtures.js";
import { acceptedSecretFixture } from "./runtime-secret-fixture.js";

/** Seeds sealed rows for the scope; the authority reads names and revisions only, never the envelope. */
async function seedSecrets(
  control: Awaited<ReturnType<typeof createTestControl>>,
  scope: { organizationId: string; projectId: string; environmentId: string },
  rows: readonly { name: string; revision: number }[],
) {
  await control.core.batch(
    rows.map((row) =>
      control.core
        .prepare(
          "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?9)",
        )
        .bind(
          scope.organizationId,
          scope.projectId,
          scope.environmentId,
          row.name,
          bytes(24, 4),
          bytes(12, 5),
          bytes(32, 6),
          row.revision,
          STORED_NOW,
        ),
    ),
  );
}

it("authorizes a WFP manifest only when its names and revisions equal the scope's stored secrets", async () => {
  const control = await createTestControl();
  try {
    const r = await acceptedSecretFixture(control);
    const scope = r.scope;
    await seedSecrets(control, scope, [
      { name: "API_TOKEN", revision: 2 },
      { name: "DATABASE_URL", revision: 1 },
      // Platform gateway keys are plan-gated: a manifest may omit them, never name them without a row.
      { name: "OHMYHOST_MAIL_KEY", revision: 1 },
      { name: "OHMYHOST_BROWSER_KEY", revision: 2 },
    ]);
    const authority = r.store.runtimeSecrets.authorizeManifest;
    const manifest = (secrets: readonly { name: string; revision: number }[]) => ({
      ...scope,
      secrets,
    });

    // The manifest of the claim: every stored secret that the plan keeps, at its stored revision.
    await expect(
      authority(
        manifest([
          { name: "API_TOKEN", revision: 2 },
          { name: "DATABASE_URL", revision: 1 },
        ]),
      ),
    ).resolves.toEqual({ authorized: true });
    await expect(
      authority(
        manifest([
          { name: "API_TOKEN", revision: 2 },
          { name: "DATABASE_URL", revision: 1 },
          { name: "OHMYHOST_MAIL_KEY", revision: 1 },
          { name: "OHMYHOST_BROWSER_KEY", revision: 2 },
        ]),
      ),
    ).resolves.toEqual({ authorized: true });

    const refused = async (secrets: readonly { name: string; revision: number }[]) =>
      expect(authority(manifest(secrets))).rejects.toMatchObject({
        code: "runtime_secret_manifest",
      });
    // A revision the scope never stored, an unknown name, a duplicate and a missing secret all refuse.
    await refused([
      { name: "API_TOKEN", revision: 1 },
      { name: "DATABASE_URL", revision: 1 },
    ]);
    await refused([
      { name: "API_TOKEN", revision: 2 },
      { name: "DATABASE_URL", revision: 1 },
      { name: "INJECTED_KEY", revision: 1 },
    ]);
    await refused([
      { name: "API_TOKEN", revision: 2 },
      { name: "DATABASE_URL", revision: 1 },
      { name: "OHMYHOST_BROWSER_KEY", revision: 1 },
    ]);
    await refused([
      { name: "API_TOKEN", revision: 2 },
      { name: "API_TOKEN", revision: 2 },
      { name: "DATABASE_URL", revision: 1 },
    ]);
    await refused([{ name: "API_TOKEN", revision: 2 }]);
  } finally {
    await control.dispose();
  }
}, 240000);

it("refuses a manifest for a scope that is not active, even when its names match", async () => {
  const control = await createTestControl();
  try {
    const r = await acceptedSecretFixture(control);
    await seedSecrets(control, r.scope, [{ name: "API_TOKEN", revision: 1 }]);
    await expect(
      r.store.runtimeSecrets.authorizeManifest({
        ...r.scope,
        environmentId: newUlid(),
        secrets: [{ name: "API_TOKEN", revision: 1 }],
      }),
    ).rejects.toMatchObject({ code: "runtime_secret_delivery_scope" });
  } finally {
    await control.dispose();
  }
}, 240000);
