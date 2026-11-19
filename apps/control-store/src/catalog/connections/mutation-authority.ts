import { z } from "zod";
import { guard } from "../../guards.js";
import type { D1Database } from "../../d1-types.js";
import { handoffAuthorityInput, handoffEffectGuards } from "../identity/handoff-effect.js";
import { authorizationRestrictionInput } from "../identity/authorization-restriction.js";
import { restrictionAllows } from "../identity/operation-delegations.js";

export const mutationAuthority = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("api_key"),
    keyId: z.string().startsWith("api_key_").max(255),
    userId: z.string().regex(/^user_[A-Za-z0-9_]{1,123}$/u),
    workosOrganizationId: z.string().startsWith("org_").min(5).max(128),
    authorizationRestriction: authorizationRestrictionInput.optional(),
  }),
  z.strictObject({
    kind: z.literal("session"),
    sessionId: z.string().min(1).max(255),
    userId: z.string().regex(/^user_[A-Za-z0-9_]{1,123}$/u),
    workosOrganizationId: z.string().startsWith("org_").min(5).max(128).nullable(),
    tokenExpiresAt: z.number().int().positive(),
    authorizationRestriction: authorizationRestrictionInput.optional(),
  }),
  handoffAuthorityInput.extend({
    kind: z.literal("mcp"),
    action: z.literal("integrations:manage"),
  }),
]);

export function integrationMutationGuards(
  db: D1Database,
  i: {
    organizationId: string;
    principalId: string;
    projectId?: string;
    environmentId?: string;
    mutationAuthority: z.output<typeof mutationAuthority>;
  },
) {
  const scope = {
    organizationId: i.organizationId,
    ...(i.projectId === undefined ? {} : { projectId: i.projectId }),
    ...(i.environmentId === undefined ? {} : { environmentId: i.environmentId }),
    principalId: i.principalId,
    action: "integrations:manage" as const,
  };
  if (i.mutationAuthority.kind === "mcp") {
    const { grantId, clientId, consentHash, action, authorizationRestriction } =
      i.mutationAuthority;
    return handoffEffectGuards(db, {
      ...scope,
      authority: {
        grantId,
        clientId,
        consentHash,
        action,
        ...(authorizationRestriction === undefined ? {} : { authorizationRestriction }),
      },
    });
  }
  const key = i.mutationAuthority;
  const denied =
    i.principalId !== `user:${key.userId}` ||
    !restrictionAllows(key.authorizationRestriction, scope);
  if (key.kind === "session")
    return [
      guard(db, "consent_changed", denied ? "1" : "0"),
      guard(
        db,
        "consent_changed",
        "EXISTS(SELECT 1 FROM revocations WHERE (kind='user' AND resource_id=?1) OR (kind='session' AND resource_id=?2 AND workos_user_id=?1))",
        [key.userId, key.sessionId],
      ),
    ];
  return [
    guard(db, "consent_changed", denied ? "1" : "0"),
    guard(
      db,
      "consent_changed",
      "NOT EXISTS(SELECT 1 FROM organizations WHERE organization_id=?1 AND workos_organization_id=?2 AND state='active')",
      [i.organizationId, key.workosOrganizationId],
    ),
  ];
}
