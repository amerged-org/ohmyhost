import { createHmac, hkdfSync } from "node:crypto";
import { readProjectExportStatus, DeploymentPersistenceConflictError } from "@ohmyhost/database";
import {
  createRecoveryInputCipher,
  parseRecoveryJobInput,
  type Clock,
  type UlidFactory,
} from "@ohmyhost/platform";
import { publicOperationFailure } from "@ohmyhost/contracts/operation-failure";
import {
  IdempotencyKeyReusedError,
  type ProductSurfaceContext,
  type ProductSurfaceMutationContext,
  type ProductSurfaceResult,
} from "./contracts.js";

export interface ProjectExportBinding {
  invokeRecovery(input: unknown): Promise<unknown>;
}
export class ProjectExportNotReadyError extends Error {
  constructor() {
    super("Project databases are not ready for SQL export");
  }
}
/** A download link is refused when its organization has used its links for the minute; nothing is signed. */
export class ProjectExportLinkLimitError extends Error {
  constructor() {
    super("Download links are limited to six per minute per organization");
  }
}

export interface ProjectExportPersistence {
  replay(request: ProductSurfaceMutationContext): Promise<ProductSurfaceResult | null>;
  inventory(request: ProductSurfaceContext): Promise<{
    environments: readonly { database: unknown | null }[];
    nativeAuthDatabase?: unknown;
  } | null>;
  accept(
    request: ProductSurfaceMutationContext & {
      operationId: string;
      operationEventId: string;
      auditEventId: string;
      outboxEventId: string;
      occurredAt: string;
      archiveBucket: "ohmyho-development-backups" | "ohmyho-production-backups";
      sealedInput: Awaited<ReturnType<ReturnType<typeof createRecoveryInputCipher>["seal"]>>;
    },
  ): Promise<ProductSurfaceResult>;
  status(
    request: ProductSurfaceContext & { operationId: string },
  ): ReturnType<typeof readProjectExportStatus>;
  /** Writes the audit event of one link before it is signed; false when the organization is over its limit. */
  recordDownloadLink(
    request: ProductSurfaceContext & { operationId: string; occurredAt: string },
  ): Promise<boolean>;
}
interface ProjectExportOptions {
  key: Uint8Array;
  crypto: Crypto;
  clock: Clock;
  ids: Pick<UlidFactory, "next">;
  archiveBucket: "ohmyho-development-backups" | "ohmyho-production-backups";
  downloadBinding: ProjectExportBinding;
  r2AccountId: string;
}

