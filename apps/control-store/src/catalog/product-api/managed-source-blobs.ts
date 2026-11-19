import { createHash } from "node:crypto";
import { z } from "zod";
import { generatedJsonb } from "../../jsonb-generated.js";
import { isManagedSourcePath, MANAGED_SOURCE_LIMITS } from "@ohmyhost/contracts/managed-sources";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import { routeOrganization, type CatalogContext } from "../common.js";
import type { D1PreparedStatement } from "../../d1-types.js";
import { integer, type Row } from "../provisioning/context-values.js";
import {
  MANAGED_BLOBS,
  MANAGED_RESERVATIONS,
  managedAuthorityGuards,
  managedAuthorized,
  managedBindingGuards,
  managedBindingOf,
  managedConflict,
  managedDelegationGuards,
  managedDelegationOf,
  managedPublicationGuards,
  managedRowsGuards,
  managedScopeInput,
  managedWritable,
  managedWriteInput,
  readManagedSnapshot,
  type ManagedSnapshot,
} from "./managed-source-common.js";
const file = z.strictObject({
  path: z.string().refine(isManagedSourcePath),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  byteLength: z.number().int().min(0).max(MANAGED_SOURCE_LIMITS.fileBytes),
  executable: z.boolean(),
});
const blob = file.extend({
  bucket: z.string(),
  key: z.string(),
  versionId: z.string(),
  eTag: z.string(),
});
const sha = z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u);
const scope = (i: z.output<typeof managedWriteInput>) =>
  managedScopeInput.parse({
    organizationId: i.organizationId,
    projectId: i.projectId,
    principalId: i.principalId,
  });
