import { describe, expect, it } from "vitest";

import { createCustomerAuthRequirement } from "./customer-auth.js";

const betterAuthConfig = {
  auth: { provider: "better-auth" },
  database: { enabled: true, migrations: "migrations" },
  mail: { enabled: true },
} as const;

describe("portable customer-auth requirement", () => {
  it("declares Native without requiring a business database or companion", () => {
    for (const deployment of ["embedded", "companion"] as const) {
      expect(
        createCustomerAuthRequirement({ auth: { provider: "omh-native" } } as never, deployment),
      ).toEqual({
        provider: "omh-native",
        routePath: "/api/auth/v1",
        bindingName: "OHMYHOST_AUTH",
      });
    }
  });
  it("normalizes omitted and explicit disabled auth", () => {
    expect(createCustomerAuthRequirement({} as never, "embedded")).toEqual({ provider: "none" });
    expect(
      createCustomerAuthRequirement({ auth: { provider: "none" } } as never, "companion"),
    ).toEqual({ provider: "none" });
  });

  it.each(["embedded", "companion"] as const)(
    "binds the pinned project-local Better Auth %s runtime",
    (deployment) => {
      const requirement = createCustomerAuthRequirement(betterAuthConfig as never, deployment);

      expect(requirement).toEqual({
        provider: "better-auth",
        version: "1.7.7",
        deployment,
        routePath: "/api/auth",
        databaseSchema: "auth",
        databaseBindingName: "OHMYHOST_DATABASE",
        authSecretName: "BETTER_AUTH_SECRET",
      });
      expect(Object.isFrozen(requirement)).toBe(true);
    },
  );

  it("admits managed auth independently of Mail while retaining its actual database requirement", () => {
    for (const database of [undefined, { enabled: false }]) {
      expect(() =>
        createCustomerAuthRequirement({ ...betterAuthConfig, database } as never, "embedded"),
      ).toThrow("Customer auth requirement is invalid");
    }
    const withoutMail = { auth: betterAuthConfig.auth, database: betterAuthConfig.database };
    for (const config of [
      withoutMail,
      { ...betterAuthConfig, mail: { enabled: false } },
      betterAuthConfig,
    ])
      expect(createCustomerAuthRequirement(config as never, "embedded")).toMatchObject({
        provider: "better-auth",
        databaseBindingName: "OHMYHOST_DATABASE",
      });
    expect(
      createCustomerAuthRequirement({ mail: { enabled: false } } as never, "embedded"),
    ).toEqual({ provider: "none" });
  });

  it("rejects unknown deployment modes", () => {
    expect(() =>
      createCustomerAuthRequirement(betterAuthConfig as never, "central" as never),
    ).toThrow("Customer auth requirement is invalid");
  });
});
