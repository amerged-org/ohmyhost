import { expect, it } from "vitest";

import { migrationFiles, createTestControl } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import { STORED_NOW, bytes } from "../support/platform-fixtures.js";
import { acceptedSecretFixture } from "./runtime-secret-fixture.js";

const MIGRATION = "0646_user_secret_digest_cleanup.sql";

it("clears legacy unsalted digests of user secrets and keeps those of platform keys", async () => {
  const control = await createTestControl();
  try {
    const r = await acceptedSecretFixture(control);
    const { organizationId, projectId, environmentId } = r.scope;
    const legacy = bytes(32, 7);
    await control.core.batch(
      ["DATABASE_URL", "OHMYHOST_MAIL_KEY", "API_TOKEN"].map((name) =>
        control.core
          .prepare(
            "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,1,1,?8,?8)",
          )
          .bind(
            organizationId,
            projectId,
            environmentId,
            name,
            bytes(24, 4),
            bytes(12, 5),
            legacy,
            STORED_NOW,
          ),
      ),
    );

    // The migration is applied again to the populated Core; it must touch only the user row.
    await control.core.batch(
      splitStatements(migrationFiles("core").find(({ name }) => name === MIGRATION)?.sql ?? "").map(
        (statement) => control.core.prepare(statement),
      ),
    );

    const digests = await control.core
      .prepare(
        "SELECT name, value_sha256 FROM environment_secrets WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 ORDER BY name",
      )
      .bind(organizationId, projectId, environmentId)
      .all<{ name: string; value_sha256: number[] }>();
    const byName = Object.fromEntries(
      digests.results.map((row) => [row.name, Uint8Array.from(row.value_sha256)]),
    );
    expect(byName["API_TOKEN"]).toEqual(new Uint8Array(32));
    expect(byName["DATABASE_URL"]).toEqual(legacy);
    expect(byName["OHMYHOST_MAIL_KEY"]).toEqual(legacy);

    // The envelope trigger is restored: a digest change without a revision bump still aborts.
    await expect(
      control.core
        .prepare(
          "UPDATE environment_secrets SET value_sha256=?1 WHERE organization_id=?2 AND project_id=?3 AND environment_id=?4 AND name='API_TOKEN'",
        )
        .bind(bytes(32, 9), organizationId, projectId, environmentId)
        .run(),
    ).rejects.toThrow(/secret envelope changes only with a revision bump/u);
  } finally {
    await control.dispose();
  }
}, 240000);
