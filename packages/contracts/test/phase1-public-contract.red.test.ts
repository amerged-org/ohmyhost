import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const openApiPath = fileURLToPath(new URL("../openapi.yaml", import.meta.url));

type OpenApiObject = Record<string, unknown>;

interface OpenApiDocument extends OpenApiObject {
  servers?: Array<OpenApiObject>;
  paths?: Record<string, OpenApiObject>;
  components?: {
    headers?: Record<string, OpenApiObject>;
    parameters?: Record<string, OpenApiObject>;
    responses?: Record<string, OpenApiObject>;
    schemas?: Record<string, OpenApiObject>;
    securitySchemes?: Record<string, OpenApiObject>;
  };
}

const phase1Routes = [
  ["/v1/me", "get"],
  ["/v1/projects", "post"],
  ["/v1/projects/{project_id}", "get"],
  ["/v1/operations/{operation_id}", "get"],
  ["/v1/operations/{operation_id}/events", "get"],
  ["/v1/audit-events", "get"],
] as const;

let document: OpenApiDocument;

beforeAll(async () => {
  document = parse(await readFile(openApiPath, "utf8")) as OpenApiDocument;
});

describe("Phase 1 public OpenAPI contract (red until the contract is promoted)", () => {
  it("uses an origin-only server URL because every public path already owns the /v1 prefix", () => {
    expect(document.servers).toEqual([
      expect.objectContaining({ url: "https://app.ohmyho.st" }),
      expect.objectContaining({ url: "https://dev.app.ohmyho.st" }),
    ]);
    expect(Object.keys(document.paths ?? {}).every((path) => path.startsWith("/v1/"))).toBe(true);
  });

  it("declares the authenticated identity and approved first-boundary operations", () => {
    expect(
      phase1Routes.map(([path, method]) => ({
        method,
        operation: operation(path, method),
        path,
      })),
    ).toEqual([
      {
        method: "get",
        operation: expect.objectContaining({ operationId: "getCurrentIdentity" }),
        path: "/v1/me",
      },
      {
        method: "post",
        operation: expect.objectContaining({ operationId: "createProject" }),
        path: "/v1/projects",
      },
      {
        method: "get",
        operation: expect.objectContaining({ operationId: "getProject" }),
        path: "/v1/projects/{project_id}",
      },
      {
        method: "get",
        operation: expect.objectContaining({ operationId: "getOperation" }),
        path: "/v1/operations/{operation_id}",
      },
      {
        method: "get",
        operation: expect.objectContaining({ operationId: "streamOperationEvents" }),
        path: "/v1/operations/{operation_id}/events",
      },
      {
        method: "get",
        operation: expect.objectContaining({ operationId: "listAuditEvents" }),
        path: "/v1/audit-events",
      },
    ]);
  });

  it("returns only the authenticated actor and internal organization identifiers", () => {
    expect(operation("/v1/me", "get")).toMatchObject({
      responses: {
        "200": {
          headers: {
            "X-Request-Id": { $ref: "#/components/headers/XRequestId" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CurrentIdentity" },
            },
          },
        },
        "400": { $ref: "#/components/responses/Problem" },
        "401": { $ref: "#/components/responses/Problem" },
        "429": { $ref: "#/components/responses/Problem" },
        "503": { $ref: "#/components/responses/Problem" },
      },
    });
    expect(document.components?.schemas?.["CurrentIdentity"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["actor_id", "email", "organization_ids", "organizations"],
      properties: {
        actor_id: { type: "string", minLength: 1, maxLength: 256 },
        email: { type: ["string", "null"], format: "email", minLength: 3, maxLength: 254 },
        organization_ids: {
          type: "array",
          uniqueItems: true,
          items: { $ref: "#/components/schemas/Ulid" },
        },
        organizations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name"],
            properties: {
              id: { $ref: "#/components/schemas/Ulid" },
              name: { type: "string", minLength: 1, maxLength: 128 },
            },
          },
        },
      },
    });
  });

  it("makes project creation an idempotent asynchronous operation with replay conflict semantics", () => {
    const createProject = operation("/v1/projects", "post");

    expect(createProject).toMatchObject({
      parameters: expect.arrayContaining([
        { $ref: "#/components/parameters/RequestId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ]),
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateProjectRequest" },
          },
        },
      },
      responses: {
        "202": { $ref: "#/components/responses/AcceptedProject" },
        "409": { $ref: "#/components/responses/Problem" },
      },
      "x-ohmyhost-idempotency": {
        canonicalRequestVersion: "v1",
        identicalRequest: "replay-stored-response",
        changedRequest: "409-idempotency-key-reused",
      },
    });

    expect(document.components?.responses?.["IdempotencyConflict"]).toMatchObject({
      headers: {
        "X-Request-Id": { $ref: "#/components/headers/XRequestId" },
      },
      content: {
        "application/problem+json": {
          schema: { $ref: "#/components/schemas/IdempotencyConflictProblem" },
        },
      },
    });
    expect(document.components?.schemas?.["IdempotencyConflictProblem"]).toMatchObject({
      allOf: [
        { $ref: "#/components/schemas/ProblemDetails" },
        {
          type: "object",
          properties: { code: { const: "idempotency_key_reused" } },
        },
      ],
    });

    expect(document.components?.schemas?.["CreateProjectRequest"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["organization_id", "name"],
      properties: {
        organization_id: { $ref: "#/components/schemas/Ulid" },
        name: { type: "string", minLength: 1, maxLength: 128 },
        region: { $ref: "#/components/schemas/HostingRegion" },
      },
    });
    expect(document.components?.schemas?.["HostingRegion"]).toMatchObject({
      type: "string",
      enum: ["us", "eu"],
      default: "us",
    });
    expect(document.components?.schemas?.["Project"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["id", "organization_id", "name", "handle", "data_mode", "region", "created_at"],
      properties: {
        id: { $ref: "#/components/schemas/Ulid" },
        organization_id: { $ref: "#/components/schemas/Ulid" },
        name: { type: "string", minLength: 1, maxLength: 128 },
        handle: {
          type: "string",
          minLength: 3,
          maxLength: 59,
          pattern: "^[a-z0-9]+(-[a-z0-9]+){0,4}$",
        },
        region: { $ref: "#/components/schemas/HostingRegion" },
        created_at: { type: "string", format: "date-time" },
      },
    });
  });

  it("defines tenant-scoped project discovery and a complete project status projection", () => {
    expect(operation("/v1/projects", "get")).toMatchObject({
      operationId: "listProjects",
      parameters: expect.arrayContaining([
        { $ref: "#/components/parameters/RequestId" },
        { $ref: "#/components/parameters/ProjectCursor" },
        { $ref: "#/components/parameters/ProjectLimit" },
      ]),
      responses: {
        "200": expect.objectContaining({
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ProjectPage" } },
          },
        }),
      },
    });
    expect(operation("/v1/projects/{project_id}/status", "get")).toMatchObject({
      operationId: "getProjectStatus",
      parameters: expect.arrayContaining([
        { $ref: "#/components/parameters/RequestId" },
        { $ref: "#/components/parameters/ProjectId" },
      ]),
      responses: {
        "200": expect.objectContaining({
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ProjectStatus" } },
          },
        }),
      },
      "x-ohmyhost-resource-disclosure": "indistinguishable-not-found",
    });
    expect(document.components?.schemas?.["ProjectStatus"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "project_id",
        "etag",
        "handle",
        "region",
        "dev_access_mode",
        "lifecycle",
        "source",
        "default_environment",
        "head_deployment",
        "dev_url",
        "prod_url",
        "latest_operation",
        "cleanup_state",
      ],
    });
  });

  it("uses RFC 9457 problem responses with correlation headers on every declared failure", () => {
    expect(document.components?.schemas?.["ProblemDetails"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["type", "title", "status", "code", "request_id", "retryable", "suggested_action"],
      properties: {
        type: { type: "string", format: "uri-reference" },
        title: { type: "string", minLength: 1 },
        status: { type: "integer", minimum: 400, maximum: 599 },
        detail: { type: "string" },
        instance: { type: "string", format: "uri-reference" },
        code: { type: "string" },
        request_id: { type: "string", minLength: 1 },
        retryable: { type: "boolean" },
        suggested_action: { type: "string", minLength: 1 },
      },
    });
    expect(document.components?.responses?.["Problem"]).toMatchObject({
      headers: {
        "X-Request-Id": { $ref: "#/components/headers/XRequestId" },
      },
      content: {
        "application/problem+json": {
          schema: { $ref: "#/components/schemas/ProblemDetails" },
        },
      },
    });
    expect(document.components?.responses?.["ResourceNotFound"]).toMatchObject({
      description: expect.stringMatching(/does not exist|not visible/i),
      headers: {
        "X-Request-Id": { $ref: "#/components/headers/XRequestId" },
      },
      content: {
        "application/problem+json": {
          schema: { $ref: "#/components/schemas/ProblemDetails" },
        },
      },
    });

    const requiredFailures = new Map<string, readonly string[]>([
      ["GET /v1/me", ["400", "401", "429", "503"]],
      ["GET /v1/projects", ["400", "401", "403", "429", "503"]],
      ["POST /v1/projects", ["400", "401", "403", "409", "413", "429", "503"]],
      ["GET /v1/projects/{project_id}", ["400", "401", "403", "404", "429", "503"]],
      ["GET /v1/projects/{project_id}/status", ["400", "401", "403", "404", "429", "503"]],
      ["GET /v1/operations/{operation_id}", ["400", "401", "403", "404", "429", "503"]],
      ["GET /v1/operations/{operation_id}/events", ["400", "401", "403", "404", "429", "503"]],
      ["GET /v1/audit-events", ["400", "401", "403", "404", "429", "503"]],
    ]);

    for (const [route, statuses] of requiredFailures) {
      const [method, path] = route.split(" ") as [string, string];
      const responses = record(operation(path, method.toLowerCase()), "responses");
      for (const status of statuses) {
        const expectedResponse =
          status === "404"
            ? "#/components/responses/ResourceNotFound"
            : "#/components/responses/Problem";
        expect(responses[status], `${route} ${status}`).toEqual({ $ref: expectedResponse });
      }
    }
  });

  it("correlates every successful response and declares its public representation", () => {
    const expectedSuccesses = [
      ["GET /v1/me", "200", "#/components/schemas/CurrentIdentity"],
      ["GET /v1/projects", "200", "#/components/schemas/ProjectPage"],
      ["POST /v1/projects", "202", "#/components/schemas/ProjectCreateOperation"],
      ["GET /v1/projects/{project_id}", "200", "#/components/schemas/Project"],
      ["GET /v1/projects/{project_id}/status", "200", "#/components/schemas/ProjectStatus"],
      ["GET /v1/operations/{operation_id}", "200", "#/components/schemas/Operation"],
      ["GET /v1/audit-events", "200", "#/components/schemas/AuditEventPage"],
    ] as const;

    for (const [route, status, schemaReference] of expectedSuccesses) {
      const [method, path] = route.split(" ") as [string, string];
      const declaredResponse = response(operation(path, method.toLowerCase()), status);
      const resolvedResponse = resolveComponentResponse(declaredResponse);

      expect(resolvedResponse, `${route} ${status}`).toMatchObject({
        headers: {
          "X-Request-Id": { $ref: "#/components/headers/XRequestId" },
        },
        content: {
          "application/json": {
            schema: { $ref: schemaReference },
          },
        },
      });
    }
  });

  it("defines opaque cursor audit reads with authorized workspace selection and no BOLA disclosure", () => {
    const audit = operation("/v1/audit-events", "get");

    expect(audit).toMatchObject({
      parameters: [
        { $ref: "#/components/parameters/RequestId" },
        {
          name: "organization_id",
          in: "query",
          description: expect.any(String),
          required: false,
          schema: { $ref: "#/components/schemas/Ulid" },
        },
        { $ref: "#/components/parameters/ProjectFilter" },
        { $ref: "#/components/parameters/OperationFilter" },
        { $ref: "#/components/parameters/AuditCursor" },
        { $ref: "#/components/parameters/AuditLimit" },
      ],
      responses: {
        "200": {
          description: expect.any(String),
          headers: {
            "X-Request-Id": { $ref: "#/components/headers/XRequestId" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AuditEventPage" },
            },
          },
        },
      },
      "x-ohmyhost-audit-order": ["occurred_at:desc", "audit_event_id:desc"],
      "x-ohmyhost-resource-disclosure": "indistinguishable-not-found",
    });

    expect(document.components?.parameters?.["AuditCursor"]).toMatchObject({
      name: "cursor",
      in: "query",
      required: false,
      schema: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    });
    expect(document.components?.parameters?.["AuditLimit"]).toMatchObject({
      name: "limit",
      in: "query",
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    });

    const parameterNames = operationParameterNames(audit);
    expect(parameterNames).toContain("organization_id");
    expect(parameterNames).toEqual(
      expect.arrayContaining(["project_id", "operation_id", "cursor", "limit"]),
    );

    for (const [path, method] of phase1Routes.filter(
      ([routePath]) => routePath.includes("{project_id}") || routePath.includes("{operation_id}"),
    )) {
      expect(operation(path, method)).toMatchObject({
        "x-ohmyhost-resource-disclosure": "indistinguishable-not-found",
      });
    }
  });

  it("defines the operation event stream as SSE with a typed, correlated event payload", () => {
    const stream = operation("/v1/operations/{operation_id}/events", "get");

    expect(stream).toMatchObject({
      responses: {
        "200": {
          headers: {
            "X-Request-Id": { $ref: "#/components/headers/XRequestId" },
          },
          content: {
            "text/event-stream": {
              schema: { $ref: "#/components/schemas/OperationEvent" },
            },
          },
        },
      },
    });
    expect(document.components?.schemas?.["OperationEvent"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["event_id", "operation_id", "project_id", "type", "occurred_at"],
      properties: {
        event_id: { $ref: "#/components/schemas/Ulid" },
        operation_id: { $ref: "#/components/schemas/Ulid" },
        project_id: { $ref: "#/components/schemas/Ulid" },
        type: {
          type: "string",
          enum: [
            "OperationQueued",
            "OperationStarted",
            "OperationSucceeded",
            "OperationFailed",
            "OperationCancelled",
          ],
        },
        occurred_at: { type: "string", format: "date-time" },
      },
    });
  });

  it("does not turn the headless product boundary into an assumed cookie-session API", () => {
    expect(document).toMatchObject({
      security: [{ BearerAuth: [] }],
      components: {
        securitySchemes: {
          BearerAuth: { type: "http", scheme: "bearer" },
        },
      },
    });
    expect(Object.keys(document.paths ?? {})).not.toEqual(
      expect.arrayContaining(["/v1/login", "/v1/logout", "/v1/session", "/v1/sessions"]),
    );

    for (const [path, method] of phase1Routes) {
      const route = operation(path, method);
      expect(operationParameterNames(route).map((name) => name.toLowerCase())).not.toContain(
        "cookie",
      );

      for (const response of Object.values(record(route, "responses"))) {
        if (isObject(response) && "$ref" in response) {
          continue;
        }
        expect(
          Object.keys(record(response, "headers")).map((name) => name.toLowerCase()),
        ).not.toContain("set-cookie");
      }
    }

    for (const scheme of Object.values(document.components?.securitySchemes ?? {})) {
      expect(scheme).not.toMatchObject({ type: "apiKey", in: "cookie" });
    }
  });

  it("publishes a closed set of stable Phase 1 problem codes", () => {
    expect(document.components?.schemas?.["ProblemDetails"]).toMatchObject({
      properties: {
        code: {
          type: "string",
          enum: [
            "invalid_request",
            "unauthenticated",
            "forbidden",
            "organization_required",
            "resource_not_found",
            "idempotency_key_reused",
            "project_handle_unavailable",
            "project_identity_unavailable",
            "deployment_plan_expired",
            "deployment_plan_incompatible",
            "confirmation_expired",
            "confirmation_invalid",
            "etag_mismatch",
            "promotion_source_stale",
            "promotion_target_stale",
            "promotion_invalid_target",
            "mail_domain_conflict",
            "mail_domain_pending_limit",
            "mail_domain_required",
            "mail_capacity_unavailable",
            "storage_jurisdiction_conflict",
            "shared_data_requires_promotion",
            "development_environment_exists",
            "development_environment_missing",
            "source_generation_conflict",
            "source_commit_conflict",
            "source_upload_conflict",
            "source_upload_expired",
            "source_scope_unavailable",
            "source_snapshot_invalid",
            "source_snapshot_too_large",
            "preview_version_conflict",
            "production_deployment_required",
            "framework_conversion_required",
            "repository_configuration_missing",
            "migration_filename_noncanonical",
            "environment_secret_mutation_blocked",
            "workers_runtime_incompatible",
            "project_handle_invalid",
            "project_handle_taken",
            "project_handle_unchanged",
            "project_rename_blocked",
            "database_limit_reached",
            "payload_too_large",
            "rate_limited",
            "build_capacity_reached",
            "insufficient_organization_credits",
            "paid_plan_required",
            "project_budget_exceeded",
            "compute_performance_paid_required",
            "compute_paid_required",
            "compute_storage_shrink_requires_migration",
            "compute_performance_unavailable",
            "database_write_pending",
            "database_access_limit",
            "database_webhook_limit",
            "database_schedule_limit",
            "database_schedule_not_runnable",
            "database_webhook_delivery_pending",
            "database_watch_limit",
            "database_watch_table_unavailable",
            "database_watch_column_unavailable",
            "database_watch_events_unavailable",
            "database_watch_conflict",
            "database_table_conflict",
            "database_table_limit",
            "compute_change_pending",
            "compute_change_conflict",
            "billing_purchase_conflict",
            "billing_recharge_conflict",
            "github_connection_required",
            "connection_revoked",
            "github_connection_revoked",
            "repository_not_installed",
            "cloudflare_zone_not_bound",
            "cloudflare_authorization_closed",
            "project_notes_conflict",
            "project_export_not_ready",
            "powered_by_flag_required",
            "interactive_login_required",
            "api_key_creation_uncertain",
            "api_key_permissions_unavailable",
            "reconciliation_exhausted",
            "reconciliation_not_pending",
            "service_unavailable",
            "source_commit_not_found",
            "domain_hostname_taken",
            "domain_ownership_required",
            "domain_dns_conflict",
            "domain_already_configured",
            "domain_deleting",
            "data_change_blocked",
            "data_change_in_progress",
            "data_change_not_applicable",
            "rollback_target_data_changed",
            "project_domain_delete_required",
            "native_domain_sync_pending",
            "native_auth_launch_unavailable",
            "native_auth_provider_unavailable",
            "native_auth_epoch_exhausted",
            "native_auth_revision_conflict",
            "native_auth_provider_incomplete",
            "auto_deploy_source_unavailable",
            "cutover_pending",
            "project_operation_in_progress",
            "native_user_conflict",
            "project_domains_conflict",
          ],
        },
      },
    });
  });

  it("publishes only a closed, redacted audit payload summary", () => {
    expect(document.components?.schemas?.["AuditEvent"]).toMatchObject({
      properties: {
        payload: { $ref: "#/components/schemas/AuditPayloadSummary" },
      },
    });
    expect(document.components?.schemas?.["AuditPayloadSummary"]).toEqual({
      type: "object",
      description: expect.stringMatching(/redacted/i),
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 512 },
      },
    });
  });
});