type Snapshot = { readonly source: ManagedSnapshot; readonly delegation: D1PreparedStatement[] };
const RESERVATION_KEYS = [
  "operation_id",
  "path",
  "sha256",
  "byte_length",
  "executable",
  "created_at",
];
const BLOB_KEYS = [...RESERVATION_KEYS, "bucket", "object_key", "version_id", "etag"];
function sameFile(r: Row, i: z.output<typeof file>) {
  return (
    r["path"] === i.path &&
    r["sha256"] === i.sha256 &&
    integer(r["byte_length"]) === i.byteLength &&
    r["executable"] === Number(i.executable)
  );
}
/** Admission precedes any external R2 write; immutable reservations enforce original per-journal file/byte quotas. */
export async function reserveApiManagedSourceBlob(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "replayed"> {
  const i = managedWriteInput.extend(file.shape).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  function fail(kind: string): never {
    throw new Error(`managed_source_reservation_${kind}`);
  }
  const command: Command<Snapshot, "created" | "replayed"> = {
    name: "managedSource.reserveBlob",
    input: i,
    retryOn: ["precondition_changed", "consent_changed"],
    naturalKeyTables: ["managed_source_reservations"],
    read: async (reader) => {
      const s = await readManagedSnapshot(reader, scope(i), i.operationId);
      return {
        source: s,
        delegation: await managedDelegationGuards(reader, s, managedDelegationOf(s.publication)),
      };
    },
    decide: ({ source: s, delegation }) => {
      const p = s.publication;
      if (!managedAuthorized(s, true) || p === null) fail("scope");
      if (p["state"] !== "staging") fail("state");
      if (String(p["expires_at"]) <= i.now) fail("expired");
      const current = managedBindingOf(s.binding);
      if (
        (current?.sourceConnectionId ?? null) !== p["expected_source_connection_id"] ||
        (current?.generation ?? 0) !== p["expected_source_generation"]
      )
        fail("generation");
      if (p["mode"] === "commit" && current?.status !== "ready") fail("scope");
      if (p["mode"] === "commit" && current?.commitSha !== p["expected_managed_commit"])
        fail("commit");
      const existing = s.reservations.find((r) => r["path"] === i.path);
      if (existing !== undefined) {
        if (!sameFile(existing, i)) fail("identity");
        return { replay: "replayed" as const };
      }
      if (
        s.reservations.length >= MANAGED_SOURCE_LIMITS.files ||
        s.reservations.reduce((sum, r) => sum + integer(r["byte_length"]), 0) + i.byteLength >
          MANAGED_SOURCE_LIMITS.treeBytes
      )
        fail("limit");
      return {
        statements: [
          ...managedAuthorityGuards(db, s, true),
          ...managedPublicationGuards(db, s),
          ...managedBindingGuards(db, s),
          ...delegation,
          ...managedRowsGuards(db, MANAGED_RESERVATIONS, i, s.reservations, RESERVATION_KEYS),
          db
            .prepare(
              "INSERT INTO managed_source_reservations(operation_id,path,sha256,byte_length,executable,created_at)VALUES(?1,?2,?3,?4,?5,?6)",
            )
            .bind(i.operationId, i.path, i.sha256, i.byteLength, Number(i.executable), i.now),
        ],
        result: () => "created" as const,
      };
    },
  };
  try {
    return await runCommand(db, command);
  } catch (error) {
    if (error instanceof Error && error.message === "managed_source_scope") return fail("scope");
    throw error;
  }
}
/** Original immutable blob receipt and entire journal quota share the same guarded native batch. */
export async function recordApiManagedSourceBlob(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = managedWriteInput.extend(blob.shape).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  if (
    !/^ohmyho-builds-(development|production)(-eu)?$/u.test(i.bucket) ||
    i.key !== `managed-staging/${i.operationId}/${i.organizationId}/${i.projectId}/${i.sha256}` ||
    i.key.length > 1024 ||
    /[?#\s]/u.test(i.key) ||
    !/^[0-9a-f]{32}$/u.test(i.versionId) ||
    !/^"[^"\r\n]{1,256}"$/u.test(i.eTag)
  )
    throw new TypeError("Managed source object receipt is invalid");
  const command: Command<Snapshot, void> = {
    name: "managedSource.recordBlob",
    input: i,
    retryOn: ["precondition_changed", "consent_changed"],
    naturalKeyTables: ["managed_source_blobs"],
    read: async (reader) => {
      const s = await readManagedSnapshot(reader, scope(i), i.operationId);
      return {
        source: s,
        delegation: await managedDelegationGuards(reader, s, managedDelegationOf(s.publication)),
      };
    },
    decide: ({ source: s, delegation }) => {
      managedWritable(s, i.now, "staging");
      if ((s.owner?.["region"] === "eu") !== i.bucket.endsWith("-eu")) managedConflict("scope");
      const existing = s.blobs.find((r) => r["path"] === i.path);
      if (
        existing !== undefined &&
        (!sameFile(existing, i) ||
          existing["bucket"] !== i.bucket ||
          existing["object_key"] !== i.key ||
          existing["version_id"] !== i.versionId ||
          existing["etag"] !== i.eTag)
      )
        managedConflict("manifest");
      if (
        s.blobs.length + (existing === undefined ? 1 : 0) > MANAGED_SOURCE_LIMITS.files ||
        s.blobs.reduce((sum, r) => sum + integer(r["byte_length"]), 0) +
          (existing === undefined ? i.byteLength : 0) >
          MANAGED_SOURCE_LIMITS.treeBytes
      )
        managedConflict("manifest");
      if (existing !== undefined) return { replay: undefined };
      return {
        statements: [
          ...managedAuthorityGuards(db, s, true),
          ...managedPublicationGuards(db, s),
          ...delegation,
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM projects WHERE organization_id=?1 AND project_id=?2 AND region=?3)",
            [i.organizationId, i.projectId, s.owner?.["region"]],
          ),
          ...managedRowsGuards(db, MANAGED_BLOBS, i, s.blobs, BLOB_KEYS),
          db
            .prepare(
              "INSERT INTO managed_source_blobs(operation_id,path,sha256,byte_length,bucket,object_key,version_id,etag,created_at,executable)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            )
            .bind(
              i.operationId,
              i.path,
              i.sha256,
              i.byteLength,
              i.bucket,
              i.key,
              i.versionId,
              i.eTag,
              i.now,
              Number(i.executable),
            ),
        ],
        result: () => undefined,
      };
    },
  };
  await runCommand(db, command);
}
/** Canonical exact manifest and complete recorded blob set are committed atomically with the original outbox wake. */
export async function sealApiManagedSourceManifest(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = managedWriteInput
      .extend({
        files: z.array(file).max(MANAGED_SOURCE_LIMITS.files),
        manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  if (new Set(i.files.map((f) => f.path)).size !== i.files.length) managedConflict("manifest");
  const canonical = [...i.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({
        path: f.path,
        sha256: f.sha256,
        byteLength: f.byteLength,
        executable: f.executable,
      })),
    digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  if (
    digest !== i.manifestSha256 ||
    canonical.reduce((sum, f) => sum + f.byteLength, 0) > MANAGED_SOURCE_LIMITS.treeBytes
  )
    managedConflict("manifest");
  const command: Command<Snapshot, void> = {
    name: "managedSource.sealManifest",
    input: i,
    retryOn: ["precondition_changed", "consent_changed"],
    read: async (reader) => {
      const s = await readManagedSnapshot(reader, scope(i), i.operationId);
      return {
        source: s,
        delegation: await managedDelegationGuards(reader, s, managedDelegationOf(s.publication)),
      };
    },
    decide: ({ source: s, delegation }) => {
      if (!managedAuthorized(s, true) || s.publication === null) managedConflict("scope");
      if (s.publication["state"] === "sealed" && s.publication["manifest_sha256"] === digest)
        return { replay: undefined };
      managedWritable(s, i.now, "staging");
      if (
        canonical.length !== s.blobs.length ||
        canonical.some((f) => !s.blobs.some((r) => sameFile(r, f)))
      )
        managedConflict("manifest");
      return {
        statements: [
          ...managedAuthorityGuards(db, s, true),
          ...managedPublicationGuards(db, s),
          ...delegation,
          ...managedRowsGuards(db, MANAGED_BLOBS, i, s.blobs, BLOB_KEYS),
          db
            .prepare(
              "UPDATE managed_source_publications SET state='sealed',manifest=?2,manifest_sha256=?3,updated_at=?4 WHERE operation_id=?1",
            )
            .bind(i.operationId, generatedJsonb(canonical), digest, i.now),
          db
            .prepare(
              "UPDATE outbox_events SET available_at=?2 WHERE operation_id=?1 AND event_type='ManagedSourcePublicationRequestedV1' AND acknowledged_at IS NULL AND current_attempt_id IS NULL",
            )
            .bind(i.operationId, i.now),
        ],
        result: () => undefined,
      };
    },
  };
  await runCommand(db, command);
}
export async function recordApiManagedSourcePreparedCommit(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = managedWriteInput
      .extend({ commitSha: sha, parentSha: sha.nullable(), treeSha: sha })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const command: Command<Snapshot, void> = {
    name: "managedSource.prepareCommit",
    input: i,
    retryOn: ["precondition_changed", "consent_changed"],
    read: async (reader) => {
      const s = await readManagedSnapshot(reader, scope(i), i.operationId);
      return {
        source: s,
        delegation: await managedDelegationGuards(reader, s, managedDelegationOf(s.publication)),
      };
    },
    decide: ({ source: s, delegation }) => {
      managedWritable(s, i.now, "sealed");
      const p = s.publication;
      if (p === null) managedConflict("scope");
      if (
        p["expected_managed_commit"] !== i.parentSha ||
        (p["commit_sha"] !== null &&
          (p["commit_sha"] !== i.commitSha || p["tree_sha"] !== i.treeSha))
      )
        managedConflict("candidate");
      return {
        statements: [
          ...managedAuthorityGuards(db, s, true),
          ...managedPublicationGuards(db, s),
          ...delegation,
          db
            .prepare(
              "UPDATE managed_source_publications SET commit_sha=?2,tree_sha=?3,updated_at=?4 WHERE operation_id=?1",
            )
            .bind(i.operationId, i.commitSha, i.treeSha, i.now),
        ],
        result: () => undefined,
      };
    },
  };
  await runCommand(db, command);
}
