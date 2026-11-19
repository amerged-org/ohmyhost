import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { STORED_NOW } from "../support/platform-fixtures.js";
import { linkSource, planDataChange, productRig } from "../support/product-api-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
}, 120_000);
afterAll(async () => control?.dispose());

const one = async (sql: string, ...values: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...values)
    .first<Record<string, unknown>>();

describe("productApi data change planning", () => {
  it("replaces the protected Dev share link with the sealed renewal of the accepted data change", async () => {
    const rig = await productRig(control, { shared: false });
    await linkSource(rig);
    const db = control.core;
    await db.batch([
      db
        .prepare("UPDATE environments SET dev_access_epoch=1 WHERE environment_id=?1")
        .bind(rig.devEnvironmentId),
      db
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_seed','admin','active',1,?2,?3,'evt')",
        )
        .bind(rig.organizationId, new Uint8Array(32).fill(1), STORED_NOW),
      db
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner',?4)",
        )
        .bind(rig.organizationId, newUlid(), rig.principalId, STORED_NOW),
      db
        .prepare(
          "INSERT INTO dev_share_links(organization_id,project_id,environment_id,token_sha256,ciphertext,nonce,key_version,generation,created_at) VALUES(?1,?2,?3,?4,?5,?6,1,1,?7)",
        )
        .bind(
          rig.organizationId,
          rig.projectId,
          rig.devEnvironmentId,
          new Uint8Array(32).fill(8),
          new Uint8Array(20).fill(9),
          new Uint8Array(12).fill(10),
          STORED_NOW,
        ),
    ]);
    const api = rig.store.productApi,
      { state, plan, request } = await planDataChange(rig, "reset_dev");
    expect(state.renewal).toEqual({
      kind: "protected",
      scope: {
        organizationId: rig.organizationId,
        projectId: rig.projectId,
        environmentId: rig.devEnvironmentId,
        handle: rig.handle,
        origin: `https://dev-${rig.handle}.check.omh.st`,
        devAccessEpoch: 1,
      },
      generation: 1,
      liveShareLinks: 1,
    });
    if (state.renewal?.kind !== "protected") throw new Error("the Dev share is not protected");
    // Re-issuing the same plan is answered from its command log and writes nothing.
    await expect(api.issueApiProjectDataChangePlan(plan)).resolves.toBeUndefined();

    // A protected share must be renewed by the data change; the sealed replacement is stored as generation 2.
    await expect(api.acceptApiProductOperation(request())).rejects.toThrow(
      "data_change_not_applicable",
    );
    const sealed = {
      ciphertext: new Uint8Array(24).fill(21),
      nonce: new Uint8Array(12).fill(22),
      valueSha256: new Uint8Array(32).fill(23),
      keyVersion: 1,
    };
    const renewed = request({
      devShareRenewal: {
        expected: { mode: "protected", scope: state.renewal.scope, generation: 1 },
        sealed,
      },
    });
    expect(await api.acceptApiProductOperation(renewed)).toMatchObject({
      operationId: renewed.operationId,
      state: "queued",
    });
    expect(
      await one(
        "SELECT generation,revoked_at,key_version,hex(token_sha256) token,length(ciphertext) size FROM dev_share_links WHERE project_id=?",
        rig.projectId,
      ),
    ).toEqual({
      generation: 2,
      revoked_at: null,
      key_version: 1,
      token: "17".repeat(32),
      size: 24,
    });
    expect(
      await one(
        "SELECT dev_access_epoch FROM environments WHERE environment_id=?",
        rig.devEnvironmentId,
      ),
    ).toEqual({ dev_access_epoch: 2 });
  }, 30_000);
});
