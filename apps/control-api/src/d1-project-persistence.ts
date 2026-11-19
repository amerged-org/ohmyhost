import { createHash } from "node:crypto";

import {
  ManagedSourceInitializationError,
  type InitialProjectTransaction,
} from "@ohmyhost/database";
import {
  createOperation,
  createProject,
  parseUlid,
  type Clock,
  type HostingRegion,
  type Ulid,
  type UlidFactory,
} from "@ohmyhost/platform";
import {
  createProjectHandleGenerator,
  parseProjectHandleReceipt,
  PROJECT_HANDLE_MAX_COLLISION_ATTEMPT,
} from "@ohmyhost/project-handles";
import {
  IdempotencyKeyReusedError,
  InvalidProjectCursorError,
  ProjectHandleAllocationExhaustedError,
  ProjectIdentityAllocationExhaustedError,
  type ControlApiPersistence,
  type CreateProjectPersistenceInput,
  type CreatedProjectResponse,
  type ProjectCreateResponse,
  type ProjectView,
} from "./contracts.js";
import { recoveryOperationView, type D1RecoveryOperationRead } from "./d1-recovery-operation.js";

/** Closed private project authority. It exposes no SQL, generic transaction, provider or money operation. */
export interface D1ProjectRuntime {
  admitCustomerProject(input: unknown): Promise<{
    readonly status: 202;
    readonly location: string;
    readonly body: {
      readonly id: string;
      readonly state: "queued";
      readonly created_at: string;
      readonly updated_at: string;
      readonly project_id: string;
    };
  }>;
  addDevelopmentEnvironment?(input: unknown): Promise<{
    readonly status: 202;
    readonly location: string;
    readonly body: {
      readonly id: string;
      readonly state: "queued";
      readonly created_at: string;
      readonly updated_at: string;
    };
  }>;
  readTakenProjectHandles(input: unknown): Promise<readonly string[]>;
  listCustomerProjects(
    input: unknown,
  ): Promise<{ readonly projects: readonly D1ProjectView[]; readonly nextCursor: string | null }>;
  getCustomerProject(input: unknown): Promise<D1ProjectView | null>;
  resolveWorkosOrganization(input: unknown): Promise<string | null>;
  resolveM2mOrganization(
    input: unknown,
  ): Promise<{ readonly organizationId: string; readonly scopes: readonly string[] } | null>;
  authorizeOrganizationAction(input: unknown): Promise<"allow" | "deny">;
  readAuditEvents?(input: unknown): Promise<{
    events: readonly {
      eventId: string;
      organizationId: string;
      projectId: string | null;
      operationId: string | null;
      eventType: string;
      actorType: string;
      actorId: string;
      summary: string;
      occurredAt: string;
    }[];
    nextCursor: string | null;
  }>;
  readProjectRecoveryOperation?(input: unknown): Promise<D1RecoveryOperationRead>;
  readProjectDatabaseOperation?(input: unknown): Promise<D1RecoveryOperationRead>;
}
interface D1ProjectView {
  readonly projectId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly handle: string;
  readonly dataMode: "shared" | "isolated";
  readonly region: "us" | "eu";
  readonly createdAt: string;
}

/** Unported paths fail explicitly. */
export function unportedD1ControlOperation(): never {
  throw new Error("control_d1_operation_unported");
}

function projectView(value: D1ProjectView): ProjectView {
  return {
    ...value,
    projectId: parseUlid(value.projectId),
    organizationId: parseUlid(value.organizationId),
  };
}