/** Shared original HMAC/sealing/public protocol; storage is a closed capability, never a SQL callback. */
export function createProjectExports(
  input: ProjectExportOptions & { persistence: ProjectExportPersistence },
) {
  if (!/^[a-f0-9]{32}$/u.test(input.r2AccountId)) throw new Error("Invalid recovery R2 account");
  const recoveryOrigin = `https://${input.r2AccountId}.eu.r2.cloudflarestorage.com`;
  const cipher = createRecoveryInputCipher({ key: input.key, keyVersion: 1, crypto: input.crypto });
  const digestKey = hkdfSync("sha256", input.key, "", "ohmyho.st/sql-export-idempotency/v1", 32);
  return {
    async create(
      request: ProductSurfaceMutationContext & { password: string },
    ): Promise<ProductSurfaceResult | null> {
      const { password, ...safeRequest } = request;
      const plaintext = new TextEncoder().encode(
        JSON.stringify({ version: 1, passphrase: password }),
      );
      try {
        parseRecoveryJobInput(plaintext);
        const canonicalRequestDigest = new Uint8Array(
          createHmac("sha256", Buffer.from(digestKey))
            .update(request.canonicalRequestDigest)
            .digest(),
        );
        const replay = await input.persistence.replay({ ...safeRequest, canonicalRequestDigest });
        if (replay) return replay;
        const inventory = await input.persistence.inventory(safeRequest);
        if (inventory === null) return null;
        if (
          !inventory.environments.some((environment) => environment.database !== null) &&
          inventory.nativeAuthDatabase === undefined
        )
          throw new ProjectExportNotReadyError();
        const operationId = input.ids.next(),
          sealedInput = await cipher.seal({ ...safeRequest, operationId }, plaintext),
          occurredAt = input.clock.now().toISOString();
        return await input.persistence.accept({
          ...safeRequest,
          canonicalRequestDigest,
          operationId,
          sealedInput,
          occurredAt,
          archiveBucket: input.archiveBucket,
          operationEventId: input.ids.next(),
          auditEventId: input.ids.next(),
          outboxEventId: input.ids.next(),
        });
      } catch (error) {
        if (error instanceof Error && error.message === "recovery_database_not_ready")
          throw new ProjectExportNotReadyError();
        if (
          error instanceof DeploymentPersistenceConflictError &&
          error.message.includes("Idempotency")
        )
          throw new IdempotencyKeyReusedError();
        throw error;
      } finally {
        plaintext.fill(0);
      }
    },
    async get(
      request: ProductSurfaceContext & { operationId: string },
    ): Promise<ProductSurfaceResult | null> {
      const stored = await input.persistence.status(request);
      if (stored === null) return null;
      // The GET never signs a link: that needs a Container. Links come from the audited POST below.
      return {
        status: 200,
        body: {
          id: request.operationId,
          project_id: request.projectId,
          state: stored.state,
          requested_at: stored.requestedAt,
          next_request_at: stored.nextRequestAt,
          next_poll_after_seconds:
            stored.state === "queued" || stored.state === "running" ? 5 : null,
          error:
            stored.state === "failed"
              ? publicOperationFailure(stored.failureCode ?? "recovery_job_failed")
              : null,
          archive: stored.archive
            ? {
                bytes: stored.archive.bytes,
                sha256: stored.archive.sha256,
                sql_files: stored.archive.sqlFiles,
                captured_at: stored.archive.capturedAt,
                expires_at: stored.archive.expiresAt,
                download_url: null,
                download_expires_at: null,
              }
            : null,
        },
      };
    },
    /**
     * Signs one download link of a ready export. The link is audited first, as the reservation of one signature, so an
     * organization over its limit gets no link, and a link is never returned without its audit event.
     */
    async issueDownloadLink(
      request: ProductSurfaceContext & { operationId: string },
    ): Promise<ProductSurfaceResult | null> {
      const stored = await input.persistence.status(request);
      if (stored === null) return null;
      const now = input.clock.now().toISOString();
      if (!stored.archive || Date.parse(stored.archive.expiresAt) - Date.parse(now) < 86400000)
        throw new ProjectExportNotReadyError();
      if (!(await input.persistence.recordDownloadLink({ ...request, occurredAt: now })))
        throw new ProjectExportLinkLimitError();
      const raw = await input.downloadBinding.invokeRecovery({
        action: "download",
        organizationId: request.organizationId,
        projectId: request.projectId,
        operationId: request.operationId,
      });
      // The container signs the URL when it runs, after any wait in its queue, so the freshness of that signature is
      // judged against the clock once it has answered.
      const download = parseDownload(
        raw,
        request,
        stored.archive,
        input.archiveBucket,
        recoveryOrigin,
        input.clock.now().toISOString(),
      );
      if (!download) throw new ProjectExportNotReadyError();
      // A transfer/freeze during the private provider read must not publish its capability.
      if ((await input.persistence.status(request)) === null) return null;
      return {
        status: 200,
        body: {
          id: request.operationId,
          project_id: request.projectId,
          download_url: download.url,
          download_expires_at: download.expiresAt,
        },
      };
    },
  };
}
export type ProjectExportsPort = ReturnType<typeof createProjectExports>;
function parseDownload(
  raw: unknown,
  scope: ProductSurfaceContext & { operationId: string },
  archive: NonNullable<Awaited<ReturnType<typeof readProjectExportStatus>>>["archive"],
  bucket: string,
  recoveryOrigin: string,
  now: string,
) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Project export download unavailable");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).join(",") === "status" && value["status"] === "unavailable") return null;
  if (
    !archive ||
    Object.keys(value).sort().join(",") !==
      "archiveExpiresAt,bytes,capturedAt,downloadExpiresAt,operationId,sha256,sqlFiles,status,url" ||
    value["status"] !== "ready" ||
    value["operationId"] !== scope.operationId ||
    value["bytes"] !== archive.bytes ||
    value["sha256"] !== archive.sha256 ||
    JSON.stringify(value["sqlFiles"]) !== JSON.stringify(archive.sqlFiles) ||
    value["capturedAt"] !== archive.capturedAt ||
    value["archiveExpiresAt"] !== archive.expiresAt ||
    typeof value["url"] !== "string" ||
    typeof value["downloadExpiresAt"] !== "string"
  )
    throw new Error("Project export download unavailable");
  // A Native Auth export is stored under native-exports/ (its auth.sql ties it to the native manifest).
  const prefix = archive.sqlFiles.includes("auth.sql") ? "native-exports" : "snapshots";
  const url = new URL(value["url"]),
    expiry = Date.parse(value["downloadExpiresAt"]),
    stamp = url.searchParams.get("X-Amz-Date") ?? "",
    match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(stamp);
  const issued = match
    ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`)
    : NaN;
  if (
    url.origin !== recoveryOrigin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !==
      `/${bucket}/${prefix}/${scope.organizationId}/${scope.projectId}/${scope.operationId}.zip` ||
    url.searchParams.get("X-Amz-Expires") !== "86400" ||
    !/^([a-f0-9]{64})$/u.test(url.searchParams.get("X-Amz-Signature") ?? "") ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expiry) ||
    Math.abs(expiry - issued - 86400000) > 999 ||
    Math.abs(issued - Date.parse(now)) > 60000 ||
    expiry > Date.parse(archive.expiresAt)
  )
    throw new Error("Project export download unavailable");
  return { url: url.toString(), expiresAt: value["downloadExpiresAt"] };
}
