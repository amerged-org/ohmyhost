import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { STORED_NOW } from "../support/platform-fixtures.js";
import {
  linkSource,
  productRig,
  requestDigest,
  type ProductRig,
} from "../support/product-api-fixture.js";

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

/** A managed-Git source as the managed journal writes it: connection, grant, selected ready row and binding. */
async function selectManagedSource(rig: ProductRig, generation: number, at: string) {
  const db = control.core,
    sourceConnectionId = newUlid(),
    repository = `managed-${sourceConnectionId.toLowerCase()}`,
    external = `omh/${repository}`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'managed',?5,?6)",
      )
      .bind(
        rig.organizationId,
        sourceConnectionId,
        rig.projectId,
        rig.billingEpochId,
        external,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO repository_grants(grant_id,organization_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?1,'managed',NULL,?5,'omh',?6,'contents:read',?7)",
      )
      .bind(
        sourceConnectionId,
        rig.organizationId,
        rig.projectId,
        rig.billingEpochId,
        external,
        repository,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO project_sources(organization_id,project_id,source_id,billing_epoch_id,grant_id,provider,installation_id,external_repository_id,repository_owner,repository_name,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?3,'managed',NULL,?5,'omh',?6,'ready',?7,?8,?8)",
      )
      .bind(
        rig.organizationId,
        rig.projectId,
        sourceConnectionId,
        rig.billingEpochId,
        external,
        repository,
        generation,
        at,
      ),
    db
      .prepare(
        "INSERT INTO project_source_bindings(organization_id,project_id,source_connection_id,provider,generation,commit_sha,updated_at) VALUES(?1,?2,?3,'managed',?4,?5,?6) ON CONFLICT(organization_id,project_id) DO UPDATE SET source_connection_id=excluded.source_connection_id,provider='managed',generation=excluded.generation,commit_sha=excluded.commit_sha,updated_at=excluded.updated_at",
      )
      .bind(rig.organizationId, rig.projectId, sourceConnectionId, generation, "a".repeat(40), at),
  ]);
  return sourceConnectionId;
}

/** A later GitHub link of the project: its connection, grant and ready source row, as the link completion writes them. */
async function laterGithubSource(
  rig: ProductRig,
  externalRepositoryId: string,
  repositoryName: string,
) {
  const db = control.core,
    sourceConnectionId = newUlid(),
    grantId = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github',?5,?6)",
      )
      .bind(
        rig.organizationId,
        sourceConnectionId,
        rig.projectId,
        rig.billingEpochId,
        externalRepositoryId,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'github','7',?6,'o',?7,'contents:read',?8)",
      )
      .bind(
        rig.organizationId,
        grantId,
        rig.projectId,
        rig.billingEpochId,
        sourceConnectionId,
        externalRepositoryId,
        repositoryName,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO project_sources(organization_id,project_id,source_id,billing_epoch_id,grant_id,provider,installation_id,external_repository_id,repository_owner,repository_name,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'github','7',?6,'o',?7,'ready',1,?8,?8)",
      )
      .bind(
        rig.organizationId,
        rig.projectId,
        newUlid(),
        rig.billingEpochId,
        grantId,
        externalRepositoryId,
        repositoryName,
        STORED_NOW,
      ),
  ]);
  return sourceConnectionId;
}

