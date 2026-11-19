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

const at = (minute: number) => `2026-10-29T10:${String(minute).padStart(2, "0")}:00.000000Z`;
const digest = (n: number) => n.toString(16).padStart(64, "0");

describe("GitHub installation access", () => {
  it("records withdrawing installation events by id and revokes exactly the grants they cover", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      project = await seedProject(control),
      organizationId = project.organizationId,
      connectionId = newUlid(),
      grants = { repo77: newUlid(), repo78: newUlid(), otherInstallation: newUlid() },
      links = [
        [grants.repo77, "42", "77"],
        [grants.repo78, "42", "78"],
        [grants.otherInstallation, "43", "77"],
      ] as const;
    await db.batch([
      db
        .prepare(
          "INSERT INTO github_organization_connections(connection_id,organization_id,installation_id,account_id,account_login,account_type,github_user_id,github_user_login,principal_id,settings_url,connected_at) VALUES(?1,?2,'42','7','octo','Organization','9','owner','user:user_gh','https://github.com/settings/installations/42',?3)",
        )
        .bind(connectionId, organizationId, STORED_NOW),
      // One source connection per grant: a project holds at most one grant per source connection.
      ...links.flatMap(([grant, installation, repository]) => {
        const sourceConnection = newUlid();
        return [
          db
            .prepare(
              "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github',?5,?6)",
            )
            .bind(
              organizationId,
              sourceConnection,
              project.projectId,
              project.billingEpochId,
              repository,
              STORED_NOW,
            ),
          db
            .prepare(
              "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'github',?6,?7,'octo','app','contents:read',?8)",
            )
            .bind(
              organizationId,
              grant,
              project.projectId,
              project.billingEpochId,
              sourceConnection,
              installation,
              repository,
              STORED_NOW,
            ),
        ];
      }),
    ]);

    // The ingress records the event by its ids; a payload that names the wrong schema or type is refused.
    const recorded = {
      inboxEventId: newUlid(),
      externalEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      eventType: "installation_repositories",
      payload: {
        schemaVersion: "github.installation.v1",
        action: "repositories_removed",
        installationId: 42,
        removedRepositoryIds: [77],
      },
      bodyDigest: digest(3),
      receivedAt: "2026-10-29T10:00:00.000Z",
      maxAttempts: 5,
    };
    expect(await store.ingress.recordGithubWebhook(recorded)).toBe("created");
    await expect(
      store.ingress.recordGithubWebhook({
        ...recorded,
        inboxEventId: newUlid(),
        externalEventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        eventType: "push",
      }),
    ).rejects.toThrow();

    const revocations = async () =>
      (
        await db
          .prepare(
            "SELECT grant_id,reason FROM repository_grant_revocations WHERE organization_id=?1 ORDER BY grant_id",
          )
          .bind(organizationId)
          .all<{ grant_id: string; reason: string }>()
      ).results;

    // Repositories removed from installation 42 revoke only that repository's grant of that installation.
    expect(
      await store.github.revokeGithubInstallationAccess({
        installationId: 42,
        action: "repositories_removed",
        removedRepositoryIds: [77],
        now: at(10),
      }),
    ).toEqual({ status: "applied" });
    expect(await revocations()).toEqual([
      { grant_id: grants.repo77, reason: "repository_removed" },
    ]);
    expect(
      await db
        .prepare("SELECT revoked_at FROM github_organization_connections WHERE connection_id=?1")
        .bind(connectionId)
        .first(),
    ).toEqual({ revoked_at: null });

    // Uninstalling installation 42 disconnects its connection and revokes the rest of its grants, once.
    for (const minute of [20, 30]) {
      await store.github.revokeGithubInstallationAccess({
        installationId: 42,
        action: "deleted",
        removedRepositoryIds: [],
        now: at(minute),
      });
    }
    expect(
      await db
        .prepare("SELECT revoked_at FROM github_organization_connections WHERE connection_id=?1")
        .bind(connectionId)
        .first(),
    ).toEqual({ revoked_at: at(20) });
    const after = await revocations();
    expect(after).toHaveLength(2);
    expect(after).toContainEqual({ grant_id: grants.repo78, reason: "installation_uninstalled" });
    expect(after.map((row) => row.grant_id)).not.toContain(grants.otherInstallation);
  });
});
