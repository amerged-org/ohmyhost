import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isNativeAuthRedirectPath } from "../src/native-auth.js";
import { PROBLEM_POLICY } from "../src/problem-policy.js";

const openApiPath = fileURLToPath(new URL("../openapi.yaml", import.meta.url));

interface OpenApiDocument {
  openapi?: unknown;
  info?: { title?: unknown; version?: unknown };
  servers?: Array<{ url?: unknown }>;
  paths?: Record<string, unknown>;
  components?: {
    headers?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    responses?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
  };
}

async function readOpenApi(): Promise<OpenApiDocument> {
  return parse(await readFile(openApiPath, "utf8")) as OpenApiDocument;
}

describe("OpenAPI base contract", () => {
  it("projects the complete master tool contract without widening executable operations", async () => {
    const { projectRemoteMcpContract } = await import(
      new URL("../../../scripts/mcp-remote-projection.mjs", import.meta.url).href
    );
    const document = await readOpenApi();
    const projected = projectRemoteMcpContract(document);
    expect(projected.operations).toHaveLength(177);
    for (const [operationId, toolName] of Object.entries({
      getProjectPreview: "preview_get",
      openProjectPreview: "preview_open",
      stopProjectPreview: "preview_stop",
      rotateProjectPreviewToken: "preview_rotate",
      listConnectionProviders: "integration_connection_providers",
      listConnections: "integration_connection_list",
      beginConnection: "integration_connection_begin",
      getConnectionRequest: "integration_connection_status",
      discoverConnection: "integration_connection_discover",
      importConnection: "integration_connection_import",
      disconnectConnection: "integration_connection_disconnect",
    })) {
      expect(
        projected.operations.find(
          (operation: { operationId: string }) => operation.operationId === operationId,
        )?.toolNames,
      ).toEqual([toolName]);
    }
    expect(
      projected.operations.every((operation: { disposition?: string }) => operation.disposition),
    ).toBe(true);
    for (const operationId of ["createMakeActionBinding", "runMakeAction"]) {
      const action = projected.operations.find(
        (operation: { operationId: string }) => operation.operationId === operationId,
      );
      expect(action?.disposition).toBe("excluded");
      expect(action?.toolNames).toEqual([]);
      expect(
        projected.tools.some((tool: { operationId: string }) => tool.operationId === operationId),
      ).toBe(false);
    }
    const names = projected.tools.map((tool: { name: string }) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    const documentedTerms = new Set<string>([
      ...names,
      ...projected.operations.flatMap((entry: { toolNames: string[] }) => entry.toolNames),
      ...projected.workflowTools.map((entry: { name: string }) => entry.name),
      ...Object.keys(PROBLEM_POLICY),
      // The existing feedback receipt contract documents this non-enumerating error marker.
      "not_found",
    ]);
    const addSchemaTerms = (schema: unknown): void => {
      if (!schema || typeof schema !== "object") return;
      const node = schema as Record<string, unknown>;
      const properties = node["properties"];
      if (properties && typeof properties === "object")
        for (const name of Object.keys(properties)) documentedTerms.add(name);
      const values = node["enum"];
      if (Array.isArray(values))
        for (const value of values) if (typeof value === "string") documentedTerms.add(value);
      if (typeof node["const"] === "string") documentedTerms.add(node["const"]);
      for (const child of Object.values(node))
        if (Array.isArray(child)) child.forEach(addSchemaTerms);
        else if (child && typeof child === "object") addSchemaTerms(child);
    };
    for (const entry of projected.operations) {
      addSchemaTerms(entry.inputSchema);
      addSchemaTerms(entry.outputSchema);
    }
    for (const tool of projected.tools) {
      const unsupportedReferences = Array.from(
        String(tool.description).matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu),
        (match) => match[0],
      ).filter((term) => !documentedTerms.has(term));
      expect(unsupportedReferences, tool.name).toEqual([]);
      expect(tool.description, tool.name).not.toMatch(/\bdatabase\s+schedule\s+(?:set|get)\b/iu);
    }
    const watch = projected.tools.find(
      (tool: { name: string }) => tool.name === "database_watch_create",
    );
    expect(watch.annotations.destructiveHint).toBe(true);
    expect(watch.description).toMatch(/replac|overwrit/iu);
    const deletion = projected.tools.find(
      (tool: { name: string }) => tool.name === "delete_execute",
    );
    const validateDeletion = new Ajv2020({ strict: false }).compile(deletion.inputSchema);
    const deletionInput = {
      project_id: "01M21T9VB6J0P0QWQJ4J3086ZJ",
      idempotency_key: "delete-project-once",
      if_match: '"current-project"',
      confirmation_token: "c".repeat(43),
    };
    expect(validateDeletion(deletionInput)).toBe(true);
    for (const header of ["idempotency_key", "if_match", "confirmation_token"])
      for (const invalid of [
        "bad\nheader",
        "bad\rheader",
        "bad\u0000header",
        "bad\u007fheader",
        "bad\u0100header",
        " leading",
        "trailing ",
      ])
        expect(
          validateDeletion({ ...deletionInput, [header]: invalid }),
          `${header}: ${JSON.stringify(invalid)}`,
        ).toBe(false);
    for (const name of [
      "database_compute_get",
      "database_compute_set",
      "database_query",
      "database_write",
      "organization_credits_get",
      "organization_usage_get",
      "project_budget_get",
      "project_budget_set",
    ])
      expect(names).toContain(name);
    const write = projected.tools.find((tool: { name: string }) => tool.name === "database_write");
    expect(write.inputSchema.properties.confirmed).toEqual({ type: "boolean", const: true });
    expect(write.inputSchema.properties).not.toHaveProperty("profile_name");
    expect(write.inputSchema.required).toContain("idempotency_key");
    const compute = projected.tools.find(
      (tool: { name: string }) => tool.name === "database_compute_set",
    );
    const validateCompute = new Ajv2020({ strict: false }).compile(compute.inputSchema);
    const change = {
      project_id: "01M21T9VB6J0P0QWQJ4J3086ZJ",
      environment: "dev",
      confirm: true,
      idempotency_key: "resize-once",
      memory_mib: 512,
    };
    expect(validateCompute(change)).toBe(true);
    expect(validateCompute({ ...change, profile: "standard" })).toBe(false);
    expect(validateCompute({ ...change, memory_mib: 513 })).toBe(false);
    for (const operation of projected.operations.filter(
      (entry: { disposition: string }) =>
        entry.disposition === "excluded" || entry.disposition === "protected-handoff",
    ))
      expect(
        projected.tools.some(
          (tool: { operationId: string }) => tool.operationId === operation.operationId,
        ),
      ).toBe(false);
    type MutableOperation = Record<string, unknown> & {
      requestBody: { content: { "application/json": { schema: unknown } } };
      responses: Record<string, unknown>;
    };
    const operation = (
      copy: unknown,
      path = "/v1/projects/{project_id}/database/query",
      method = "post",
    ) => {
      const selected = (copy as { paths: Record<string, Record<string, MutableOperation>> }).paths[
        path
      ]?.[method];
      if (!selected) throw new Error("Missing operation fixture");
      return selected;
    };
    const mutations = [
      (copy: unknown) => {
        delete operation(copy, "/v1/projects", "get")["x-ohmyhost-mcp"];
      },
      (copy: unknown) => {
        operation(copy).requestBody.content["application/json"].schema = {
          $ref: "#/components/schemas/Missing",
        };
      },
      (copy: unknown) => {
        operation(copy).requestBody.content["application/json"].schema = {
          $ref: "https://example.invalid/schema.json",
        };
      },
      (copy: unknown) => {
        operation(copy).requestBody.content["application/json"].schema = {
          type: "object",
          properties: { project_id: { type: "string" } },
        };
      },
      (copy: unknown) => {
        operation(copy).requestBody.content["application/json"].schema = {
          type: "object",
          properties: {},
          unevaluatedProperties: false,
        };
      },
      (copy: unknown) => {
        operation(copy).responses["200"] = {
          content: {
            "application/json": {
              schema: { type: "object", properties: { secret: { type: "string" } } },
            },
          },
        };
      },
      (copy: unknown) => {
        operation(copy).responses["200"] = {
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { type: "object", properties: { signing_secret: { type: "string" } } },
              },
            },
          },
        };
      },
      (copy: unknown) => {
        const existing = operation(copy)["x-ohmyhost-mcp"] as object;
        operation(copy, "/v1/projects/{project_id}/database/compute", "get")["x-ohmyhost-mcp"] =
          structuredClone(existing);
      },
      (copy: unknown) => {
        const secret = operation(copy, "/v1/projects/{project_id}/database/webhooks");
        secret["x-ohmyhost-mcp"] = {
          disposition: "named",
          adapter: "generated",
          tool_names: ["database_webhook_create"],
          tool: {
            name: "database_webhook_create",
            title: "Create webhook",
            description: "Forbidden raw secret projection",
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: true,
              openWorldHint: true,
            },
          },
        };
      },
    ];
    const feedback = projected.tools.find(
      (tool: { name: string }) => tool.name === "feedback_submit",
    );
    const validateFeedback = new Ajv2020({ strict: false }).compile(feedback.inputSchema);
    const report = {
      organization_id: change.project_id,
      kind: "bug",
      title: "Test feedback",
      description: "Expected versus actual result",
      idempotency_key: "feedback-once",
    };
    expect(validateFeedback(report)).toBe(true);
    expect(validateFeedback({ ...report, environment_id: change.project_id })).toBe(false);
    expect(validateFeedback({ ...report, operation_id: change.project_id })).toBe(false);
    expect(
      validateFeedback({
        ...report,
        project_id: change.project_id,
        environment_id: change.project_id,
      }),
    ).toBe(true);
    expect(
      validateFeedback({
        ...report,
        project_id: change.project_id,
        operation_id: change.project_id,
      }),
    ).toBe(true);
    for (const mutate of mutations) {
      const copy = structuredClone(document);
      mutate(copy);
      expect(() => projectRemoteMcpContract(copy)).toThrow();
    }
  });
  it("keeps Native redirect path schema aligned with runtime validation", async () => {
    const document = await readOpenApi();
    const schema = document.components?.schemas?.["NativeAuthRedirectPath"];
    const validate = new Ajv2020().compile(schema as object);
    for (const path of [
      "/",
      "/login",
      "/u/~name.v1",
      "//evil",
      "/a//b",
      "/..",
      "/a/../b",
      "/a/./b",
      "/a?b",
      "/%2e",
      "/" + "a".repeat(256),
    ]) {
      expect(validate(path), path).toBe(isNativeAuthRedirectPath(path));
    }
  });
  it("defines owner-scoped Native management with revision fences and write-only provider secrets", async () => {
    const document = await readOpenApi();
    const base = "/v1/projects/{project_id}/environments/{environment_id}/auth";
    type Operation = {
      description: string;
      responses: Record<string, unknown>;
      parameters: unknown[];
    };
    const configuration = document.paths?.[base] as { get: Operation; put: Operation };
    const provider = document.paths?.[`${base}/providers/{provider}`] as {
      get: Operation;
      put: Operation;
    };
    const users = document.paths?.[`${base}/users`] as { get: Operation; post: Operation };
    for (const operation of [
      configuration.get,
      configuration.put,
      provider.get,
      provider.put,
      users.get,
      users.post,
    ]) {
      expect(operation.description).toContain("current project Owner");
      expect(operation.responses["403"]).toBeDefined();
      expect(operation.responses["404"]).toBeDefined();
    }
    for (const operation of [configuration.put, provider.put, users.post]) {
      expect(operation.parameters).toContainEqual({
        $ref: "#/components/parameters/IdempotencyKey",
      });
      expect(operation.responses["409"]).toBeDefined();
    }
    expect(document.components?.schemas?.["NativeAuthProviderUpdate"]).toMatchObject({
      additionalProperties: false,
      required: ["configurationRevision", "enabled"],
      properties: { clientSecret: { writeOnly: true } },
    });
    expect(document.components?.schemas?.["NativeAuthProviderStatus"]).not.toHaveProperty(
      "properties.clientSecret",
    );
    const providerInput = new Ajv2020().compile(
      document.components?.schemas?.["NativeAuthProviderUpdate"] as object,
    );
    const boundaryInput = {
      configurationRevision: 1,
      enabled: true,
      clientId: "c".repeat(1024),
      clientSecret: "s".repeat(5120),
    };
    expect(providerInput(boundaryInput)).toBe(true);
    expect(providerInput({ ...boundaryInput, clientId: "c".repeat(1025) })).toBe(false);
    expect(providerInput({ ...boundaryInput, clientSecret: "s".repeat(5121) })).toBe(false);
    const configurationSchema = document.components?.schemas?.["NativeAuthConfigurationUpdate"] as {
      properties: { applicationName: object };
    };
    const nameInput = new Ajv2020().compile(configurationSchema.properties.applicationName);
    expect(nameInput("a".repeat(128))).toBe(true);
    expect(nameInput("a".repeat(129))).toBe(false);
    expect(users.get.parameters).toContainEqual(
      expect.objectContaining({ name: "limit", schema: expect.objectContaining({ maximum: 100 }) }),
    );
  });
  it("pins the canonical OpenAPI version and API identity", async () => {
    const document = await readOpenApi();

    expect(document.openapi).toBe("3.1.2");
    expect(document.info).toMatchObject({ title: "ohmyho.st API", version: "0.0.0" });
    const operations = Object.values(document.paths ?? {}).flatMap((path) =>
      Object.entries(path as Record<string, unknown>).filter(([method]) =>
        ["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method),
      ),
    );
    expect(operations).toHaveLength(177);
    expect(Object.keys(document.paths ?? {}).some((path) => path.includes("/previews"))).toBe(
      false,
    );
    const preview = "/v1/projects/{project_id}/preview";
    expect(
      Object.keys(document.paths ?? {})
        .filter((path) => /\/previews?(?:\/|$)/u.test(path))
        .sort(),
    ).toEqual([preview, `${preview}/token`]);
    const resource = document.paths?.[preview] as Record<string, unknown>;
    const token = document.paths?.[`${preview}/token`] as Record<string, unknown>;
    expect(Object.keys(resource).sort()).toEqual(["delete", "get", "post"]);
    expect(Object.keys(token)).toEqual(["post"]);
    expect(resource).toMatchObject({
      get: { operationId: "getProjectPreview" },
      post: { operationId: "openProjectPreview" },
      delete: { operationId: "stopProjectPreview" },
    });
    expect(token).toMatchObject({ post: { operationId: "rotateProjectPreviewToken" } });
    expect(document).toHaveProperty("security", [{ BearerAuth: [] }]);
    for (const operation of [
      resource["get"],
      resource["post"],
      resource["delete"],
      token["post"],
    ]) {
      expect(operation).toMatchObject({
        parameters: expect.arrayContaining([
          { $ref: "#/components/parameters/ProjectId" },
          { $ref: "#/components/parameters/PreviewEnvironment" },
        ]),
        responses: {
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/ResourceNotFound" },
        },
        "x-ohmyhost-resource-disclosure": "indistinguishable-not-found",
      });
    }
    for (const operation of [resource["delete"], token["post"]])
      expect(operation).toMatchObject({
        parameters: expect.arrayContaining([{ $ref: "#/components/parameters/IdempotencyKey" }]),
        responses: { "409": { $ref: "#/components/responses/Problem" } },
      });
    expect(document.servers).toEqual([
      expect.objectContaining({ url: "https://app.ohmyho.st" }),
      expect.objectContaining({ url: "https://dev.app.ohmyho.st" }),
    ]);
  });

  it("defines the shared RFC 9457 problem representation", async () => {
    const document = await readOpenApi();
    const problem = document.components?.schemas?.["ProblemDetails"];

    expect(problem).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["type", "title", "status", "code", "request_id", "retryable", "suggested_action"],
      properties: {
        type: { type: "string", format: "uri-reference" },
        status: { type: "integer", minimum: 400, maximum: 599 },
        code: { type: "string" },
        request_id: { type: "string" },
        retryable: { type: "boolean" },
        suggested_action: { type: "string" },
      },
    });
    expect(document.components?.responses?.["Problem"]).toMatchObject({
      headers: { "X-Request-Id": { $ref: "#/components/headers/XRequestId" } },
      content: {
        "application/problem+json": {
          schema: { $ref: "#/components/schemas/ProblemDetails" },
        },
      },
    });
  });

  it("declares the Idempotency-Key characters that the operations which refuse others enforce", async () => {
    const document = await readOpenApi();
    const parameterOf = (operationId: string) => {
      for (const item of Object.values(document.paths ?? {})) {
        for (const operation of Object.values((item ?? {}) as Record<string, unknown>)) {
          const op = operation as { operationId?: unknown; parameters?: unknown[] };
          if (op?.operationId !== operationId) continue;
          for (const raw of op.parameters ?? []) {
            const ref = (raw as { $ref?: string }).$ref;
            const parameter = (
              ref === undefined
                ? raw
                : document.components?.parameters?.[ref.slice(ref.lastIndexOf("/") + 1)]
            ) as { name?: unknown } | undefined;
            if (parameter?.name === "Idempotency-Key") return parameter;
          }
        }
      }
      throw new Error(`${operationId} declares no Idempotency-Key`);
    };
    for (const operationId of [
      "createUserApiKey",
      "submitFeedback",
      "revokeCurrentSession",
      "configureBillingRecharge",
      "createBillingCheckout",
      "createWorkspaceMailDomain",
      "retireWorkspaceMailDomain",
      "authorizeWorkspaceMailDomainDns",
      "revokeWorkspaceMailDomainDnsAuthorization",
      "putProjectMailDomainBinding",
      "detachProjectMailDomainBinding",
      "declareApplicationDomainIdentity",
      "revokeApplicationDomainIdentity",
      "verifyApplicationDomainIdentity",
      "authorizeApplicationDomainIdentityDns",
      "revokeApplicationDomainIdentityDnsAuthorization",
    ]) {
      expect(parameterOf(operationId), operationId).toMatchObject({
        schema: { pattern: "^[A-Za-z0-9._:-]+$" },
      });
    }
  });

  it("defines reusable asynchronous operation and request conventions", async () => {
    const document = await readOpenApi();

    expect(document.components?.schemas?.["Operation"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["id", "state", "created_at", "updated_at"],
      properties: {
        state: {
          enum: ["queued", "running", "succeeded", "failed", "cancelled"],
        },
      },
    });
    expect(document.components?.parameters?.["IdempotencyKey"]).toMatchObject({
      name: "Idempotency-Key",
      in: "header",
      required: true,
    });
    expect(document.components?.headers?.["XRequestId"]).toMatchObject({
      required: true,
      schema: { type: "string", minLength: 1 },
    });
    expect(document.components?.responses?.["AcceptedOperation"]).toMatchObject({
      description: "The mutation was accepted for asynchronous processing.",
      headers: {
        Location: { required: true },
        "X-Request-Id": { $ref: "#/components/headers/XRequestId" },
      },
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Operation" },
        },
      },
    });
  });

  it("requires bounded customer-chosen handles in project projections", async () => {
    const document = await readOpenApi();

    expect(document.components?.schemas?.["Project"]).toMatchObject({
      additionalProperties: false,
      required: ["id", "organization_id", "name", "handle", "data_mode", "region", "created_at"],
      properties: {
        handle: {
          type: "string",
          maxLength: 59,
          minLength: 3,
          pattern: "^[a-z0-9]+(-[a-z0-9]+){0,4}$",
        },
      },
    });
  });
});

