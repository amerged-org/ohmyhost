import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isSaasCnameTarget } from "../src/platform-origins.js";

type OpenApiObject = Record<string, unknown>;

interface OpenApiDocument {
  paths?: Record<string, OpenApiObject>;
  components?: { schemas?: Record<string, OpenApiObject> };
}

let document: OpenApiDocument;

beforeAll(async () => {
  const path = fileURLToPath(new URL("../openapi.yaml", import.meta.url));
  document = parse(await readFile(path, "utf8")) as OpenApiDocument;
});

describe("Cloudflare project-domain public contract", () => {
  it("accepts only the two owned SaaS delegation targets without URLs or hostname lookalikes", () => {
    expect(isSaasCnameTarget("customers.omh.st")).toBe(true);
    expect(isSaasCnameTarget("customers.ohmyho.st")).toBe(true);
    for (const value of [
      null,
      "https://customers.omh.st",
      "customers.omh.st.attacker.example",
      "customer.example",
    ])
      expect(isSaasCnameTarget(value)).toBe(false);
  });
  it("creates a canonical customer-zone authorization through an idempotent owner mutation", () => {
    expect(
      operation("/v1/projects/{project_id}/cloudflare-dns/authorization", "post"),
    ).toMatchObject({
      operationId: "createCloudflareDnsAuthorization",
      parameters: expect.arrayContaining([
        { $ref: "#/components/parameters/RequestId" },
        { $ref: "#/components/parameters/ProjectId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ]),
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateCloudflareDnsAuthorizationRequest" },
          },
        },
      },
      responses: {
        "201": expect.objectContaining({
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CloudflareDnsAuthorization" },
            },
          },
        }),
        "404": { $ref: "#/components/responses/ResourceNotFound" },
        "409": { $ref: "#/components/responses/Problem" },
      },
      "x-ohmyhost-idempotency": {
        canonicalRequestVersion: "v1",
        identicalRequest: "replay-stored-response",
        changedRequest: "409-idempotency-key-reused",
      },
      "x-ohmyhost-resource-disclosure": "indistinguishable-not-found",
    });
    expect(schema("CreateCloudflareDnsAuthorizationRequest")).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["zone"],
      properties: {
        zone: {
          type: "string",
          minLength: 4,
          maxLength: 253,
          pattern: "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$",
        },
      },
    });
    expect(schema("CloudflareDnsAuthorization")).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["authorization_id", "authorization_url", "expires_at"],
      properties: {
        authorization_id: { $ref: "#/components/schemas/Ulid" },
        authorization_url: {
          type: "string",
          format: "uri",
          minLength: 20,
          maxLength: 4096,
          pattern: "^https://dash\\.cloudflare\\.com/oauth2/auth\\?",
        },
        expires_at: { type: "string", format: "date-time" },
      },
    });
  });

  it("reads the closed credential-free authorization status", () => {
    expect(operation("/v1/projects/{project_id}/cloudflare-dns", "get")).toMatchObject({
      operationId: "getCloudflareDnsAuthorizationStatus",
      parameters: expect.arrayContaining([
        { $ref: "#/components/parameters/RequestId" },
        { $ref: "#/components/parameters/ProjectId" },
      ]),
      responses: {
        "200": expect.objectContaining({
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CloudflareDnsAuthorizationStatus" },
            },
          },
        }),
        "404": { $ref: "#/components/responses/ResourceNotFound" },
      },
      "x-ohmyhost-resource-disclosure": "indistinguishable-not-found",
    });
    expect(schema("CloudflareDnsAuthorizationStatus")).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["status", "zone", "scopes", "expires_at"],
      properties: {
        status: {
          enum: [
            "not_authorized",
            "pending",
            "authorized",
            "reauthorization_required",
            "expired",
            "revoked",
          ],
        },
        zone: {
          type: ["string", "null"],
          minLength: 4,
          maxLength: 253,
          pattern: "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$",
        },
        scopes: {
          type: "array",
          uniqueItems: true,
          maxItems: 2,
          items: { type: "string", enum: ["dns.write", "zone.read"] },
        },
        expires_at: {
          oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
      },
    });
  });

  it("applies server-derived project domains with no request body and one durable operation", () => {
    const apply = operation("/v1/projects/{project_id}/domains", "put");
    expect(apply).toMatchObject({
      operationId: "configureProjectDomains",
      parameters: expect.arrayContaining([
        { $ref: "#/components/parameters/RequestId" },
        { $ref: "#/components/parameters/ProjectId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ]),
      responses: {
        "202": { $ref: "#/components/responses/AcceptedOperation" },
        "404": { $ref: "#/components/responses/ResourceNotFound" },
        "409": { $ref: "#/components/responses/Problem" },
      },
      "x-ohmyhost-idempotency": {
        canonicalRequestVersion: "v1",
        identicalRequest: "replay-stored-response",
        changedRequest: "409-idempotency-key-reused",
      },
      "x-ohmyhost-resource-disclosure": "indistinguishable-not-found",
    });
    expect(apply).not.toHaveProperty("requestBody");
  });

  it("declares early hostname preparation and retains guarded activation replay", () => {
    for (const [path, method] of [
      ["/v1/projects/{project_id}/paid-domain:plan", "post"],
      ["/v1/projects/{project_id}/paid-domain", "put"],
    ] as const) {
      const declared = operation(path, method);
      expect(declared).toMatchObject({
        responses: { "409": { $ref: "#/components/responses/Problem" } },
      });
      expect(declared["description"]).not.toContain("production_deployment_required (409)");
    }
    const apply = operation("/v1/projects/{project_id}/paid-domain", "put");
    expect(apply["description"]).toContain("awaiting_deployment");
    expect(apply["description"]).toContain("idempotency_key_reused (409)");
    expect(document.components?.schemas?.["PaidDomain"]).toMatchObject({
      properties: {
        status: { enum: expect.arrayContaining(["awaiting_deployment", "pending", "active"]) },
      },
    });
  });

  it("exposes only the one-time unauthenticated provider callback", () => {
    expect(operation("/v1/cloudflare/oauth/callback", "get")).toMatchObject({
      operationId: "completeCloudflareDnsAuthorization",
      security: [],
      parameters: [
        expect.objectContaining({ name: "code", in: "query", required: false }),
        expect.objectContaining({ name: "state", in: "query", required: false }),
        expect.objectContaining({ name: "error", in: "query" }),
        expect.objectContaining({ name: "error_description", in: "query" }),
        expect.objectContaining({ name: "error_uri", in: "query" }),
      ],
      responses: {
        "200": expect.objectContaining({
          content: { "text/html": { schema: { type: "string" } } },
        }),
        "400": { $ref: "#/components/responses/Problem" },
        "429": { $ref: "#/components/responses/Problem" },
        "503": { $ref: "#/components/responses/Problem" },
      },
    });
  });
});

function operation(path: string, method: string): OpenApiObject {
  const candidate = document.paths?.[path]?.[method];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return {};
  return candidate as OpenApiObject;
}

function schema(name: string): OpenApiObject {
  return document.components?.schemas?.[name] ?? {};
}
