import { z } from "zod";
import type { AuthenticatedPrincipal } from "./contracts.js";
import { readBoundedText, type WorkosSessionStatusBinding } from "./workos-session-status.js";

const userIdSchema = z.string().regex(/^user_[A-Za-z0-9_]{1,123}$/u);
const workosIdSchema = z.string().regex(/^org_[A-Za-z0-9_]{1,124}$/u);
const safeText = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u;
const metadataSchema = z
  .object({
    user_id: userIdSchema.nullable(),
    email: z
      .string()
      .min(3)
      .max(254)
      .regex(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u)
      .regex(safeText)
      .nullable(),
    organizations: z
      .array(
        z
          .object({
            workos_id: workosIdSchema,
            name: z
              .string()
              .min(1)
              .max(128)
              .refine(
                (name) =>
                  name === name.trim() &&
                  [...name].every((character) => {
                    const point = character.codePointAt(0) ?? 0;
                    return point > 31 && point !== 127;
                  }),
              ),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

/** The same authenticated-scope and AuthStatus comparison over a fixed mapping read. */
export function createCurrentIdentityPortWithMappings(
  readMappings: (
    organizationIds: readonly string[],
  ) => Promise<readonly { organization_id: string; workos_organization_id: string }[]>,
  binding: WorkosSessionStatusBinding,
) {
  return {
    async read(principal: AuthenticatedPrincipal) {
      const userId =
        principal.authorizationPrincipal.kind === "user"
          ? userIdSchema.parse(principal.actorId.slice(5))
          : null;
      const organizationIds = [...principal.organizationIds].sort();
      const organizations: { id: string; name: string }[] = [];
      let email: string | null | undefined;
      // Both the mapping query and AuthStatus endpoint have a 100-item bound.
      // An empty batch is still needed to retrieve the user's email.
      for (let offset = 0; offset < Math.max(organizationIds.length, 1); offset += 100) {
        const batch = organizationIds.slice(offset, offset + 100);
        const mappings = await readMappings(batch);
        if (
          mappings.length !== batch.length ||
          mappings.some((row, index) => row.organization_id !== batch[index])
        )
          throw new Error("Identity scope is unavailable");
        const workosIds = mappings.map((row) => workosIdSchema.parse(row.workos_organization_id));
        const response = await binding.fetch(
          new Request("https://auth-status.internal/current-identity", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ user_id: userId, workos_organization_ids: workosIds }),
            signal: AbortSignal.timeout(10_000),
          }),
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Identity metadata is unavailable");
        }
        const metadata = metadataSchema.parse(JSON.parse(await readBoundedText(response, 65_536)));
        if (
          metadata.user_id !== userId ||
          (metadata.email === null) !== (userId === null) ||
          (email !== undefined && email !== metadata.email) ||
          metadata.organizations.length !== workosIds.length ||
          metadata.organizations.some(
            (organization, index) => organization.workos_id !== workosIds[index],
          )
        )
          throw new Error("Identity metadata does not match the authenticated scope");
        email = metadata.email;
        for (const [index, id] of batch.entries()) {
          const organization = metadata.organizations[index];
          if (organization === undefined) throw new Error("Identity metadata is incomplete");
          organizations.push({ id, name: organization.name });
        }
      }
      return { email: email ?? null, organizations };
    },
  };
}
