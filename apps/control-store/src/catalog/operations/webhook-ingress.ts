import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command, type Plan } from "../../run-command.js";
import { type CatalogContext, jsonRecord, sha256Hex, ulid } from "../common.js";
import {
  pendingBarrierCommand,
  recordMembershipBarrierInput,
  recordTerminalRevocationInput,
  shardBarrierCommand,
  terminalRevocationCommand,
} from "../identity/membership-state.js";
import { exactInstant } from "../identity/shared.js";
import { inboxRecordCommand, recordInboxEventInput, type RecordInboxEventResult } from "./inbox.js";

const record = z.strictObject({
  inboxEventId: ulid,
  externalEventId: z.string().min(1).max(512),
  eventType: z.string().min(1).max(256),
  payload: jsonRecord,
  bodyDigest: sha256Hex,
  receivedAt: exactInstant,
  maxAttempts: z.number().int().min(1).max(2_147_483_647),
});
const membership = recordMembershipBarrierInput.extend({ kind: z.literal("membership-barrier") });
const projection = z.union([membership, recordTerminalRevocationInput]);
const workosRecord = record.extend({
  signatureTimestamp: exactInstant,
  projection: projection.optional(),
});
const githubPayload = z
  .strictObject({
    schemaVersion: z.literal("github.push.v1"),
    installationId: z.number().int().positive().safe(),
    repositoryId: z.number().int().positive().safe(),
    repositoryFullName: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u),
    ref: z
      .string()
      .min(1)
      .max(1024)
      .startsWith("refs/")
      .refine((value) =>
        Array.from(value).every((character) => {
          const point = character.codePointAt(0) as number;
          return point > 31 && point !== 127;
        }),
      ),
    beforeCommitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .refine((value) => value !== "0".repeat(40))
      .nullable(),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .refine((value) => value !== "0".repeat(40))
      .nullable(),
    deleted: z.boolean(),
  })
  .refine((value) =>
    value.deleted
      ? value.beforeCommitSha !== null && value.commitSha === null
      : value.commitSha !== null,
  );
/** An installation event that withdraws access: ids only, no account or sender details. */
const githubInstallationPayload = z
  .strictObject({
    schemaVersion: z.literal("github.installation.v1"),
    action: z.enum(["deleted", "suspended", "repositories_removed"]),
    installationId: z.number().int().positive().safe(),
    removedRepositoryIds: z.array(z.number().int().positive().safe()).max(1000),
  })
  .refine((value) =>
    value.action === "repositories_removed"
      ? value.removedRepositoryIds.length > 0
      : value.removedRepositoryIds.length === 0,
  );
const githubRecord = record
  .extend({
    externalEventId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
    eventType: z.enum(["push", "installation", "installation_repositories"]),
    payload: z.union([githubPayload, githubInstallationPayload]),
  })
  .refine(
    (value) =>
      value.eventType === "push"
        ? "schemaVersion" in value.payload && value.payload.schemaVersion === "github.push.v1"
        : "schemaVersion" in value.payload &&
          value.payload.schemaVersion === "github.installation.v1" &&
          value.eventType ===
            (value.payload.action === "repositories_removed"
              ? "installation_repositories"
              : "installation"),
    "the event type and payload must describe the same GitHub event",
  );
const stripeRecord = z.strictObject({
  inboxEventId: ulid,
  receivedAt: exactInstant,
  event: z.strictObject({
    id: z.string().regex(/^evt_[A-Za-z0-9_]{1,128}$/u),
    type: z.string().regex(/^[a-z][a-z0-9_.]{1,100}$/u),
    objectId: z.string().regex(/^[A-Za-z0-9_]{1,256}$/u),
    accountId: z.string().regex(/^acct_[A-Za-z0-9_]{1,128}$/u),
    mode: z.enum(["test", "live"]),
  }),
});

type AuthPlan =
  | { readonly reject: Error }
  | { readonly replay: unknown }
  | { readonly statements: D1PreparedStatement[] };

/** Membership mapping is chosen by provider subject, and rechecked in the final inbox/projection batch. */
async function membershipPlan(db: D1Database, raw: z.output<typeof membership>): Promise<AuthPlan> {
  const input = {
    workosOrganizationId: raw.workosOrganizationId,
    workosUserId: raw.workosUserId,
    sourceEventId: raw.sourceEventId,
    eventCreatedAt: raw.eventCreatedAt,
  };
  const row = await db
    .prepare(
      `SELECT d.organization_id FROM org_directory d
    JOIN organizations o ON o.organization_id=d.organization_id
    WHERE d.workos_organization_id=?1`,
    )
    .bind(input.workosOrganizationId)
    .first<{ organization_id: string }>();
  const organizationId = row?.organization_id ?? null;
  const plan =
    organizationId === null
      ? await (async () => {
          const child = pendingBarrierCommand(db, input);
          return child.decide(await child.read(db));
        })()
      : await (async () => {
          const child = shardBarrierCommand(db, organizationId, input);
          return child.decide(await child.read(db));
        })();
  if ("reject" in plan) return plan;
  const mapping = guard(
    db,
    "precondition_changed",
    `(SELECT d.organization_id FROM org_directory d JOIN organizations o ON o.organization_id=d.organization_id WHERE d.workos_organization_id=?1) IS NOT ?2`,
    [input.workosOrganizationId, organizationId],
  );
  const fences =
    organizationId === null
      ? []
      : [
          guard(
            db,
            "precondition_changed",
            "EXISTS (SELECT 1 FROM organizations o JOIN bucket_fences f ON f.bucket=o.bucket WHERE o.organization_id=?1)",
            [organizationId],
          ),
        ];
  return {
    statements: [mapping, ...fences, ...("statements" in plan ? plan.statements : [])],
  };
}

