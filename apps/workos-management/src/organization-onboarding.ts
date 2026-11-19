import type {
  OrganizationOnboardingPersistence,
  OnboardingRequest,
} from "./onboarding-persistence.js";

import { readJson } from "./workos-readonly-transport.js";
import { OrganizationOnboardingError } from "./onboarding-error.js";

export { OrganizationOnboardingError };

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new OrganizationOnboardingError("service_unavailable");
  return value as Record<string, unknown>;
};

function parseRequest(value: unknown): OnboardingRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new OrganizationOnboardingError("invalid_request");
  const request = object(value);
  if (
    Object.keys(request)
      .filter((key) => key !== "initial")
      .sort()
      .join(",") !== "idempotencyKey,name,sessionId,signupSource,userId" ||
    (request["initial"] !== undefined && typeof request["initial"] !== "boolean") ||
    typeof request["signupSource"] !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(request["signupSource"]) ||
    typeof request["userId"] !== "string" ||
    !/^user_[A-Za-z0-9_]{1,123}$/u.test(request["userId"]) ||
    typeof request["sessionId"] !== "string" ||
    !/^session_[A-Za-z0-9_]{1,120}$/u.test(request["sessionId"]) ||
    typeof request["name"] !== "string" ||
    request["name"] !== request["name"].trim() ||
    request["name"].length < 1 ||
    request["name"].length > 128 ||
    [...request["name"]].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || point === 127;
    }) ||
    typeof request["idempotencyKey"] !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(request["idempotencyKey"])
  ) {
    throw new OrganizationOnboardingError("invalid_request");
  }
  return request as unknown as OnboardingRequest;
}

