import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { newUlid } from "../../src/catalog/common.js";
import { createTestControl } from "../support/control-d1.js";
import { workflowFixture } from "./workflow-fixture.js";
import { claimProductProviderMutation } from "../../src/catalog/provisioning/provider-claim.js";
import { authorizeProductProviderMutation } from "../../src/catalog/provisioning/provider-authorization.js";
import { SharedCoreRouter } from "../../src/router.js";
import { beforeFirstWrite, losingWriteResponses } from "../support/platform-fixtures.js";
const context = (db: Awaited<ReturnType<typeof createTestControl>>["core"]) => ({
  directory: db,
  router: new SharedCoreRouter(db),
});
const inputOf = (r: Awaited<ReturnType<typeof workflowFixture>>) => ({
  organizationId: parseUlid(r.p.organizationId),
  projectId: parseUlid(r.p.projectId),
  environmentId: parseUlid(r.input.environmentId),
  operationId: parseUlid(r.input.operationId),
  acceptedLifecycleVersion: 1,
});
it("authorizes on the five fields, refuses absence and a changed lifecycle without granting or changing a claim, and follows current ownership rather than the claim's epoch", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c);
    const input = inputOf(r);
    await expect(authorizeProductProviderMutation(context(c.core), input)).rejects.toThrow(
      "authorized",
    );
    for (const patch of [
      { claimId: r.input.claimId },
      { acceptedLifecycleVersion: 0 },
      { acceptedLifecycleVersion: 2147483648 },
      { organizationId: "invalid" },
    ])
      await expect(
        authorizeProductProviderMutation(context(c.core), { ...input, ...patch }),
      ).rejects.toThrow();
    await claimProductProviderMutation(context(c.core), r.input);
    const foreign = await workflowFixture(c);
    await expect(
      authorizeProductProviderMutation(context(c.core), {
        ...input,
        projectId: foreign.p.projectId,
      }),
    ).rejects.toThrow("authorized");
    expect(await authorizeProductProviderMutation(context(c.core), input)).toBeUndefined();
    await expect(
      authorizeProductProviderMutation(context(c.core), { ...input, acceptedLifecycleVersion: 2 }),
    ).rejects.toThrow("authorized");
    expect(
      await authorizeProductProviderMutation(context(losingWriteResponses(c.core, 1)), input),
    ).toBeUndefined();
    // Five-field authorization uses current ownership/lifecycle, without requiring the claim's epoch to remain current/open.
    const ended = "2026-10-29T12:00:00.000000Z";
    await c.core
      .prepare("UPDATE billing_epochs SET ended_at=? WHERE billing_epoch_id=?")
      .bind(ended, r.p.billingEpochId)
      .run();
    expect(await authorizeProductProviderMutation(context(c.core), input)).toBeUndefined();
    const epoch = newUlid();
    await c.core
      .prepare(
        "INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id) VALUES(?,?,?,?,'user:fixture')",
      )
      .bind(epoch, r.p.projectId, r.p.organizationId, ended)
      .run();
    await c.core
      .prepare(
        "UPDATE projects SET active_billing_epoch_id=? WHERE project_id=? AND organization_id=?",
      )
      .bind(epoch, r.p.projectId, r.p.organizationId)
      .run();
    expect(await authorizeProductProviderMutation(context(c.core), input)).toBeUndefined();
    await c.core
      .prepare(
        "UPDATE projects SET owner_state='security_frozen' WHERE project_id=? AND organization_id=?",
      )
      .bind(r.p.projectId, r.p.organizationId)
      .run();
    await expect(authorizeProductProviderMutation(context(c.core), input)).rejects.toThrow(
      "authorized",
    );
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 60_000);
it("rechecks delegated consent, pinned source and owner/lifecycle inside the actual authorization batch", async () => {
  const c = await createTestControl();
  try {
    for (const mode of ["grant", "source", "owner", "lifecycle"]) {
      const r = await workflowFixture(c, { delegated: true, production: true });
      await claimProductProviderMutation(context(c.core), r.input);
      let changed = false;
      const race = beforeFirstWrite(c.core, async () => {
        changed = true;
        if (mode === "grant")
          await c.core
            .prepare(
              "UPDATE mcp_client_grants SET revoked_at='2026-10-28T11:00:06.000000Z' WHERE grant_id=?",
            )
            .bind(r.grantId)
            .run();
        if (mode === "source")
          await c.core
            .prepare(
              "UPDATE project_source_bindings SET generation=generation+1 WHERE organization_id=? AND project_id=?",
            )
            .bind(r.p.organizationId, r.p.projectId)
            .run();
        if (mode === "owner")
          await c.core
            .prepare(
              "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=? AND project_id=?",
            )
            .bind(r.p.organizationId, r.p.projectId)
            .run();
        if (mode === "lifecycle")
          await c.core
            .prepare(
              "UPDATE projects SET lifecycle_version=lifecycle_version+1 WHERE organization_id=? AND project_id=?",
            )
            .bind(r.p.organizationId, r.p.projectId)
            .run();
      });
      await expect(authorizeProductProviderMutation(context(race), inputOf(r))).rejects.toThrow();
      expect(changed).toBe(true);
      expect(
        await c.core
          .prepare("SELECT count(*) n FROM product_provider_mutation_claims WHERE claim_id=?")
          .bind(r.input.claimId)
          .first(),
      ).toEqual({ n: 1 });
    }
  } finally {
    await c.dispose();
  }
});
it("never turns an old successful authorization into permission after lost reply and revocation", async () => {
  const c = await createTestControl();
  try {
    for (const mode of ["grant", "owner"]) {
      const r = await workflowFixture(c, { delegated: mode === "grant", production: true });
      await claimProductProviderMutation(context(c.core), r.input);
      const lost = losingWriteResponses(c.core, 1);
      let revoked = false;
      const db = {
        prepare: (sql: string) => lost.prepare(sql),
        batch: async (statements: Parameters<typeof lost.batch>[0]) => {
          try {
            return await lost.batch(statements);
          } catch (e) {
            if (!revoked && e instanceof Error && e.message.includes("Network connection lost")) {
              if (mode === "grant")
                await c.core
                  .prepare(
                    "UPDATE mcp_client_grants SET revoked_at='2026-10-28T11:00:06.000000Z' WHERE grant_id=?",
                  )
                  .bind(r.grantId)
                  .run();
              else
                await c.core
                  .prepare(
                    "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=? AND project_id=?",
                  )
                  .bind(r.p.organizationId, r.p.projectId)
                  .run();
              revoked = true;
            }
            throw e;
          }
        },
      };
      await expect(authorizeProductProviderMutation(context(db), inputOf(r))).rejects.toMatchObject(
        mode === "grant"
          ? {
              name: "OperationAuthorizationConflictError",
              code: "operation_authorization_changed",
            }
          : { name: "DeploymentPersistenceConflictError" },
      );
      expect(revoked).toBe(true);
    }
  } finally {
    await c.dispose();
  }
});
