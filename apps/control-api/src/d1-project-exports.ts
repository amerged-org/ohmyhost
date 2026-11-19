import { ProjectRecoveryDailyLimitError } from "@ohmyhost/database";
import { IdempotencyKeyReusedError } from "./contracts.js";
import { operationResult, ProductSurfaceUnavailableError } from "./product-surface.js";
import { createProjectExports, type ProjectExportPersistence } from "./project-exports.js";

type OperationView = Parameters<typeof operationResult>[0];
interface ExportRuntime {
  readProjectExportReplay(
    input: unknown,
  ): Promise<
    { outcome: "absent" | "conflict" } | { outcome: "replayed"; operation: OperationView }
  >;
  acceptProjectRecoveryExport(input: unknown): Promise<
    | { outcome: "limited"; retryAt: string }
    | { outcome: "replayed"; operation: OperationView }
    | {
        outcome: "created";
        response: {
          httpStatus: number;
          responseHeaders: { Location: string };
          responseBody: Readonly<Record<string, unknown>>;
        };
      }
  >;
  readProjectRecoveryInventory(input: unknown): ReturnType<ProjectExportPersistence["inventory"]>;
  readProjectExportStatus(input: unknown): ReturnType<ProjectExportPersistence["status"]>;
  recordProjectDatabaseEventAudit(input: unknown): Promise<unknown>;
}
type Options = Omit<Parameters<typeof createProjectExports>[0], "persistence"> & {
  readonly runtime: unknown;
};
const digestHex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Same original API HMAC/sealing/public protocol, one closed D1 command per authoritative write. The plaintext
 * password never enters this persistence port or a service-binding message, and missing D1 never falls back. */
export function createD1ProjectExports(input: Options) {
  if (
    input.runtime === null ||
    input.runtime === undefined ||
    (typeof input.runtime !== "object" && typeof input.runtime !== "function")
  )
    throw new ProductSurfaceUnavailableError();
  const runtime = input.runtime as ExportRuntime;
  const persistence: ProjectExportPersistence = {
    async replay(request) {
      const result = await runtime.readProjectExportReplay({
        organizationId: request.organizationId,
        projectId: request.projectId,
        principalId: request.principalId,
        idempotencyKey: request.idempotencyKey,
        canonicalRequestDigest: digestHex(request.canonicalRequestDigest),
        ...(request.delegation === undefined ? {} : { delegation: request.delegation }),
      });
      if (result.outcome === "absent") return null;
      if (result.outcome === "conflict") throw new IdempotencyKeyReusedError();
      if (!("operation" in result)) throw new ProductSurfaceUnavailableError();
      return operationResult(result.operation);
    },
    async recordDownloadLink(request) {
      const raw = await runtime.recordProjectDatabaseEventAudit({
        organizationId: request.organizationId,
        projectId: request.projectId,
        environment: null,
        principalId: request.principalId,
        eventType: "ProjectExportDownloadLinkIssuedV1",
        payload: { operation_id: request.operationId },
        occurredAt: request.occurredAt,
      });
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as { recorded?: unknown }).recorded !== "boolean"
      )
        throw new ProductSurfaceUnavailableError();
      return (raw as { recorded: boolean }).recorded;
    },
    inventory: (request) =>
      runtime.readProjectRecoveryInventory({
        organizationId: request.organizationId,
        projectId: request.projectId,
      }),
    status: (request) =>
      runtime.readProjectExportStatus({
        organizationId: request.organizationId,
        projectId: request.projectId,
        operationId: request.operationId,
      }),
    async accept(request) {
      let result: Awaited<ReturnType<ExportRuntime["acceptProjectRecoveryExport"]>>;
      try {
        result = await runtime.acceptProjectRecoveryExport({
          organizationId: request.organizationId,
          projectId: request.projectId,
          principalId: request.principalId,
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          canonicalRequestDigest: digestHex(request.canonicalRequestDigest),
          operationId: request.operationId,
          operationEventId: request.operationEventId,
          auditEventId: request.auditEventId,
          outboxEventId: request.outboxEventId,
          occurredAt: request.occurredAt,
          archiveBucket: request.archiveBucket,
          sealedInput: request.sealedInput,
          ...(request.delegation === undefined ? {} : { delegation: request.delegation }),
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Idempotency key reused")
          throw new IdempotencyKeyReusedError();
        throw error;
      }
      if (result.outcome === "limited") throw new ProjectRecoveryDailyLimitError(result.retryAt);
      if (result.outcome === "replayed") return operationResult(result.operation);
      if (result.response.httpStatus !== 202) throw new ProductSurfaceUnavailableError();
      return {
        status: 202,
        location: result.response.responseHeaders.Location,
        body: result.response.responseBody,
      };
    },
  };
  return createProjectExports({ ...input, persistence });
}
