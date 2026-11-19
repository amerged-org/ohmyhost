import { parseUlid } from "@ohmyhost/platform";
import { parseWorkosOrganizationSnapshot } from "@ohmyhost/workos-auth-contracts";
import { createWorkosReadOnlyBoundary, readJson } from "./workos-readonly-transport.js";

export interface CreditWarningPersistence {
  readScope(organizationId: string, exhaustedAt: string): Promise<string | null>;
  isOwner(organizationId: ReturnType<typeof parseUlid>, userId: string): Promise<boolean>;
}

/** Private prerequisite for credit notices; contacts never enter the public API or logs. */
export function createCreditWarningRecipients(input: {
  credential: string;
  fetcher: (request: Request) => Promise<Response>;
  clock: { now(): Date };
  persistence: CreditWarningPersistence;
}) {
  const fetcher = input.fetcher.bind(globalThis);
  const boundary = createWorkosReadOnlyBoundary({ secret: input.credential, fetcher });
  const readScope = input.persistence.readScope;
  const isOwner = input.persistence.isOwner;
  return {
    async resolve(raw: unknown) {
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(",") !== "exhaustedAt,organizationId"
      )
        throw new Error("credit_warning_invalid");
      const value = raw as Record<string, unknown>,
        organizationId = parseUlid(String(value["organizationId"])),
        exhaustedAt = value["exhaustedAt"];
      if (
        typeof exhaustedAt !== "string" ||
        !Number.isFinite(Date.parse(exhaustedAt)) ||
        new Date(exhaustedAt).toISOString() !== exhaustedAt ||
        Date.parse(exhaustedAt) > input.clock.now().getTime()
      )
        throw new Error("credit_warning_invalid");
      const empty = {
        organizationId,
        exhaustedAt,
        required: false,
        recipients: [] as { userId: string; email: string }[],
      };
      const workosId = await readScope(organizationId, exhaustedAt);
      if (!workosId) return empty;
      const rawSnapshot = await boundary.resolver.withWorkosManagementCredential((credential) =>
        boundary.transport.fetchCurrentOrganizationSnapshot(credential, workosId),
      );
      const snapshot = parseWorkosOrganizationSnapshot(rawSnapshot, input.clock.now());
      if (snapshot.organization.id !== workosId) throw new Error("credit_warning_scope_conflict");
      const owners = snapshot.memberships.filter(
        (m) =>
          m.status === "active" &&
          m.roles.length === 1 &&
          (m.roles[0] === "admin" || m.roles[0] === "owner"),
      );
      const recipients: { userId: string; email: string }[] = [];
      for (const owner of owners) {
        // The mail gateway accepts at most ten recipients. Stop once they are found, which also bounds the WorkOS reads.
        if (recipients.length === 10) break;
        if (
          !/^user_[A-Za-z0-9_]{1,128}$/u.test(owner.userId) ||
          !(await isOwner(organizationId, owner.userId))
        )
          continue;
        const response = await fetcher(
          new Request(
            `https://api.workos.com/user_management/users/${encodeURIComponent(owner.userId)}`,
            {
              headers: { authorization: `Bearer ${input.credential}`, accept: "application/json" },
              signal: AbortSignal.timeout(5000),
            },
          ),
        );
        if (!response.ok) throw new Error("credit_warning_recipient_unavailable");
        const user = (await readJson(response, 32768)) as Record<string, unknown>;
        if (
          !user ||
          user["id"] !== owner.userId ||
          user["object"] !== "user" ||
          typeof user["email_verified"] !== "boolean"
        )
          throw new Error("credit_warning_recipient_invalid");
        if (!user["email_verified"]) continue;
        const email = user["email"];
        if (
          typeof email !== "string" ||
          email.length > 254 ||
          email.includes("\0") ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
        )
          throw new Error("credit_warning_recipient_invalid");
        if (await isOwner(organizationId, owner.userId))
          recipients.push({ userId: owner.userId, email });
      }
      if ((await readScope(organizationId, exhaustedAt)) !== workosId) return empty;
      if (!recipients.length) throw new Error("credit_warning_no_verified_owner");
      return { organizationId, exhaustedAt, required: true, recipients };
    },
  };
}