describe("productApi GitHub auto-deploy configuration", () => {
  it("refuses enabling without Dev, preserves disable, then permits enable after Dev is added", async () => {
    const rig = await productRig(control, { prodOnly: true });
    const scope = { organizationId: rig.organizationId, projectId: rig.projectId };
    const configure = (enabled: boolean) => ({
      ...scope,
      principalId: rig.principalId,
      requestId: "req-auto-prod-only",
      idempotencyKey: `auto-${newUlid()}`,
      canonicalRequestDigest: requestDigest(),
      operationId: newUlid(),
      queuedEventId: newUlid(),
      succeededEventId: newUlid(),
      auditEventId: newUlid(),
      branchRef: "refs/heads/main",
      enabled,
      configuredAt: "2026-10-28T11:00:00.000Z",
    });
    await expect(
      rig.store.productApi.configureApiGithubAutoDeploy(configure(true)),
    ).rejects.toMatchObject({ code: "development_environment_missing" });
    await linkSource(rig);
    await expect(
      rig.store.productApi.configureApiGithubAutoDeploy(configure(true)),
    ).rejects.toMatchObject({ code: "development_environment_missing" });
    expect(await rig.store.productApi.readApiGithubAutoDeploy(scope)).toBeNull();
    expect(await rig.store.productApi.configureApiGithubAutoDeploy(configure(false))).toMatchObject(
      { enabled: false, generation: 1 },
    );
    await rig.store.projects.addDevelopmentEnvironment({
      ...scope,
      environmentId: newUlid(),
      operationId: newUlid(),
      operationEventId: newUlid(),
      auditEventId: newUlid(),
      outboxEventId: newUlid(),
      principalId: "service:fixture",
      requestId: "add-dev",
      idempotencyKey: "add-dev",
      canonicalRequestDigest: "b".repeat(64),
      occurredAt: "2026-10-28T11:01:00.000Z",
    });
    expect(await rig.store.productApi.configureApiGithubAutoDeploy(configure(true))).toMatchObject({
      enabled: true,
      generation: 2,
    });
  });

  it("configures once per key with its succeeded operation and audit, replays, refuses a reused key and follows the grant", async () => {
    const rig = await productRig(control),
      { sourceConnectionId, grantId } = await linkSource(rig),
      api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId };
    const configure = (overrides: Record<string, unknown> = {}) => ({
      ...scope,
      principalId: rig.principalId,
      requestId: "req-auto-deploy",
      idempotencyKey: `auto-${newUlid()}`,
      canonicalRequestDigest: requestDigest(),
      operationId: newUlid(),
      queuedEventId: newUlid(),
      succeededEventId: newUlid(),
      auditEventId: newUlid(),
      branchRef: "refs/heads/main",
      enabled: true,
      configuredAt: "2026-10-28T11:00:00.000Z",
      ...overrides,
    });
    expect(await api.readApiGithubAutoDeploy(scope)).toBeNull();

    const first = configure();
    const expected = {
      ...scope,
      sourceConnectionId,
      branchRef: "refs/heads/main",
      generation: 1,
      enabled: true,
      updatedAt: "2026-10-28T11:00:00.000Z",
      grantActive: true,
    };
    expect(await api.configureApiGithubAutoDeploy(first)).toEqual(expected);
    expect(await api.readApiGithubAutoDeploy(scope)).toEqual(expected);
    expect(
      await one("SELECT state FROM operations WHERE operation_id=?", first.operationId),
    ).toEqual({
      state: "succeeded",
    });
    expect(
      (
        await control.core
          .prepare("SELECT event_type FROM operation_events WHERE operation_id=? ORDER BY revision")
          .bind(first.operationId)
          .all()
      ).results,
    ).toEqual([{ event_type: "OperationQueued" }, { event_type: "OperationSucceeded" }]);
    expect(
      await one("SELECT event_type FROM audit_events WHERE audit_event_id=?", first.auditEventId),
    ).toEqual({ event_type: "GithubAutoDeployConfiguredV1" });

    // The same key and digest answers the stored response; another digest under the key is a conflict.
    const again = {
      ...first,
      operationId: newUlid(),
      queuedEventId: newUlid(),
      succeededEventId: newUlid(),
      auditEventId: newUlid(),
    };
    expect(await api.configureApiGithubAutoDeploy(again)).toEqual(expected);
    expect(
      await one("SELECT count(*) n FROM operations WHERE operation_id=?", again.operationId),
    ).toEqual({ n: 0 });
    await expect(
      api.configureApiGithubAutoDeploy({ ...again, canonicalRequestDigest: requestDigest() }),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });

    // An unchanged configuration keeps its generation, a changed branch advances it.
    expect(await api.configureApiGithubAutoDeploy(configure())).toMatchObject({ generation: 1 });
    expect(
      await api.configureApiGithubAutoDeploy(
        configure({ branchRef: "refs/heads/release", enabled: false }),
      ),
    ).toMatchObject({ branchRef: "refs/heads/release", enabled: false, generation: 2 });

    // After the grant is revoked the configuration can still be disabled but not enabled.
    await control.core
      .prepare(
        "INSERT INTO repository_grant_revocations(organization_id,revocation_id,grant_id,project_id,reason,revoked_at) VALUES(?1,?2,?3,?4,'permission_revoked',?5)",
      )
      .bind(rig.organizationId, newUlid(), grantId, rig.projectId, STORED_NOW)
      .run();
    expect(await api.readApiGithubAutoDeploy(scope)).toMatchObject({ grantActive: false });
    expect(await api.configureApiGithubAutoDeploy(configure({ enabled: false }))).toMatchObject({
      grantActive: false,
      enabled: false,
    });
    await expect(api.configureApiGithubAutoDeploy(configure())).rejects.toThrow(
      "auto_deploy_source_unavailable",
    );
    await expect(
      api.configureApiGithubAutoDeploy(configure({ branchRef: "refs/heads/../escape" })),
    ).rejects.toThrow();
  }, 30_000);

  it("never configures GitHub auto-deploy on a managed source, nor keeps a GitHub configuration once a switch unbinds it", async () => {
    const configure = (rig: ProductRig, enabled = true) => ({
      organizationId: rig.organizationId,
      projectId: rig.projectId,
      principalId: rig.principalId,
      requestId: "req-auto-managed",
      idempotencyKey: `auto-${newUlid()}`,
      canonicalRequestDigest: requestDigest(),
      operationId: newUlid(),
      queuedEventId: newUlid(),
      succeededEventId: newUlid(),
      auditEventId: newUlid(),
      branchRef: "refs/heads/main",
      enabled,
      configuredAt: "2026-10-28T11:00:00.000Z",
    });
    const scope = (rig: ProductRig) => ({
      organizationId: rig.organizationId,
      projectId: rig.projectId,
    });
    const configCount = async (rig: ProductRig) =>
      (
        await one(
          "SELECT count(*) n FROM github_auto_deploy_configs WHERE organization_id=?1",
          rig.organizationId,
        )
      )?.["n"];

    // A managed-Git project has no GitHub connection to watch, so there is nothing to configure.
    const managed = await productRig(control);
    await selectManagedSource(managed, 1, STORED_NOW);
    await expect(
      managed.store.productApi.configureApiGithubAutoDeploy(configure(managed)),
    ).rejects.toThrow("auto_deploy_source_unavailable");
    // Nothing is stored to switch off either.
    await expect(
      managed.store.productApi.configureApiGithubAutoDeploy(configure(managed, false)),
    ).rejects.toThrow("auto_deploy_source_unavailable");
    expect(await configCount(managed)).toBe(0);

    // GitHub is configured, then the project switches to managed: the older GitHub row stays ready, but the binding
    // no longer names its connection, so the configuration is no longer enabled and cannot be re-enabled.
    const switched = await productRig(control);
    const { sourceConnectionId } = await linkSource(switched);
    expect(
      await switched.store.productApi.configureApiGithubAutoDeploy(configure(switched)),
    ).toMatchObject({ enabled: true, generation: 1 });
    await selectManagedSource(switched, 2, "2026-10-28T11:30:00.000000Z");
    expect(await switched.store.productApi.readApiGithubAutoDeploy(scope(switched))).toMatchObject({
      enabled: false,
    });
    await expect(
      switched.store.productApi.configureApiGithubAutoDeploy(configure(switched)),
    ).rejects.toThrow("auto_deploy_source_unavailable");
    // A disable is still answered for the connection the stored configuration watches, and it stays switched off.
    expect(
      await switched.store.productApi.configureApiGithubAutoDeploy(configure(switched, false)),
    ).toMatchObject({ sourceConnectionId, enabled: false, generation: 2, grantActive: true });
    expect(await switched.store.productApi.readApiGithubAutoDeploy(scope(switched))).toMatchObject({
      sourceConnectionId,
      enabled: false,
      generation: 2,
    });
  }, 30_000);

  it("leaves a configuration inert once the binding moves to another GitHub connection, and re-arms only through an explicit enable", async () => {
    const rig = await productRig(control),
      api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId };
    const configure = (enabled: boolean) => ({
      ...scope,
      principalId: rig.principalId,
      requestId: "req-auto-relink",
      idempotencyKey: `auto-${newUlid()}`,
      canonicalRequestDigest: requestDigest(),
      operationId: newUlid(),
      queuedEventId: newUlid(),
      succeededEventId: newUlid(),
      auditEventId: newUlid(),
      branchRef: "refs/heads/main",
      enabled,
      configuredAt: "2026-10-28T11:00:00.000Z",
    });
    const first = (await linkSource(rig)).sourceConnectionId;
    expect(await api.configureApiGithubAutoDeploy(configure(true))).toMatchObject({
      sourceConnectionId: first,
      enabled: true,
      generation: 1,
    });

    // A later GitHub link binds its own connection; the stored configuration still names the first one.
    const second = await laterGithubSource(rig, "43", "s");
    await control.core
      .prepare(
        "UPDATE project_source_bindings SET source_connection_id=?3,generation=generation+1 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(rig.organizationId, rig.projectId, second)
      .run();
    expect(await api.readApiGithubAutoDeploy(scope)).toMatchObject({
      sourceConnectionId: first,
      enabled: false,
    });
    // The push targets of this project only: other projects of the shared store watch the same installation.
    const targetsOf = async (repositoryId: string, repositoryFullName: string) =>
      (
        await rig.store.github.readGithubAutoDeployTargets({
          installationId: "7",
          repositoryId,
          repositoryFullName,
        })
      ).filter((target) => target.projectId === rig.projectId);
    expect(await targetsOf("42", "o/r")).toEqual([]);

    // Only an explicit enable of the connection bound now re-arms it: its pushes then reach the project, the old repository's do not.
    expect(await api.configureApiGithubAutoDeploy(configure(true))).toMatchObject({
      sourceConnectionId: second,
      enabled: true,
      generation: 2,
    });
    expect(await targetsOf("43", "o/s")).toEqual([
      expect.objectContaining({ sourceConnectionId: second }),
    ]);
    expect(await targetsOf("42", "o/r")).toEqual([]);
  }, 30_000);

  it("refuses enabling after the project's source switched from GitHub to managed, though its GitHub source row stays ready", async () => {
    const rig = await productRig(control),
      api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId };
    await linkSource(rig);
    const configure = () => ({
      ...scope,
      principalId: rig.principalId,
      requestId: "req-auto-switch",
      idempotencyKey: `auto-${newUlid()}`,
      canonicalRequestDigest: requestDigest(),
      operationId: newUlid(),
      queuedEventId: newUlid(),
      succeededEventId: newUlid(),
      auditEventId: newUlid(),
      branchRef: "refs/heads/main",
      enabled: true,
      configuredAt: "2026-10-28T11:00:00.000Z",
    });
    expect(await api.configureApiGithubAutoDeploy(configure())).toMatchObject({ enabled: true });

    // The managed switch: a platform-hosted connection, its grant and ready source, and the binding moved to them.
    const managedConnection = newUlid(),
      managedGrant = newUlid(),
      switchedAt = "2026-10-28T11:05:00.000000Z";
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'managed','acme/shop',?5)",
        )
        .bind(rig.organizationId, managedConnection, rig.projectId, rig.billingEpochId, switchedAt),
      control.core
        .prepare(
          "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'managed',NULL,'acme/shop','acme','shop','contents:read',?6)",
        )
        .bind(
          rig.organizationId,
          managedGrant,
          rig.projectId,
          rig.billingEpochId,
          managedConnection,
          switchedAt,
        ),
      control.core
        .prepare(
          "INSERT INTO project_sources(organization_id,project_id,source_id,billing_epoch_id,grant_id,provider,installation_id,external_repository_id,repository_owner,repository_name,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'managed',NULL,'acme/shop','acme','shop','ready',1,?6,?6)",
        )
        .bind(
          rig.organizationId,
          rig.projectId,
          managedConnection,
          rig.billingEpochId,
          managedGrant,
          switchedAt,
        ),
      control.core
        .prepare(
          "UPDATE project_source_bindings SET source_connection_id=?3,provider='managed',generation=2,commit_sha=?4,updated_at=?5 WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(rig.organizationId, rig.projectId, managedConnection, "c".repeat(40), switchedAt),
    ]);
    // The GitHub project_sources row is still ready, but it no longer names the current source.
    await expect(api.configureApiGithubAutoDeploy(configure())).rejects.toThrow(
      "auto_deploy_source_unavailable",
    );
  }, 30_000);
});
