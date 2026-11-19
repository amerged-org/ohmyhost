import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { authorizationRestrictionInput } from "../identity/authorization-restriction.js";
import { restrictionAllows } from "../identity/operation-delegations.js";

const user = z.string().regex(/^user_[A-Za-z0-9_]{1,123}$/u);
const org = z.string().startsWith("org_").min(5).max(128);
export const originatingCredential = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("api_key"),
    keyId: z.string().startsWith("api_key_").max(255),
    userId: user,
    workosOrganizationId: org,
    authorizationRestriction: authorizationRestrictionInput.optional(),
  }),
  z.strictObject({
    kind: z.literal("session"),
    sessionId: z.string().min(1).max(256),
    userId: user,
    workosOrganizationId: org.nullable(),
    tokenExpiresAt: z.number().int().positive(),
    authorizationRestriction: authorizationRestrictionInput.optional(),
  }),
]);
export type OriginatingCredential = z.output<typeof originatingCredential>;
/** Check captured identity, authorization ceiling and local terminal revocations in the effect's D1 batch. */
export function originatingCredentialGuards(
  db: D1Database,
  scope: { organizationId: string; principalId: string; credentialId?: string },
  raw: unknown,
) {
  const c = originatingCredential.parse(raw),
    credentialId = c.kind === "session" ? c.sessionId : c.keyId;
  const denied =
    scope.principalId !== `user:${c.userId}` ||
    (scope.credentialId !== undefined && scope.credentialId !== credentialId) ||
    !restrictionAllows(c.authorizationRestriction, {
      organizationId: scope.organizationId,
      action: "integrations:manage",
    });
  const checks = [guard(db, "consent_changed", denied ? "1" : "0")];
  // API keys are workspace-bound. A human session's selected organization is
  // context, retained for provider observation rather than a target-workspace ceiling.
  if (c.kind === "api_key")
    checks.push(
      guard(
        db,
        "consent_changed",
        "NOT EXISTS(SELECT 1 FROM organizations WHERE organization_id=?1 AND workos_organization_id=?2 AND state='active')",
        [scope.organizationId, c.workosOrganizationId],
      ),
    );
  if (c.kind === "session")
    checks.push(
      guard(
        db,
        "consent_changed",
        "EXISTS(SELECT 1 FROM revocations WHERE (kind='user' AND resource_id=?1) OR (kind='session' AND resource_id=?2 AND workos_user_id=?1))",
        [c.userId, c.sessionId],
      ),
    );
  return checks;
}
/** Every field of the credential except the token expiry, which a renewal is allowed to move. */
function withoutTokenExpiry(credential: OriginatingCredential): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(credential).filter(([key]) => key !== "tokenExpiresAt"));
}
/** Session identity survives token renewal; the captured expiry remains unchanged for provider observation. */
export function sameOriginatingCredential(
  left: OriginatingCredential | undefined,
  right: OriginatingCredential | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "session" && right.kind === "session")
    return JSON.stringify(withoutTokenExpiry(left)) === JSON.stringify(withoutTokenExpiry(right));
  return JSON.stringify(left) === JSON.stringify(right);
}