describe("OpenAPI problem codes", () => {
  it("lists every problem code the API returns in the ProblemDetails enum", async () => {
    const document = await readOpenApi();
    const schema = document.components?.schemas?.["ProblemDetails"] as {
      properties: { code: { enum: string[] } };
    };
    expect([...schema.properties.code.enum].sort()).toEqual(Object.keys(PROBLEM_POLICY).sort());
  });
});

describe("OpenAPI conflict responses", () => {
  it("answers the 409 of each operation that can return several conflict codes with the problem response", async () => {
    const document = await readOpenApi();
    const operations: Array<[string, string]> = [
      ["/v1/projects/{project_id}/credit-budget", "put"],
      ["/v1/projects", "post"],
      ["/v1/projects/{project_id}/source:link", "post"],
      ["/v1/projects/{project_id}/handle", "put"],
      ["/v1/projects/{project_id}/domains", "put"],
      ["/v1/projects/{project_id}/paid-domain", "delete"],
      ["/v1/projects/{project_id}/deployments", "post"],
      ["/v1/projects/{project_id}/environments/{environment_id}/secrets/{secret_name}", "put"],
      ["/v1/projects/{project_id}/environments/{environment_id}/secrets/{secret_name}", "delete"],
      [
        "/v1/projects/{project_id}/environments/{environment_id}/secrets/{secret_name}/rotate",
        "post",
      ],
    ];
    for (const [path, method] of operations) {
      const paths = document.paths as Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
      expect(paths[path]?.[method]?.responses["409"], `${method} ${path}`).toEqual({
        $ref: "#/components/responses/Problem",
      });
    }
  });
});
