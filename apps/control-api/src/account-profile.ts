import type { AuthenticatedPrincipal } from "./contracts.js";
import { readBoundedText, type WorkosSessionStatusBinding } from "./workos-session-status.js";

export interface AccountProfileFacts {
  memberships: { id: string; workos_id: string; name: string }[];
  origin: { source: string | null; recordedAt: string } | null;
  workspace: { organization_id: string | null; source_id: string } | null;
}
export interface AccountProfilePersistence {
  read(userId: string, workosOrganizationIds: readonly string[]): Promise<AccountProfileFacts>;
  recordSource(
    userId: string,
    source: string | null,
    recordedAt: Date,
    utm?: Record<string, string>,
  ): Promise<void>;
}

/** Same AuthStatus validation and first-write semantics over a closed persistence port. */
export function createAccountProfilePortWithPersistence(
  persistence: AccountProfilePersistence,
  binding: WorkosSessionStatusBinding,
  now: () => Date,
) {
  async function read(principal: AuthenticatedPrincipal) {
    const userId = principal.actorId.slice(5);
    const response = await binding.fetch(
      new Request("https://auth-status.internal/user-profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId,
          sessionId: principal.credentialId.slice("workos_session:".length),
        }),
        signal: AbortSignal.timeout(10000),
      }),
    );
    if (!response.ok) throw Error("Profile unavailable");
    // The list holds up to the workspace limit of the provider profile, about thirty bytes per id.
    const user: unknown = JSON.parse(await readBoundedText(response, 65536));
    if (
      !user ||
      typeof user !== "object" ||
      !("user_id" in user) ||
      user.user_id !== userId ||
      !("name" in user) ||
      typeof user.name !== "string" ||
      user.name.length > 256 ||
      !("email" in user) ||
      typeof user.email !== "string" ||
      user.email.length > 254 ||
      !("email_verified" in user) ||
      typeof user.email_verified !== "boolean"
    )
      throw Error("Invalid profile");
    if (
      !("workos_organization_ids" in user) ||
      !Array.isArray(user.workos_organization_ids) ||
      !user.workos_organization_ids.every(
        (id) => typeof id === "string" && /^org_[A-Za-z0-9_]+$/u.test(id),
      )
    )
      throw Error("Invalid memberships");
    const { memberships, origin, workspace } = await persistence.read(
      userId,
      user.workos_organization_ids,
    );
    return {
      user_id: userId,
      name: user.name,
      email: user.email,
      email_verified: user.email_verified,
      organizations: memberships,
      organization_ids: memberships.map((x) => x.id),
      signup_source: origin?.source ?? workspace?.source_id ?? null,
      attributed_at: origin?.recordedAt ?? null,
      initial_workspace_id: workspace?.organization_id ?? null,
    };
  }
  return {
    read,
    async recordSource(
      principal: AuthenticatedPrincipal,
      source: string | null,
      utm?: Record<string, string>,
    ) {
      if (source !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(source))
        throw new TypeError("Invalid source");
      await persistence.recordSource(principal.actorId.slice(5), source, now(), utm);
      return read(principal);
    },
  };
}