function operation(path: string, method: string): OpenApiObject {
  return record(document.paths?.[path], method);
}

function response(route: OpenApiObject, status: string): OpenApiObject {
  const value = record(route, "responses")[status];
  return isObject(value) ? value : {};
}

function resolveComponentResponse(value: OpenApiObject): OpenApiObject {
  const reference = value["$ref"];
  if (typeof reference !== "string") {
    return value;
  }

  const componentName = reference.split("/").at(-1);
  return componentName === undefined ? {} : (document.components?.responses?.[componentName] ?? {});
}

function operationParameterNames(value: OpenApiObject): string[] {
  const parameters = value["parameters"];
  if (!Array.isArray(parameters)) {
    return [];
  }

  return parameters.flatMap((parameter) => {
    if (!isObject(parameter)) {
      return [];
    }
    if (typeof parameter["name"] === "string") {
      return [parameter["name"]];
    }
    if (typeof parameter["$ref"] !== "string") {
      return [];
    }

    const componentName = parameter["$ref"].split("/").at(-1);
    const component =
      componentName === undefined ? undefined : document.components?.parameters?.[componentName];
    return typeof component?.["name"] === "string" ? [component["name"]] : [];
  });
}

function record(value: unknown, key: string): OpenApiObject {
  if (!isObject(value)) {
    return {};
  }
  const nested = value[key];
  return isObject(nested) ? nested : {};
}

function isObject(value: unknown): value is OpenApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
