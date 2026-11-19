import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createTestControl } from "../support/control-d1.js";
import { beforeFirstWrite, losingWriteResponses } from "../support/platform-fixtures.js";
import { workflowFixture } from "./workflow-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { SharedCoreRouter } from "../../src/router.js";
import {
  recordProductSourceArchiveEvidence,
  observeSourceArchiveReceipt,
} from "../../src/catalog/provisioning/source-custody.js";
import { createCoreDeploymentSourcePort } from "../../../project-provisioning-worker/src/core-deployment-source.js";
const context = (db: Awaited<ReturnType<typeof createTestControl>>["core"]) => ({
  directory: db,
  router: new SharedCoreRouter(db),
});
function archive(r: Awaited<ReturnType<typeof workflowFixture>>) {
  return {
    organizationId: parseUlid(r.p.organizationId),
    projectId: parseUlid(r.p.projectId),
    environmentId: parseUlid(r.input.environmentId),
    operationId: parseUlid(r.input.operationId),
    billingEpochId: parseUlid(r.p.billingEpochId),
    sourceConnectionId: parseUlid(r.source),
    externalRepositoryId: "42",
    commitSha: "a".repeat(40),
    sourceSha256: "03".repeat(32),
    archive: {
      bucket: "synthetic-source",
      key: "source.tar.gz",
      versionId: "retained-version",
      archiveId: `archive_${r.input.operationId}_${newUlid()}`,
      eTag: "retained-etag",
      byteLength: 123,
    },
    recordedAt: "2026-10-28T11:00:05.000Z",
  };
}
const normalized = (v: Awaited<ReturnType<typeof observeSourceArchiveReceipt>>) =>
  v === null ? null : { ...v, sha256: Array.from(v.sha256) };
