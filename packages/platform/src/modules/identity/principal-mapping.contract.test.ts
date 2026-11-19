import { describe, expect, it } from "vitest";

import * as platform from "../../index.js";

type UnknownFunction = (...arguments_: readonly unknown[]) => unknown;

function requirePlatformFunction(name: string): UnknownFunction {
  const candidate = (platform as Record<string, unknown>)[name];
  expect(candidate, `Expected @ohmyhost/platform to export ${name}`).toBeTypeOf("function");
  return candidate as UnknownFunction;
}

describe("canonical authorization principal mapping", () => {
  const examples = [
    {
      source: { kind: "workos_user", userId: "user_01" },
      expected: { kind: "user", subjectId: "user:user_01" },
    },
    {
      source: { kind: "device_session", sessionId: "session_01", userId: "user_01" },
      expected: { kind: "user", subjectId: "user:user_01" },
    },
    {
      source: { kind: "organization_api_key", apiKeyId: "api_key_01" },
      expected: { kind: "organization_api_key", subjectId: "api_key:api_key_01" },
    },
    {
      source: { kind: "m2m_service", clientId: "client_01" },
      expected: { kind: "m2m_service", subjectId: "service:client_01" },
    },
  ] as const;

  for (const example of examples) {
    it(`maps ${example.source.kind} to its canonical principal`, () => {
      const toAuthorizationPrincipal = requirePlatformFunction("toAuthorizationPrincipal");

      expect(toAuthorizationPrincipal(example.source)).toEqual(example.expected);
    });
  }

  it("maps browser and Device Flow authentication to the same authority identity", () => {
    const toAuthorizationPrincipal = requirePlatformFunction("toAuthorizationPrincipal");

    expect(
      toAuthorizationPrincipal({
        kind: "device_session",
        sessionId: "session_metadata_only",
        userId: "user_01",
      }),
    ).toEqual(toAuthorizationPrincipal({ kind: "workos_user", userId: "user_01" }));
  });

  it("rejects an empty canonical subject with a stable error", () => {
    expect(() =>
      requirePlatformFunction("toAuthorizationPrincipal")({ kind: "workos_user", userId: " " }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_AUTHENTICATION_PRINCIPAL" }));
  });
});
