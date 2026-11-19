import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";

import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedProject, STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import { createD1GithubInstallationEventConsumer } from "../src/d1-github-installation-events.js";

const at = "2026-10-29T10:00:00.000Z";

async function seedInstallation(control: Awaited<ReturnType<typeof createTestControl>>) {
  const project = await seedProject(control),
    db = control.core,
    connection = newUlid(),
    grant = newUlid(),
    sourceConnection = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO github_organization_connections(connection_id,organization_id,installation_id,account_id,account_login,account_type,github_user_id,github_user_login,principal_id,settings_url,connected_at) VALUES(?1,?2,'42','7','octo','Organization','9','owner','user:user_gh','https://github.com/settings/installations/42',?3)",
      )
      .bind(connection, project.organizationId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github','77',?5)",
      )
      .bind(
        project.organizationId,
        sourceConnection,
        project.projectId,
        project.billingEpochId,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'github','42','77','octo','app','contents:read',?6)",
      )
      .bind(
        project.organizationId,
        grant,
        project.projectId,
        project.billingEpochId,
        sourceConnection,
        STORED_NOW,
      ),
  ]);
  return { project, grant };
}

const delivery = (guid: string, eventType: string, payload: Record<string, unknown>) => ({
  inboxEventId: newUlid(),
  externalEventId: guid,
  eventType,
  payload,
  bodyDigest: "03".repeat(32),
  receivedAt: at,
  maxAttempts: 5,
});

it("applies a recorded installation withdrawal through the Core and acknowledges it once", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      db = control.core,
      { grant } = await seedInstallation(control),
      clock = { now: () => new Date(Date.parse(at)) },
      ids = { next: () => parseUlid(newUlid()) },
      consumer = createD1GithubInstallationEventConsumer({
        bindings: {
          GITHUB_RUNTIME: store.github,
          CONTROL_RUNTIME: store.operations,
          CONTROL_MAINTENANCE_RUNTIME: store.maintenance,
        },
        clock,
        ids,
      });

    // Nothing recorded yet.
    expect(await consumer.pollOne()).toEqual({ status: "idle" });

    // A repository removed from installation 42 revokes that repository's grant.
    const removed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(
      await store.ingress.recordGithubWebhook(
        delivery(removed, "installation_repositories", {
          schemaVersion: "github.installation.v1",
          action: "repositories_removed",
          installationId: 42,
          removedRepositoryIds: [77],
        }),
      ),
    ).toBe("created");
    expect(await consumer.pollOne()).toEqual({
      status: "applied",
      eventType: "installation_repositories",
    });
    expect(
      await db
        .prepare("SELECT reason FROM repository_grant_revocations WHERE grant_id=?1")
        .bind(grant)
        .first(),
    ).toEqual({ reason: "repository_removed" });
    expect(
      await db
        .prepare("SELECT acknowledged_at FROM webhook_inbox WHERE external_event_id=?1")
        .bind(removed)
        .first(),
    ).toEqual({ acknowledged_at: "2026-10-29T10:00:00.000000Z" });
    // Acknowledged events are never claimed again.
    expect(await consumer.pollOne()).toEqual({ status: "idle" });
  } finally {
    await control.dispose();
  }
});

it("records a failed application for retry and does not acknowledge it", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      db = control.core,
      clock = { now: () => new Date(Date.parse(at)) },
      ids = { next: () => parseUlid(newUlid()) },
      guid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      consumer = createD1GithubInstallationEventConsumer({
        bindings: {
          GITHUB_RUNTIME: {
            revokeGithubInstallationAccess: async () => {
              throw new Error("core unavailable");
            },
          },
          CONTROL_RUNTIME: store.operations,
          CONTROL_MAINTENANCE_RUNTIME: store.maintenance,
        },
        clock,
        ids,
      });
    await store.ingress.recordGithubWebhook(
      delivery(guid, "installation", {
        schemaVersion: "github.installation.v1",
        action: "deleted",
        installationId: 42,
        removedRepositoryIds: [],
      }),
    );
    expect(await consumer.pollOne()).toEqual({ status: "failed", eventType: "installation" });
    expect(
      await db
        .prepare(
          "SELECT acknowledged_at, last_error_code FROM webhook_inbox WHERE external_event_id=?1",
        )
        .bind(guid)
        .first(),
    ).toEqual({ acknowledged_at: null, last_error_code: "GITHUB_INSTALLATION_REVOCATION_FAILED" });
  } finally {
    await control.dispose();
  }
});
