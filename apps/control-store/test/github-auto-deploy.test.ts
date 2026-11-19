import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { seedProject, STORED_NOW } from "./support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const sha = (character: string) => character.repeat(40);

describe("github auto-deploy", () => {
  it("reserves one push per delivery, attaches the accepted operation once, records a failed plan and supersedes older pushes", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      project = await seedProject(control),
      grantId = newUlid(),
      connection = newUlid();
    await db.batch([
      db
        .prepare(
          "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github','77',?5)",
        )
        .bind(
          project.organizationId,
          connection,
          project.projectId,
          project.billingEpochId,
          STORED_NOW,
        ),
      db
        .prepare(
          "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'github','42','77','Octo','App','contents:read',?6)",
        )
        .bind(
          project.organizationId,
          grantId,
          project.projectId,
          project.billingEpochId,
          connection,
          STORED_NOW,
        ),
      db
        .prepare(
          "INSERT INTO github_auto_deploy_configs(organization_id,project_id,source_connection_id,branch_ref,generation,enabled,configured_at,updated_at) VALUES(?1,?2,?3,'refs/heads/main',1,1,?4,?4)",
        )
        .bind(project.organizationId, project.projectId, connection, STORED_NOW),
    ]);
    const inbox = async (guid: string) => {
      const id = newUlid();
      await db
        .prepare(
          "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,state,max_attempts,available_at,organization_id) VALUES(?1,'github',?2,'push','{}',?3,?4,'pending',5,?4,?5)",
        )
        .bind(id, guid, new Uint8Array(32).fill(1), STORED_NOW, project.organizationId)
        .run();
      return id;
    };
    const target = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      sourceConnectionId: connection,
      configGeneration: 1,
      branchRef: "refs/heads/main",
    };
    const targets = await store.github.readGithubAutoDeployTargets({
      installationId: "42",
      repositoryId: "77",
      repositoryFullName: "octo/app",
    });
    expect(targets).toEqual([
      {
        ...target,
        installationId: "42",
        repositoryId: "77",
        grantActive: true,
        repositoryRenamed: false,
      },
    ]);
    expect(
      await store.github.readGithubAutoDeployTargets({
        installationId: "43",
        repositoryId: "77",
        repositoryFullName: "octo/app",
      }),
    ).toEqual([]);

    const reserveInput = async (guid: string, commit: string) => ({
      ...target,
      inboxEventId: await inbox(guid),
      deliveryGuid: guid,
      installationId: "42",
      repositoryId: "77",
      ref: "refs/heads/main",
      commitSha: commit,
      claimedAt: "2026-10-29T10:00:00.000Z",
      pushDeploymentId: newUlid(),
    });
    const first = await reserveInput("11111111-1111-4111-8111-111111111111", sha("a"));
    expect(await store.github.reserveGithubPushDeployment(first)).toEqual({
      pushDeploymentId: first.pushDeploymentId,
      outcome: "reserved",
      operationId: null,
      workflowAttached: false,
    });
    // The same delivery, and the same commit under the same configuration, answer the stored reservation.
    expect(
      await store.github.reserveGithubPushDeployment({ ...first, pushDeploymentId: newUlid() }),
    ).toMatchObject({
      pushDeploymentId: first.pushDeploymentId,
      outcome: "replay",
    });
    await expect(
      store.github.reserveGithubPushDeployment({
        ...first,
        pushDeploymentId: newUlid(),
        commitSha: sha("b"),
      }),
    ).rejects.toMatchObject({ code: "github_push_replay_conflict" });
    await expect(
      store.github.reserveGithubPushDeployment({
        ...first,
        pushDeploymentId: newUlid(),
        deliveryGuid: "22222222-2222-4222-8222-222222222222",
        configGeneration: 2,
      }),
    ).rejects.toMatchObject({ code: "github_auto_deploy_config_stale" });

    // Attaching binds the accepted operation once; the push is then queued.
    const operationId = newUlid();
    await db
      .prepare(
        "INSERT INTO operations(organization_id,project_id,operation_id,billing_epoch_id,state,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        operationId,
        project.billingEpochId,
        STORED_NOW,
        STORED_NOW,
      )
      .run();
    const attach = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      pushDeploymentId: first.pushDeploymentId,
      operationId,
      now: "2026-10-29T10:00:05.000Z",
    };
    expect(await store.github.attachGithubPushOperation(attach)).toBe("attached");
    expect(await store.github.attachGithubPushOperation(attach)).toBe("existing");
    await expect(
      store.github.attachGithubPushOperation({ ...attach, operationId: newUlid() }),
    ).rejects.toMatchObject({ code: "github_push_attachment_changed" });
    expect(
      await db
        .prepare(
          "SELECT state,operation_id FROM github_push_deployments WHERE push_deployment_id=?",
        )
        .bind(first.pushDeploymentId)
        .first(),
    ).toEqual({ state: "queued", operation_id: operationId });

    // A newer push supersedes the queued one; a plan the newer push could not make is recorded as a failed operation.
    const second = await reserveInput("33333333-3333-4333-8333-333333333333", sha("c"));
    await store.github.reserveGithubPushDeployment(second);
    expect(
      await db
        .prepare(
          "SELECT state,superseded_by_id,cleanup_required FROM github_push_deployments WHERE push_deployment_id=?",
        )
        .bind(first.pushDeploymentId)
        .first(),
    ).toEqual({
      state: "cleanup_pending",
      superseded_by_id: second.pushDeploymentId,
      cleanup_required: 1,
    });
    const failedOperation = newUlid();
    const failure = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      pushDeploymentId: second.pushDeploymentId,
      operationId: failedOperation,
      billingEpochId: project.billingEpochId,
      auditEventId: newUlid(),
      queuedOperationEventId: newUlid(),
      startedOperationEventId: newUlid(),
      operationEventId: newUlid(),
      failedAt: "2026-10-29T10:01:00.000Z",
      errorCode: "MAIL_DOMAIN_REQUIRED" as const,
      diagnostic: null,
    };
    expect(await store.github.failGithubPushPlanning(failure)).toBe("failed");
    expect(await store.github.failGithubPushPlanning(failure)).toBe("existing");
    expect(
      await db
        .prepare("SELECT state,failure FROM operations WHERE operation_id=?")
        .bind(failedOperation)
        .first(),
    ).toMatchObject({ state: "failed" });
    expect(
      (
        await db
          .prepare("SELECT event_type FROM operation_events WHERE operation_id=? ORDER BY revision")
          .bind(failedOperation)
          .all()
      ).results.map((row) => row["event_type"]),
    ).toEqual(["OperationQueued", "OperationStarted", "OperationFailed"]);
    expect(
      await db
        .prepare(
          "SELECT state,operation_id FROM github_push_deployments WHERE push_deployment_id=?",
        )
        .bind(second.pushDeploymentId)
        .first(),
    ).toEqual({ state: "failed", operation_id: failedOperation });

    // A reset back to commit A is a new delivery of a commit already pushed: it reserves a push of its own.
    const reset = await reserveInput("55555555-5555-4555-8555-555555555555", sha("a"));
    expect(await store.github.reserveGithubPushDeployment(reset)).toEqual({
      pushDeploymentId: reset.pushDeploymentId,
      outcome: "reserved",
      operationId: null,
      workflowAttached: false,
    });
    expect(
      await store.github.failGithubPushPlanning({
        organizationId: project.organizationId,
        projectId: project.projectId,
        pushDeploymentId: reset.pushDeploymentId,
        operationId: newUlid(),
        billingEpochId: project.billingEpochId,
        auditEventId: newUlid(),
        queuedOperationEventId: newUlid(),
        startedOperationEventId: newUlid(),
        operationEventId: newUlid(),
        failedAt: "2026-10-29T10:02:00.000Z",
        errorCode: "MAIL_DOMAIN_REQUIRED" as const,
        diagnostic: null,
      }),
    ).toBe("failed");
    // A redelivery of A after its failed planning reserves and attaches its own push, not the failed one.
    const redelivered = await reserveInput("66666666-6666-4666-8666-666666666666", sha("a"));
    expect(await store.github.reserveGithubPushDeployment(redelivered)).toEqual({
      pushDeploymentId: redelivered.pushDeploymentId,
      outcome: "reserved",
      operationId: null,
      workflowAttached: false,
    });
    const retry = newUlid();
    await db
      .prepare(
        "INSERT INTO operations(organization_id,project_id,operation_id,billing_epoch_id,state,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        retry,
        project.billingEpochId,
        STORED_NOW,
        STORED_NOW,
      )
      .run();
    expect(
      await store.github.attachGithubPushOperation({
        organizationId: project.organizationId,
        projectId: project.projectId,
        pushDeploymentId: redelivered.pushDeploymentId,
        operationId: retry,
        now: "2026-10-29T10:03:00.000Z",
      }),
    ).toBe("attached");

    // A revoked grant denies the target at reservation.
    await db
      .prepare(
        "INSERT INTO repository_grant_revocations(organization_id,revocation_id,grant_id,project_id,reason,revoked_at) VALUES(?1,?2,?3,?4,'installation_uninstalled',?5)",
      )
      .bind(project.organizationId, newUlid(), grantId, project.projectId, STORED_NOW)
      .run();
    await expect(
      store.github.reserveGithubPushDeployment(
        await reserveInput("44444444-4444-4444-8444-444444444444", sha("d")),
      ),
    ).rejects.toMatchObject({ code: "GITHUB_AUTO_DEPLOY_GRANT_REVOKED" });
    expect(
      (
        (await store.github.readGithubAutoDeployTargets({
          installationId: "42",
          repositoryId: "77",
          repositoryFullName: "octo/app",
        })) as { grantActive: boolean }[]
      )[0]?.grantActive,
    ).toBe(false);
  });

  it("flags a repository renamed on GitHub by its unchanged id, and records its push as a visible planning refusal", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      project = await seedProject(control),
      connection = newUlid();
    await db.batch([
      db
        .prepare(
          "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github','77',?5)",
        )
        .bind(
          project.organizationId,
          connection,
          project.projectId,
          project.billingEpochId,
          STORED_NOW,
        ),
      db
        .prepare(
          "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'github','42','77','Octo','App','contents:read',?6)",
        )
        .bind(
          project.organizationId,
          newUlid(),
          project.projectId,
          project.billingEpochId,
          connection,
          STORED_NOW,
        ),
      db
        .prepare(
          "INSERT INTO github_auto_deploy_configs(organization_id,project_id,source_connection_id,branch_ref,generation,enabled,configured_at,updated_at) VALUES(?1,?2,?3,'refs/heads/main',1,1,?4,?4)",
        )
        .bind(project.organizationId, project.projectId, connection, STORED_NOW),
    ]);
    const renamed = (
      await store.github.readGithubAutoDeployTargets({
        installationId: "42",
        repositoryId: "77",
        repositoryFullName: "octo/app-renamed",
      })
    ).filter((row) => row.projectId === project.projectId);
    expect(renamed).toMatchObject([
      {
        projectId: project.projectId,
        repositoryId: "77",
        grantActive: true,
        repositoryRenamed: true,
      },
    ]);
    const unchanged = (
      await store.github.readGithubAutoDeployTargets({
        installationId: "42",
        repositoryId: "77",
        repositoryFullName: "OCTO/app",
      })
    ).filter((row) => row.projectId === project.projectId);
    expect(unchanged).toMatchObject([{ projectId: project.projectId, repositoryRenamed: false }]);

    // The renamed push is recorded as a failed operation with the public code of the refusal, never planned.
    const inboxEventId = newUlid(),
      pushDeploymentId = newUlid(),
      deliveryGuid = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,state,max_attempts,available_at,organization_id) VALUES(?1,'github',?5,'push','{}',?2,?3,'pending',5,?3,?4)",
      )
      .bind(
        inboxEventId,
        new Uint8Array(32).fill(4),
        STORED_NOW,
        project.organizationId,
        deliveryGuid,
      )
      .run();
    const reserved = await store.github.reserveGithubPushDeployment({
      organizationId: project.organizationId,
      projectId: project.projectId,
      sourceConnectionId: connection,
      configGeneration: 1,
      branchRef: "refs/heads/main",
      installationId: "42",
      repositoryId: "77",
      inboxEventId,
      deliveryGuid,
      ref: "refs/heads/main",
      commitSha: sha("d"),
      claimedAt: "2026-10-29T10:00:00.000Z",
      pushDeploymentId,
    });
    const failedOperation = newUlid();
    expect(
      await store.github.failGithubPushPlanning({
        organizationId: project.organizationId,
        projectId: project.projectId,
        pushDeploymentId: reserved.pushDeploymentId,
        operationId: failedOperation,
        billingEpochId: project.billingEpochId,
        auditEventId: newUlid(),
        queuedOperationEventId: newUlid(),
        startedOperationEventId: newUlid(),
        operationEventId: newUlid(),
        failedAt: "2026-10-29T10:01:00.000Z",
        errorCode: "REPOSITORY_RENAMED",
        diagnostic: null,
      }),
    ).toBe("failed");
    const stored = await db
      .prepare("SELECT state,failure FROM operations WHERE operation_id=?")
      .bind(failedOperation)
      .first<{ state: string; failure: string }>();
    expect(stored?.state).toBe("failed");
    expect(JSON.parse(String(stored?.failure))).toMatchObject({
      code: "AUTO_DEPLOY_REPOSITORY_RENAMED",
    });
  });
});
