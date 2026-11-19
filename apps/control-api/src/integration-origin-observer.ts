import { z } from "zod";
import { AUTHORIZATION_ACTIONS, parseUlid, restrictionAllows } from "@ohmyhost/platform";
import { parseWorkosSessionStatusRequest } from "@ohmyhost/workos-auth-contracts";
import type { WorkosSessionStatusPort } from "./workos-session-status.js";
import type { WorkosUserApiKeyStatusPort } from "./workos-user-api-keys.js";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/\p{Cc}/u.test(value));
const restriction = z.strictObject({
  actions: z.array(z.enum(AUTHORIZATION_ACTIONS)).optional(),
  organizationIds: z.array(identifier.transform(parseUlid)).optional(),
  projectIds: z.array(identifier.transform(parseUlid)).optional(),
  mailDomainIds: z.array(identifier.transform(parseUlid)).optional(),
});
const keyAuthority = z.strictObject({
  kind: z.literal("api_key"),
  keyId: z.string().regex(/^api_key_[A-Za-z0-9_]{1,120}$/u),
  userId: z.string().regex(/^user_[A-Za-z0-9_]{1,123}$/u),
  workosOrganizationId: z.string().regex(/^org_[A-Za-z0-9_]{1,124}$/u),
  authorizationRestriction: restriction.optional(),
});
const sessionAuthority = z.strictObject({
  kind: z.literal("session"),
  sessionId: identifier,
  userId: z.string().regex(/^user_[A-Za-z0-9_]{1,123}$/u),
  workosOrganizationId: z
    .string()
    .regex(/^org_[A-Za-z0-9_]{1,124}$/u)
    .nullable(),
  tokenExpiresAt: z.number().int().positive(),
  authorizationRestriction: restriction.optional(),
});
const mutationAuthority = z.discriminatedUnion("kind", [
  keyAuthority,
  sessionAuthority,
  z.strictObject({
    kind: z.literal("mcp"),
    grantId: z.string().uuid(),
    clientId: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => !/[\s\p{Cc}]/u.test(value)),
    consentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    action: z.literal("integrations:manage"),
    authorizationRestriction: restriction.optional(),
  }),
]);
const mutationCommon = {
  organizationId: identifier.transform(parseUlid),
  principalId: z.string().regex(/^user:user_[A-Za-z0-9_]{1,123}$/u),
  mutationAuthority,
};
const mutation = z.discriminatedUnion("resourceKind", [
  z.strictObject({ ...mutationCommon, resourceKind: z.literal("organization") }),
  z.strictObject({
    ...mutationCommon,
    resourceKind: z.literal("project"),
    projectId: identifier.transform(parseUlid),
    environmentId: identifier.transform(parseUlid),
  }),
]);
/** Reobserve the originally accepted key; a browser session never substitutes for it. */
export async function observeIntegrationApiKey(
  input: {
    readonly originatingApiKey: {
      readonly keyId: string;
      readonly userId: string;
      readonly workosOrganizationId: string;
      readonly authorizationRestriction?: import("@ohmyhost/platform").AuthorizationRestriction;
    };
    readonly organizationId: string;
    readonly principalId: string;
  },
  dependencies: { readonly apiKeyStatus: WorkosUserApiKeyStatusPort; readonly now: () => Date },
): Promise<void> {
  const origin = input.originatingApiKey;
  if (
    input.principalId !== `user:${origin.userId}` ||
    !restrictionAllows(
      origin.authorizationRestriction,
      { kind: "organization", organizationId: parseUlid(input.organizationId) },
      "integrations:manage",
    )
  )
    throw new Error("integration_origin_denied");
  const current = await dependencies.apiKeyStatus.observe({
    keyId: origin.keyId,
    userId: origin.userId,
    organizationId: origin.workosOrganizationId,
  });
  if (
    current === null ||
    current.id !== origin.keyId ||
    current.userId !== origin.userId ||
    current.organizationId !== origin.workosOrganizationId ||
    !current.permissions.includes("integrations:manage") ||
    (current.expiresAt !== null && !(Date.parse(current.expiresAt) > dependencies.now().getTime()))
  )
    throw new Error("integration_origin_denied");
}

