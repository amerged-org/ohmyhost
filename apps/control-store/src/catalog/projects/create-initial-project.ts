import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { type Command } from "../../run-command.js";
import {
  auditRecordInput,
  auditStatement,
  conflict,
  instant,
  organizationLiveGuard,
  outboxRecordInput,
  outboxStatement,
  ownershipInvariantGuard,
  queuedOperationStatements,
  ringDoorbell,
  routeOrganization,
  rowsOf,
  runMapped,
  ulid,
  type CatalogContext,
} from "../common.js";

const handle = z
  .string()
  .min(1)
  .max(59)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u)
  .refine((value) => !value.includes("--") && value.split("-").length - 1 <= 4, "invalid handle");

export const createInitialProjectInput = z
  .strictObject({
    organizationId: ulid,
    projectId: ulid,
    billingEpochId: ulid,
    principalId: z.string().trim().min(1),
    projectName: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value === value.trim(), "project name must be trimmed"),
    projectHandle: handle,
    projectHandleVersion: z.string().min(1),
    projectHandleAttempt: z.number().int().min(0).max(31),
    dataMode: z.enum(["shared", "isolated"]).default("shared"),
    includeDevelopmentEnvironment: z.boolean().default(true),
    devAccessMode: z.enum(["protected", "public"]).default("protected"),
    region: z.enum(["us", "eu"]),
    createdEventId: ulid,
    createdAt: instant,
    developmentEnvironmentId: ulid,
    productionEnvironmentId: ulid,
    /** One data environment for a shared project, two distinct ones for an isolated project. */
    developmentDataEnvironmentId: ulid,
    productionDataEnvironmentId: ulid,
    operation: z.strictObject({ operationId: ulid, eventId: ulid }),
    audit: auditRecordInput,
    outbox: outboxRecordInput,
  })
  .superRefine((value, context) => {
    const sameData = value.developmentDataEnvironmentId === value.productionDataEnvironmentId;
    if (value.includeDevelopmentEnvironment && sameData !== (value.dataMode === "shared")) {
      context.addIssue({
        code: "custom",
        message: "data mode must match the data environment ids",
      });
    }
    if (value.developmentEnvironmentId === value.productionEnvironmentId) {
      context.addIssue({ code: "custom", message: "environment ids must differ" });
    }
    if (
      value.audit.projectId !== value.projectId ||
      value.audit.operationId !== value.operation.operationId ||
      (value.audit.billingEpochId !== null && value.audit.billingEpochId !== value.billingEpochId)
    ) {
      context.addIssue({
        code: "custom",
        message: "audit event must share the project operation scope",
      });
    }
  });

export type CreateInitialProjectInput = z.input<typeof createInitialProjectInput>;
export type Input = z.output<typeof createInitialProjectInput>;

export interface CreateInitialProjectResult {
  readonly outcome: "created" | "existing";
  readonly projectId: string;
  readonly operationId: string;
}

export interface DirectoryClaim {
  readonly project_id: string;
  readonly organization_id: string;
  readonly handle: string;
  readonly state: "reserved" | "active" | "deleting" | "deleted";
}

/** A handle a rename gave up: another organization may claim it only once `quarantined_until` has passed. */
export interface HandleRelease {
  readonly organization_id: string;
  readonly quarantined_until: string;
}

/** What the core knows in ONE snapshot: the Directory claim, the project scope row, its tombstone, the organization. */
interface CoreSnapshot {
  readonly claims: readonly DirectoryClaim[];
  readonly releases: readonly HandleRelease[];
  readonly project: {
    readonly name: string;
    readonly handle: string;
    readonly handle_version: string;
    readonly handle_attempt: number;
    readonly created_event_id: string;
    readonly created_at: string;
    readonly region: string;
    readonly data_mode: string;
    readonly dev_access_mode: string;
    readonly organization_id: string;
    readonly active_billing_epoch_id: string;
  } | null;
  readonly aborted: boolean;
  readonly organizationLive: boolean;
}

/**
 * The Directory claim of a project id and its globally unique handle, classified from the one snapshot: another
 * project owns the handle, the id is claimed with another owner or handle, or the project was deleted (its id and
 * handle are never reused). Pure: the claim and the project commit in ONE batch, so there is no reservation to expire.
 */