/** Private WorkOS boundary. The caller must authenticate this exact user/session before entry. */
export function createWorkosOrganizationOnboarding(input: {
  readonly credential: string;
  readonly fetcher: (request: Request) => Promise<Response>;
  readonly clock: { now(): Date };
  readonly ids: { next(): string };
  readonly persistence: OrganizationOnboardingPersistence;
}) {
  if (input.credential.length < 8) throw new TypeError("WorkOS credential is unavailable");
  const persistence = input.persistence;

  const requestProvider = async (path: string, body?: Record<string, unknown>) => {
    try {
      const response = await input.fetcher(
        new Request(`https://api.workos.com${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${input.credential}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        }),
      );
      if (response.status === 404 && body === undefined) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Provider request failed");
      }
      return object(await readJson(response, 65_536));
    } catch {
      throw new OrganizationOnboardingError("service_unavailable");
    }
  };

  const eligible = async (request: OnboardingRequest) => {
    if (
      !(await persistence.isSessionEligible({
        sessionId: request.sessionId,
        workosUserId: request.userId,
        workosOrganizationId: null,
        observedAt: input.clock.now().toISOString(),
      }))
    )
      throw new OrganizationOnboardingError("forbidden");
  };

  return {
    async profile(raw: unknown) {
      const value = object(raw);
      if (Object.keys(value).sort().join(",") !== "sessionId,userId")
        throw new OrganizationOnboardingError("invalid_request");
      const request = parseRequest({
        ...value,
        name: "Profile",
        signupSource: "profile",
        idempotencyKey: "profile",
      });
      await eligible(request);
      const user = await requestProvider(
        `/user_management/users/${encodeURIComponent(request.userId)}`,
      );
      if (
        !user ||
        user["id"] !== request.userId ||
        typeof user["email"] !== "string" ||
        user["email"].length > 254 ||
        typeof user["email_verified"] !== "boolean"
      )
        throw new OrganizationOnboardingError("service_unavailable");
      const name = [user["first_name"], user["last_name"]]
        .filter((x) => typeof x === "string")
        .join(" ")
        .slice(0, 256);
      // Every active membership is read page by page. A longer list fails closed: a truncated list would hide
      // workspaces from the portal and sign their sessions out.
      const workosIds: string[] = [];
      let after: string | null = null;
      for (let page = 0; ; page += 1) {
        if (page === 10) throw new OrganizationOnboardingError("service_unavailable");
        const query = new URLSearchParams({
          user_id: request.userId,
          statuses: "active",
          limit: "100",
        });
        if (after !== null) query.set("after", after);
        const memberships = await requestProvider(
          `/user_management/organization_memberships?${query}`,
        );
        if (!memberships || !Array.isArray(memberships["data"]) || memberships["data"].length > 100)
          throw new OrganizationOnboardingError("service_unavailable");
        for (const raw of memberships["data"]) {
          const m = object(raw);
          if (
            m["user_id"] !== request.userId ||
            m["status"] !== "active" ||
            typeof m["organization_id"] !== "string"
          )
            throw new OrganizationOnboardingError("service_unavailable");
          workosIds.push(m["organization_id"]);
        }
        const next = object(memberships["list_metadata"])["after"];
        if (next === null || next === undefined) break;
        if (typeof next !== "string" || next === after)
          throw new OrganizationOnboardingError("service_unavailable");
        after = next;
      }
      return {
        workos_organization_ids: workosIds,
        user_id: request.userId,
        name,
        email: user["email"],
        email_verified: user["email_verified"],
      };
    },
    async create(raw: unknown): Promise<{ id: string; name: string }> {
      let request = parseRequest(raw);
      await eligible(request);
      const prepared = await persistence.prepare({
        request,
        now: input.clock.now().toISOString(),
      });
      request = prepared.request;
      const row = prepared.row;

      let organization = await requestProvider(`/organizations/external_id/${row.request_id}`);
      if (organization === null) {
        if (row.workos_organization_id !== null) throw new OrganizationOnboardingError("forbidden");
        if (!(await persistence.claimOrganization(row.request_id, request.userId)))
          throw new OrganizationOnboardingError("service_unavailable");
        await eligible(request);
        organization = await requestProvider("/organizations", {
          name: request.name,
          external_id: row.request_id,
          metadata: { ohmyhost_creator: request.userId },
        });
      }
      const workosId = organization?.["id"];
      if (
        typeof workosId !== "string" ||
        !/^org_[A-Za-z0-9_]{1,124}$/u.test(workosId) ||
        organization?.["external_id"] !== row.request_id ||
        organization["name"] !== request.name ||
        object(organization["metadata"])["ohmyhost_creator"] !== request.userId ||
        (row.workos_organization_id !== null && row.workos_organization_id !== workosId)
      ) {
        throw new OrganizationOnboardingError("service_unavailable");
      }
      await persistence.recordOrganization(row.request_id, request.userId, workosId);

      const query = new URLSearchParams({
        organization_id: workosId,
        user_id: request.userId,
        statuses: "active,inactive,pending",
        limit: "2",
      });
      const page = await requestProvider(`/user_management/organization_memberships?${query}`);
      if (
        !page ||
        !Array.isArray(page["data"]) ||
        page["data"].length > 1 ||
        object(page["list_metadata"])["after"] !== null
      ) {
        throw new OrganizationOnboardingError("service_unavailable");
      }
      let membership = page["data"][0] === undefined ? null : object(page["data"][0]);
      if (membership === null) {
        if (!(await persistence.claimMembership(row.request_id, request.userId)))
          throw new OrganizationOnboardingError(
            row.organization_id === null ? "service_unavailable" : "forbidden",
          );
        await eligible(request);
        membership = await requestProvider("/user_management/organization_memberships", {
          organization_id: workosId,
          user_id: request.userId,
          role_slug: "admin",
        });
      }
      if (
        !membership ||
        membership["organization_id"] !== workosId ||
        membership["user_id"] !== request.userId ||
        membership["status"] !== "active" ||
        !Array.isArray(membership["roles"]) ||
        membership["roles"].length !== 1 ||
        object(membership["roles"][0])["slug"] !== "admin"
      ) {
        throw new OrganizationOnboardingError("forbidden");
      }
      const membershipUpdatedAt = membership["updated_at"];
      if (
        typeof membershipUpdatedAt !== "string" ||
        !Number.isFinite(Date.parse(membershipUpdatedAt))
      )
        throw new OrganizationOnboardingError("service_unavailable");
      await eligible(request);
      return persistence.complete({
        request,
        requestId: row.request_id,
        workosOrganizationId: workosId,
        membershipUpdatedAt,
        now: input.clock.now().toISOString(),
      });
    },
  };
}
