import { AUTHORIZATION_ACTIONS } from "@ohmyhost/platform";
import { z } from "zod";
import { ulid } from "../common.js";

/** The accepted credential ceiling, retained verbatim with the accepted work. */
export const authorizationRestrictionInput = z.strictObject({
  actions: z.array(z.enum(AUTHORIZATION_ACTIONS)).optional(),
  organizationIds: z.array(ulid).optional(),
  projectIds: z.array(ulid).optional(),
  mailDomainIds: z.array(ulid).optional(),
});
export const delegationActionInput = z.enum(AUTHORIZATION_ACTIONS);