export function claimRefusal(
  claims: readonly DirectoryClaim[],
  input: Input,
  releases: readonly HandleRelease[],
): Error | null {
  const own = claims.find((row) => row.project_id === input.projectId);
  if (
    claims.some((row) => row.project_id !== input.projectId) ||
    releases.some(
      (row) =>
        row.organization_id !== input.organizationId && row.quarantined_until > input.createdAt,
    )
  ) {
    return conflict(
      "project_handle_taken",
      "The project handle is already claimed by another project",
    );
  }
  if (
    own !== undefined &&
    (own.organization_id !== input.organizationId || own.handle !== input.projectHandle)
  ) {
    return conflict(
      "project_identity_conflict",
      "The project id is claimed with another owner or handle",
    );
  }
  if (own !== undefined && (own.state === "deleting" || own.state === "deleted")) {
    return conflict(
      "project_deleted",
      "The project was deleted; its id and handle are never reused",
    );
  }
  return null;
}

/** The pure statements of one initial project; the customer admission composes them with its receipt and recipe. */
export function coreStatements(
  db: D1Database,
  input: Input,
  operationCreatedAt: string = input.createdAt,
): D1PreparedStatement[] {
  const scope = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    operationId: input.operation.operationId,
    billingEpochId: input.billingEpochId,
  };
  const environment = (environmentId: string, name: string) =>
    db
      .prepare(
        "INSERT INTO environments(organization_id, environment_id, project_id, name, desired_state, head_version, dev_access_epoch, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '{}', 0, 0, ?5, ?5)",
      )
      .bind(input.organizationId, environmentId, input.projectId, name, input.createdAt);
  const dataEnvironment = (dataEnvironmentId: string) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, ?4)",
      )
      .bind(input.organizationId, input.projectId, dataEnvironmentId, input.createdAt);
  const assignment = (environmentId: string, dataEnvironmentId: string) =>
    db
      .prepare(
        "INSERT INTO environment_data_assignments(organization_id, environment_id, assignment_version, project_id, data_environment_id, assigned_at, operation_id) VALUES (?1, ?2, 1, ?3, ?4, ?5, NULL)",
      )
      .bind(
        input.organizationId,
        environmentId,
        input.projectId,
        dataEnvironmentId,
        input.createdAt,
      );
  return [
    organizationLiveGuard(db, input.organizationId),
    // The abort tombstone of a creation a resolver closed stays a fence: such a creation never commits afterwards.
    guard(
      db,
      "scope_inactive",
      "EXISTS (SELECT 1 FROM project_creation_aborts WHERE project_id = ?1)",
      [input.projectId],
    ),
    // The Directory claim, in the SAME batch as the project: it is active at once. A claim an older reservation left
    // behind for this exact project is activated; any other row keeps its owner and is caught by the guard below.
    guard(
      db,
      "precondition_changed",
      "EXISTS (SELECT 1 FROM project_handle_releases WHERE handle = ?1 AND organization_id <> ?2 AND quarantined_until > ?3)",
      [input.projectHandle, input.organizationId, input.createdAt],
    ),
    db
      .prepare(
        "INSERT INTO project_directory(project_id, organization_id, handle, state, reserved_until, created_at) VALUES (?1, ?2, ?3, 'active', NULL, ?4) ON CONFLICT (project_id) DO UPDATE SET state = 'active', reserved_until = NULL WHERE project_directory.organization_id = excluded.organization_id AND project_directory.handle = excluded.handle AND project_directory.state = 'reserved'",
      )
      .bind(input.projectId, input.organizationId, input.projectHandle, input.createdAt),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS (SELECT 1 FROM project_directory WHERE project_id = ?1 AND organization_id = ?2 AND handle = ?3 AND state = 'active')",
      [input.projectId, input.organizationId, input.projectHandle],
    ),
    db
      .prepare(
        "INSERT INTO projects(organization_id, project_id, created_organization_id, name, created_event_id, handle, handle_version, handle_attempt, lifecycle_state, lifecycle_version, owner_state, ownership_version, active_billing_epoch_id, data_mode, region, dev_access_mode, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, ?4, ?5, ?6, ?7, 'active', 1, 'active', 1, ?8, ?9, ?10, ?11, ?12, ?12)",
      )
      .bind(
        input.organizationId,
        input.projectId,
        input.projectName,
        input.createdEventId,
        input.projectHandle,
        input.projectHandleVersion,
        input.projectHandleAttempt,
        input.billingEpochId,
        input.dataMode,
        input.region,
        input.devAccessMode,
        input.createdAt,
      ),
    db
      .prepare(
        "INSERT INTO billing_epochs(organization_id, billing_epoch_id, project_id, started_at, created_by_principal_id) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .bind(
        input.organizationId,
        input.billingEpochId,
        input.projectId,
        input.createdAt,
        input.principalId,
      ),
    ...(input.includeDevelopmentEnvironment
      ? [environment(input.developmentEnvironmentId, "dev")]
      : []),
    environment(input.productionEnvironmentId, "prod"),
    ...(input.includeDevelopmentEnvironment
      ? [dataEnvironment(input.developmentDataEnvironmentId)]
      : []),
    dataEnvironment(input.productionDataEnvironmentId),
    ...(input.includeDevelopmentEnvironment
      ? [assignment(input.developmentEnvironmentId, input.developmentDataEnvironmentId)]
      : []),
    assignment(input.productionEnvironmentId, input.productionDataEnvironmentId),
    guard(
      db,
      "environment_set_invalid",
      "(SELECT count(*) FROM environments WHERE organization_id = ?1 AND project_id = ?2 AND name IN ('dev','prod')) <> ?3",
      [input.organizationId, input.projectId, input.includeDevelopmentEnvironment ? 2 : 1],
    ),
    ...queuedOperationStatements(db, scope, {
      eventId: input.operation.eventId,
      occurredAt: operationCreatedAt,
    }),
    auditStatement(db, input.organizationId, {
      ...input.audit,
      billingEpochId: input.billingEpochId,
    }),
    outboxStatement(db, scope, input.outbox),
    ownershipInvariantGuard(db, input.projectId),
  ];
}

