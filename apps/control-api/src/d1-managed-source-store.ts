import { z } from "zod";
import { isManagedSourcePath, MANAGED_SOURCE_LIMITS } from "@ohmyhost/contracts/managed-sources";
import {
  AUTHORIZATION_ACTIONS,
  parseUlid,
  type Clock,
  type HostingRegion,
  type UlidFactory,
} from "@ohmyhost/platform";
import {
  ManagedSourceConflictError,
  ManagedSourceInitializationError,
  ManagedSourceReservationError,
} from "@ohmyhost/database";
import { operationResult } from "./product-operation-result.js";
import { ManagedSourceSurfaceError, type ManagedSourceStore } from "./managed-source-surface.js";
import {
  createManagedSourceCompositionFromStore,
  type ManagedSourcePrivateBinding,
} from "./managed-source-composition.js";
export interface D1ManagedSourceRuntime {
  readApiManagedSourceProjectScope(input: unknown): Promise<unknown>;
  readApiProjectSourceBinding(input: unknown): Promise<unknown>;
  readApiManagedSourceInitialization(input: unknown): Promise<unknown>;
  beginApiManagedSourcePublication(input: unknown): Promise<unknown>;
  readApiManagedSourcePublication(input: unknown): Promise<unknown>;
  reserveApiManagedSourceBlob(input: unknown): Promise<unknown>;
  recordApiManagedSourceBlob(input: unknown): Promise<unknown>;
  sealApiManagedSourceManifest(input: unknown): Promise<unknown>;
  recordApiManagedSourcePreparedCommit(input: unknown): Promise<unknown>;
  completeApiManagedSourcePublication(input: unknown): Promise<unknown>;
  failApiManagedSourcePublication(input: unknown): Promise<unknown>;
  recordApiManagedSourceRequest(input: unknown): Promise<unknown>;
  readApiManagedSourceOperation(input: unknown): Promise<unknown>;
  authorizeApiManagedSourcePublication(input: unknown): Promise<unknown>;
}
export const D1_MANAGED_SOURCE_METHODS = [
  "readApiManagedSourceProjectScope",
  "readApiProjectSourceBinding",
  "readApiManagedSourceInitialization",
  "beginApiManagedSourcePublication",
  "readApiManagedSourcePublication",
  "reserveApiManagedSourceBlob",
  "recordApiManagedSourceBlob",
  "sealApiManagedSourceManifest",
  "recordApiManagedSourcePreparedCommit",
  "completeApiManagedSourcePublication",
  "failApiManagedSourcePublication",
  "recordApiManagedSourceRequest",
  "readApiManagedSourceOperation",
  "authorizeApiManagedSourcePublication",
] as const;
export function isD1ManagedSourceRuntime(raw: unknown): raw is D1ManagedSourceRuntime {
  return (
    typeof raw === "object" &&
    raw !== null &&
    D1_MANAGED_SOURCE_METHODS.every((m) => typeof Reflect.get(raw, m) === "function")
  );
}
const id = z.string().refine((v) => {
    try {
      parseUlid(v);
      return true;
    } catch {
      return false;
    }
  }),
  sha = z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
  digest = z.string().regex(/^[0-9a-f]{64}$/u),
  count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  instant = z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const delegated = z.strictObject({
  grantId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  clientId: z.string(),
  consentHash: digest,
  action: z.enum(AUTHORIZATION_ACTIONS),
  authorizationRestriction: z
    .strictObject({
      actions: z.array(z.enum(AUTHORIZATION_ACTIONS)).optional(),
      organizationIds: z.array(id.transform(parseUlid)).optional(),
      projectIds: z.array(id.transform(parseUlid)).optional(),
      mailDomainIds: z.array(id.transform(parseUlid)).optional(),
    })
    .optional(),
});
const binding = z.strictObject({
  provider: z.enum(["github", "managed"]),
  sourceConnectionId: id,
  generation: count.min(1),
  commitSha: sha.nullable(),
  namespace: z.string(),
  repositoryName: z.string(),
  status: z.enum(["ready", "revoked"]),
  linkedAt: instant,
  updatedAt: instant,
});
const file = z.strictObject({
  path: z.string().refine(isManagedSourcePath),
  sha256: digest,
  byteLength: count.max(MANAGED_SOURCE_LIMITS.fileBytes),
  executable: z.boolean(),
});
const blob = file.extend({
  bucket: z.string(),
  key: z.string(),
  versionId: z.string(),
  eTag: z.string(),
});
const publication = z.strictObject({
  operationId: id,
  sourceConnectionId: id,
  mode: z.enum(["initialize", "commit", "switch"]),
  state: z.enum(["staging", "sealed", "committed", "failed"]),
  expectedSourceConnectionId: id.nullable(),
  expectedSourceGeneration: count,
  expectedManagedCommit: sha.nullable(),
  manifestDigest: digest.nullable(),
  commitSha: sha.nullable(),
  treeSha: sha.nullable(),
  namespace: z.string(),
  repositoryName: z.string(),
  message: z.string(),
  files: z.array(file).max(MANAGED_SOURCE_LIMITS.files),
  blobs: z.array(blob).max(MANAGED_SOURCE_LIMITS.files),
  createdAt: instant,
  expiresAt: instant,
  errorCode: z.string().nullable(),
  delegation: delegated.nullable(),
});
const initialization = z.strictObject({
  organizationId: id,
  projectId: id,
  parentOperationId: id,
  sourceConnectionId: id,
  initializationEventId: id,
  principalId: z.string(),
  template: z.enum(["vite-react", "empty"]),
  region: z.enum(["us", "eu"]),
  requestId: z.string(),
  billingEpochId: id,
  state: z.enum(["waiting", "queued", "initializing", "initialized", "failed"]),
  childOperationId: id.nullable(),
  creationDelegation: delegated.nullable(),
  errorCode: z.string().nullable(),
  createdAt: instant,
  updatedAt: instant,
});
const operation = z.strictObject({
  operationId: id,
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  createdAt: instant,
  updatedAt: instant,
  failure: z.strictObject({ code: z.string() }).nullable().optional(),
  failureDiagnostic: z.unknown().optional(),
});
const scope = (i: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly principalId: string;
}) => ({ organizationId: i.organizationId, projectId: i.projectId, principalId: i.principalId });
const publicationScope = (i: Parameters<ManagedSourceStore["publication"]>[0]) => ({
  ...scope(i),
  operationId: i.operationId,
});
export async function managedSourceCoreCall<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : "",
      code = error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined,
      raw = typeof code === "string" ? code : message;
    if (raw === "source_scope_unavailable")
      throw new ManagedSourceSurfaceError("source_scope_unavailable", 404, "Resource not found.");
    let kind =
      /^managed_source_(scope|generation|commit|operation|manifest|candidate|expired|state|idempotency)$/u.exec(
        raw,
      )?.[1] ??
      /^Managed source (scope|generation|commit|operation|manifest|candidate|expired|state|idempotency) conflict$/u.exec(
        raw,
      )?.[1];
    if (kind !== undefined)
      throw new ManagedSourceConflictError(
        kind as ConstructorParameters<typeof ManagedSourceConflictError>[0],
      );
    kind =
      /^managed_source_reservation_(scope|state|expired|identity|limit|generation|commit)$/u.exec(
        raw,
      )?.[1] ??
      /^Managed source reservation (scope|state|expired|identity|limit|generation|commit) conflict$/u.exec(
        raw,
      )?.[1];
    if (kind !== undefined)
      throw new ManagedSourceReservationError(
        kind as ConstructorParameters<typeof ManagedSourceReservationError>[0],
      );
    kind = /^managed_source_initialization_(scope|identity|state)$/u.exec(raw)?.[1];
    if (kind !== undefined)
      throw new ManagedSourceInitializationError(
        kind as ConstructorParameters<typeof ManagedSourceInitializationError>[0],
      );
    throw error;
  }
}
/** All14 original journal operations retain fixed DTOs and the original public/provider surface. Constructor performs no reads. */
export function createD1ManagedSourceStore(input: {
  readonly runtime: D1ManagedSourceRuntime;
  readonly clock: Clock;
  readonly notifyPreviewSource?: (scope: {
    organizationId: string;
    projectId: string;
  }) => Promise<void>;
}): ManagedSourceStore & Required<Pick<ManagedSourceStore, "pendingInitialization">> {
  const runtime = input.runtime;
  if (!isD1ManagedSourceRuntime(runtime)) throw new Error("managed_source_core_binding_required");
  const core = (method: (typeof D1_MANAGED_SOURCE_METHODS)[number], request: unknown) =>
    managedSourceCoreCall(() => runtime[method](request));
  const readPublication = async (i: Parameters<ManagedSourceStore["publication"]>[0]) => {
    const r = publication
      .nullable()
      .parse(await core("readApiManagedSourcePublication", publicationScope(i)));
    if (r !== null && r.operationId !== i.operationId)
      throw new Error("managed_source_core_scope_invalid");
    return r;
  };
  return {
    async projectScope(i) {
      const raw = await core("readApiManagedSourceProjectScope", scope(i));
      if (raw === null)
        throw new ManagedSourceSurfaceError("source_scope_unavailable", 404, "Resource not found.");
      return z.strictObject({ environmentId: id, region: z.enum(["us", "eu"]) }).parse(raw);
    },
    async binding(i) {
      return binding.nullable().parse(await core("readApiProjectSourceBinding", scope(i)));
    },
    async pendingInitialization(i) {
      const r = initialization
        .nullable()
        .parse(await core("readApiManagedSourceInitialization", scope(i)));
      if (r !== null && (r.organizationId !== i.organizationId || r.projectId !== i.projectId))
        throw new Error("managed_source_core_scope_invalid");
      return r;
    },
    async begin(i) {
      return publication.parse(
        await core("beginApiManagedSourcePublication", {
          ...scope(i),
          environmentId: i.environmentId,
          operationId: i.operationId,
          operationEventId: i.operationEventId,
          auditEventId: i.auditEventId,
          outboxEventId: i.outboxEventId,
          requestId: i.requestId,
          idempotencyKey: i.idempotencyKey,
          canonicalRequestDigest: i.canonicalRequestDigest,
          mode: i.mode,
          sourceConnectionId: i.sourceConnectionId,
          expectedSourceConnectionId: i.expectedSourceConnectionId,
          expectedSourceGeneration: i.expectedSourceGeneration,
          expectedManagedCommit: i.expectedManagedCommit,
          namespace: i.namespace,
          repositoryName: i.repositoryName,
          message: i.message,
          now: i.now,
          expiresAt: i.expiresAt,
          ...(i.routeTemplate === undefined ? {} : { routeTemplate: i.routeTemplate }),
          ...(i.delegation === undefined ? {} : { delegation: i.delegation }),
        }),
      );
    },
    publication: readPublication,
    async reserveBlob(i) {
      return z.enum(["created", "replayed"]).parse(
        await core("reserveApiManagedSourceBlob", {
          ...publicationScope(i),
          path: i.path,
          sha256: i.sha256,
          byteLength: i.byteLength,
          executable: i.executable,
          now: i.now,
        }),
      );
    },
    async recordBlob(i) {
      z.undefined().parse(
        await core("recordApiManagedSourceBlob", {
          ...publicationScope(i),
          path: i.path,
          sha256: i.sha256,
          byteLength: i.byteLength,
          executable: i.executable,
          bucket: i.bucket,
          key: i.key,
          versionId: i.versionId,
          eTag: i.eTag,
          now: i.now,
        }),
      );
    },
    async seal(i) {
      z.undefined().parse(
        await core("sealApiManagedSourceManifest", {
          ...publicationScope(i),
          files: i.files,
          manifestSha256: i.manifestSha256,
          now: i.now,
        }),
      );
    },
    async prepared(i) {
      z.undefined().parse(
        await core("recordApiManagedSourcePreparedCommit", {
          ...publicationScope(i),
          commitSha: i.commitSha,
          parentSha: i.parentSha,
          treeSha: i.treeSha,
          now: i.now,
        }),
      );
    },
    async complete(i) {
      const result = binding.parse(
        await core("completeApiManagedSourcePublication", {
          ...publicationScope(i),
          commitSha: i.commitSha,
          treeSha: i.treeSha,
          now: i.now,
          eventId: i.eventId,
          ...(i.observedHeadCommitSha === undefined
            ? {}
            : { observedHeadCommitSha: i.observedHeadCommitSha }),
        }),
      );
      // Publication already committed with its pending outbox. Notification failure cannot undo it.
      try {
        await input.notifyPreviewSource?.({
          organizationId: i.organizationId,
          projectId: i.projectId,
        });
      } catch {
        /* Outbox retries independently. */
      }
      return result;
    },
    async fail(i) {
      z.undefined().parse(
        await core("failApiManagedSourcePublication", {
          ...publicationScope(i),
          errorCode: i.errorCode,
          now: i.now,
          eventId: i.eventId,
        }),
      );
    },
    async recordRequest(i) {
      return z.enum(["created", "replayed"]).parse(
        await core("recordApiManagedSourceRequest", {
          ...publicationScope(i),
          httpMethod: i.httpMethod,
          routeTemplate: i.routeTemplate,
          idempotencyKey: i.idempotencyKey,
          canonicalRequestDigest: i.canonicalRequestDigest,
          requestId: i.requestId,
          now: i.now,
        }),
      );
    },
    async operation(i) {
      return operationResult(
        operation.parse(await core("readApiManagedSourceOperation", publicationScope(i))),
      );
    },
    async authorizePublication(i) {
      z.undefined().parse(
        await core("authorizeApiManagedSourcePublication", {
          ...publicationScope(i),
          now: input.clock.now().toISOString(),
        }),
      );
    },
  };
}
export function createD1ManagedSourceComposition(input: {
  readonly runtime: D1ManagedSourceRuntime;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  readonly binding: ManagedSourcePrivateBinding;
  readonly namespaces: Readonly<Record<HostingRegion, string>>;
  readonly wake: () => Promise<void>;
  readonly notifyPreviewSource?: (scope: {
    organizationId: string;
    projectId: string;
  }) => Promise<void>;
}) {
  return createManagedSourceCompositionFromStore({
    ...input,
    store: createD1ManagedSourceStore(input),
  });
}

export const managedSourceInitializationResult = initialization;
export const managedSourcePublicationResult = publication;
