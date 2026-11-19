import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { canonicalAuthorizationGuard } from "../projects/customer-projects-access.js";
import {
  authorizationRestrictionInput,
  delegationActionInput,
} from "./authorization-restriction.js";
import { activeGrantGuard } from "./mcp-sql.js";
import { restrictionAllows } from "./operation-delegations.js";

export const handoffAuthorityInput = z.strictObject({
  grantId: z.string().uuid(),
  clientId: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => !/[\s\p{Cc}]/u.test(value)),
  consentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  action: delegationActionInput,
  authorizationRestriction: authorizationRestrictionInput.optional(),
  secretSubmission: z
    .strictObject({ requestHash: z.string().regex(/^[a-f0-9]{64}$/u), id: z.ulid() })
    .optional(),
});
type Authority = z.output<typeof handoffAuthorityInput>;

/** Effect-time guards use only the authority captured in the consumed server-side handoff. */
export function handoffEffectGuards(
  db: D1Database,
  input: {
    organizationId: string;
    principalId: string;
    projectId?: string;
    environmentId?: string;
    secretName?: string;
    action: "secrets:write" | "sources:link" | "auth:read" | "auth:manage" | "integrations:manage";
    authority: Authority;
  },
) {
  const userId = input.principalId.startsWith("user:") ? input.principalId.slice(5) : "";
  if (
    !/^user_[A-Za-z0-9]+$/u.test(userId) ||
    input.authority.action !== input.action ||
    !restrictionAllows(input.authority.authorizationRestriction, input)
  ) {
    return [guard(db, "consent_changed", "1")];
  }
  return [
    guard(
      db,
      "consent_changed",
      "EXISTS (SELECT 1 FROM revocations WHERE kind='user' AND resource_id=?)",
      [userId],
    ),
    canonicalAuthorizationGuard(db, input),
    activeGrantGuard(
      db,
      {
        organizationId: input.organizationId,
        userId,
        clientId: input.authority.clientId,
        consentHash: input.authority.consentHash,
      },
      input.projectId ?? null,
      false,
      input.authority.grantId,
    ),
    ...(input.authority.secretSubmission
      ? [
          guard(
            db,
            "consent_changed",
            `NOT EXISTS(SELECT 1 FROM mcp_portal_handoffs h, json_each(h.secret_target,'$.names') n
             WHERE h.organization_id=?1 AND h.request_hash=?2 AND h.user_id=?3
             AND h.client_id=?4 AND h.consent_hash=?5 AND h.kind='secret'
             AND h.consumed_at IS NOT NULL AND h.outcome='secret_submitted'
             AND json_type(h.secret_target,'$.results') IS NULL
             AND json_extract(h.secret_target,'$.submissionId')=?6
             AND json_extract(h.secret_target,'$.projectId')=?7
             AND json_extract(h.secret_target,'$.environmentId')=?8 AND n.value=?9)`,
            [
              input.organizationId,
              input.authority.secretSubmission.requestHash,
              userId,
              input.authority.clientId,
              input.authority.consentHash,
              input.authority.secretSubmission.id,
              input.projectId ?? null,
              input.environmentId ?? null,
              input.secretName ?? null,
            ],
          ),
        ]
      : []),
  ];
}