export type IntegrationMutationObservation = z.input<typeof mutation>;
const origin = z
  .strictObject({
    organizationId: identifier,
    projectId: identifier.transform(parseUlid).optional(),
    environmentId: identifier.transform(parseUlid).optional(),
    principalId: z.string().regex(/^user:user_[A-Za-z0-9_]{1,123}$/u),
    sessionId: identifier,
    browserSession: z.unknown(),
    originatingDelegation: z.unknown().optional(),
    originatingCredential: z
      .discriminatedUnion("kind", [keyAuthority, sessionAuthority])
      .optional(),
  })
  .refine((input) => (input.projectId === undefined) === (input.environmentId === undefined));

/** Observe captured identities through private WorkOS capabilities; Core owns effect-time authority. */
export function createIntegrationOriginObserver(dependencies: {
  readonly sessionStatus: WorkosSessionStatusPort;
  readonly apiKeyStatus: WorkosUserApiKeyStatusPort;
  readonly resolveOrganization: (workosOrganizationId: string) => Promise<string | null>;
  readonly now: () => Date;
}) {
  return {
    /** The Core separately checks current human roles and MCP proof in the mutation transaction. */
    async observeIntegrationMutation(raw: unknown): Promise<void> {
      const input = mutation.parse(raw),
        authority = input.mutationAuthority;
      const resource =
        input.resourceKind === "organization"
          ? { kind: "organization" as const, organizationId: input.organizationId }
          : {
              kind: "project" as const,
              organizationId: input.organizationId,
              projectId: input.projectId,
              environmentId: input.environmentId,
            };
      if (!restrictionAllows(authority.authorizationRestriction, resource, "integrations:manage"))
        throw new Error("integration_mutation_denied");
      if (authority.kind === "mcp") return;
      if (authority.kind === "session") {
        if (
          input.principalId !== `user:${authority.userId}` ||
          !(await dependencies.sessionStatus.isActive({
            sessionId: authority.sessionId,
            userId: authority.userId,
            organizationId: authority.workosOrganizationId,
            tokenExpiresAt: authority.tokenExpiresAt,
          }))
        )
          throw new Error("integration_mutation_denied");
        return;
      }
      if (
        input.principalId !== `user:${authority.userId}` ||
        (await dependencies.resolveOrganization(authority.workosOrganizationId)) !==
          input.organizationId
      )
        throw new Error("integration_mutation_denied");
      const current = await dependencies.apiKeyStatus.observe({
        keyId: authority.keyId,
        userId: authority.userId,
        organizationId: authority.workosOrganizationId,
      });
      if (
        current === null ||
        current.id !== authority.keyId ||
        current.userId !== authority.userId ||
        current.organizationId !== authority.workosOrganizationId ||
        !current.permissions.includes("integrations:manage") ||
        (current.expiresAt !== null &&
          !(Date.parse(current.expiresAt) > dependencies.now().getTime()))
      )
        throw new Error("integration_mutation_denied");
    },
    async observeConnectionOrigin(raw: unknown): Promise<void> {
      const input = origin.parse(raw);
      parseUlid(input.organizationId);
      const browser = parseWorkosSessionStatusRequest(input.browserSession);
      if (
        input.principalId !== `user:${browser.userId}` ||
        input.sessionId !== browser.sessionId ||
        !(await dependencies.sessionStatus.isActive(browser))
      )
        throw new Error("integration_origin_denied");
      if (input.originatingCredential !== undefined) {
        const accepted = input.originatingCredential;
        if (accepted.kind === "session") {
          if (
            input.principalId !== `user:${accepted.userId}` ||
            !restrictionAllows(
              accepted.authorizationRestriction,
              { kind: "organization", organizationId: parseUlid(input.organizationId) },
              "integrations:manage",
            ) ||
            !(await dependencies.sessionStatus.isActive({
              sessionId: accepted.sessionId,
              userId: accepted.userId,
              organizationId: accepted.workosOrganizationId,
              tokenExpiresAt: accepted.tokenExpiresAt,
            }))
          )
            throw new Error("integration_origin_denied");
          return;
        }
        if (
          (await dependencies.resolveOrganization(accepted.workosOrganizationId)) !==
          input.organizationId
        )
          throw new Error("integration_origin_denied");
        await observeIntegrationApiKey(
          {
            organizationId: input.organizationId,
            principalId: input.principalId,
            originatingApiKey: accepted,
          },
          dependencies,
        );
      }
    },
  };
}
