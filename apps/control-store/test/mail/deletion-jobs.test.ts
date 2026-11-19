import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { createControlStore, type ControlStore } from "../../src/store.js";
import { seedDeletionIntent, seedOperation } from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  rowOf,
  seedLegacyMailDomain,
  seedSharedMailBinding,
  stored,
} from "../support/mail-lifecycle-fixture.js";
import { seedProject } from "../support/platform-fixtures.js";

let control: TestControl, store: ControlStore;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
}, 120_000);
afterAll(async () => control?.dispose());

describe("mail of a project that is being deleted", () => {
  it("freezes admissions in one effect, records the found resource and completes the retirement", async () => {
    const project = await seedProject(control),
      { organizationId, projectId } = project,
      { domainId } = await seedLegacyMailDomain(control, project),
      operationId = await seedOperation(project),
      now = new Date().toISOString(),
      scope = { organizationId, projectId, operationId };
    await seedDeletionIntent(project, project.prodEnvironmentId, operationId);

    // the scope exists only once the project is deleting
    expect(await store.mailDeletion.readScope(scope)).toBe(false);
    await expect(store.mailDeletion.prepare(scope)).rejects.toThrow(
      "Mail deletion scope unavailable",
    );
    await control.core
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=2 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(organizationId, projectId)
      .run();
    expect(await store.mailDeletion.readScope(scope)).toBe(true);

    // a resource found at the provider is recorded; the frozen inventory and retained senders come back
    await store.mailDeletion.recordFound({ domainId, providerDomainId: "provider_found" });
    await control.core
      .prepare(
        "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES(?1,?2,?3,?4,'resend','mail-domain',?5,?6,'provider_found')",
      )
      .bind(
        organizationId,
        newUlid(),
        projectId,
        operationId,
        new Uint8Array(32).fill(7),
        stored(now),
      )
      .run();
    expect(await store.mailDeletion.prepare(scope)).toEqual({
      inventory: ["07".repeat(32)],
      legacy: [],
      retained: [{ domain_id: domainId, provider_domain_id: "provider_found", sending: false }],
      domains: [],
    });
    expect(
      await rowOf(
        control,
        "SELECT sending,receiving,sending_status FROM resend_mail_domains WHERE domain_id=?",
        domainId,
      ),
    ).toEqual({ sending: 0, receiving: 0, sending_status: "pending" });

    // finishing is atomic with the unfinished retirement response and replays
    await control.core
      .prepare(
        "INSERT INTO resend_mail_commands(organization_id,project_id,environment_id,idempotency_key,request_sha256,created_at,domain_id) VALUES(?1,?2,?3,'retire-1',?4,?5,?6)",
      )
      .bind(
        organizationId,
        projectId,
        project.prodEnvironmentId,
        new Uint8Array(32).fill(1),
        stored(now),
        domainId,
      )
      .run();
    const finish = () => store.mailDeletion.finish({ domainId, deletedAt: now, completedAt: now });
    await finish();
    await finish();
    await store.mailDeletion.finish({ domainId: newUlid(), deletedAt: now, completedAt: now });
    expect(
      await rowOf(
        control,
        "SELECT d.deleted_at,c.response FROM resend_mail_domains d JOIN resend_mail_commands c ON c.domain_id=d.domain_id WHERE d.domain_id=?",
        domainId,
      ),
    ).toMatchObject({
      deleted_at: stored(now),
      response: expect.stringContaining('"status": "deleted"'),
    });
  });
});

describe("mail reconciliation jobs", () => {
  it("lists and claims the legacy and workspace cohorts, revalidates proofs and suspends expired bindings", async () => {
    const legacyProject = await seedProject(control),
      sharedProject = await seedProject(control),
      { domainId: legacyId } = await seedLegacyMailDomain(control, legacyProject),
      { domainId: sharedId, now } = await seedSharedMailBinding(control, store, sharedProject),
      bindingState = () =>
        rowOf(
          control,
          "SELECT state,sending FROM project_mail_domain_bindings WHERE project_id=?",
          sharedProject.projectId,
        );

    // legacy resources without a provider domain are pending; a claim is taken once per 30 s
    expect(await store.mailManagementJobs.listPendingLegacy({})).toEqual([
      {
        domain_id: legacyId,
        organization_id: legacyProject.organizationId,
        project_id: legacyProject.projectId,
        environment_id: legacyProject.prodEnvironmentId,
      },
    ]);
    expect(await store.mailManagementJobs.claimLegacy({ domainId: legacyId, now })).toBe(true);
    expect(await store.mailManagementJobs.claimLegacy({ domainId: legacyId, now })).toBe(false);
    expect(await store.mailManagementJobs.claimLegacy({ domainId: newUlid(), now })).toBe(false);

    // workspace senders that still need work: the legacy one is provisioning, the bound shared one is dirty
    const pending = await store.mailManagementJobs.listPendingWorkspaces({ now });
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain_id: legacyId, provisioning: true }),
        expect.objectContaining({ domain_id: sharedId, provisioning: false }),
      ]),
    );
    const claim = () =>
      store.mailManagementJobs.claimWorkspace({
        organizationId: sharedProject.organizationId,
        domainId: sharedId,
        now,
      });
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);
    expect(
      (await store.mailManagementJobs.listPendingWorkspaces({ now })).map(
        (row) => row["domain_id"],
      ),
    ).not.toContain(sharedId);

    // the proof expires within seven days: its project is claimed once per day
    expect(await store.mailManagementJobs.claimDueIdentity({ now })).toEqual([
      {
        organization_id: sharedProject.organizationId,
        project_id: sharedProject.projectId,
        revision: "1",
      },
    ]);
    expect(await store.mailManagementJobs.claimDueIdentity({ now })).toEqual([]);

    // once the proof has lapsed the binding is suspended and sending stops
    expect(await bindingState()).toEqual({ state: "active", sending: 1 });
    await store.mailManagementJobs.suspendExpiredBindings({
      now: new Date(Date.parse(now) + 2 * 86_400_000).toISOString(),
    });
    expect(await bindingState()).toEqual({ state: "suspended", sending: 0 });
    expect(
      await rowOf(
        control,
        "SELECT state FROM project_mail_domain_bindings WHERE project_id=?",
        legacyProject.projectId,
      ),
    ).toEqual({ state: "active" });
  });
});
