import { z } from "zod";
import type { D1Database, D1PreparedStatement, D1Result } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command, type Plan } from "../../run-command.js";
import { ulid, instant, routeOrganization, type CatalogContext } from "../common.js";
import { currentDataEnvironment } from "../database/authority.js";
export const scopeInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  dataEnvironmentId: ulid,
});
export type Scope = z.output<typeof scopeInput>;
export type Row = Record<string, unknown>;
export const digestInput = z.instanceof(Uint8Array).refine((v) => v.byteLength === 32);
export const hex = (v: Uint8Array) =>
  Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
export const clock = instant;
export const key = z
  .string()
  .refine(
    (v) =>
      new TextEncoder().encode(v).length <= 512 &&
      /^[A-Za-z0-9._/-]+$/u.test(v) &&
      v.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
  );
export const idempotency = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
export const contentType = z
  .string()
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u);
export class StorageGatewayConflictError extends Error {
  readonly code: string;
  constructor(code = "storage_gateway_conflict") {
    super(
      code === "storage_object_conflict"
        ? "Storage logical key has multiple historical physical files"
        : "Storage gateway request conflicts with durable state",
    );
    this.name = "StorageGatewayConflictError";
    this.code = code;
  }
}
export class StorageGatewayBindingChangedError extends Error {
  readonly code = "storage_binding_data_changed";
  constructor() {
    super("Storage deployment must be redeployed for its current data assignment");
    this.name = "StorageGatewayBindingChangedError";
  }
}
export class StorageGatewayDataChangeInProgressError extends Error {
  readonly code = "data_change_in_progress";
  constructor() {
    super("This environment's data change must finish before retrying storage");
    this.name = "StorageGatewayDataChangeInProgressError";
  }
}
export class StorageGatewayQuotaError extends Error {
  readonly code = "storage_gateway_quota_exceeded";
  constructor() {
    super("Storage gateway quota is exceeded");
    this.name = "StorageGatewayQuotaError";
  }
}
export class StorageErasureConflictError extends Error {
  readonly code = "storage_erasure_conflict";
  constructor() {
    super("Storage erasure conflicts with accepted deletion custody");
    this.name = "StorageErasureConflictError";
  }
}
export const dataAt = (org: string, project: string, environment: string) =>
  currentDataEnvironment(org, project, environment);
export const blocked = (org: string, project: string, environment: string) =>
  `EXISTS(SELECT 1 FROM product_command_intents intent JOIN operations operation USING(organization_id,project_id,operation_id) JOIN environments caller ON caller.organization_id=intent.organization_id AND caller.project_id=intent.project_id AND caller.environment_id=${environment} WHERE intent.organization_id=${org} AND intent.project_id=${project} AND intent.event_type='ProjectDataChangeRequestedV1' AND operation.state IN('queued','running') AND CASE WHEN json_type(intent.data_change_snapshot,'$.transition.redeployEnvironments')='array' THEN CASE WHEN json_array_length(json_extract(intent.data_change_snapshot,'$.transition.redeployEnvironments'))=1 AND json_extract(intent.data_change_snapshot,'$.transition.redeployEnvironments[0]')=CASE WHEN intent.data_change='isolate_dev_keeps_data' THEN 'prod' WHEN intent.data_change IN('isolate_prod_keeps_data','share_prod_keeps_data','reset_dev') THEN 'dev' ELSE NULL END THEN EXISTS(SELECT 1 FROM json_each(json_extract(intent.data_change_snapshot,'$.transition.redeployEnvironments')) wanted WHERE wanted.value=caller.name) ELSE 1 END ELSE 1 END)`;
