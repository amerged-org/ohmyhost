import { readJson } from "./workos-readonly-transport.js";

const USER_ID = /^user_[A-Za-z0-9_]{1,123}$/u;
const ORGANIZATION_ID = /^org_[A-Za-z0-9_]{1,124}$/u;
const INVALID_EMAIL_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export class CurrentIdentityError extends Error {
  constructor(public readonly code: "invalid_request" | "service_unavailable") {
    super(code);
    this.name = "CurrentIdentityError";
  }
}

export interface WorkosCurrentIdentity {
  readonly user_id: string | null;
  readonly email: string | null;
  readonly organizations: readonly { readonly workos_id: string; readonly name: string }[];
}

/** Private metadata read: Control supplies only the user and scope it has already authenticated. */
export function createWorkosCurrentIdentity(input: {
  readonly credential: string;
  readonly fetcher: (request: Request) => Promise<Response>;
}) {
  if (input.credential.length < 8) throw new Error("Current identity credential is unavailable");
  return {
    async read(raw: unknown): Promise<WorkosCurrentIdentity> {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new CurrentIdentityError("invalid_request");
      const value = raw as Record<string, unknown>;
      const userId = value["user_id"];
      const organizationIds = value["workos_organization_ids"];
      if (
        Object.keys(value).sort().join(",") !== "user_id,workos_organization_ids" ||
        !(userId === null || (typeof userId === "string" && USER_ID.test(userId))) ||
        !Array.isArray(organizationIds) ||
        organizationIds.length > 100 ||
        organizationIds.some((id) => typeof id !== "string" || !ORGANIZATION_ID.test(id)) ||
        new Set(organizationIds).size !== organizationIds.length
      )
        throw new CurrentIdentityError("invalid_request");
      try {
        const signal = AbortSignal.timeout(10_000);
        const readProvider = async (path: string, expectedId: string) => {
          const response = await input.fetcher(
            new Request(`https://api.workos.com${path}`, {
              headers: { authorization: `Bearer ${input.credential}`, accept: "application/json" },
              redirect: "manual",
              signal,
            }),
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new CurrentIdentityError("service_unavailable");
          }
          const result = await readJson(response, 32_768);
          if (
            !result ||
            typeof result !== "object" ||
            Array.isArray(result) ||
            !("id" in result) ||
            result.id !== expectedId
          )
            throw new CurrentIdentityError("service_unavailable");
          return result as Record<string, unknown>;
        };
        const user =
          userId === null
            ? null
            : await readProvider(`/user_management/users/${encodeURIComponent(userId)}`, userId);
        let email: string | null = null;
        if (user !== null) {
          const providerEmail = user["email"];
          if (
            typeof providerEmail !== "string" ||
            providerEmail.length > 254 ||
            INVALID_EMAIL_CHARACTER.test(providerEmail) ||
            !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(providerEmail)
          )
            throw new CurrentIdentityError("service_unavailable");
          email = providerEmail;
        }
        const organizations = await Promise.all(
          organizationIds.map(async (id: string) => {
            const organization = await readProvider(`/organizations/${encodeURIComponent(id)}`, id);
            const name = organization["name"];
            if (
              typeof name !== "string" ||
              name.length === 0 ||
              name !== name.trim() ||
              name.length > 128 ||
              [...name].some((character) => {
                const point = character.codePointAt(0) ?? 0;
                return point <= 31 || point === 127;
              })
            )
              throw new CurrentIdentityError("service_unavailable");
            return { workos_id: id, name };
          }),
        );
        return { user_id: userId, email, organizations };
      } catch {
        throw new CurrentIdentityError("service_unavailable");
      }
    },
  };
}
