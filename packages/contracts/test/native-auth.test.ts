import { describe, expect, it } from "vitest";

import {
  isNativeAuthPublicRoute,
  isNativeAuthRedirectPath,
  NATIVE_AUTH_DEFAULT_REDIRECT_PATHS,
} from "../src/native-auth.js";

describe("Native Auth public route boundary", () => {
  it("accepts only canonical local redirect paths", () => {
    for (const path of NATIVE_AUTH_DEFAULT_REDIRECT_PATHS)
      expect(isNativeAuthRedirectPath(path)).toBe(true);
    for (const path of [
      "//evil",
      "/x//y",
      "/../login",
      "/x/./y",
      "/%2e%2e",
      "/path?x=1",
      "/path#x",
      "/a\\b",
      "https://example.test/x",
      "/" + "a".repeat(256),
    ])
      expect(isNativeAuthRedirectPath(path)).toBe(false);
    expect(isNativeAuthRedirectPath("/hello/~user.name")).toBe(true);
  });
  it("admits exact method and path pairs, and rejects administration and prefix lookalikes", () => {
    expect(isNativeAuthPublicRoute("POST", "/api/auth/v1/sign-in/email")).toBe(true);
    expect(isNativeAuthPublicRoute("GET", "/api/auth/v1/callback/google")).toBe(true);
    expect(isNativeAuthPublicRoute("GET", "/api/auth/v1/list-accounts")).toBe(true);
    for (const [method, path] of [
      ["GET", "/api/auth/v1/sign-in/email"],
      ["GET", "/api/auth/v1/admin/list-users"],
      ["POST", "/api/auth/v1/get-access-token"],
      ["POST", "/api/auth/v1/list-accounts"],
      ["GET", "/api/auth/v1/callback/google/extra"],
      ["GET", "/api/auth/v10/get-session"],
      ["GET", "/api/auth/v1/get-session?x=1"],
      ["get", "/api/auth/v1/get-session"],
      ["toString", "/api/auth/v1/get-session"],
    ] as const)
      expect(isNativeAuthPublicRoute(method, path)).toBe(false);
  });
});
