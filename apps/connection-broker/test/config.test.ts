import { expect, test } from "vitest";
import { configurationState } from "../src/config.js";

test("missing or malformed credentials cannot enable linking", () => {
  expect(configurationState({})).toBe("provider_unconfigured");
  expect(configurationState({ clientId: "a", clientSecret: "b", vaultKey: "invalid" })).toBe(
    "provider_misconfigured",
  );
  expect(
    configurationState({ clientId: "a", clientSecret: "b", vaultKey: btoa("x".repeat(32)) }),
  ).toBe("configured");
});

test("disabled or unsafe registry entries cannot become ready with valid credentials", async () => {
  const { createBroker } = await import("../src/authorization.js");
  const { makeRegistration } = await import("../src/registry.js");
  const registration = { ...makeRegistration("development"), enabled: false };
  const deps = {
    environment: "development" as const,
    registration,
    registry: [registration],
    secrets: { clientId: "client", clientSecret: "secret", vaultKey: btoa("x".repeat(32)) },
    qualified: true,
    core: {} as never,
    observer: {} as never,
    adapter: {} as never,
  };
  expect(await createBroker(deps).providerReadiness({ provider: "make" })).toEqual({
    state: "provider_unavailable",
  });
  const enabled = { ...registration, enabled: true };
  for (const invalid of [
    { ...enabled, registration: "make-development-1" },
    { ...enabled, noncePolicy: "required" as const },
    { ...enabled, noncePolicy: undefined },
    { ...enabled, provider: "other", noncePolicy: "not_requested" as const },
  ])
    expect(
      await createBroker({
        ...deps,
        registration: invalid,
        registry: [invalid],
      } as never).providerReadiness({ provider: invalid.provider }),
    ).toEqual({ state: "provider_unavailable" });
  const { supportsMakeGrantRegistration } = await import("../src/registry.js");
  expect(
    supportsMakeGrantRegistration("development", "make-development-3", "make-development-1"),
  ).toBe(true);
  expect(
    supportsMakeGrantRegistration("development", "make-development-3", "make-development-2"),
  ).toBe(true);
  for (const value of ["make-production-1", "make-development-4", "other"])
    expect(supportsMakeGrantRegistration("development", "make-development-3", value)).toBe(false);
  expect(
    supportsMakeGrantRegistration("development", "make-development-1", "make-development-1"),
  ).toBe(false);
  const other = {
    ...enabled,
    provider: "other",
    issuer: "https://other.example",
    registration: "other",
  };
  expect(
    await createBroker({
      ...deps,
      registration: enabled,
      registry: [enabled, other],
    }).providerReadiness({ provider: "make" }),
  ).toEqual({ state: "provider_unavailable" });
});
