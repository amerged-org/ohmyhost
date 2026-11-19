import { describe, expect, expectTypeOf, it } from "vitest";

import {
  configureProjectDomains,
  createCloudflareDnsAuthorization,
  getCloudflareDnsAuthorizationStatus,
  type CloudflareDnsAuthorization,
  type CloudflareDnsAuthorizationStatus,
  type ConfigureProjectDomainsResponse,
  type CreateCloudflareDnsAuthorizationResponse,
  type GetCloudflareDnsAuthorizationStatusResponse,
  type Operation,
} from "../src/index.js";

describe("generated Cloudflare project-domain SDK", () => {
  it("exports the three generated operations with exact inputs and responses", () => {
    expect([
      createCloudflareDnsAuthorization,
      getCloudflareDnsAuthorizationStatus,
      configureProjectDomains,
    ]).toEqual(new Array(3).fill(expect.any(Function)));

    expectTypeOf<Parameters<typeof createCloudflareDnsAuthorization>[0]>().toMatchTypeOf<{
      "Idempotency-Key": string;
      project_id: string;
      createCloudflareDnsAuthorizationRequest: { zone: string };
    }>();
    expectTypeOf<Parameters<typeof getCloudflareDnsAuthorizationStatus>[0]>().toMatchTypeOf<{
      project_id: string;
    }>();
    expectTypeOf<Parameters<typeof configureProjectDomains>[0]>().toMatchTypeOf<{
      "Idempotency-Key": string;
      project_id: string;
    }>();
    expectTypeOf<CreateCloudflareDnsAuthorizationResponse>().toEqualTypeOf<CloudflareDnsAuthorization>();
    expectTypeOf<GetCloudflareDnsAuthorizationStatusResponse>().toEqualTypeOf<CloudflareDnsAuthorizationStatus>();
    expectTypeOf<ConfigureProjectDomainsResponse>().toEqualTypeOf<Operation>();
  });
});