it("records and observes both custody facts with exact replay and a lost commit response", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c);
    const input = archive(r),
      lost = losingWriteResponses(c.core, 1),
      port = createCoreDeploymentSourcePort({
        recordProductSourceArchiveEvidence: (i) =>
          recordProductSourceArchiveEvidence(context(lost), i),
        observeSourceArchiveReceipt: (i) => observeSourceArchiveReceipt(context(c.core), i),
      });
    // The first commit succeeded but its reply was lost: the retry finds its own archive.
    expect(await port.recordArchive(input)).toBe("existing");
    expect(await port.recordArchive(input)).toBe("existing");
    const scope = {
      organizationId: input.organizationId,
      projectId: input.projectId,
      operationId: input.operationId,
    };
    expect(normalized(await port.observeArchive(scope))).toEqual({
      organizationId: input.organizationId,
      projectId: input.projectId,
      operationId: input.operationId,
      billingEpochId: input.billingEpochId,
      provider: "github",
      sourceConnectionId: input.sourceConnectionId,
      externalRepositoryId: "42",
      requestedCommitSha: "a".repeat(40),
      resolvedCommitSha: "a".repeat(40),
      archiveFormat: "tar.gz",
      sha256: Array.from({ length: 32 }, () => 3),
      byteLength: 123,
      objectRef: input.archive.archiveId,
      acquiredAt: input.recordedAt,
    });
    expect(
      (
        await c.core
          .prepare(
            "SELECT operation_id,organization_id,project_id,billing_epoch_id,provider,source_connection_id,external_repository_id,requested_commit_sha,resolved_commit_sha,archive_format,lower(hex(sha256)) sha256,CAST(byte_length AS TEXT) byte_length,object_ref,acquired_at FROM source_archives WHERE operation_id=?",
          )
          .bind(input.operationId)
          .all()
      ).results,
    ).toEqual([
      {
        operation_id: input.operationId,
        organization_id: input.organizationId,
        project_id: input.projectId,
        billing_epoch_id: input.billingEpochId,
        provider: "github",
        source_connection_id: input.sourceConnectionId,
        external_repository_id: "42",
        requested_commit_sha: "a".repeat(40),
        resolved_commit_sha: "a".repeat(40),
        archive_format: "tar.gz",
        sha256: "03".repeat(32),
        byte_length: "123",
        object_ref: input.archive.archiveId,
        acquired_at: "2026-10-28T11:00:05.000000Z",
      },
    ]);
    expect(
      (
        await c.core
          .prepare(
            "SELECT operation_id,organization_id,project_id,environment_id,bucket_name,object_key,object_version_id,object_etag,CAST(byte_length AS TEXT) byte_length,lower(hex(source_sha256)) source_sha256,recorded_at FROM product_source_archive_objects WHERE operation_id=?",
          )
          .bind(input.operationId)
          .all()
      ).results,
    ).toEqual([
      {
        operation_id: input.operationId,
        organization_id: input.organizationId,
        project_id: input.projectId,
        environment_id: input.environmentId,
        bucket_name: "synthetic-source",
        object_key: "source.tar.gz",
        object_version_id: "retained-version",
        object_etag: "retained-etag",
        byte_length: "123",
        source_sha256: "03".repeat(32),
        recorded_at: "2026-10-28T11:00:05.000000Z",
      },
    ]);
    await expect(
      port.recordArchive({
        ...input,
        archive: { ...input.archive, archiveId: `archive_${input.operationId}_${newUlid()}` },
      }),
    ).rejects.toMatchObject({ name: "SourceArchiveReconciliationConflictError" });
    await expect(
      port.recordArchive({ ...input, archive: { ...input.archive, eTag: "changed" } }),
    ).rejects.toMatchObject({ name: "DeploymentPersistenceConflictError" });
    const other = await workflowFixture(c);
    expect(
      await port.observeArchive({ ...scope, organizationId: parseUlid(other.p.organizationId) }),
    ).toBeNull();
  } finally {
    await c.dispose();
  }
}, 120_000);
it("rolls a late object failure back with its receipt and records retained custody after a source/owner change without granting a provider write", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c),
      input = archive(r);
    await c.core
      .prepare(
        "CREATE TRIGGER source_object_late_failure BEFORE INSERT ON product_source_archive_objects BEGIN SELECT RAISE(ABORT,'late source object'); END",
      )
      .run();
    await expect(recordProductSourceArchiveEvidence(context(c.core), input)).rejects.toThrow(
      "late source object",
    );
    expect(await c.core.prepare("SELECT count(*) n FROM source_archives").first()).toEqual({
      n: 0,
    });
    await c.core.prepare("DROP TRIGGER source_object_late_failure").run();
    const race = beforeFirstWrite(c.core, async () => {
      await c.core
        .prepare(
          "UPDATE projects SET owner_state='transfer_pending_frozen' WHERE organization_id=? AND project_id=?",
        )
        .bind(input.organizationId, input.projectId)
        .run();
    });
    expect(await recordProductSourceArchiveEvidence(context(race), input)).toBe("created");
    expect(
      await observeSourceArchiveReceipt(context(c.core), {
        organizationId: input.organizationId,
        projectId: input.projectId,
        operationId: input.operationId,
      }),
    ).toMatchObject({ objectRef: input.archive.archiveId });
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
});
it("retains native original archive/reference and repository shapes without guessed GitHub mirrors or Unicode object truncation", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c),
      i = archive(r);
    for (const bad of [
      { ...i, externalRepositoryId: "9007199254740992" },
      { ...i, commitSha: "0".repeat(40) },
      { ...i, archive: { ...i.archive, archiveId: `archive_${newUlid()}_${newUlid()}` } },
      {
        ...i,
        archive: { ...i.archive, archiveId: "https://provider.invalid/source?credential=not-used" },
      },
      { ...i, archive: { ...i.archive, bucket: "xy" } },
    ])
      await expect(recordProductSourceArchiveEvidence(context(c.core), bad)).rejects.toThrow();
    const value = {
      ...i,
      archive: { ...i.archive, key: "😀".repeat(512), byteLength: Number.MAX_SAFE_INTEGER },
    };
    expect(await recordProductSourceArchiveEvidence(context(c.core), value)).toBe("created");
    expect(
      await c.core
        .prepare(
          "SELECT length(object_key) n,CAST(byte_length AS TEXT) bytes FROM product_source_archive_objects WHERE operation_id=?",
        )
        .bind(i.operationId)
        .first(),
    ).toEqual({ n: 512, bytes: String(Number.MAX_SAFE_INTEGER) });
    expect(
      await c.core.prepare("SELECT count(*) n FROM github_source_connections").first(),
    ).toEqual({ n: 0 });
    await expect(
      c.core
        .prepare("UPDATE source_archives SET object_ref=object_ref WHERE operation_id=?")
        .bind(i.operationId)
        .run(),
    ).rejects.toThrow("append-only");
    await expect(
      c.core.prepare("DELETE FROM source_archives WHERE operation_id=?").bind(i.operationId).run(),
    ).rejects.toThrow("append-only");
  } finally {
    await c.dispose();
  }
});
