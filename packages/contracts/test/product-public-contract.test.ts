import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { FIXED_PLATFORM_NAMES, INSTALLED_PLATFORM_KEY_NAMES } from "../src/secret-names.js";

const openApiPath = fileURLToPath(new URL("../openapi.yaml", import.meta.url));

type OpenApiObject = Record<string, unknown>;

interface OpenApiDocument extends OpenApiObject {
  paths?: Record<string, OpenApiObject>;
  components?: {
    parameters?: Record<string, OpenApiObject>;
    schemas?: Record<string, OpenApiObject>;
  };
}

let document: OpenApiDocument;

beforeAll(async () => {
  document = parse(await readFile(openApiPath, "utf8")) as OpenApiDocument;
});

describe("product public deploy contract", () => {
  it("declares the complete source, deploy, promotion, rollback, delete, and log boundary", () => {
    expect(operation("/v1/projects/{project_id}/source:link", "post")).toMatchObject({
      operationId: "linkProjectSource",
    });
    expect(operation("/v1/projects/{project_id}/source", "get")).toMatchObject({
      operationId: "getProjectSource",
    });
    expect(operation("/v1/projects/{project_id}/source/auto-deploy", "put")).toMatchObject({
      operationId: "configureProjectSourceAutoDeploy",
    });
    expect(operation("/v1/projects/{project_id}/source/auto-deploy", "get")).toMatchObject({
      operationId: "getProjectSourceAutoDeploy",
    });
    expect(operation("/v1/projects/{project_id}/deployments:plan", "post")).toMatchObject({
      operationId: "planDeployment",
    });
    expect(operation("/v1/projects/{project_id}/deployments", "post")).toMatchObject({
      operationId: "createDeployment",
    });
    expect(operation("/v1/projects/{project_id}/deployments", "get")).toMatchObject({
      operationId: "listDeployments",
    });
    expect(operation("/v1/projects/{project_id}/deployments/{deployment_id}", "get")).toMatchObject(
      { operationId: "getDeployment" },
    );
    expect(
      operation(
        "/v1/projects/{project_id}/deployments/{target_deployment_id}:rollback-plan",
        "post",
      ),
    ).toMatchObject({ operationId: "planDeploymentRollback" });
    expect(
      operation("/v1/projects/{project_id}/deployments/{target_deployment_id}:rollback", "post"),
    ).toMatchObject({ operationId: "rollbackDeployment" });
    expect(
      operation(
        "/v1/projects/{project_id}/deployments/{source_deployment_id}:promote-plan",
        "post",
      ),
    ).toMatchObject({ operationId: "planDeploymentPromotion" });
    expect(
      operation("/v1/projects/{project_id}/deployments/{source_deployment_id}:promote", "post"),
    ).toMatchObject({ operationId: "promoteDeployment" });
    expect(operation("/v1/projects/{project_id}:delete-plan", "post")).toMatchObject({
      operationId: "planProjectDeletion",
    });
    expect(operation("/v1/projects/{project_id}", "delete")).toMatchObject({
      operationId: "deleteProject",
    });
    expect(operation("/v1/operations/{operation_id}/events", "get")).toMatchObject({
      operationId: "streamOperationEvents",
      responses: {
        "200": {
          content: {
            "text/event-stream": {
              schema: { $ref: "#/components/schemas/OperationEvent" },
            },
          },
        },
      },
    });
    expect(
      operation("/v1/projects/{project_id}/deployments/{deployment_id}/logs", "get"),
    ).toMatchObject({ operationId: "getDeploymentLogs" });
    // A truncated stream declares the same paging and refusals as the page it streams.
    expect(
      operation("/v1/projects/{project_id}/deployments/{deployment_id}/logs/events", "get"),
    ).toMatchObject({
      operationId: "streamDeploymentLogs",
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: "cursor", in: "query" }),
        expect.objectContaining({ name: "limit", in: "query" }),
      ]),
      responses: {
        "200": {
          content: {
            "text/event-stream": { schema: { $ref: "#/components/schemas/DeploymentDiagnostic" } },
          },
        },
        "400": { $ref: "#/components/responses/Problem" },
        "429": { $ref: "#/components/responses/Problem" },
      },
    });
    expect(operation("/v1/operations/{operation_id}:reconcile", "post")).toMatchObject({
      operationId: "reconcileOperation",
      responses: {
        "202": {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProviderReconciliationAttempt" },
            },
          },
        },
      },
    });
    expect(operation("/v1/operations/{operation_id}:reconcile", "post")).not.toHaveProperty(
      "requestBody",
    );
  });

  it("requires idempotency for mutations and concurrency plus confirmation for destructive actions", () => {
    for (const [path, method] of [
      ["/v1/projects/{project_id}/source:link", "post"],
      ["/v1/projects/{project_id}/source/auto-deploy", "put"],
      ["/v1/projects/{project_id}/deployments", "post"],
      ["/v1/operations/{operation_id}:reconcile", "post"],
    ] as const) {
      expect(parameterReferences(operation(path, method))).toContain(
        "#/components/parameters/IdempotencyKey",
      );
    }

    for (const [path, method] of [
      ["/v1/projects/{project_id}/deployments/{target_deployment_id}:rollback", "post"],
      ["/v1/projects/{project_id}/deployments/{source_deployment_id}:promote", "post"],
      ["/v1/projects/{project_id}", "delete"],
    ] as const) {
      const references = parameterReferences(operation(path, method));
      expect(references).toEqual(
        expect.arrayContaining([
          "#/components/parameters/IdempotencyKey",
          "#/components/parameters/IfMatch",
          "#/components/parameters/ConfirmationToken",
        ]),
      );
    }

    expect(document.components?.parameters?.["IfMatch"]).toMatchObject({
      name: "If-Match",
      in: "header",
      required: true,
    });
    expect(document.components?.parameters?.["ConfirmationToken"]).toMatchObject({
      name: "X-Confirmation-Token",
      in: "header",
      required: true,
    });
  });

  it("publishes a 24-hour deployment plan for a named environment with the required immutable inputs and estimates", () => {
    expect(document.components?.schemas?.["DeploymentPlan"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      "x-ohmyhost-ttl-seconds": 86400,
      required: expect.arrayContaining([
        "id",
        "project_id",
        "environment",
        "commit_sha",
        "source_digest",
        "build_plan_digest",
        "application_root",
        "runtime",
        "route",
        "resource_effects",
        "risks",
        "estimated_cost",
        "created_at",
        "expires_at",
      ]),
      properties: {
        commit_sha: { $ref: "#/components/schemas/GitCommitSha" },
        source_digest: { $ref: "#/components/schemas/Sha256Digest" },
        build_plan_digest: { $ref: "#/components/schemas/Sha256Digest" },
        application_root: {
          type: "string",
          readOnly: true,
          maxLength: 64,
          pattern:
            "^(?:\\.|[A-Za-z0-9][A-Za-z0-9._-]{0,62}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,62}){0,7})$",
        },
        artifact_digest: { $ref: "#/components/schemas/Sha256Digest" },
        expires_at: { type: "string", format: "date-time" },
      },
    });
  });

  it("publishes reconciliation-required as an honest deployment status", () => {
    expect(document.components?.schemas?.["Deployment"]).toMatchObject({
      properties: {
        status: {
          enum: [
            "queued",
            "building",
            "publishing",
            "active",
            "failed",
            "rolled_back",
            "deleting",
            "deleted",
            "reconciliation_required",
          ],
        },
      },
    });
  });

  it("publishes the owner-only single-use dev access response without cacheable credentials", () => {
    expect(operation("/v1/projects/{project_id}/dev-access-tickets", "post")).toMatchObject({
      operationId: "createProjectDevAccessTicket",
      responses: {
        "201": {
          headers: {
            "Cache-Control": { schema: { const: "no-store" } },
            Pragma: { schema: { const: "no-cache" } },
          },
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/DevAccessTicket" } },
          },
        },
      },
    });
    expect(document.components?.schemas?.["DevAccessTicket"]).toMatchObject({
      additionalProperties: false,
      required: ["ticket_id", "project_id", "environment_id", "origin", "redeem_url", "expires_at"],
      properties: {
        origin: {
          pattern: "^https://dev-[a-z0-9]+(?:-[a-z0-9]+){0,4}\\.(?:dev\\.)?check\\.omh\\.st$",
        },
        redeem_url: {
          pattern:
            "^https://dev-[a-z0-9]+(?:-[a-z0-9]+){0,4}\\.(?:dev\\.)?check\\.omh\\.st/\\.ohmyhost/dev-access/redeem\\?stage=dev&ticket=[A-Za-z0-9_-]{43}$",
        },
      },
    });
  });

  it("publishes ten-minute action- and resource-bound destructive plans", () => {
    expect(document.components?.schemas?.["GuardedActionPlan"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      "x-ohmyhost-ttl-seconds": 600,
      required: expect.arrayContaining([
        "action",
        "project_id",
        "resource_etag",
        "confirmation_token",
        "created_at",
        "expires_at",
      ]),
      properties: {
        action: { type: "string", enum: ["rollback", "promote", "delete"] },
        project_id: { $ref: "#/components/schemas/Ulid" },
        resource_etag: { type: "string" },
        confirmation_token: { $ref: "#/components/schemas/ConfirmationToken" },
      },
      oneOf: [
        {
          properties: { action: { const: "rollback" } },
          required: ["target_deployment_id", "target_artifact_digest"],
        },
        {
          properties: { action: { const: "promote" } },
          required: [
            "source_deployment_id",
            "source_artifact_digest",
            "source_environment",
            "target_environment",
          ],
        },
        {
          properties: { action: { const: "delete" } },
          not: {
            anyOf: [
              { required: ["target_deployment_id"] },
              { required: ["target_artifact_digest"] },
              { required: ["source_deployment_id"] },
              { required: ["source_artifact_digest"] },
              { required: ["source_environment"] },
              { required: ["target_environment"] },
            ],
          },
        },
      ],
    });
  });

  it("publishes environment-secret metadata with write-only values and idempotent mutations", () => {
    const collection = "/v1/projects/{project_id}/environments/{environment_id}/secrets";
    const item = `${collection}/{secret_name}`;
    expect(operation(collection, "get")).toMatchObject({ operationId: "listEnvironmentSecrets" });
    expect(operation(item, "put")).toMatchObject({ operationId: "putEnvironmentSecret" });
    expect(operation(item, "delete")).toMatchObject({ operationId: "deleteEnvironmentSecret" });
    for (const method of ["put", "delete"] as const) {
      expect(parameterReferences(operation(item, method))).toContain(
        "#/components/parameters/IdempotencyKey",
      );
    }
    expect(document.components?.parameters?.["EnvironmentId"]).toMatchObject({
      name: "environment_id",
      in: "path",
      required: true,
    });
    expect(document.components?.parameters?.["SecretName"]).toMatchObject({
      name: "secret_name",
      in: "path",
      required: true,
      schema: { pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
    });
    expect(document.components?.schemas?.["PutEnvironmentSecretRequest"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: {
        value: { type: "string", minLength: 1, maxLength: 5120, writeOnly: true },
      },
    });
    expect(document.components?.schemas?.["EnvironmentSecret"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "name",
        "revision",
        "key_version",
        "created_at",
        "updated_at",
        "desired_generation",
        "applied_generation",
        "delivery_state",
        "runtime_provider",
        "applied_secret_count",
        "last_error",
      ],
    });
    expect(
      (document.components?.schemas?.["EnvironmentSecret"] as OpenApiObject | undefined)?.[
        "properties"
      ],
    ).not.toHaveProperty("value");
  });

  it("names every reserved secret name that set and delete refuse in the SecretName parameter", () => {
    const description = String(document.components?.parameters?.["SecretName"]?.["description"]);
    for (const name of [...FIXED_PLATFORM_NAMES, ...INSTALLED_PLATFORM_KEY_NAMES, "OHMYHOST_"]) {
      expect(description, name).toContain(name);
    }
  });

  it("accepts the caller correlation header on every organization report", () => {
    for (const report of ["credits", "credit-usage", "account"] as const) {
      expect(
        parameterReferences(operation(`/v1/organizations/{organization_id}/${report}`, "get")),
      ).toContain("#/components/parameters/RequestId");
    }
  });
});

function operation(path: string, method: string): OpenApiObject {
  return record(document.paths?.[path], method);
}

function parameterReferences(value: OpenApiObject): string[] {
  const parameters = value["parameters"];
  if (!Array.isArray(parameters)) return [];
  return parameters.flatMap((parameter) => {
    if (!isObject(parameter)) return [];
    return typeof parameter["$ref"] === "string" ? [parameter["$ref"]] : [];
  });
}

function record(value: unknown, key: string): OpenApiObject {
  return isObject(value) && isObject(value[key]) ? value[key] : {};
}

function isObject(value: unknown): value is OpenApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
