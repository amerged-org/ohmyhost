import { parseUlid } from "@ohmyhost/platform";
import { expect, it } from "vitest";

import { newUlid } from "../../control-store/src/catalog/common.js";
import { createControlStore } from "../../control-store/src/store.js";
import { seedOperation } from "../../control-store/test/support/accepted-operation.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import { createD1ProjectExports } from "../src/d1-project-exports.js";
import { ProjectExportLinkLimitError } from "../src/project-exports.js";

it("signs a ready export's download link once per audited request, through the Core, and refuses the seventh in a minute", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      db = control.core,
      project = await seedProject(control),
      operationId = await seedOperation(project),
      principalId = "user:user_export",
      sha256 = `sha256:${"04".repeat(32)}`,
      archiveExpiresAt = "2026-11-04T10:00:00.000Z";
    // A succeeded, verified export with its archive: the Owner's status reads it as ready.
    await db.batch([
      db
        .prepare(
          "UPDATE operations SET state='succeeded' WHERE organization_id=?1 AND operation_id=?2",
        )
        .bind(project.organizationId, operationId),
      db
        .prepare(
          `INSERT INTO project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket,archive_bytes,archive_sha256,sql_files,captured_at,archive_expires_at,verified_at,finished_at)
           VALUES(?1,?2,?3,?4,'2026-10-28T10:00:00.000000Z','2026-10-28T09:00:00.000000Z','ohmyho-development-backups',123,?5,'["dev.sql"]','2026-10-28T10:00:00.000000Z','2026-11-04T10:00:00.000000Z','2026-10-28T10:00:00.000000Z','2026-10-28T10:00:00.000000Z')`,
        )
        .bind(
          project.organizationId,
          operationId,
          project.projectId,
          project.devEnvironmentId,
          new Uint8Array(32).fill(4),
        ),
    ]);
    const exports = createD1ProjectExports({
      key: new Uint8Array(32).fill(9),
      crypto: globalThis.crypto,
      clock: { now: () => new Date("2026-10-28T10:00:00.000Z") },
      ids: { next: () => parseUlid(newUlid()) },
      archiveBucket: "ohmyho-development-backups",
      // The recovery Worker signs the private R2 download; the link's own audit is the Core's.
      r2AccountId: "00000000000000000000000000000001",
      downloadBinding: {
        invokeRecovery: async () => ({
          status: "ready",
          operationId,
          bytes: 123,
          sha256,
          sqlFiles: ["dev.sql"],
          capturedAt: "2026-10-28T10:00:00.000Z",
          archiveExpiresAt,
          downloadExpiresAt: "2026-10-29T10:00:00.000Z",
          url: `https://00000000000000000000000000000001.eu.r2.cloudflarestorage.com/ohmyho-development-backups/snapshots/${project.organizationId}/${project.projectId}/${operationId}.zip?X-Amz-Date=20261028T100000Z&X-Amz-Expires=86400&X-Amz-Signature=${"a".repeat(64)}`,
        }),
      },
      runtime: {
        readProjectExportStatus: store.recovery.owner.readExportStatus,
        recordProjectDatabaseEventAudit: store.productDatabase.recordEventAudit,
      },
    });
    const context = {
      organizationId: parseUlid(project.organizationId),
      projectId: parseUlid(project.projectId),
      principalId,
      requestId: "req_download_link",
      operationId,
    };
    const audited = () =>
      db
        .prepare(
          "SELECT count(*) AS n, min(actor_id) AS actor FROM audit_events WHERE organization_id=?1 AND event_type='ProjectExportDownloadLinkIssuedV1'",
        )
        .bind(project.organizationId)
        .first<{ n: number; actor: string }>();

    const first = await exports.issueDownloadLink(context);
    expect(first).toMatchObject({
      status: 200,
      body: {
        id: operationId,
        project_id: project.projectId,
        download_url: expect.stringContaining(`/${operationId}.zip?`),
        download_expires_at: "2026-10-29T10:00:00.000Z",
      },
    });
    expect(await audited()).toEqual({ n: 1, actor: principalId });

    // Six links in one minute are audited and signed; the seventh is refused before any link is signed.
    for (let link = 1; link < 6; link += 1) await exports.issueDownloadLink(context);
    expect(await audited()).toMatchObject({ n: 6 });
    await expect(exports.issueDownloadLink(context)).rejects.toBeInstanceOf(
      ProjectExportLinkLimitError,
    );
    expect(await audited()).toMatchObject({ n: 6 });
  } finally {
    await control.dispose();
  }
});