const SCOPE = `SELECT ${dataAt("e.organization_id", "e.project_id", "e.environment_id")} data_environment_id,${blocked("e.organization_id", "e.project_id", "e.environment_id")} blocked FROM environments e JOIN projects p ON p.organization_id=e.organization_id AND p.project_id=e.project_id AND p.owner_state='active' AND p.lifecycle_state='active' WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?3`;
export const scopeValues = (s: Scope) => [
  s.organizationId,
  s.projectId,
  s.environmentId,
  s.dataEnvironmentId,
];
export function scopeGuard(db: D1Database, s: Scope): D1PreparedStatement {
  return guard(
    db,
    "precondition_changed",
    `NOT EXISTS(SELECT 1 FROM(${SCOPE}) scope WHERE scope.data_environment_id=?4 AND scope.blocked=0)`,
    scopeValues(s),
  );
}
export async function assertScope(db: D1Database, s: Scope) {
  const r = await db
    .prepare(SCOPE)
    .bind(...scopeValues(s).slice(0, 3))
    .first<{ data_environment_id: string | null; blocked: number }>();
  if (!r) throw new StorageGatewayConflictError();
  if (r.data_environment_id !== s.dataEnvironmentId) throw new StorageGatewayBindingChangedError();
  if (r.blocked) throw new StorageGatewayDataChangeInProgressError();
}
/** Read snapshots carry the SAME frozen-scope guard as the following effect, not a detached precheck. */
function scopedReader(db: D1Database, scope: Scope): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const batch = async (input: D1PreparedStatement[]) => {
    const inner = input.map((s) => {
      const value = originals.get(s);
      if (!value) throw new TypeError("Storage reader received foreign statement");
      return value;
    });
    try {
      return (await db.batch([scopeGuard(db, scope), ...inner])).slice(1);
    } catch (e) {
      await assertScope(db, scope);
      throw e;
    }
  };
  return {
    batch,
    prepare(sql) {
      const wrap = (inner: D1PreparedStatement): D1PreparedStatement => {
        const run = async () => (await batch([value]))[0] as D1Result;
        const value: D1PreparedStatement = {
          bind: (...args) => wrap(inner.bind(...args)),
          first: async <Row>() => ((await run()).results[0] as Row) ?? null,
          all: run as D1PreparedStatement["all"],
          run,
        };
        originals.set(value, inner);
        return value;
      };
      return wrap(db.prepare(sql));
    },
  };
}
/** A storage decision refuses or writes: every answer travels in a batch that starts with the frozen-scope guard. */
export type StoragePlan<Result> =
  | Extract<Plan<Result>, { readonly reject: Error }>
  | Extract<Plan<Result>, { readonly statements: D1PreparedStatement[] }>;
/** Every scoped read/effect includes frozen binding authority IN THE SAME native batch, never a lasting precheck. */
export async function runStorage<Snapshot, Result>(
  context: CatalogContext,
  rawScope: unknown,
  name: string,
  input: unknown,
  read: (db: D1Database) => Promise<Snapshot>,
  decide: (db: D1Database, snapshot: Snapshot) => StoragePlan<Result>,
  naturalKeyTables: readonly string[] = [],
): Promise<Result> {
  const scope = scopeInput.parse(rawScope),
    { db } = await routeOrganization(context, scope.organizationId);
  const command: Command<Snapshot, Result> = {
    name,
    input,
    naturalKeyTables,
    retryOn: ["precondition_changed"],
    read: async (r) => {
      await assertScope(r, scope);
      return read(scopedReader(r, scope));
    },
    decide: (s) => {
      const p = decide(db, s);
      return "reject" in p
        ? p
        : {
            ...p,
            statements: [scopeGuard(db, scope), ...p.statements],
            result: (r) => p.result(r.slice(1)),
          };
    },
  };
  return runCommand(db, command);
}
export const asDate = (v: unknown) => new Date(String(v));
export function objectRow(r: Row) {
  return {
    organizationId: String(r["organization_id"]),
    projectId: String(r["project_id"]),
    environmentId: String(r["environment_id"]),
    transferId: String(r["transfer_id"]),
    objectKey: String(r["object_key"]),
    contentType: String(r["content_type"]),
    size: Number(r["size"]),
    etag: String(r["etag"]),
    uploadedAt: asDate(r["uploaded_at"]),
    jurisdiction: r["jurisdiction"] as "eu" | "us",
    dataEnvironmentId: String(r["data_environment_id"]),
    physicalObjectKey: String(r["physical_object_key"]),
  };
}