/** Reuses the original seed, handle receipt and audit-key hashing; only the single transactional transport differs. */
export function createD1ControlApiPersistence(input: {
  readonly platform: "development" | "production";
  readonly runtime: D1ProjectRuntime;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  readonly projectHandles?: ProjectHandleReceiptSource;
  /** Feedback and the full original product-operation read, from their own Core capabilities. */
  readonly extras?: Partial<
    Pick<ControlApiPersistence, "submitFeedback" | "readFeedbackStatus" | "getOperation">
  >;
}): ControlApiPersistence {
  const { runtime, clock, ids, platform } = input;
  const handles = input.projectHandles ?? createProjectHandleGenerator(globalThis.crypto);
  return {
    submitFeedback: input.extras?.submitFeedback ?? unportedD1ControlOperation,
    readFeedbackStatus: input.extras?.readFeedbackStatus ?? unportedD1ControlOperation,
    async getOperation(organizationId, operationId) {
      let result =
        runtime.readProjectRecoveryOperation === undefined
          ? { outcome: "unported" as const }
          : await runtime.readProjectRecoveryOperation({ organizationId, operationId });
      if (result.outcome === "unported" && runtime.readProjectDatabaseOperation !== undefined) {
        const database = await runtime.readProjectDatabaseOperation({
          organizationId,
          operationId,
        });
        // The database reader's "absent" means "not a database operation", not "no such operation".
        if (database.outcome === "absent")
          return input.extras?.getOperation === undefined
            ? null
            : input.extras.getOperation(organizationId, operationId);
        result = database;
      }
      if (result.outcome === "absent") return null;
      if (result.outcome === "unported" && input.extras?.getOperation !== undefined)
        return input.extras.getOperation(organizationId, operationId);
      if (result.outcome === "unported") return unportedD1ControlOperation();
      if (!("operation" in result)) return unportedD1ControlOperation();
      if (
        result.operation.organizationId !== organizationId ||
        result.operation.operationId !== operationId
      )
        throw new Error("Operation persistence result escaped its requested scope");
      return recoveryOperationView(result.operation, result.blockingOperationId);
    },
    async readAuditEvents(request) {
      if (runtime.readAuditEvents === undefined) return unportedD1ControlOperation();
      try {
        const page = await runtime.readAuditEvents(request);
        return {
          nextCursor: page.nextCursor,
          events: page.events.map((event) => ({
            ...event,
            eventId: parseUlid(event.eventId),
            organizationId: parseUlid(event.organizationId),
            projectId: parseUlid(event.projectId ?? ""),
            operationId: event.operationId === null ? null : parseUlid(event.operationId),
          })),
        };
      } catch (error) {
        if (
          (error !== null &&
            typeof error === "object" &&
            Reflect.get(error, "code") === "invalid_audit_cursor") ||
          (error instanceof Error && error.message.startsWith("Invalid audit cursor:"))
        )
          throw new TypeError("Invalid audit cursor");
        throw error;
      }
    },
    async takenProjectHandles(candidates) {
      return new Set(await runtime.readTakenProjectHandles({ candidates }));
    },
    async createProject(request): Promise<ProjectCreateResponse> {
      const seed = initialProjectSeed(request, clock, ids);
      const projectEvent = seed.project.events[0],
        operationEvent = seed.operation.events[0];
      if (projectEvent === undefined || operationEvent === undefined)
        throw new Error("Initial events are unavailable");
      const source =
        request.source === undefined
          ? undefined
          : {
              template: request.source.template,
              sourceConnectionId: ids.next(),
              initializationEventId: ids.next(),
              ...(request.sourceDelegation === undefined
                ? {}
                : { delegation: request.sourceDelegation }),
            };
      const { eventId: auditEventId, ...audit } = seed.audit;
      for (
        let collisionAttempt = 0;
        collisionAttempt <= PROJECT_HANDLE_MAX_COLLISION_ATTEMPT;
        collisionAttempt += 1
      ) {
        const expected = { projectId: seed.project.projectId, collisionAttempt };
        const receipt = parseProjectHandleReceipt(await handles.generate(expected), expected);
        try {
          const result = await runtime.admitCustomerProject({
            platform,
            operationCreatedAt: seed.operation.createdAt,
            request: {
              requestId: request.requestId,
              idempotencyKey: createIdempotencyKeyReference(request),
              canonicalRequestDigest: Buffer.from(request.canonicalRequestDigest).toString("hex"),
            },
            project: {
              organizationId: seed.organizationId,
              projectId: seed.project.projectId,
              billingEpochId: seed.billingEpochId,
              principalId: seed.principalId,
              projectName: seed.projectName,
              projectHandle: receipt.handle,
              projectHandleVersion: receipt.version,
              projectHandleAttempt: receipt.collisionAttempt,
              dataMode: seed.dataMode,
              includeDevelopmentEnvironment: seed.includeDevelopmentEnvironment,
              devAccessMode: seed.devAccessMode,
              region: seed.region,
              createdEventId: projectEvent.eventId,
              createdAt: seed.project.createdAt,
              developmentEnvironmentId: seed.developmentEnvironmentId,
              productionEnvironmentId: seed.productionEnvironmentId,
              developmentDataEnvironmentId: seed.developmentEnvironmentId,
              productionDataEnvironmentId:
                seed.dataMode === "shared" && seed.includeDevelopmentEnvironment
                  ? seed.developmentEnvironmentId
                  : seed.productionEnvironmentId,
              operation: {
                operationId: seed.operation.operationId,
                eventId: operationEvent.eventId,
              },
              audit: { ...audit, auditEventId },
              outbox: {
                eventId: seed.outbox.eventId,
                eventType: seed.outbox.eventType,
                payload: seed.outbox.payload,
                createdAt: seed.outbox.createdAt,
                maxAttempts: seed.outbox.maxAttempts,
                ...(seed.outbox.availableAt === undefined
                  ? {}
                  : { availableAt: seed.outbox.availableAt }),
              },
            },
            ...(source === undefined ? {} : { source }),
            ...(request.sourceDelegation === undefined
              ? {}
              : { delegation: request.sourceDelegation }),
          });
          return {
            status: result.status,
            location: result.location,
            body: {
              ...result.body,
              id: parseUlid(result.body.id),
              project_id: parseUlid(result.body.project_id),
            },
          };
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (code === "idempotency_key_reused") throw new IdempotencyKeyReusedError();
          if (code === "managed_source_scope") throw new ManagedSourceInitializationError("scope");
          if (code !== "project_handle_taken") throw error;
          if (collisionAttempt === PROJECT_HANDLE_MAX_COLLISION_ATTEMPT)
            throw new ProjectHandleAllocationExhaustedError();
        }
      }
      throw new ProjectHandleAllocationExhaustedError();
    },
    async addDevelopmentEnvironment(request): Promise<CreatedProjectResponse> {
      if (runtime.addDevelopmentEnvironment === undefined) return unportedD1ControlOperation();
      const occurredAt = clock.now().toISOString();
      const operationId = ids.next();
      try {
        const result = await runtime.addDevelopmentEnvironment({
          ...request,
          idempotencyKey: `sha256:${createHash("sha256").update(`ohmyhost-idempotency-audit-v1\n${request.organizationId}\n${request.principalId}\n${request.idempotencyKey}`, "utf8").digest("hex")}`,
          canonicalRequestDigest: Buffer.from(request.canonicalRequestDigest).toString("hex"),
          environmentId: nextDistinctId(ids, [request.projectId, operationId]),
          operationId,
          operationEventId: ids.next(),
          auditEventId: ids.next(),
          outboxEventId: ids.next(),
          occurredAt,
        });
        return { ...result, body: { ...result.body, id: parseUlid(result.body.id) } };
      } catch (error) {
        if (error instanceof Error && error.message === "idempotency_key_reused")
          throw new IdempotencyKeyReusedError();
        throw error;
      }
    },
    async listProjects(request) {
      try {
        const page = await runtime.listCustomerProjects(request);
        return {
          projects: page.projects.map(projectView),
          nextCursor: page.nextCursor === null ? null : parseUlid(page.nextCursor),
        };
      } catch (error) {
        if (error instanceof Error && error.message === "invalid_project_cursor")
          throw new InvalidProjectCursorError();
        throw error;
      }
    },
    async getProject(organizationId, projectId) {
      const project = await runtime.getCustomerProject({ organizationId, projectId });
      return project === null ? null : projectView(project);
    },
  };
}

