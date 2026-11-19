import type { Dashboard, TimelinePage } from "./metrics.js";
import { parseUsageCursor, type UsageCallsPage } from "./usage-reader.js";
import { renderCallsPage, renderOperatorPage } from "./operator-page.js";
import type { SegmentChange, SegmentFilter } from "./segments.js";
import type { ExperimentInput } from "./experiments.js";
export interface OperatorPrincipal {
  subject: string;
  permissions: string[];
}
export interface OperatorDependencies {
  environment: "development" | "production";
  authorize(request: Request): Promise<OperatorPrincipal | null>;
  readDashboard(input: {
    limit: number;
    cursor: string | null;
    segment?: SegmentFilter;
  }): Promise<Dashboard>;
  readAttribution?(input: { subject: string; operator: string }): Promise<{
    observed_at: string;
    r: string | null;
    utm: Record<string, string> | null;
    utm_observed_at?: string | null;
  } | null>;
  readAccounts?(input: { limit: number; cursor: string | null }): Promise<{
    accounts: { subject: string; firstSeen: string; lastSeen: string }[];
    nextCursor: string | null;
  }>;
  readTimeline?(input: {
    subject: string;
    scope: string;
    limit: number;
    cursor: string | null;
  }): Promise<TimelinePage>;
  readUsageCalls?(input: {
    day: string;
    accountId: string | null;
    cursor?: string | null;
  }): Promise<UsageCallsPage>;
  registerExperiment?(input: ExperimentInput): Promise<unknown>;
  setSegment?(input: SegmentChange): Promise<void>;
  resolveIdentityForOperator?(input: {
    subject: string;
    operator: string;
  }): Promise<{ name: string | null; email: string | null }>;
}
export async function handleGrowthOperatorRequest(
  request: Request,
  deps: OperatorDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    !["GET", "POST"].includes(request.method) ||
    !["/growth", "/growth/cohorts", "/growth/timeline", "/growth/calls"].includes(url.pathname)
  )
    return new Response("Not found", { status: 404 });
  const principal = await deps.authorize(request);
  if (!principal?.permissions.includes("growth.read_aggregate"))
    return new Response("Forbidden", { status: 403 });
  if (
    (url.pathname === "/growth/timeline" || url.pathname === "/growth/calls") &&
    !principal.permissions.includes("growth.read_identity")
  )
    return new Response("Forbidden", { status: 403 });
  if (url.pathname === "/growth/calls" && request.method === "GET") {
    const day = url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
    const accountId = url.searchParams.get("account_id") || null;
    const cursor = url.searchParams.get("cursor");
    try {
      parseUsageCursor(cursor);
    } catch {
      return new Response("Invalid cursor", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)) ||
      new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day ||
      (accountId && !/^user_[A-Za-z0-9_]{1,123}$/.test(accountId))
    )
      return new Response("Invalid filter", { status: 400 });
    if (!deps.readUsageCalls)
      return new Response("Calls unavailable", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    const page = await deps.readUsageCalls({ day, accountId, cursor });
    return new Response(renderCallsPage(deps.environment, day, accountId, page), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "POST") {
    if (
      url.pathname !== "/growth" ||
      (!principal.permissions.includes("growth.manage_experiments") &&
        !principal.permissions.includes("growth.manage_segments"))
    )
      return new Response("Forbidden", { status: 403 });
    const contentType = request.headers.get("content-type") ?? "";
    const form = contentType.startsWith("application/x-www-form-urlencoded");
    if (
      request.headers.get("origin") !== url.origin ||
      (form
        ? request.headers.get("sec-fetch-site") !== "same-origin"
        : contentType !== "application/json" || request.headers.get("x-growth-csrf") !== "1")
    )
      return new Response("Forbidden", { status: 403 });
    if (Number(request.headers.get("content-length") ?? "0") > 8192)
      return new Response("Too large", { status: 413 });
    let body: unknown;
    try {
      const raw = await request.text();
      if (raw.length > 8192) return new Response("Too large", { status: 413 });
      if (form) {
        const params = new URLSearchParams(raw);
        const token = params.get("csrf");
        const cookie = request.headers
          .get("cookie")
          ?.split(";")
          .map((x) => x.trim())
          .find((x) => x.startsWith("__Host-growth-csrf="))
          ?.slice("__Host-growth-csrf=".length);
        if (!token || token !== cookie || !/^[a-f0-9-]{36}$/.test(token))
          return new Response("Forbidden", { status: 403 });
        body = Object.fromEntries(params);
        const formBody = body as Record<string, unknown>;
        if (formBody["action"] === "register") {
          formBody["guardrails"] = String(formBody["guardrails"] ?? "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
          formBody["evidence_reference"] = formBody["evidence_reference"] || null;
          for (const key of ["horizon_start", "horizon_end"])
            formBody[key] = new Date(`${String(formBody[key])}:00Z`).toISOString();
          formBody["surface"] = "authorized_product_response";
          formBody["exposure_mode"] = "before_after";
        }
      } else body = JSON.parse(raw);
    } catch {
      return new Response("Invalid request", { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return new Response("Invalid request", { status: 400 });
    const data = body as Record<string, unknown>;
    const text = (value: unknown) =>
      typeof value === "string" && value.length > 0 && value.length <= 500;
    if (data["action"] === "segment") {
      if (
        !principal.permissions.includes("growth.manage_segments") ||
        (data["entity_type"] === "account" &&
          !principal.permissions.includes("growth.read_identity"))
      )
        return new Response("Forbidden", { status: 403 });
      if (
        !deps.setSegment ||
        !["account", "organization"].includes(String(data["entity_type"])) ||
        !["test", "non_test", "unknown"].includes(String(data["segment"])) ||
        typeof data["entity_id"] !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,199}$/.test(data["entity_id"])
      )
        return new Response("Invalid request", { status: 400 });
      await deps.setSegment({
        entityType: data["entity_type"] as SegmentChange["entityType"],
        entityId: data["entity_id"],
        segment: data["segment"] as SegmentChange["segment"],
        operator: principal.subject,
      });
      return form
        ? new Response(null, {
            status: 303,
            headers: { location: "/growth", "cache-control": "no-store" },
          })
        : new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    if (
      data["action"] === "register" &&
      principal.permissions.includes("growth.manage_experiments") &&
      deps.registerExperiment &&
      text(data["hypothesis"]) &&
      ["observed_technical", "user_reported", "hypothesis"].includes(
        String(data["evidence_basis"]),
      ) &&
      (data["evidence_reference"] === null || text(data["evidence_reference"])) &&
      ["all", "new_accounts_7d"].includes(String(data["segment"])) &&
      ["workspace_ready_7d", "healthy_deployment_7d"].includes(String(data["primary_metric"])) &&
      Array.isArray(data["guardrails"]) &&
      data["guardrails"].length > 0 &&
      data["guardrails"].length <= 10 &&
      data["guardrails"].every(text) &&
      text(data["baseline_version"]) &&
      text(data["variant_version"]) &&
      data["baseline_version"] !== data["variant_version"] &&
      data["surface"] === "authorized_product_response" &&
      data["exposure_mode"] === "before_after" &&
      ["horizon_start", "horizon_end"].every(
        (k) =>
          typeof data[k] === "string" &&
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data[k] as string) &&
          !Number.isNaN(Date.parse(data[k] as string)) &&
          new Date(data[k] as string).toISOString() === data[k],
      ) &&
      Date.parse(data["horizon_start"] as string) < Date.parse(data["horizon_end"] as string) &&
      Date.parse(data["horizon_end"] as string) > Date.now()
    ) {
      const input = {
        hypothesis: data["hypothesis"],
        evidence_basis: data["evidence_basis"],
        evidence_reference: data["evidence_reference"],
        segment: data["segment"],
        primary_metric: data["primary_metric"],
        guardrails: data["guardrails"],
        horizon_start: data["horizon_start"],
        horizon_end: data["horizon_end"],
        baseline_version: data["baseline_version"],
        variant_version: data["variant_version"],
        surface: data["surface"],
        exposure_mode: data["exposure_mode"],
      } as ExperimentInput;
      const registered = await deps.registerExperiment(input);
      if (form)
        return new Response(null, {
          status: 303,
          headers: { location: "/growth", "cache-control": "no-store" },
        });
      return Response.json(registered, {
        status: 201,
        headers: { "cache-control": "no-store" },
      });
    }
    return new Response("Invalid request", { status: 400 });
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor && (cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)))
    return new Response("Invalid cursor", { status: 400 });
  const segmentParam = url.searchParams.get("segment") ?? "all";
  if (!["all", "test", "non_test", "unknown"].includes(segmentParam))
    return new Response("Invalid segment", { status: 400 });
  const segment = segmentParam as SegmentFilter;
  const dashboard = await deps.readDashboard({ limit: 50, cursor, segment });
  let accounts:
    | {
        accounts: { subject: string; firstSeen: string; lastSeen: string }[];
        nextCursor: string | null;
      }
    | undefined;
  if (url.searchParams.get("accounts") === "1") {
    if (!principal.permissions.includes("growth.read_identity"))
      return new Response("Forbidden", { status: 403 });
    if (!deps.readAccounts) return new Response("Accounts unavailable", { status: 503 });
    accounts = await deps.readAccounts({ limit: 50, cursor });
  }
  let attribution:
    | {
        observed_at: string;
        r: string | null;
        utm: Record<string, string> | null;
        utm_observed_at?: string | null;
      }
    | null
    | undefined;
  let timeline: TimelinePage | undefined;
  let timelineBase: string | undefined;
  if (url.pathname === "/growth/timeline") {
    const subject = url.searchParams.get("subject"),
      scope = url.searchParams.get("scope");
    if (
      !subject ||
      !scope ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(subject) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(scope)
    )
      return new Response("Invalid scope", { status: 400 });
    if (!deps.readTimeline) return new Response("Timeline unavailable", { status: 503 });
    timelineBase = `/growth/timeline?subject=${encodeURIComponent(subject)}&scope=${encodeURIComponent(scope)}`;
    timeline = await deps.readTimeline({ subject, scope, limit: 50, cursor });
    if (url.searchParams.get("attribution") === "1") {
      if (!principal.permissions.includes("growth.read_identity"))
        return new Response("Forbidden", { status: 403 });
      if (!deps.readAttribution) return new Response("Attribution unavailable", { status: 503 });
      attribution = await deps.readAttribution({ subject, operator: principal.subject });
    }
    if (url.searchParams.get("identity") === "1") {
      if (!principal.permissions.includes("growth.read_identity"))
        return new Response("Forbidden", { status: 403 });
      if (!deps.resolveIdentityForOperator)
        return new Response("Identity unavailable", { status: 503 });
      const identity = await deps.resolveIdentityForOperator({
        subject,
        operator: principal.subject,
      });
      timeline = {
        ...timeline,
        items: [
          {
            at: "",
            stage: `Identity: ${identity.name ?? "Unknown"} / ${identity.email ?? "Unknown"}`,
            error: null,
            actor: null,
            client: null,
            clientTrust: null,
            campaign: null,
            environment: null,
            kind: null,
            health: null,
          },
          ...timeline.items,
        ],
      };
    }
  }
  const csrf =
    (principal.permissions.includes("growth.manage_experiments") && deps.registerExperiment) ||
    (principal.permissions.includes("growth.manage_segments") && deps.setSegment)
      ? crypto.randomUUID()
      : undefined;
  return new Response(
    renderOperatorPage(
      deps.environment,
      dashboard,
      timeline,
      csrf,
      timelineBase,
      accounts,
      principal.permissions.includes("growth.read_identity"),
      attribution,
      segment,
      principal.permissions.includes("growth.manage_segments") && !!deps.setSegment,
      principal.permissions.includes("growth.manage_experiments") && !!deps.registerExperiment,
    ),
    {
      headers: {
        ...(csrf
          ? {
              "set-cookie": `__Host-growth-csrf=${csrf}; Path=/; Secure; HttpOnly; SameSite=Strict`,
            }
          : {}),
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
