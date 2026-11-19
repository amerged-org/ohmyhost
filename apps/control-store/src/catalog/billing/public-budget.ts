import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { generatedJsonb } from "../../jsonb-generated.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  addMilliseconds,
  hexBytes,
  routeOrganization,
  rowsOf,
  ulid,
  type CatalogContext,
} from "../common.js";
import { setProjectBudget } from "../credit/index.js";
import {
  readIdempotencyRecordStatement,
  storedIdempotencyRecord,
} from "../operations/idempotency.js";
import { OrganizationCreditError } from "./errors.js";
import {
  PROJECT_BUDGET_SELECT,
  publicBudgetBody,
  publicBudgetInput,
  type ProjectCreditRow,
} from "./public-reads.js";

const inputSchema = publicBudgetInput
  .extend({
    // Money is a JavaScript number in the credit core, exact up to 2^53 - 1 micro-credits (about 9 billion credits).
    amountMicros: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,15})$/u)
      .transform(Number)
      .refine(Number.isSafeInteger)
      .nullable(),
    mode: z.enum(["continue", "stop"]),
    principalId: z.string().min(1),
    requestId: z.string().min(1),
    idempotencyKey: z.string().min(1).max(255),
    canonicalRequestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    operationId: ulid,
    queuedEventId: ulid,
    succeededEventId: ulid,
    auditEventId: ulid,
  })
  .refine((input) => input.amountMicros !== null || input.mode === "continue", {
    message: "A project budget must explicitly continue or stop; removing it restores continue",
  });
type Input = z.output<typeof inputSchema>;
type Body = ReturnType<typeof publicBudgetBody>;
const ROUTE = "/v1/projects/{project_id}/credit-budget";
const keyOf = (input: Input) => ({ ...input, httpMethod: "PUT", routeTemplate: ROUTE });
const conflict = () => new OrganizationCreditError("credit_request_conflict");

interface ScopeRow {
  readonly org_state: string | null;
  readonly owner_state: string;
  readonly lifecycle_state: string;
  readonly ownership_version: number;
  readonly active_billing_epoch_id: string;
}

interface Snapshot {
  readonly scope: ScopeRow | undefined;
  readonly budget: ProjectCreditRow | undefined;
  readonly record: unknown;
}

function budgetCommand(
  db: D1Database,
  input: Input,
  keyReference: string,
): Command<Snapshot, Body> {
  return {
    name: "billing.configureProjectCreditBudget",
    input,
    naturalKeyTables: ["api_idempotency_records", "operations", "operation_events", "audit_events"],
    retryOn: ["precondition_changed"],
    read: async (reader) => {
      const [scope, budget, record] = await reader.batch([
        reader
          .prepare(
            `SELECT (SELECT state FROM organizations WHERE organization_id = ?1) AS org_state, owner_state, lifecycle_state,
               ownership_version, active_billing_epoch_id
             FROM projects WHERE organization_id = ?1 AND project_id = ?2`,
          )
          .bind(input.organizationId, input.projectId),
        reader.prepare(PROJECT_BUDGET_SELECT).bind(input.organizationId, input.projectId),
        readIdempotencyRecordStatement(reader, keyOf(input)),
      ]);
      return {
        scope: rowsOf<ScopeRow>(scope)[0],
        budget: rowsOf<ProjectCreditRow>(budget)[0],
        record: rowsOf(record)[0],
      };
    },
    decide: ({ scope, budget, record }) => {
      if (
        scope === undefined ||
        scope.org_state !== "active" ||
        scope.owner_state !== "active" ||
        scope.lifecycle_state !== "active"
      )
        return { reject: new OrganizationCreditError("organization_credit_scope_missing") };
      const original = storedIdempotencyRecord(record);
      if (original) {
        if (original.digestHex !== input.canonicalRequestDigest || !original.body)
          return { reject: conflict() };
        return { replay: original.body as Body };
      }
      const body = publicBudgetBody(input.projectId, input.now, budget, input);
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM projects p JOIN organizations o USING(organization_id)
            WHERE p.organization_id=?1 AND p.project_id=?2 AND p.active_billing_epoch_id=?3 AND p.ownership_version=?4
              AND p.owner_state='active' AND p.lifecycle_state='active' AND o.state='active')`,
            [
              input.organizationId,
              input.projectId,
              scope.active_billing_epoch_id,
              scope.ownership_version,
            ],
          ),
          ...setProjectBudget(db, {
            organizationId: input.organizationId,
            projectId: input.projectId,
            budgetMicros: input.amountMicros,
            mode: input.mode,
            now: input.now,
          }).statements,
          db
            .prepare(
              "INSERT INTO operations(organization_id,operation_id,project_id,state,created_at,updated_at,billing_epoch_id) VALUES(?1,?2,?3,'succeeded',?4,?4,?5)",
            )
            .bind(
              input.organizationId,
              input.operationId,
              input.projectId,
              input.now,
              scope.active_billing_epoch_id,
            ),
          db
            .prepare(
              `INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,payload,occurred_at)
            VALUES(?1,?2,?3,?4,0,'OperationQueued','{}',?5),(?1,?6,?3,?4,1,'OperationSucceeded','{}',?5)`,
            )
            .bind(
              input.organizationId,
              input.queuedEventId,
              input.operationId,
              input.projectId,
              input.now,
              input.succeededEventId,
            ),
          db
            .prepare(
              "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'ProjectCreditBudgetConfiguredV1','principal',?5,?6,?7,?8)",
            )
            .bind(
              input.organizationId,
              input.auditEventId,
              input.projectId,
              input.operationId,
              input.principalId,
              generatedJsonb({
                amount_micros: body.amount_micros,
                mode: body.mode,
                requestId: input.requestId,
                idempotencyKeyReference: keyReference,
              }),
              input.now,
              scope.active_billing_epoch_id,
            ),
          db
            .prepare(
              `INSERT INTO api_idempotency_records(organization_id,principal_id,http_method,route_template,idempotency_key,
            canonical_request_sha256,canonicalization_version,request_id,operation_id,http_status,response_headers,response_body,created_at,completed_at,expires_at)
            VALUES(?1,?2,'PUT',?3,?4,?5,'rfc8785-v1',?6,?7,200,'{}',?8,?9,?9,?10)`,
            )
            .bind(
              input.organizationId,
              input.principalId,
              ROUTE,
              input.idempotencyKey,
              hexBytes(input.canonicalRequestDigest),
              input.requestId,
              input.operationId,
              generatedJsonb(body),
              input.now,
              addMilliseconds(input.now, 86_400_000),
            ),
        ],
        result: () => body,
      };
    },
  };
}

/** One guarded batch of the budget, its operation, its audit event and its idempotency receipt; a replay answers the first body. */
export async function configureProjectCreditBudget(
  context: CatalogContext,
  raw: unknown,
): Promise<Body> {
  const input = inputSchema.parse(raw),
    digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.idempotencyKey)),
    ),
    keyReference =
      "sha256:" + Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    db = (await routeOrganization(context, input.organizationId)).db,
    command = budgetCommand(db, input, keyReference);
  return runCommand(db, {
    ...command,
    // A lost response is answered from the committed receipt: decide again and return only a replay.
    lookup: async (database) => {
      const plan = command.decide(await command.read(database));
      return "replay" in plan ? plan.replay : undefined;
    },
  });
}