interface ProjectHandleReceiptSource {
  generate(input: unknown): Promise<unknown>;
}

interface InitialProjectSeed {
  readonly organizationId: Ulid;
  readonly billingEpochId: Ulid;
  readonly principalId: string;
  readonly projectName: string;
  readonly dataMode: "shared" | "isolated";
  readonly includeDevelopmentEnvironment: boolean;
  readonly devAccessMode: "protected" | "public";
  readonly region: HostingRegion;
  readonly developmentEnvironmentId: Ulid;
  readonly productionEnvironmentId: Ulid;
  readonly project: InitialProjectTransaction["project"];
  readonly operation: InitialProjectTransaction["operation"];
  readonly audit: InitialProjectTransaction["audit"];
  readonly outbox: InitialProjectTransaction["outbox"];
}

function initialProjectSeed(
  input: CreateProjectPersistenceInput,
  clock: Clock,
  ids: UlidFactory,
): InitialProjectSeed {
  const projectId = ids.next();
  const project = createProject({ projectId, clock, eventIds: ids });
  let operationId = ids.next();
  while (operationId === input.requestId) operationId = ids.next();
  const operation = createOperation({ operationId, projectId, clock, eventIds: ids });
  if (operation.state !== "queued") {
    throw new Error("Platform operation creation did not return a queued operation");
  }
  const queuedOperation: InitialProjectTransaction["operation"] = {
    ...operation,
    state: "queued",
  };
  const billingEpochId = ids.next();
  const developmentEnvironmentId = nextDistinctId(ids, [projectId, operationId, billingEpochId]);
  const productionEnvironmentId = nextDistinctId(ids, [
    projectId,
    operationId,
    billingEpochId,
    developmentEnvironmentId,
  ]);
  return {
    organizationId: input.organizationId,
    billingEpochId,
    principalId: input.principalId,
    projectName: input.name,
    dataMode: input.dataMode,
    includeDevelopmentEnvironment: input.includeDevelopmentEnvironment ?? true,
    devAccessMode: input.devAccessMode ?? "protected",
    region: input.region,
    developmentEnvironmentId,
    productionEnvironmentId,
    project,
    operation: queuedOperation,
    audit: {
      eventId: ids.next(),
      projectId,
      operationId,
      eventType: "ProjectCreated",
      actorType: input.principalId.split(":", 1)[0] ?? "principal",
      actorId: input.principalId,
      occurredAt: project.createdAt,
      payload: {
        requestId: input.requestId,
        dataMode: input.dataMode,
        devAccessMode: input.devAccessMode ?? "protected",
        ...(input.includeDevelopmentEnvironment === false
          ? { includeDevelopmentEnvironment: false }
          : {}),
        region: input.region,
        idempotencyKeyReference: createIdempotencyKeyReference(input),
      },
    },
    outbox: {
      eventId: ids.next(),
      projectId,
      operationId,
      eventType: "ProjectProvisioningRequested",
      payload: { projectId, operationId },
      createdAt: project.createdAt,
      maxAttempts: 3,
    },
  };
}

function nextDistinctId(ids: UlidFactory, excluded: readonly Ulid[]): Ulid {
  for (let attempt = 0; attempt <= PROJECT_HANDLE_MAX_COLLISION_ATTEMPT; attempt += 1) {
    const candidate = ids.next();
    if (!excluded.includes(candidate)) return candidate;
  }
  throw new ProjectIdentityAllocationExhaustedError();
}

function createIdempotencyKeyReference(input: CreateProjectPersistenceInput): string {
  return `sha256:${createHash("sha256")
    .update(
      `ohmyhost-idempotency-audit-v1\n${input.organizationId}\n${input.principalId}\n${input.idempotencyKey}`,
      "utf8",
    )
    .digest("hex")}`;
}
