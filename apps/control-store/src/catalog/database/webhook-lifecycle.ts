import { z } from "zod";
import { DATABASE_WEBHOOK_LIMIT } from "@ohmyhost/contracts/database-events";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { currentDataEnvironment } from "./authority.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const providerId = z.string().regex(/^whk_[a-z0-9]{20}$/u);
const scope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environment: z.enum(["dev", "prod"]),
  physicalEnvironmentId: ulid,
  providerProjectId: z.string().regex(/^prj_[a-z0-9]{20}$/u),
  databaseId: z.string().regex(/^[a-z][a-z0-9]{19}$/u),
  subscriptionId: ulid,
});
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const clock = z.string().datetime({ precision: 3 });
const activation = scope.extend({ generation, keyHash: hash, requestHash: hash, now: clock });
const begin = activation.extend({ providerIds: z.array(providerId).max(5000).nullable() });
const deletion = scope.extend({ generation, keyHash: hash, now: clock });
const sealed = activation.extend({
  providerId,
  ciphertext: z.string().regex(/^(?:[a-f0-9]{2}){17,5136}$/u),
  nonce: z.string().regex(/^[a-f0-9]{24}$/u),
  valueSha256: hash,
  keyVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const abort = activation.extend({
  providerId,
  confirmed: z.boolean(),
  reason: z.enum(["webhook_limit", "idempotency_key_reused"]),
});
type Scope = z.output<typeof scope>;
type State = "creating" | "active" | "deactivating" | "inactive";
export interface Head {
  generation: number;
  state: State;
  provider_id: string | null;
  physical_environment_id: string;
  provider_project_id: string;
  database_id: string;
}
export interface Receipt {
  subscription_id: string;
  generation: number;
  request_hash: string;
  key_hash: string;
  provider_id: string | null;
  ciphertext: string | null;
  nonce: string | null;
  value_sha256: string | null;
  key_version: number | null;
  delete_hash: string | null;
  abort_reason: "webhook_limit" | "idempotency_key_reused" | null;
  created_at: string;
}
export type Decision =
  | "absent"
  | "pending"
  | "idempotency_key_reused"
  | "webhook_limit"
  | "capacity_required";
export type Result = { outcome: Decision } | { outcome: "ok"; head: Head; receipt?: Receipt };
const values = (s: Scope) => [s.organizationId, s.projectId, s.environment, s.subscriptionId];
const targetValues = (s: Scope) => [
  s.organizationId,
  s.projectId,
  s.environment,
  s.physicalEnvironmentId,
  s.providerProjectId,
  s.databaseId,
];
const TARGET = `SELECT 1 FROM environments e JOIN projects p ON p.organization_id=e.organization_id AND p.project_id=e.project_id
 JOIN database_provider_target_heads h ON h.organization_id=e.organization_id AND h.project_id=e.project_id
   AND h.physical_environment_id=${currentDataEnvironment("e.organization_id", "e.project_id", "e.environment_id")} AND h.state='active'
 JOIN database_provider_target_revisions t ON t.organization_id=h.organization_id AND t.project_id=h.project_id
   AND t.physical_environment_id=h.physical_environment_id AND t.target_version=h.target_version
 WHERE e.organization_id=?1 AND e.project_id=?2 AND e.name=?3 AND p.owner_state='active' AND p.lifecycle_state='active'
 AND h.physical_environment_id=?4 AND t.provider='pgcf' AND t.provider_project_id=?5 AND t.database_id=?6`;
const HEAD = `SELECT generation,state,provider_id,physical_environment_id,provider_project_id,database_id FROM database_webhook_subscriptions
 WHERE organization_id=?1 AND project_id=?2 AND environment=?3 AND subscription_id=?4`;
const RECEIPT = `SELECT subscription_id,generation,lower(hex(request_sha256)) request_hash,lower(hex(request_key_sha256)) key_hash,
 provider_id,lower(hex(secret_ciphertext)) ciphertext,lower(hex(secret_nonce)) nonce,lower(hex(secret_sha256)) value_sha256,
 secret_key_version key_version,CASE WHEN delete_key_sha256 IS NULL THEN NULL ELSE lower(hex(delete_key_sha256)) END delete_hash,abort_reason,created_at
 FROM database_webhook_activation_receipts WHERE organization_id=?1 AND project_id=?2 AND environment=?3`;
const capacity = `SELECT json_array_length(?3)+COUNT(*) n FROM database_webhook_subscriptions
 WHERE provider_project_id=?1 AND database_id=?2 AND state IN('creating','active','deactivating')
 AND (provider_id IS NULL OR provider_id NOT IN (SELECT value FROM json_each(?3)))`;
const targetMatches = (head: Head, input: Scope) =>
  head.physical_environment_id === input.physicalEnvironmentId &&
  head.provider_project_id === input.providerProjectId &&
  head.database_id === input.databaseId;
const reply = (head: Head, receipt?: Receipt): Result => ({
  outcome: "ok",
  head,
  ...(receipt ? { receipt } : {}),
});
const fail = (outcome: Decision): Result => ({ outcome });
const targetGuard = (db: D1Database, input: Scope) =>
  guard(db, "precondition_changed", `NOT EXISTS(${TARGET})`, targetValues(input));

async function snapshot(
  db: D1Database,
  input: Scope,
  keyHash?: string,
  providerIds?: readonly string[],
  deleteHash?: string,
) {
  const statements = [
    db.prepare(TARGET).bind(...targetValues(input)),
    db.prepare(HEAD).bind(...values(input)),
    db
      .prepare(
        `${RECEIPT} AND subscription_id=?4 AND generation=(SELECT generation FROM database_webhook_subscriptions WHERE organization_id=?1 AND project_id=?2 AND environment=?3 AND subscription_id=?4)`,
      )
      .bind(...values(input)),
    db
      .prepare(`${RECEIPT} AND request_key_sha256=unhex(?4)`)
      .bind(input.organizationId, input.projectId, input.environment, keyHash ?? "00".repeat(32)),
    db
      .prepare(capacity)
      .bind(input.providerProjectId, input.databaseId, JSON.stringify(providerIds ?? [])),
    db
      .prepare(`${RECEIPT} AND delete_key_sha256=unhex(?4)`)
      .bind(
        input.organizationId,
        input.projectId,
        input.environment,
        deleteHash ?? "00".repeat(32),
      ),
  ];
  const rows = await db.batch(statements);
  return {
    target: (rows[0]?.results.length ?? 0) === 1,
    head: rows[1]?.results[0] as unknown as Head | undefined,
    receipt: rows[2]?.results[0] as unknown as Receipt | undefined,
    prior: rows[3]?.results[0] as unknown as Receipt | undefined,
    count: Number(rows[4]?.results[0]?.["n"]),
    deletePrior: rows[5]?.results[0] as unknown as Receipt | undefined,
  };
}
const valid = (s: Awaited<ReturnType<typeof snapshot>>, input: Scope) =>
  s.target && (!s.head || targetMatches(s.head, input));

/** Reserves an activation before PGCF I/O. Same-key replay is decided before the capacity check. */
export async function beginDatabaseWebhookActivation(
  context: CatalogContext,
  raw: unknown,
): Promise<Result> {
  const input = begin.parse(raw),
    db = (await routeOrganization(context, input.organizationId)).db;
  if (input.providerIds && new Set(input.providerIds).size !== input.providerIds.length)
    throw new TypeError("Invalid provider ids");
  return runCommand<Awaited<ReturnType<typeof snapshot>>, Result>(db, {
    name: "database.webhook.beginActivation",
    input,
    read: (r) => snapshot(r, input, input.keyHash, input.providerIds ?? undefined),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["database_webhook_subscriptions", "database_webhook_activation_receipts"],
    decide: (s) => {
      if (!valid(s, input)) return { replay: fail("absent") };
      if (s.prior) {
        if (
          s.prior.subscription_id !== input.subscriptionId ||
          s.prior.generation !== input.generation ||
          s.prior.request_hash !== input.requestHash
        )
          return { replay: fail("idempotency_key_reused") };
        if (
          !s.head ||
          s.head.generation !== input.generation ||
          !(
            ["creating", "active"].includes(s.head.state) ||
            (s.head.state === "deactivating" && s.prior.provider_id === null)
          )
        )
          return { replay: fail("idempotency_key_reused") };
        return { replay: reply(s.head, s.prior) };
      }
      if (s.head && s.head.state !== "inactive") return { replay: fail("pending") };
      if (
        (!s.head && input.generation !== 1) ||
        (s.head && input.generation !== s.head.generation + 1)
      )
        return { replay: fail("idempotency_key_reused") };
      if (input.providerIds === null) return { replay: fail("capacity_required") };
      if (s.count >= DATABASE_WEBHOOK_LIMIT) return { replay: fail("webhook_limit") };
      const previous = s.head;
      const head: Head = {
        generation: input.generation,
        state: "creating",
        provider_id: null,
        physical_environment_id: input.physicalEnvironmentId,
        provider_project_id: input.providerProjectId,
        database_id: input.databaseId,
      };
      return {
        statements: [
          targetGuard(db, input),
          guard(
            db,
            "precondition_changed",
            previous
              ? `NOT EXISTS(${HEAD} AND generation=?5 AND state='inactive')`
              : `EXISTS(${HEAD})`,
            previous ? [...values(input), previous.generation] : values(input),
          ),
          guard(db, "precondition_changed", `EXISTS(${RECEIPT} AND request_key_sha256=unhex(?4))`, [
            input.organizationId,
            input.projectId,
            input.environment,
            input.keyHash,
          ]),
          guard(db, "precondition_changed", `(${capacity})>=${DATABASE_WEBHOOK_LIMIT}`, [
            input.providerProjectId,
            input.databaseId,
            JSON.stringify(input.providerIds),
          ]),
          previous
            ? db
                .prepare(
                  "UPDATE database_webhook_subscriptions SET generation=?5,state='creating',provider_id=NULL,updated_at=?6 WHERE organization_id=?1 AND project_id=?2 AND environment=?3 AND subscription_id=?4",
                )
                .bind(...values(input), input.generation, input.now)
            : db
                .prepare(
                  "INSERT INTO database_webhook_subscriptions(organization_id,project_id,environment,subscription_id,physical_environment_id,provider_project_id,database_id,generation,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'creating',?9,?9)",
                )
                .bind(
                  ...values(input),
                  input.physicalEnvironmentId,
                  input.providerProjectId,
                  input.databaseId,
                  input.generation,
                  input.now,
                ),
          db
            .prepare(
              "INSERT INTO database_webhook_activation_receipts(organization_id,project_id,environment,subscription_id,generation,request_key_sha256,request_sha256,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,unhex(?6),unhex(?7),?8,?8)",
            )
            .bind(...values(input), input.generation, input.keyHash, input.requestHash, input.now),
        ],
        result: () => reply(head),
      };
    },
  });
}

/** Persists only a generation-bound encrypted secret before an activation can be acknowledged. */
export async function finishDatabaseWebhookActivation(
  context: CatalogContext,
  raw: unknown,
): Promise<Result> {
  const input = sealed.parse(raw),
    db = (await routeOrganization(context, input.organizationId)).db;
  return runCommand<Awaited<ReturnType<typeof snapshot>>, Result>(db, {
    name: "database.webhook.finishActivation",
    input,
    read: (r) => snapshot(r, input, input.keyHash),
    retryOn: ["precondition_changed"],
    decide: (s) => {
      if (!valid(s, input) || !s.head || !s.receipt) return { replay: fail("absent") };
      const r = s.receipt,
        head = s.head;
      if (
        s.head.generation !== input.generation ||
        r.key_hash !== input.keyHash ||
        r.request_hash !== input.requestHash
      )
        return { replay: fail("idempotency_key_reused") };
      if (s.head.state === "active") {
        if (r.provider_id !== input.providerId || r.value_sha256 !== input.valueSha256)
          throw new Error("webhook_provider_receipt_conflict");
        return { replay: reply(s.head, r) };
      }
      if (s.head.state !== "creating") return { replay: fail("idempotency_key_reused") };
      return {
        statements: [
          targetGuard(db, input),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(${HEAD} AND generation=?5 AND state='creating')`,
            [...values(input), input.generation],
          ),
          db
            .prepare(
              "UPDATE database_webhook_activation_receipts SET provider_id=?6,secret_ciphertext=unhex(?7),secret_nonce=unhex(?8),secret_sha256=unhex(?9),secret_key_version=?10,updated_at=?11 WHERE organization_id=?1 AND project_id=?2 AND environment=?3 AND subscription_id=?4 AND generation=?5 AND provider_id IS NULL",
            )
            .bind(
              ...values(input),
              input.generation,
              input.providerId,
              input.ciphertext,
              input.nonce,
              input.valueSha256,
              input.keyVersion,
              input.now,
            ),
          db
            .prepare(
              "UPDATE database_webhook_subscriptions SET state='active',provider_id=?6,updated_at=?7 WHERE organization_id=?1 AND project_id=?2 AND environment=?3 AND subscription_id=?4 AND generation=?5 AND state='creating'",
            )
            .bind(...values(input), input.generation, input.providerId, input.now),
        ],
        result: () =>
          reply(
            { ...head, state: "active", provider_id: input.providerId },
            {
              ...r,
              provider_id: input.providerId,
              ciphertext: input.ciphertext,
              nonce: input.nonce,
              value_sha256: input.valueSha256,
              key_version: input.keyVersion,
            },
          ),
      };
    },
  });
}

/** Fence an over-cap generation before provider deletion, then close it only after confirmed deletion. */
export async function abortDatabaseWebhookActivation(
  context: CatalogContext,
  raw: unknown,
): Promise<Result> {
  const input = abort.parse(raw),
    db = (await routeOrganization(context, input.organizationId)).db;
  return runCommand<Awaited<ReturnType<typeof snapshot>>, Result>(db, {
    name: "database.webhook.abortActivation",
    input,
    read: (r) => snapshot(r, input, input.keyHash),
    retryOn: ["precondition_changed"],
    decide: (s) => {
      if (!valid(s, input) || !s.head || !s.receipt) return { replay: fail("absent") };
      const head = s.head;
      if (
        s.head.generation !== input.generation ||
        s.receipt.key_hash !== input.keyHash ||
        s.receipt.request_hash !== input.requestHash
      )
        return { replay: fail("idempotency_key_reused") };
      if (s.receipt.provider_id !== null) return { replay: fail("pending") };
      if (s.receipt.abort_reason !== null && s.receipt.abort_reason !== input.reason)
        return { replay: fail("idempotency_key_reused") };
      if (input.confirmed && s.head.state === "inactive" && s.head.provider_id === input.providerId)
        return { replay: reply(s.head) };
      if (
        !input.confirmed &&
        s.head.state === "deactivating" &&
        s.head.provider_id === input.providerId
      )
        return { replay: reply(s.head) };
      if (
        input.confirmed
          ? s.head.state !== "deactivating" || s.head.provider_id !== input.providerId
          : s.head.state !== "creating"
      )
        return { replay: fail("pending") };
      const expected = input.confirmed ? "deactivating" : "creating",
        next = input.confirmed ? "inactive" : "deactivating";
      return {
        statements: [
          targetGuard(db, input),
          guard(db, "precondition_changed", `NOT EXISTS(${HEAD} AND generation=?5 AND state=?6)`, [
            ...values(input),
            input.generation,
            expected,
          ]),
          ...(!input.confirmed
            ? [
                db
                  .prepare(
                    "UPDATE database_webhook_activation_receipts SET abort_reason=?6,updated_at=?7 WHERE organization_id=?1 AND project_id=?2 AND environment=?3 AND subscription_id=?4 AND generation=?5 AND abort_reason IS NULL",
                  )
                  .bind(...values(input), input.generation, input.reason, input.now),
              ]
            : []),
          db
            .prepare(
              "UPDATE database_webhook_subscriptions SET state=?6,provider_id=?7,updated_at=?8 WHERE organization_id=?1 AND project_id=?2 AND environment=?3 AND subscription_id=?4 AND generation=?5 AND state=?9",
            )
            .bind(...values(input), input.generation, next, input.providerId, input.now, expected),
        ],
        result: () => reply({ ...head, state: next, provider_id: input.providerId }),
      };
    },
  });
}

/** A deletion is fenced before the provider call; activation cannot pass a deactivating generation. */
export async function beginDatabaseWebhookDeactivation(
  context: CatalogContext,
  raw: unknown,
): Promise<Result> {
  const input = deletion.parse(raw),
    db = (await routeOrganization(context, input.organizationId)).db;
  return runCommand<Awaited<ReturnType<typeof snapshot>>, Result>(db, {
    name: "database.webhook.beginDeactivation",
    input,
    read: (r) => snapshot(r, input, undefined, undefined, input.keyHash),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["database_webhook_activation_receipts"],
    decide: (s) => {
      if (!valid(s, input) || !s.head || !s.receipt) return { replay: fail("absent") };
      const head = s.head;
      if (
        s.deletePrior &&
        (s.deletePrior.subscription_id !== input.subscriptionId ||
          s.deletePrior.generation !== input.generation)
      )
        return { replay: fail("idempotency_key_reused") };
      if (s.head.generation !== input.generation) return { replay: fail("idempotency_key_reused") };
      if (s.head.state === "creating") return { replay: fail("pending") };
      if (s.head.state === "deactivating" || s.head.state === "inactive")
        return {
          replay:
            s.receipt.delete_hash === input.keyHash
              ? reply(s.head)
              : fail("idempotency_key_reused"),
        };
      return {
        statements: [
          targetGuard(db, input),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(${HEAD} AND generation=?5 AND state='active')`,
            [...values(input), input.generation],
          ),
          guard(db, "precondition_changed", `EXISTS(${RECEIPT} AND delete_key_sha256=unhex(?4))`, [
            input.organizationId,
            input.projectId,
            input.environment,
            input.keyHash,
          ]),
          db
            .prepare(
              "UPDATE database_webhook_activation_receipts SET delete_key_sha256=unhex(?6),updated_at=?7 WHERE organization_id=?1 AND project_id=?2 AND environment=?3 AND subscription_id=?4 AND generation=?5 AND delete_key_sha256 IS NULL",
            )
            .bind(...values(input), input.generation, input.keyHash, input.now),
          db
            .prepare(
              "UPDATE database_webhook_subscriptions SET state='deactivating',updated_at=?6 WHERE organization_id=?1 AND project_id=?2 AND environment=?3 AND subscription_id=?4 AND generation=?5 AND state='active'",
            )
            .bind(...values(input), input.generation, input.now),
        ],
        result: () => reply({ ...head, state: "deactivating" }),
      };
    },
  });
}

export async function finishDatabaseWebhookDeactivation(
  context: CatalogContext,
  raw: unknown,
): Promise<Result> {
  const input = deletion.parse(raw),
    db = (await routeOrganization(context, input.organizationId)).db;
  return runCommand<Awaited<ReturnType<typeof snapshot>>, Result>(db, {
    name: "database.webhook.finishDeactivation",
    input,
    read: (r) => snapshot(r, input),
    retryOn: ["precondition_changed"],
    decide: (s) => {
      if (!valid(s, input) || !s.head || !s.receipt) return { replay: fail("absent") };
      const head = s.head;
      if (s.head.generation !== input.generation || s.receipt.delete_hash !== input.keyHash)
        return { replay: fail("idempotency_key_reused") };
      if (s.head.state === "inactive") return { replay: reply(s.head) };
      if (s.head.state !== "deactivating") return { replay: fail("pending") };
      return {
        statements: [
          targetGuard(db, input),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(${HEAD} AND generation=?5 AND state='deactivating')`,
            [...values(input), input.generation],
          ),
          db
            .prepare(
              "UPDATE database_webhook_subscriptions SET state='inactive',updated_at=?6 WHERE organization_id=?1 AND project_id=?2 AND environment=?3 AND subscription_id=?4 AND generation=?5 AND state='deactivating'",
            )
            .bind(...values(input), input.generation, input.now),
        ],
        result: () => reply({ ...head, state: "inactive" }),
      };
    },
  });
}

/** Status never returns ciphertext, request digests, headers, or a signing secret. */
export async function readDatabaseWebhookSubscription(
  context: CatalogContext,
  raw: unknown,
): Promise<Result> {
  const input = scope.parse(raw),
    db = (await routeOrganization(context, input.organizationId)).db,
    s = await snapshot(db, input);
  return valid(s, input) && s.head ? reply(s.head) : fail("absent");
}