/**
 * `ensureInitialProjectTransaction` as ONE core batch, the single PostgreSQL transaction it was: the Directory claim of
 * the project id and its globally unique handle, the project, its billing epoch, environments, data assignments, first
 * operation, audit and outbox event commit together or not at all, guarded by the organization and by the resolver's
 * tombstone. A late failure of any statement leaves no claim behind, so no reservation can block a handle.
 *
 * The decision reads the claim, the project, the tombstone and the organization in one snapshot. A claim, handle or
 * project that appears between the read and the write fails the batch's own guard or a UNIQUE constraint and is
 * classified again from the committed rows. The existing project is compared with the request field by field, so a
 * different request under the same id is a conflict.
 */
export async function createInitialProject(
  context: CatalogContext,
  rawInput: unknown,
): Promise<CreateInitialProjectResult> {
  const input = createInitialProjectInput.parse(rawInput);
  const core = await routeOrganization(context, input.organizationId);
  const result: CreateInitialProjectResult = {
    outcome: "created",
    projectId: input.projectId,
    operationId: input.operation.operationId,
  };
  const command: Command<CoreSnapshot, CreateInitialProjectResult> = {
    name: "projects.createInitialProject",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: [
      "projects",
      "operations",
      "audit_events",
      "outbox_events",
      "project_directory",
      "project_identities",
    ],
    read: async (reader) => {
      const [claims, project, aborted, organization, releases] = await reader.batch([
        reader
          .prepare(
            "SELECT project_id, organization_id, handle, state FROM project_directory WHERE project_id = ?1 OR handle = ?2",
          )
          .bind(input.projectId, input.projectHandle),
        reader
          .prepare(
            "SELECT name, handle, handle_version, handle_attempt, created_event_id, created_at, region, data_mode, dev_access_mode, organization_id, active_billing_epoch_id FROM projects WHERE project_id = ?1 AND created_organization_id = ?2 AND organization_id = ?2",
          )
          .bind(input.projectId, input.organizationId),
        reader
          .prepare("SELECT 1 AS aborted FROM project_creation_aborts WHERE project_id = ?1")
          .bind(input.projectId),
        reader
          .prepare(
            "SELECT 1 AS live FROM organizations WHERE organization_id = ?1 AND state <> 'deleted'",
          )
          .bind(input.organizationId),
        reader
          .prepare(
            "SELECT organization_id, quarantined_until FROM project_handle_releases WHERE handle = ?1",
          )
          .bind(input.projectHandle),
      ]);
      return {
        claims: rowsOf<DirectoryClaim>(claims),
        releases: rowsOf<HandleRelease>(releases),
        project: rowsOf<NonNullable<CoreSnapshot["project"]>>(project)[0] ?? null,
        aborted: rowsOf(aborted).length > 0,
        organizationLive: rowsOf(organization).length > 0,
      };
    },
    decide: ({ claims, releases, project, aborted, organizationLive }) => {
      const refusal = claimRefusal(claims, input, releases);
      if (refusal !== null) return { reject: refusal };
      if (project !== null) {
        const same =
          project.name === input.projectName &&
          project.handle === input.projectHandle &&
          project.handle_version === input.projectHandleVersion &&
          project.handle_attempt === input.projectHandleAttempt &&
          project.created_event_id === input.createdEventId &&
          project.created_at === input.createdAt &&
          project.region === input.region &&
          project.data_mode === input.dataMode &&
          project.dev_access_mode === input.devAccessMode &&
          project.organization_id === input.organizationId &&
          project.active_billing_epoch_id === input.billingEpochId;
        return same
          ? { replay: { ...result, outcome: "existing" } }
          : {
              reject: conflict(
                "project_identity_conflict",
                "Existing project does not match the request",
              ),
            };
      }
      if (aborted) {
        return {
          reject: conflict(
            "project_reservation_expired",
            "The project reservation expired and was closed",
          ),
        };
      }
      if (!organizationLive) {
        return { reject: conflict("organization_inactive", "The organization is not active") };
      }
      return { statements: coreStatements(core.db, input), result: () => result };
    },
  };
  const created = await runMapped(core.db, command, {
    scope_inactive: () =>
      conflict("project_reservation_expired", "The project reservation expired and was closed"),
    organization_inactive: () =>
      conflict("organization_inactive", "The organization is not active"),
  });
  // The doorbell is advisory and idempotent (the earliest due time wins): every attempt rings it again.
  await ringDoorbell(
    context.directory,
    "outbox",
    core.shardId,
    input.outbox.availableAt ?? input.outbox.createdAt,
  );
  return created;
}

