function mustFixtureValue<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
import { expect, test } from "vitest";
import { makeRegistration, validateIssuerCallbackPolicies } from "../src/registry.js";
test("shared callback rejects a second issuer without pre-exchange defense", () => {
  const registrations = ["https://www.make.com", "https://other.example"].map((issuer) => ({
    issuer,
    redirectUri: "https://connect.ohmyho.st/oauth/callback",
    enabled: true,
    issuerDefense: "single-issuer" as const,
  }));
  expect(() => validateIssuerCallbackPolicies(registrations)).toThrow("issuer_defense_required");
  expect(() =>
    validateIssuerCallbackPolicies([
      { ...mustFixtureValue(registrations[0]), issuerDefense: "signed-response" },
    ]),
  ).toThrow("issuer_defense_unsupported");
  expect(() =>
    validateIssuerCallbackPolicies([
      { ...mustFixtureValue(registrations[0]), issuerDefense: "rfc9207" },
    ]),
  ).toThrow("issuer_defense_unsupported");
  expect(() =>
    validateIssuerCallbackPolicies([
      { ...mustFixtureValue(registrations[0]), issuer: "https://other.example" },
    ]),
  ).toThrow("issuer_defense_unsupported");
  expect(makeRegistration("development").redirectUri).toBe(
    "https://dev.connect.ohmyho.st/oauth/callback",
  );
});
