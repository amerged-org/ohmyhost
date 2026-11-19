import { z } from "zod";
import { classifyFailure, guard } from "../../guards.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { canonicalAuthorizationGuard } from "../projects/customer-projects-access.js";
import { handoffAuthorityInput, handoffEffectGuards } from "./handoff-effect.js";
import { authorizeNativeMail } from "./native-auth-readiness.js";

const input = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  principalId: z.string().min(1).max(256),
  action: z.enum([
    "create-invite",
    "resend-invitation",
    "suspend",
    "reactivate",
    "delete",
    "revoke-sessions",
  ]),
  resourceId: z.string().uuid().nullable(),
  idempotencyKey: z.string().min(1).max(128),
  canonicalRequestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  delegation: handoffAuthorityInput.optional(),
});
type Mutation = z.output<typeof input>;
const fail = () => new Error("native_auth_user_acceptance_conflict");
function parse(raw: unknown): Mutation {
  const i = input.parse(raw);
  if ((i.action === "create-invite") !== (i.resourceId === null)) throw fail();
  return i;
}
const scopeValues = (i: Mutation) => [
  i.organizationId,
  i.projectId,
  i.environmentId,
  i.idempotencyKey,
];
const exactValues = (i: Mutation) => [
  ...scopeValues(i),
  i.principalId,
  i.action,
  i.resourceId,
  i.canonicalRequestDigest,
  i.delegation === undefined ? null : JSON.stringify(i.delegation),
];
const exact = `organization_id=?1 AND project_id=?2 AND environment_id=?3 AND idempotency_key=?4 AND principal_id=?5 AND action=?6 AND resource_id IS ?7 AND request_digest=?8 AND delegation IS ?9`;
const currentEpoch = `EXISTS(SELECT 1 FROM native_auth_realms realm WHERE realm.organization_id=native_auth_user_mutation_acceptances.organization_id AND realm.project_id=native_auth_user_mutation_acceptances.project_id AND realm.environment_id=native_auth_user_mutation_acceptances.environment_id AND realm.revocation_epoch=native_auth_user_mutation_acceptances.revocation_epoch)`;
function guards(db: Parameters<typeof guard>[0], i: Mutation) {
  const authority = {
    organizationId: i.organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
    principalId: i.principalId,
    action: "auth:manage" as const,
  };
  return [
    canonicalAuthorizationGuard(db, authority),
    ...(i.delegation === undefined
      ? []
      : handoffEffectGuards(db, { ...authority, authority: i.delegation })),
    guard(
      db,
      "consent_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_realms r JOIN projects p ON p.organization_id=r.organization_id AND p.project_id=r.project_id JOIN environments e ON e.organization_id=r.organization_id AND e.project_id=r.project_id AND e.environment_id=r.environment_id WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 AND p.owner_state='active' AND p.lifecycle_state='active')`,
      [i.organizationId, i.projectId, i.environmentId],
    ),
  ];
}
async function mailReady(context: CatalogContext, i: Mutation): Promise<boolean> {
  if (i.action !== "create-invite" && i.action !== "resend-invitation") return true;
  return (
    (await authorizeNativeMail(context, {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId: i.environmentId,
    })) !== null
  );
}

/** Commit only redacted metadata before the private Native user database can be mutated. */
export async function acceptNativeAuthUserMutation(context: CatalogContext, raw: unknown) {
  const i = parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  if (!(await mailReady(context, i))) throw fail();
  const result = await db
    .batch([
      ...guards(db, i),
      db
        .prepare(
          `INSERT INTO native_auth_user_mutation_acceptances(organization_id,project_id,environment_id,idempotency_key,principal_id,action,resource_id,request_digest,delegation,revocation_epoch,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,r.revocation_epoch,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') FROM native_auth_realms r WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 ON CONFLICT DO NOTHING RETURNING idempotency_key`,
        )
        .bind(...exactValues(i)),
      guard(
        db,
        "precondition_changed",
        `NOT EXISTS(SELECT 1 FROM native_auth_user_mutation_acceptances WHERE ${exact})`,
        exactValues(i),
      ),
      guard(
        db,
        "claim_lost",
        `NOT EXISTS(SELECT 1 FROM native_auth_user_mutation_acceptances WHERE ${exact} AND ${currentEpoch})`,
        exactValues(i),
      ),
    ])
    .catch((error: unknown) => {
      const failure = classifyFailure(error);
      if (failure.kind === "guard" && failure.code === "precondition_changed")
        throw new Error("idempotency_key_reused");
      if (failure.kind === "guard" && failure.code === "claim_lost")
        throw new Error("native_auth_operation_revoked");
      throw error;
    });
  if (!(await mailReady(context, i))) throw fail();
  return {
    outcome: (result.at(-3)?.results.length ? "accepted" : "replayed") as "accepted" | "replayed",
  };
}

/** Every private effect rechecks the exact accepted request, current Owner and delegated grant. */
export async function authorizeAcceptedNativeAuthUserMutation(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  if (!(await mailReady(context, i))) return false;
  await db.batch([
    ...guards(db, i),
    guard(
      db,
      "consent_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_user_mutation_acceptances WHERE ${exact} AND ${currentEpoch})`,
      exactValues(i),
    ),
  ]);
  return mailReady(context, i);
}