export const resolveProjectReservationsInput = z.strictObject({
  now: instant,
  limit: z.number().int().min(1).max(100),
});

export interface ProjectReservationResolution {
  readonly activated: number;
  readonly released: number;
}

/**
 * Resolves expired reservations (a creator crashed or lost its response). For each: ask the owning shard to
 * close the creation in one batch that either finds the project (then the reservation is activated) or
 * writes the abort tombstone (then the reservation is released and the creator can never commit late).
 * Safe to run concurrently and repeatedly.
 */
export async function resolveProjectReservations(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ProjectReservationResolution> {
  const input = resolveProjectReservationsInput.parse(rawInput);
  const due = await context.directory
    .prepare(
      "SELECT project_id, organization_id FROM project_directory WHERE state = 'reserved' AND reserved_until <= ?1 ORDER BY reserved_until, project_id LIMIT ?2",
    )
    .bind(input.now, input.limit)
    .all<{ project_id: string; organization_id: string }>();
  let activated = 0;
  let released = 0;
  for (const reservation of due.results) {
    const shard = await routeOrganization(context, reservation.organization_id);
    // One batch: tombstone only when the project does not exist, then report what exists.
    const [, exists] = await shard.db.batch([
      shard.db
        .prepare(
          "INSERT OR IGNORE INTO project_creation_aborts(project_id, organization_id, aborted_at) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = ?2 AND project_id = ?1)",
        )
        .bind(reservation.project_id, reservation.organization_id, input.now),
      shard.db
        .prepare("SELECT 1 AS present FROM projects WHERE organization_id = ?1 AND project_id = ?2")
        .bind(reservation.organization_id, reservation.project_id),
    ]);
    if (rowsOf(exists).length > 0) {
      const done = await context.directory
        .prepare(
          "UPDATE project_directory SET state = 'active', reserved_until = NULL WHERE project_id = ?1 AND state = 'reserved'",
        )
        .bind(reservation.project_id)
        .run();
      activated += done.meta.changes;
    } else {
      const done = await context.directory
        .prepare(
          "DELETE FROM project_directory WHERE project_id = ?1 AND state = 'reserved' AND reserved_until <= ?2",
        )
        .bind(reservation.project_id, input.now)
        .run();
      released += done.meta.changes;
    }
  }
  return { activated, released };
}
