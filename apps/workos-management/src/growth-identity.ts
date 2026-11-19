import { readJson } from "./workos-readonly-transport.js";

const TYPES = [
  "user.created",
  "user.deleted",
  "authentication.magic_auth_succeeded",
  "authentication.oauth_succeeded",
  "authentication.password_succeeded",
  "authentication.passkey_succeeded",
  "authentication.sso_succeeded",
  "authentication.mfa_succeeded",
];
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("workos_growth_invalid");
  return value as Record<string, unknown>;
};

/** The provider credential and unminimized event payload never leave this worker. */
export function createGrowthIdentityReader(input: {
  credential: string;
  environment: "development" | "production";
  fetcher: (request: Request) => Promise<Response>;
}) {
  return {
    async readGrowthIdentityPage(page: { cursor: string | null; limit: number }) {
      if (
        !Number.isInteger(page.limit) ||
        page.limit < 1 ||
        page.limit > 200 ||
        (page.cursor !== null && !id(page.cursor))
      )
        throw new TypeError("invalid growth page");
      const url = new URL("https://api.workos.com/events");
      url.searchParams.set("events", TYPES.join(","));
      url.searchParams.set("limit", String(Math.min(page.limit, 100)));
      if (page.cursor) url.searchParams.set("after", page.cursor);
      const response = await input.fetcher(
        new Request(url, {
          headers: { authorization: `Bearer ${input.credential}` },
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        }),
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("workos_growth_unavailable");
      }
      const body = record(await readJson(response, 2_000_000));
      if (!Array.isArray(body["data"]) || body["data"].length > Math.min(page.limit, 100))
        throw new Error("workos_growth_invalid");
      const facts = [];
      let watermark: string | null = null;
      for (const raw of body["data"]) {
        const event = record(raw);
        const data = record(event["data"]);
        const eventId = event["id"];
        const name = event["event"];
        const time = event["created_at"];
        if (!id(eventId) || typeof time !== "string" || !Number.isFinite(Date.parse(time)))
          throw new Error("workos_growth_invalid");
        watermark = time;
        const eventName =
          name === "user.created"
            ? "account_created"
            : name === "user.deleted"
              ? "account_deleted"
              : typeof name === "string" &&
                  TYPES.includes(name) &&
                  name.startsWith("authentication.")
                ? "provider_auth_succeeded"
                : null;
        if (!eventName) continue;
        const account =
          name === "user.created" || name === "user.deleted" ? data["id"] : data["user_id"];
        const organization = null;
        if (!id(account) || !account.startsWith("user_")) throw new Error("workos_growth_invalid");
        facts.push({
          schema_version: 1 as const,
          event_id: eventId,
          event_name: eventName,
          outcome: "succeeded" as const,
          occurred_at: time,
          received_at: new Date().toISOString(),
          platform_environment: input.environment,
          producer: "workos" as const,
          evidence_kind: "event" as const,
          flow_id: null,
          account_id: account,
          organization_id: organization,
          project_id: null,
          operation_id: null,
          deployment_id: null,
          transport: "unknown" as const,
          client_class: "unknown" as const,
          client_class_trust: "unknown" as const,
          error_class: null,
          campaign_key: null,
          request_country: null,
        });
      }
      const metadata = record(body["list_metadata"]);
      const next = metadata["after"];
      if (next !== null && next !== undefined && (!id(next) || next === page.cursor))
        throw new Error("workos_growth_invalid");
      return { facts, next_cursor: next ?? null, source_watermark: watermark, history_floor: null };
    },
    async getGrowthIdentity(raw: { user_id: string }) {
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).join(",") !== "user_id" ||
        typeof raw.user_id !== "string" ||
        !/^user_[A-Za-z0-9_]{1,123}$/u.test(raw.user_id)
      )
        throw new TypeError("invalid growth identity request");
      const response = await input.fetcher(
        new Request(
          `https://api.workos.com/user_management/users/${encodeURIComponent(raw.user_id)}`,
          {
            headers: { authorization: `Bearer ${input.credential}`, accept: "application/json" },
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          },
        ),
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("workos_growth_unavailable");
      }
      const user = record(await readJson(response, 32_768));
      if (
        user["id"] !== raw.user_id ||
        typeof user["email"] !== "string" ||
        user["email"].length > 254 ||
        !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(user["email"]) ||
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(user["email"])
      )
        throw new Error("workos_growth_unavailable");
      const parts = [user["first_name"], user["last_name"]].filter(
        (part): part is string => typeof part === "string" && part.trim().length > 0,
      );
      if (parts.some((part) => part.length > 128 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(part)))
        throw new Error("workos_growth_unavailable");
      return {
        name: parts.length ? parts.map((part) => part.trim()).join(" ") : null,
        email: user["email"],
      };
    },
    async readGrowthUserSnapshotPage(page: { cursor: string | null; limit: number }) {
      if (
        !page ||
        !Number.isInteger(page.limit) ||
        page.limit < 1 ||
        page.limit > 200 ||
        (page.cursor !== null && !id(page.cursor))
      )
        throw new TypeError("invalid growth page");
      const url = new URL("https://api.workos.com/user_management/users");
      url.searchParams.set("limit", String(Math.min(page.limit, 100)));
      if (page.cursor) url.searchParams.set("after", page.cursor);
      const response = await input.fetcher(
        new Request(url, {
          headers: { authorization: `Bearer ${input.credential}` },
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        }),
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("workos_growth_unavailable");
      }
      const body = record(await readJson(response, 2_000_000));
      if (!Array.isArray(body["data"]) || body["data"].length > Math.min(page.limit, 100))
        throw new Error("workos_growth_invalid");
      const received = new Date().toISOString();
      const facts = body["data"].map((raw: unknown) => {
        const user = record(raw);
        const userId = user["id"];
        const created = user["created_at"];
        if (
          !id(userId) ||
          !userId.startsWith("user_") ||
          typeof created !== "string" ||
          !Number.isFinite(Date.parse(created))
        )
          throw new Error("workos_growth_invalid");
        return {
          schema_version: 1 as const,
          event_id: `snapshot:${userId}`,
          event_name: "account_created" as const,
          outcome: "succeeded" as const,
          occurred_at: created,
          received_at: received,
          platform_environment: input.environment,
          producer: "workos" as const,
          evidence_kind: "snapshot" as const,
          flow_id: null,
          account_id: userId,
          organization_id: null,
          project_id: null,
          operation_id: null,
          deployment_id: null,
          transport: "unknown" as const,
          client_class: "unknown" as const,
          client_class_trust: "unknown" as const,
          error_class: null,
          campaign_key: null,
          request_country: null,
        };
      });
      const metadata = record(body["list_metadata"]);
      const next = metadata["after"];
      if (next !== null && next !== undefined && (!id(next) || next === page.cursor))
        throw new Error("workos_growth_invalid");
      return { facts, next_cursor: next ?? null, source_watermark: null, history_floor: null };
    },
  };
}
