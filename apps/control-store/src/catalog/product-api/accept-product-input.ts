import { devShareRenewalInput } from "./data-changes.js";
import { z } from "zod";
import { parseProjectHandle } from "@ohmyhost/project-handles";
import { instant, ulid } from "../common.js";
import {
  authorizationRestrictionInput,
  delegationActionInput,
} from "../identity/authorization-restriction.js";
import { acceptApiOperationInput } from "../operations/accept-api-operation.js";
import { parseProjectDataChangeSnapshot } from "../provisioning/context-snapshots.js";

const binary = z.instanceof(Uint8Array).refine((v) => v.byteLength === 32);
const timestamp = z
  .string()
  .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const confirmation = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  issuedToPrincipalId: z.string().min(1),
  action: z.enum(["rollback", "promote", "delete", "data_change"]),
  targetDeploymentId: ulid.optional(),
  subjectEtag: z.string().min(1),
  tokenDigest: binary,
  consumedAt: timestamp,
});
const base = {
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  billingEpochId: ulid,
  operationId: ulid,
  operationEventId: ulid,
  auditEventId: ulid,
  outboxEventId: ulid,
  principalId: z.string().refine((v) => v.trim() !== ""),
  actorType: z.enum(["principal", "service"]).optional(),
  requestId: z.string(),
  httpMethod: z.enum(["POST", "PUT", "DELETE"]),
  routeTemplate: z.string().startsWith("/v1/"),
  idempotencyKey: z.string().refine((v) => v.trim() !== ""),
  canonicalRequestDigest: binary,
  occurredAt: timestamp,
  availableAt: timestamp.optional(),
  delegation: z
    .strictObject({
      grantId: z.string(),
      clientId: z.string(),
      consentHash: z.string(),
      action: delegationActionInput,
      authorizationRestriction: authorizationRestrictionInput.optional(),
    })
    .optional(),
};
const expected = { expectedEtag: z.string(), confirmation };
const input = z.discriminatedUnion("eventType", [
  z.strictObject({
    ...base,
    eventType: z.literal("SourceLinkRequestedV1"),
    installationId: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => v.trim() === v),
    repositoryOwner: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => v.trim() === v),
    repositoryName: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => v.trim() === v),
  }),
  z.strictObject({
    ...base,
    eventType: z.literal("DeploymentRequestedV1"),
    planId: ulid,
    planDigest: binary,
    deploymentId: ulid,
  }),
  z.strictObject({
    ...base,
    eventType: z.literal("DeploymentRollbackRequestedV1"),
    ...expected,
    deploymentId: ulid,
    targetDeploymentId: ulid,
    targetRevisionId: ulid,
    targetArtifactId: ulid,
    expectedHeadVersion: count,
    expectedDataEnvironmentId: ulid,
    expectedAssignmentVersion: count.min(1),
    expectedRegistrationVersion: count,
  }),
  z.strictObject({
    ...base,
    eventType: z.literal("DeploymentPromotionRequestedV1"),
    ...expected,
    deploymentId: ulid,
    sourceEnvironmentId: ulid,
    sourceDeploymentId: ulid,
    sourceRevisionId: ulid,
    sourceArtifactId: ulid,
    sourceArtifactDigest: binary,
    expectedSourceHeadVersion: count.min(1),
    expectedHeadVersion: count,
  }),
  z.strictObject({
    ...base,
    eventType: z.literal("ProjectHandleChangeRequestedV1"),
    expectedEtag: z.string(),
    requestedHandle: z.string().transform(parseProjectHandle),
  }),
  z.strictObject({
    ...base,
    eventType: z.literal("ProjectDataChangeRequestedV1"),
    devShareRenewal: devShareRenewalInput.optional(),
    ...expected,
    cleanupRunId: ulid,
    expectedProjectVersion: count.min(1),
    dataChange: z.enum([
      "isolate_prod_keeps_data",
      "isolate_dev_keeps_data",
      "share_prod_keeps_data",
      "reset_dev",
    ]),
    dataChangeSnapshot: z.unknown(),
    expectedEnvironmentHeads: z.unknown(),
    expectedRegistrationGenerations: z.unknown(),
  }),
  z.strictObject({
    ...base,
    eventType: z.literal("ProjectDeletionRequestedV1"),
    ...expected,
    cleanupRunId: ulid,
    expectedProjectVersion: count.min(1),
  }),
]);
const productHex = (value: Uint8Array) =>
  Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
export function parseApiProductAcceptance(raw: unknown) {
  const i = input.parse(raw);
  if (i.availableAt !== undefined && i.availableAt < i.occurredAt)
    throw new TypeError("API operation availability must not precede acceptance");
  if ("confirmation" in i) {
    const c = i.confirmation;
    const action =
      i.eventType === "DeploymentRollbackRequestedV1"
        ? "rollback"
        : i.eventType === "DeploymentPromotionRequestedV1"
          ? "promote"
          : i.eventType === "ProjectDeletionRequestedV1"
            ? "delete"
            : "data_change";
    const target =
      i.eventType === "DeploymentRollbackRequestedV1"
        ? i.targetDeploymentId
        : i.eventType === "DeploymentPromotionRequestedV1"
          ? i.sourceDeploymentId
          : undefined;
    if (
      c.organizationId !== i.organizationId ||
      c.projectId !== i.projectId ||
      c.action !== action ||
      c.subjectEtag !== i.expectedEtag ||
      c.targetDeploymentId !== target
    )
      throw new TypeError("Product action confirmation identity is invalid");
  }
  if (i.eventType === "DeploymentPromotionRequestedV1" && i.sourceEnvironmentId === i.environmentId)
    throw new TypeError("Promotion environments must differ");
  const snapshot =
    i.eventType === "ProjectDataChangeRequestedV1"
      ? parseProjectDataChangeSnapshot({
          transition: i.dataChangeSnapshot,
          environmentHeads: i.expectedEnvironmentHeads,
          registrationGenerations: i.expectedRegistrationGenerations,
        })
      : null;
  if (
    i.eventType === "ProjectDataChangeRequestedV1" &&
    snapshot?.transition.change !== i.dataChange
  )
    throw new Error("deployment_persistence_conflict");
  const c = "confirmation" in i ? i.confirmation : undefined;
  const parsed = acceptApiOperationInput.parse(
    Object.fromEntries([
      ...Object.keys(base)
        .filter((k) => k !== "canonicalRequestDigest")
        .map((k) => [k, Reflect.get(i, k)]),
      ["canonicalRequestDigest", productHex(i.canonicalRequestDigest)],
      ["eventType", i.eventType],
      ...(c === undefined
        ? []
        : [
            [
              "confirmation",
              {
                action: c.action,
                ...(c.targetDeploymentId === undefined
                  ? {}
                  : { targetDeploymentId: c.targetDeploymentId }),
                issuedToPrincipalId: c.issuedToPrincipalId,
                subjectEtag: c.subjectEtag,
                tokenDigest: productHex(c.tokenDigest),
                consumedAt: c.consumedAt,
              },
            ],
          ]),
    ]),
  );
  // Native stores the original identities; validation must not trim a legitimate request's key/principal.
  const accepted = {
    ...parsed,
    principalId: i.principalId,
    requestId: i.requestId,
    idempotencyKey: i.idempotencyKey,
  };
  return { input: i, base: accepted, snapshot, at: instant.parse(i.occurredAt) };
}
export type ApiProductAcceptance = ReturnType<typeof parseApiProductAcceptance>;