function assertProjection(eventType: string, value: z.output<typeof projection> | undefined): void {
  const expected =
    eventType === "session.revoked"
      ? "session"
      : eventType === "user.deleted"
        ? "user"
        : eventType === "organization.deleted"
          ? "organization"
          : eventType === "organization_membership.updated" ||
              eventType === "organization_membership.deleted"
            ? "membership-barrier"
            : undefined;
  if (value?.kind !== expected)
    throw new TypeError("WorkOS event authentication projection is invalid");
}

export function createWebhookIngressCommands(context: CatalogContext) {
  const db = context.directory;
  return {
    async recordWorkosWebhook(raw: unknown): Promise<"created" | "existing"> {
      const input = workosRecord.parse(raw);
      assertProjection(input.eventType, input.projection);
      const { projection: auth, ...facts } = input;
      const inbox = inboxRecordCommand(
        db,
        recordInboxEventInput.parse({
          ...facts,
          provider: "workos",
          routing: { kind: "unscoped", routingKey: input.externalEventId },
          ...(input.eventType === "session.revoked" || input.eventType === "user.deleted"
            ? { acknowledgedAt: input.receivedAt }
            : {}),
        }),
        null,
      );
      // Every replay checks the projection too. A pre-existing inbox row alone is never proof that auth state exists.
      const command: Command<
        { inbox: Plan<RecordInboxEventResult>; auth?: AuthPlan },
        "created" | "existing"
      > = {
        name: "ingress.recordWorkosWebhook",
        input,
        retryOn: ["precondition_changed", "row_version_conflict"],
        naturalKeyTables: [
          "webhook_inbox",
          "inbox_unrouted",
          "revocations",
          "workos_membership_sync_barriers",
          "pending_membership_barriers",
        ],
        read: async (reader) => {
          const inboxPlan = inbox.decide(await inbox.read(reader));
          if (auth === undefined) return { inbox: inboxPlan };
          if (auth.kind === "membership-barrier")
            return { inbox: inboxPlan, auth: await membershipPlan(reader, auth) };
          const child = terminalRevocationCommand(reader, auth);
          return { inbox: inboxPlan, auth: child.decide(await child.read(reader)) };
        },
        decide: (state) => {
          if ("reject" in state.inbox) return state.inbox;
          if (state.auth !== undefined && "reject" in state.auth) return state.auth;
          const outcome = "replay" in state.inbox ? state.inbox.replay.outcome : "created";
          const statements = [
            ...("statements" in state.inbox ? state.inbox.statements : []),
            ...(state.auth !== undefined && "statements" in state.auth
              ? state.auth.statements
              : []),
          ];
          return statements.length === 0
            ? { replay: outcome }
            : { statements, result: () => outcome };
        },
      };
      return runCommand(db, command);
    },
    async recordGithubWebhook(raw: unknown): Promise<"created" | "existing"> {
      const input = githubRecord.parse(raw);
      return (
        await runCommand(
          db,
          inboxRecordCommand(
            db,
            recordInboxEventInput.parse({
              ...input,
              provider: "github",
              signatureTimestamp: null,
              routing: { kind: "unscoped", routingKey: input.externalEventId },
            }),
            null,
          ),
        )
      ).outcome;
    },
    async recordStripeWebhook(raw: unknown): Promise<"created" | "existing"> {
      const input = stripeRecord.parse(raw);
      const e = input.event;
      // The source Stripe helper hashes the minimized, ordered identity payload, never the raw signed request.
      const payload = {
        id: e.id,
        type: e.type,
        objectId: e.objectId,
        accountId: e.accountId,
        mode: e.mode,
      };
      const bytes = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload))),
      );
      const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return (
        await runCommand(
          db,
          inboxRecordCommand(
            db,
            recordInboxEventInput.parse({
              inboxEventId: input.inboxEventId,
              externalEventId: `${e.accountId}/${e.mode}/${e.id}`,
              eventType: e.type,
              payload,
              bodyDigest: digest,
              receivedAt: input.receivedAt,
              provider: "stripe",
              signatureTimestamp: null,
              maxAttempts: 10,
              routing: { kind: "unscoped", routingKey: e.accountId },
            }),
            null,
          ),
        )
      ).outcome;
    },
  };
}
